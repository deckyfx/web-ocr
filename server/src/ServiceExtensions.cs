using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

/// <summary>Tracks per-model readiness and overall boot completion.</summary>
public sealed class BootState
{
    // volatile ensures cross-thread visibility: BootBackgroundService writes,
    // request-handler threads read, with no JIT register-caching in between.
    private volatile bool _ocrReady;
    private volatile bool _translateReady;
    private volatile bool _dictionaryReady;
    private volatile bool _inpaintReady;
    private volatile bool _bubbleReady;
    private volatile bool _inpaintEnabled;
    private volatile bool _bubbleEnabled;
    private volatile bool _isReady;

    public bool OcrReady        { get => _ocrReady;        set => _ocrReady = value; }
    public bool TranslateReady  { get => _translateReady;  set => _translateReady = value; }
    public bool DictionaryReady { get => _dictionaryReady; set => _dictionaryReady = value; }

    // Optional models — only relevant when enabled in ModelSettingsStore
    public bool InpaintReady    { get => _inpaintReady;    set => _inpaintReady = value; }
    public bool BubbleReady     { get => _bubbleReady;     set => _bubbleReady = value; }

    /// <summary>Mirrors the enabled flag from settings so /health can distinguish "disabled" from "not yet ready".</summary>
    public bool InpaintEnabled  { get => _inpaintEnabled;  set => _inpaintEnabled = value; }
    public bool BubbleEnabled   { get => _bubbleEnabled;   set => _bubbleEnabled = value; }

    /// <summary>True once OCR and Translate are both initialized. /health returns "ok" or "degraded" from here.</summary>
    public bool IsReady         { get => _isReady;         set => _isReady = value; }
}

public static class ServiceExtensions
{
    public static void AddWebOcrServices(this WebApplicationBuilder builder)
    {
        var config = AppConfig.FromEnvironment();
        builder.Services.AddSingleton(config);

        // Model settings store: env vars → persisted JSON → defaults (runtime-configurable via /api/settings)
        builder.Services.AddSingleton<ModelSettingsStore>(sp =>
            ModelSettingsStore.Create(config, sp.GetRequiredService<ILogger<ModelSettingsStore>>()));

        // JSON: serialize/deserialize with snake_case (elapsed_ms, is_common, etc.)
        builder.Services.ConfigureHttpJsonOptions(opts =>
            opts.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower);

        // CORS — the browser extension calls from any origin
        builder.Services.AddCors(o =>
        {
            o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());

            // Portal UI is served by this server; restrict cross-origin access to localhost only
            o.AddPolicy("portal", p => p
                .WithOrigins(
                    "http://localhost",
                    "http://127.0.0.1",
                    $"http://localhost:{config.Port}",
                    $"http://127.0.0.1:{config.Port}")
                .AllowAnyMethod()
                .AllowAnyHeader());
        });

        // Authorization — portal policy explicitly allows unauthenticated (local-first server)
        builder.Services.AddAuthorization(opts =>
            opts.AddPolicy("portal", p => p.RequireAssertion(_ => true)));

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
        builder.Services.AddSingleton<PageTranslationQueue>();
        builder.Services.AddHostedService<PageTranslationWorker>();

        // Boot background service: scaffolds dirs, runs migrations, downloads models, inits services
        builder.Services.AddHostedService<BootBackgroundService>();

        // EF Core scoped DbContext (SQLite)
        builder.Services.AddDbContext<AppDbContext>(o =>
            o.UseSqlite($"Data Source={config.DatabasePath}"));

        // Readiness tracking — set to true at end of RunBootTasksAsync
        builder.Services.AddSingleton<BootState>();

        // Page translation pipeline
        builder.Services.AddSingleton<TranslationJobStore>();
        builder.Services.AddSingleton<BubbleDetectionService>();
        builder.Services.AddSingleton<TypesettingService>();
        builder.Services.AddSingleton<PageTranslationService>();

        // Blazor with Interactive Server mode (required for IJSRuntime / JS Interop)
        builder.Services.AddRazorComponents()
                        .AddInteractiveServerComponents();

        // OpenAPI spec served at /openapi/v1.json; Scalar UI at /scalar/v1
        builder.Services.AddOpenApi();
    }

    public static WebApplication MapWebOcrRoutes(this WebApplication app)
    {
        app.MapHealthRoutes();
        app.MapOcrRoutes();
        app.MapTranslateRoutes();
        app.MapAnalyzeRoutes();
        app.MapSettingsRoutes();
        app.MapTranslatePageRoutes();
        app.MapPortalRoutes();
        return app;
    }
}
