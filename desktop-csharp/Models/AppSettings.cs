namespace WebOcrDesktop.Models;

public record AppSettings
{
    public string ServerUrl { get; init; } = "http://localhost:3579";
    public string? ApiKey { get; init; }
    public string TranslateEngine { get; init; } = "none";
    public string DictionaryMode { get; init; } = "local";
}
