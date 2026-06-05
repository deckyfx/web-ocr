using System;
using CommunityToolkit.Mvvm.ComponentModel;
using WebOcrDesktop.Models;

namespace WebOcrDesktop.ViewModels;

public partial class SettingsViewModel : ObservableObject
{
    [ObservableProperty] private string _serverUrl  = "http://localhost:3579";
    [ObservableProperty] private string _apiKey     = "";
    [ObservableProperty] private string _translateEngine = "none";
    [ObservableProperty] private string _dictionaryMode  = "local";

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
