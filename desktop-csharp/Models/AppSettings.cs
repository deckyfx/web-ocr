using System.Text.Json.Serialization;

namespace WebOcrDesktop.Models;

public record AppSettings
{
    public string ServerUrl { get; init; } = "http://localhost:3579";

    /// <summary>
    /// Not stored in settings.json. Loaded/saved separately by SettingsStore
    /// (DPAPI on Windows, chmod-600 file on Unix).
    /// </summary>
    [JsonIgnore]
    public string? ApiKey { get; init; }

    public string TranslateEngine { get; init; } = "none";
    public string DictionaryMode { get; init; } = "local";
}
