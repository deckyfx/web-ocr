using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using WebOcrDesktop.Models;

namespace WebOcrDesktop.ViewModels;

public class SettingsViewModel : INotifyPropertyChanged
{
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

    private string _serverUrl       = "http://localhost:3579";
    private string _apiKey          = "";
    private string _translateEngine = "none";
    private string _dictionaryMode  = "local";

    public string ServerUrl       { get => _serverUrl;       set => SetProperty(ref _serverUrl,       value); }
    public string ApiKey          { get => _apiKey;          set => SetProperty(ref _apiKey,           value); }
    public string TranslateEngine { get => _translateEngine; set => SetProperty(ref _translateEngine,  value); }
    public string DictionaryMode  { get => _dictionaryMode;  set => SetProperty(ref _dictionaryMode,   value); }

    public SettingsViewModel() { }

    public SettingsViewModel(AppSettings s)
    {
        _serverUrl       = s.ServerUrl;
        _apiKey          = s.ApiKey ?? "";
        _translateEngine = s.TranslateEngine;
        _dictionaryMode  = s.DictionaryMode;
    }

    public AppSettings ToSettings()
    {
        var url = ServerUrl.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out _))
            throw new ArgumentException($"Invalid server URL: \"{url}\"");

        return new AppSettings
        {
            ServerUrl       = url,
            ApiKey          = string.IsNullOrWhiteSpace(ApiKey) ? null : ApiKey.Trim(),
            TranslateEngine = TranslateEngine,
            DictionaryMode  = DictionaryMode,
        };
    }
}
