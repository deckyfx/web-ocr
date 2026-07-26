using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

/// <summary>
/// Runs all startup tasks (dir scaffolding, DB migrations, model downloads, service init)
/// as a hosted background service so the HTTP server starts immediately and /health
/// returns "starting" while work is in progress.
/// </summary>
public sealed class BootBackgroundService(
    AppConfig               config,
    BootState               bootState,
    ModelSettingsStore      modelSettings,
    OcrEngine               ocr,
    TranslateService        translate,
    DictionaryService       dict,
    BubbleDetectionService  bubble,
    IServiceScopeFactory    scopeFactory,
    ILogger<BootBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            var ms = modelSettings.Current;

            // ── 1. Mirror enabled flags into BootState ────────────────────────
            bootState.InpaintEnabled = ms.Inpaint.Enabled;
            bootState.BubbleEnabled  = ms.Bubble.Enabled;

            // ── 2. Scaffold directories ───────────────────────────────────────
            Directory.CreateDirectory(ms.Ocr.Dir);
            Directory.CreateDirectory(ms.Translate.Dir);
            if (ms.Inpaint.Enabled) Directory.CreateDirectory(ms.Inpaint.Dir);
            if (ms.Bubble.Enabled)  Directory.CreateDirectory(ms.Bubble.Dir);
            var dbDir = Path.GetDirectoryName(config.DatabasePath);
            if (!string.IsNullOrEmpty(dbDir)) Directory.CreateDirectory(dbDir);

            // ── 3. Bootstrap database ─────────────────────────────────────────
            await using (var scope = scopeFactory.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await db.Database.MigrateAsync(ct);
                logger.LogInformation("Database ready at {Path}", config.DatabasePath);
            }

            // ── 4. Print download plan ────────────────────────────────────────
            PrintDownloadPlan(ms, config);

            // ── 5. Download models ────────────────────────────────────────────
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            http.DefaultRequestHeaders.Add("User-Agent", "WebOcrServer/1.0");

            await DownloadHfModelAsync(http, ms.Ocr,       "OCR",       logger, ct);
            await DownloadHfModelAsync(http, ms.Translate,  "Translate", logger, ct);
            await DownloadHfModelAsync(http, ms.Inpaint,    "Inpaint",   logger, ct);
            await DownloadHfModelAsync(http, ms.Bubble,     "Bubble",    logger, ct);
            await DownloadDictionaryAsync(http, config, logger, ct);

            // ── 6. Initialise core services ───────────────────────────────────
            if (ms.Ocr.Enabled)
            {
                logger.LogInformation("[Boot] Loading OCR models...");
                var ocr0 = ms.Ocr.FileList;
                await ocr.InitializeAsync(
                    Path.Combine(ms.Ocr.Dir, Path.GetFileName(ocr0[0])),
                    Path.Combine(ms.Ocr.Dir, Path.GetFileName(ocr0[1])),
                    Path.Combine(ms.Ocr.Dir, Path.GetFileName(ocr0[2])));
                bootState.OcrReady = true;
                logger.LogInformation("[Boot] OCR engine ready.");
            }

            if (ms.Translate.Enabled)
            {
                logger.LogInformation("[Boot] Loading Translate models...");
                var tr0 = ms.Translate.FileList;
                await translate.InitializeAsync(
                    Path.Combine(ms.Translate.Dir, Path.GetFileName(tr0[0])),
                    Path.Combine(ms.Translate.Dir, Path.GetFileName(tr0[1])),
                    Path.Combine(ms.Translate.Dir, Path.GetFileName(tr0[2])), ct);
                bootState.TranslateReady = true;
                logger.LogInformation("[Boot] Translate service ready.");
            }

            // ── 7. Initialise optional services ───────────────────────────────

            if (ms.Inpaint.ShouldDownload)
            {
                logger.LogInformation("[Boot] Inpaint model downloaded; service init pending (not yet wired).");
                // TODO: initialise InpaintService when implemented
                bootState.InpaintReady = true;
            }

            if (ms.Bubble.ShouldDownload)
            {
                try
                {
                    logger.LogInformation("[Boot] Loading Bubble-detection model...");
                    var modelFile = Path.GetFileName(ms.Bubble.FileList[0]);
                    var modelPath = Path.Combine(ms.Bubble.Dir, modelFile);
                    bubble.LoadModel(modelPath);
                    bootState.BubbleReady = true;
                    logger.LogInformation("[Boot] Bubble-detection service ready.");
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex,
                        "[Boot] Bubble-detection model failed to load — page translation will use whole-image fallback.");
                }
            }

            // ── 8. Dictionary (non-fatal) ─────────────────────────────────────
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
            throw;
        }
    }

    // ── Download helpers ──────────────────────────────────────────────────────

    private const string HfBase = "https://huggingface.co";

    /// <summary>
    /// Download all files listed in <paramref name="entry"/> from HuggingFace.
    /// Files with a subdirectory prefix in the URL (e.g. "onnx/encoder_model.onnx") are stored
    /// flat inside <see cref="ModelEntry.Dir"/> using only the filename.
    /// Skips entirely when <see cref="ModelEntry.ShouldDownload"/> is false.
    /// </summary>
    private static async Task DownloadHfModelAsync(
        HttpClient http, ModelEntry entry, string label, ILogger logger, CancellationToken ct)
    {
        if (!entry.ShouldDownload) return;

        Directory.CreateDirectory(entry.Dir);
        foreach (var filePath in entry.FileList)
        {
            var fileName = Path.GetFileName(filePath);
            var url      = $"{HfBase}/{entry.Repo}/resolve/main/{filePath}";
            var dest     = Path.Combine(entry.Dir, fileName);
            await ModelDownloader.EnsureAsync(http, url, dest, $"{label}/{fileName}", ct: ct);
        }
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
            Directory.CreateDirectory(cfg.DictDir);
            await ModelDownloader.EnsureAsync(http, url, destPath, "Dict/jitendex-yomitan.zip", ct: ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not download Jitendex; dictionary will be unavailable.");
        }
    }

    // ── Download plan summary ─────────────────────────────────────────────────

    private static void PrintDownloadPlan(AllModelSettings ms, AppConfig cfg)
    {
        var entries = new (ModelEntry Entry, string Label)[]
        {
            (ms.Ocr,       "OCR"),
            (ms.Translate, "Translate"),
            (ms.Inpaint,   "Inpaint"),
            (ms.Bubble,    "Bubble"),
        };

        var dictFile    = Path.Combine(cfg.DictDir, "jitendex-yomitan.zip");
        bool dictMissing = !File.Exists(dictFile);
        bool anyMissing  = dictMissing || entries.Any(e =>
            e.Entry.ShouldDownload &&
            e.Entry.FileList.Any(f => !File.Exists(Path.Combine(e.Entry.Dir, Path.GetFileName(f)))));

        if (!anyMissing) return;

        Console.WriteLine();
        Console.WriteLine("[Boot] ─── Models to download ─────────────────────────────────────────────");

        foreach (var (entry, label) in entries)
        {
            if (!entry.ShouldDownload) continue;
            foreach (var f in entry.FileList)
            {
                var dest = Path.Combine(entry.Dir, Path.GetFileName(f));
                Console.WriteLine($"[Boot]   {(File.Exists(dest) ? "✓" : "↓")} {label}/{Path.GetFileName(f),-30}  {dest}");
            }
        }

        if (dictMissing)
            Console.WriteLine($"[Boot]   ↓ Dict/jitendex-yomitan.zip             {dictFile}");

        Console.WriteLine("[Boot] ─────────────────────────────────────────────────────────────────────");
        Console.WriteLine();
    }
}
