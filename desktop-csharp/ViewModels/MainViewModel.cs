using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Input.Platform;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using WebOcrDesktop.Models;
using WebOcrDesktop.Services;

namespace WebOcrDesktop.ViewModels;

public enum AppStatus { Idle, Capturing, Selecting, Analyzing, Error }

public partial class MainViewModel : ObservableObject, IDisposable
{
    // ── Services ─────────────────────────────────────────────────────────────
    private readonly ScreenCaptureService _capture = new();
    private readonly HotkeyService        _hotkey  = new();
    public  readonly ServerClient         Server;
    public  AppSettings Settings { get; private set; }

    // ── Bound state ──────────────────────────────────────────────────────────
    [ObservableProperty] [NotifyPropertyChangedFor(nameof(StatusText))] private AppStatus _status = AppStatus.Idle;
    [ObservableProperty] private string?       _errorMessage;
    [ObservableProperty] private Bitmap?       _screenshotBitmap;
    [ObservableProperty] private string?       _ocrText;
    [ObservableProperty] private string?       _translation;
    [ObservableProperty] private long          _elapsedMs;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TokenCards))]
    private List<TokenInfo> _tokens = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TokenCards))]
    private List<Definition?> _definitions = [];

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

    /// <summary>Zips Tokens + Definitions into card models for the TokenList control.</summary>
    public List<TokenCardModel> TokenCards =>
        Tokens.Select((t, i) => new TokenCardModel(t, i < Definitions.Count ? Definitions[i] : null))
              .Where(c => c.Token.Pos is not ("助詞" or "助動詞" or "記号" or "接続詞" or "感動詞"))
              .ToList();

    // Raw PNG bytes for cropping (not bound to UI)
    public byte[]? ScreenshotPng { get; private set; }

    public MainViewModel()
    {
        Settings = SettingsStore.Load();
        Server   = new ServerClient(Settings);

        _hotkey.HotkeyFired += () =>
            Dispatcher.UIThread.Post(() => _ = StartCaptureAsync());

        _hotkey.Start();
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    [RelayCommand]
    public async Task StartCaptureAsync()
    {
        if (Status is AppStatus.Capturing or AppStatus.Selecting or AppStatus.Analyzing) return;

        Status = AppStatus.Capturing;
        CaptureRequested?.Invoke();
    }

    /// <summary>Called by App after the main window is hidden and screenshot is taken.</summary>
    public async Task OnScreenshotReadyAsync(byte[] png)
    {
        ScreenshotPng = png;

        using var ms = new System.IO.MemoryStream(png);
        ScreenshotBitmap = new Bitmap(ms);

        Status = AppStatus.Selecting;
        SelectionRequested?.Invoke();
    }

    /// <summary>Called by OverlayWindow when user completes a selection.</summary>
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

    [RelayCommand]
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

    [RelayCommand]
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

    [RelayCommand]
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
