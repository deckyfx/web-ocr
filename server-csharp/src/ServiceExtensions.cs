using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class ServiceExtensions
{
    public static void AddWebOcrServices(this WebApplicationBuilder builder)
    {
        var config = AppConfig.FromEnvironment();
        builder.Services.AddSingleton(config);

        // JSON: serialize/deserialize with snake_case (elapsed_ms, is_common, etc.)
        builder.Services.ConfigureHttpJsonOptions(opts =>
            opts.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower);

        // CORS — the browser extension calls from any origin
        builder.Services.AddCors(o =>
            o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

        // ONNX / inference services
        builder.Services.AddSingleton<OcrEngine>();
        builder.Services.AddSingleton<TranslateService>(sp => new TranslateService(
            sp.GetRequiredService<AppConfig>(),
            new HttpClient(),
            sp.GetRequiredService<ILogger<TranslateService>>()));

        // NMeCab analyzer — fast, no queue needed
        builder.Services.AddSingleton<AnalyzeService>();

        // Jitendex dictionary + Jisho fallback
        builder.Services.AddSingleton<DictionaryService>(sp => new DictionaryService(
            sp.GetRequiredService<AppConfig>(),
            new HttpClient(),
            sp.GetRequiredService<ILogger<DictionaryService>>()));

        // Background inference queue (serialises ONNX sessions)
        builder.Services.AddSingleton<InferenceQueue>();
        builder.Services.AddHostedService<InferenceWorker>();

        // EF Core scoped DbContext (SQLite)
        builder.Services.AddDbContext<AppDbContext>(o =>
            o.UseSqlite($"Data Source={config.DatabasePath}"));

        // Blazor with Interactive Server mode (required for IJSRuntime / JS Interop)
        builder.Services.AddRazorComponents()
                        .AddInteractiveServerComponents();
    }

    public static WebApplication MapWebOcrRoutes(this WebApplication app)
    {
        app.MapHealthRoutes();
        app.MapOcrRoutes();
        app.MapTranslateRoutes();
        app.MapAnalyzeRoutes();
        return app;
    }
}
