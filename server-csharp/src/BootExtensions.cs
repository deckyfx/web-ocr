using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

/// <summary>
/// Runs all startup tasks (dir scaffolding, DB migrations, model downloads, service init)
/// as a hosted background service so the HTTP server starts immediately and /health
/// returns "starting" while work is in progress.
/// </summary>
public sealed class BootBackgroundService(
    AppConfig            config,
    BootState            bootState,
    OcrEngine            ocr,
    TranslateService     translate,
    DictionaryService    dict,
    IServiceScopeFactory scopeFactory,
    ILogger<BootBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            // ── 1. Scaffold directories ───────────────────────────────────────
            Directory.CreateDirectory(config.OcrModelsDir);
            Directory.CreateDirectory(config.TranslateModelsDir);
            Directory.CreateDirectory(Path.Combine(config.DictDir, "extracted"));
            var dbDir = Path.GetDirectoryName(config.DatabasePath);
            if (!string.IsNullOrEmpty(dbDir)) Directory.CreateDirectory(dbDir);

            // ── 2. Bootstrap database ─────────────────────────────────────────
            await using (var scope = scopeFactory.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await db.Database.MigrateAsync(ct);
                logger.LogInformation("Database ready at {Path}", config.DatabasePath);
            }

            // ── 3. Print download plan ────────────────────────────────────────
            PrintDownloadPlan(config);

            // ── 4. Download models ────────────────────────────────────────────
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            http.DefaultRequestHeaders.Add("User-Agent", "WebOcrServer/1.0");

            await DownloadOcrModelsAsync(http, config, logger, ct);
            await DownloadTranslateModelsAsync(http, config, logger, ct);
            await DownloadDictionaryAsync(http, config, logger, ct);

            // ── 5. Initialise services ────────────────────────────────────────
            logger.LogInformation("[Boot] Loading OCR models...");
            await ocr.InitializeAsync(
                Path.Combine(config.OcrModelsDir, "encoder_model.onnx"),
                Path.Combine(config.OcrModelsDir, "decoder_model.onnx"),
                Path.Combine(config.OcrModelsDir, "vocab.txt"));
            logger.LogInformation("[Boot] OCR engine ready.");

            logger.LogInformation("[Boot] Loading Translate models...");
            await translate.InitializeAsync(
                Path.Combine(config.TranslateModelsDir, "encoder_model.onnx"),
                Path.Combine(config.TranslateModelsDir, "decoder_model.onnx"),
                Path.Combine(config.TranslateModelsDir, "tokenizer.json"), ct);
            logger.LogInformation("[Boot] Translate service ready.");

            // Dictionary extraction — await completion so readiness reflects actual settlement
            logger.LogInformation("[Boot] Extracting dictionary...");
            try
            {
                await dict.InitializeAsync(ct);
                bootState.DictionaryReady = true;
                logger.LogInformation("[Boot] Dictionary ready.");
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "[Boot] Dictionary init failed — server will operate in degraded mode.");
            }

            // Signal readiness — /health returns "ok" or "degraded" from this point on
            bootState.IsReady = true;
            logger.LogInformation("[Boot] Server is ready.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            logger.LogWarning("[Boot] Startup cancelled.");
        }
        catch (Exception ex)
        {
            logger.LogCritical(ex, "[Boot] Startup failed — server cannot serve requests.");
            throw; // causes the host to stop
        }
    }

    // ── Download plan summary ─────────────────────────────────────────────────

    private static void PrintDownloadPlan(AppConfig cfg)
    {
        var ocrFiles       = new[] { "encoder_model.onnx", "decoder_model.onnx", "vocab.txt" };
        var translateFiles = new[] { "encoder_model.onnx", "decoder_model.onnx", "tokenizer.json" };
        var dictFile       = Path.Combine(cfg.DictDir, "jitendex-yomitan.zip");

        bool anyMissing = ocrFiles.Any(f => !File.Exists(Path.Combine(cfg.OcrModelsDir, f)))
                       || translateFiles.Any(f => !File.Exists(Path.Combine(cfg.TranslateModelsDir, f)))
                       || !File.Exists(dictFile);

        if (!anyMissing) return;

        Console.WriteLine();
        Console.WriteLine("[Boot] ─── Models to download ─────────────────────────────────────────────");
        Console.WriteLine($"[Boot]   Root: {Path.GetDirectoryName(cfg.OcrModelsDir)}");
        Console.WriteLine();

        foreach (var f in ocrFiles)
        {
            var path = Path.Combine(cfg.OcrModelsDir, f);
            Console.WriteLine($"[Boot]   {(File.Exists(path) ? "✓" : "↓")} OCR/{f,-30}  {path}");
        }
        foreach (var f in translateFiles)
        {
            var path = Path.Combine(cfg.TranslateModelsDir, f);
            Console.WriteLine($"[Boot]   {(File.Exists(path) ? "✓" : "↓")} Translate/{f,-26}  {path}");
        }
        Console.WriteLine($"[Boot]   {(File.Exists(dictFile) ? "✓" : "↓")} Dict/jitendex-yomitan.zip             {dictFile}");
        Console.WriteLine("[Boot] ─────────────────────────────────────────────────────────────────────");
        Console.WriteLine();
    }

    // ── Model download helpers ────────────────────────────────────────────────

    private const string HfBase = "https://huggingface.co";

    private static async Task DownloadOcrModelsAsync(
        HttpClient http, AppConfig cfg, ILogger logger, CancellationToken ct)
    {
        const string repo  = "mayocream/manga-ocr-onnx";
        string[]     files = ["encoder_model.onnx", "decoder_model.onnx", "vocab.txt"];
        foreach (var file in files)
            await ModelDownloader.EnsureAsync(
                http,
                url:      $"{HfBase}/{repo}/resolve/main/{file}",
                destPath: Path.Combine(cfg.OcrModelsDir, file),
                label:    $"OCR/{file}", ct: ct);
    }

    private static async Task DownloadTranslateModelsAsync(
        HttpClient http, AppConfig cfg, ILogger logger, CancellationToken ct)
    {
        const string repo = "Xenova/opus-mt-ja-en";
        foreach (var file in new[] { "encoder_model.onnx", "decoder_model.onnx" })
            await ModelDownloader.EnsureAsync(
                http,
                url:      $"{HfBase}/{repo}/resolve/main/onnx/{file}",
                destPath: Path.Combine(cfg.TranslateModelsDir, file),
                label:    $"Translate/{file}", ct: ct);

        await ModelDownloader.EnsureAsync(
            http,
            url:      $"{HfBase}/{repo}/resolve/main/tokenizer.json",
            destPath: Path.Combine(cfg.TranslateModelsDir, "tokenizer.json"),
            label:    "Translate/tokenizer.json", ct: ct);
    }

    private static async Task DownloadDictionaryAsync(
        HttpClient http, AppConfig cfg, ILogger logger, CancellationToken ct)
    {
        var destPath = Path.Combine(cfg.DictDir, "jitendex-yomitan.zip");
        if (File.Exists(destPath)) return;

        logger.LogInformation("[Boot] Resolving Jitendex release URL...");
        try
        {
            var url = await ModelDownloader.FindGitHubReleaseAssetAsync(
                http, "stephenmk", "Jitendex", "yomitan", ct);
            await ModelDownloader.EnsureAsync(http, url, destPath, "Dict/jitendex-yomitan.zip", ct: ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not download Jitendex; dictionary will be unavailable.");
        }
    }
}
