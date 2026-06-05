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

    public AppSettings ToSettings() => new()
    {
        ServerUrl       = ServerUrl.Trim(),
        ApiKey          = string.IsNullOrWhiteSpace(ApiKey) ? null : ApiKey.Trim(),
        TranslateEngine = TranslateEngine,
        DictionaryMode  = DictionaryMode,
    };
}
