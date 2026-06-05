using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
using System.Windows.Input;
using Avalonia;
using Avalonia.Input.Platform;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using WebOcrDesktop.Models;
using WebOcrDesktop.Services;

namespace WebOcrDesktop.ViewModels;

public enum AppStatus { Idle, Capturing, Selecting, Analyzing, Error }

public class MainViewModel : INotifyPropertyChanged, IDisposable
{
    // ── INotifyPropertyChanged ────────────────────────────────────────────────
    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    private bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        OnPropertyChanged(name);
        return true;
    }

    // ── Services ──────────────────────────────────────────────────────────────
    private readonly ScreenCaptureService _capture = new();
    private readonly HotkeyService        _hotkey  = new();
    public  readonly ServerClient         Server;
    public  AppSettings Settings { get; private set; }

    // ── Observable properties ─────────────────────────────────────────────────
    private AppStatus        _status = AppStatus.Idle;
    private string?          _errorMessage;
    private Bitmap?          _screenshotBitmap;
    private string?          _ocrText;
    private string?          _translation;
    private long             _elapsedMs;
    private List<TokenInfo>  _tokens      = [];
    private List<Definition?> _definitions = [];

    public AppStatus Status
    {
        get => _status;
        set { if (SetProperty(ref _status, value)) OnPropertyChanged(nameof(StatusText)); }
    }

    public string? ErrorMessage    { get => _errorMessage;    set => SetProperty(ref _errorMessage,    value); }
    public Bitmap? ScreenshotBitmap { get => _screenshotBitmap; set => SetProperty(ref _screenshotBitmap, value); }
    public string? OcrText         { get => _ocrText;         set => SetProperty(ref _ocrText,         value); }
    public string? Translation     { get => _translation;     set => SetProperty(ref _translation,     value); }
    public long    ElapsedMs       { get => _elapsedMs;       set => SetProperty(ref _elapsedMs,       value); }

    public List<TokenInfo> Tokens
    {
        get => _tokens;
        set { if (SetProperty(ref _tokens, value)) OnPropertyChanged(nameof(TokenCards)); }
    }

    public List<Definition?> Definitions
    {
        get => _definitions;
        set { if (SetProperty(ref _definitions, value)) OnPropertyChanged(nameof(TokenCards)); }
    }

    public string StatusText => Status switch
    {
        AppStatus.Idle      => "Press Super+Shift+O to capture",
        AppStatus.Capturing => "Capturing screen…",
        AppStatus.Selecting => "Drag to select a region",
        AppStatus.Analyzing => "Analyzing…",
        AppStatus.Error     => ErrorMessage ?? "Error",
        _                   => ""
    };

    public bool HasResults => OcrText is { Length: > 0 };

    public List<TokenCardModel> TokenCards =>
        Tokens.Select((t, i) => new TokenCardModel(t, i < Definitions.Count ? Definitions[i] : null))
              .Where(c => c.Token.Pos is not ("助詞" or "助動詞" or "記号" or "接続詞" or "感動詞"))
              .ToList();

    // Raw PNG bytes for cropping (not bound to UI)
    public byte[]? ScreenshotPng { get; private set; }

    // ── Commands ──────────────────────────────────────────────────────────────
    public ICommand StartCaptureCommand  { get; }
    public ICommand CopyOcrTextCommand   { get; }
    public ICommand ClearResultsCommand  { get; }

    public MainViewModel()
    {
        Settings = SettingsStore.Load();
        Server   = new ServerClient(Settings);

        StartCaptureCommand = new DelegateCommand(async () => await StartCaptureAsync());
        CopyOcrTextCommand  = new DelegateCommand(async () => await CopyOcrTextAsync());
        ClearResultsCommand = new DelegateCommand(ClearResults);

        _hotkey.HotkeyFired += () =>
            Dispatcher.UIThread.Post(() => _ = StartCaptureAsync());

        _hotkey.Start();
    }

    // ── Capture flow ──────────────────────────────────────────────────────────

    public async Task StartCaptureAsync()
    {
        if (Status is AppStatus.Capturing or AppStatus.Selecting or AppStatus.Analyzing) return;

        Status = AppStatus.Capturing;
        CaptureRequested?.Invoke();
    }

    public async Task OnScreenshotReadyAsync(byte[] png)
    {
        ScreenshotPng = png;

        using var ms = new System.IO.MemoryStream(png);
        ScreenshotBitmap = new Bitmap(ms);

        Status = AppStatus.Selecting;
        SelectionRequested?.Invoke();
    }

    public async Task OnRegionSelectedAsync(int x, int y, int w, int h)
    {
        if (ScreenshotPng is null) return;

        Status = AppStatus.Analyzing;

        try
        {
            var cropped = _capture.CropPng(ScreenshotPng, x, y, w, h);
            var base64  = Convert.ToBase64String(cropped);

            var ocr = await Server.OcrAsync(base64, Settings.TranslateEngine);
            OcrText     = ocr.Text;
            Translation = ocr.Translation;
            ElapsedMs   = ocr.ElapsedMs;

            if (!string.IsNullOrWhiteSpace(ocr.Text))
            {
                var analyze = await Server.AnalyzeAsync(ocr.Text, mode: Settings.DictionaryMode);
                Tokens      = analyze.Tokens;
                Definitions = analyze.Definitions;
                ElapsedMs   = analyze.ElapsedMs;
            }
            else
            {
                Tokens      = [];
                Definitions = [];
            }

            OnPropertyChanged(nameof(HasResults));
            Status = AppStatus.Idle;
            ResultReady?.Invoke();
        }
        catch (Exception ex)
        {
            ErrorMessage = ex.Message;
            Status = AppStatus.Error;
            ResultReady?.Invoke();
        }
    }

    public void CancelCapture()
    {
        ScreenshotPng    = null;
        ScreenshotBitmap = null;
        Status = AppStatus.Idle;
    }

    public async Task CopyOcrTextAsync()
    {
        if (OcrText is null) return;
        var clipboard = Avalonia.Application.Current?.ApplicationLifetime is
            Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime { MainWindow: { } w }
            ? w.Clipboard
            : null;
        if (clipboard is not null)
            await clipboard.SetTextAsync(OcrText);
    }

    public void ClearResults()
    {
        OcrText          = null;
        Translation      = null;
        Tokens           = [];
        Definitions      = [];
        ScreenshotBitmap = null;
        ScreenshotPng    = null;
        ErrorMessage     = null;
        Status           = AppStatus.Idle;
        OnPropertyChanged(nameof(HasResults));
    }

    public void SaveSettings(AppSettings settings)
    {
        Settings = settings;
        if (!SettingsStore.Save(settings))
        {
            ErrorMessage = $"Settings not saved: {SettingsStore.LastSaveError}";
            Status = AppStatus.Error;
        }
        Server.Reinitialize(settings);
    }

    // ── Events for the App shell ──────────────────────────────────────────────
    public event Action? CaptureRequested;
    public event Action? SelectionRequested;
    public event Action? ResultReady;

    public void Dispose()
    {
        _hotkey.Dispose();
        Server.Dispose();
    }
}
