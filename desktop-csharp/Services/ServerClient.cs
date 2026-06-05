using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using WebOcrDesktop.Models;

namespace WebOcrDesktop.Services;

/// <summary>Typed HTTP client for the Web-OCR server API.</summary>
public sealed class ServerClient : IDisposable
{
    private readonly HttpClient _http;

    public ServerClient(AppSettings settings)
    {
        _http = new HttpClient { BaseAddress = new Uri(settings.ServerUrl), Timeout = TimeSpan.FromSeconds(120) };
        if (!string.IsNullOrWhiteSpace(settings.ApiKey))
            _http.DefaultRequestHeaders.Add("X-Api-Key", settings.ApiKey);
    }

    public async Task<HealthResponse?> HealthAsync()
    {
        try { return await _http.GetFromJsonAsync<HealthResponse>("/health"); }
        catch { return null; }
    }

    public async Task<OcrResponse> OcrAsync(string base64Image, string translateEngine = "none")
    {
        var req = new OcrRequest { Image = base64Image, TranslateEngine = translateEngine };
        var resp = await _http.PostAsJsonAsync("/ocr", req);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<OcrResponse>()
            ?? throw new InvalidOperationException("Empty OCR response");
    }

    public async Task<AnalyzeResponse> AnalyzeAsync(string text, bool sanitize = true, string mode = "local")
    {
        var req = new AnalyzeRequest { Text = text, Sanitize = sanitize, Mode = mode };
        var resp = await _http.PostAsJsonAsync("/analyze", req);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<AnalyzeResponse>()
            ?? throw new InvalidOperationException("Empty analyze response");
    }

    public void Reinitialize(AppSettings settings)
    {
        _http.BaseAddress = new Uri(settings.ServerUrl);
        _http.DefaultRequestHeaders.Remove("X-Api-Key");
        if (!string.IsNullOrWhiteSpace(settings.ApiKey))
            _http.DefaultRequestHeaders.Add("X-Api-Key", settings.ApiKey);
    }

    public void Dispose() => _http.Dispose();
}
