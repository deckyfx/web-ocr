using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class BootExtensions
{
    public static async Task RunBootTasksAsync(this WebApplication app)
    {
        var config  = app.Services.GetRequiredService<AppConfig>();
        var logger  = app.Services.GetRequiredService<ILogger<WebApplication>>();

        // ── 1. Scaffold directories ───────────────────────────────────────────
        Directory.CreateDirectory(config.OcrModelsDir);
        Directory.CreateDirectory(config.TranslateModelsDir);
        Directory.CreateDirectory(Path.Combine(config.DictDir, "extracted"));
        var dbDir = Path.GetDirectoryName(config.DatabasePath);
        if (!string.IsNullOrEmpty(dbDir)) Directory.CreateDirectory(dbDir);

        // ── 2. Bootstrap database ─────────────────────────────────────────────
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await db.Database.MigrateAsync();
            logger.LogInformation("Database ready at {Path}", config.DatabasePath);
        }

        // ── 3. Print download plan ────────────────────────────────────────────
        PrintDownloadPlan(config);

        // ── 4. Download models ────────────────────────────────────────────────
        using var http = new HttpClient
        {
            Timeout = TimeSpan.FromMinutes(30),
        };
        http.DefaultRequestHeaders.Add("User-Agent", "WebOcrServer/1.0");

        await DownloadOcrModelsAsync(http, config, logger);
        await DownloadTranslateModelsAsync(http, config, logger);
        await DownloadDictionaryAsync(http, config, logger);

        // ── 5. Initialise services ────────────────────────────────────────────
        logger.LogInformation("[Boot] Loading OCR models...");
        var ocr = app.Services.GetRequiredService<OcrEngine>();
        await ocr.InitializeAsync(
            Path.Combine(config.OcrModelsDir, "encoder_model.onnx"),
            Path.Combine(config.OcrModelsDir, "decoder_model.onnx"),
            Path.Combine(config.OcrModelsDir, "vocab.txt"));
        logger.LogInformation("[Boot] OCR engine ready.");

        logger.LogInformation("[Boot] Loading Translate models...");
        var translate = app.Services.GetRequiredService<TranslateService>();
        await translate.InitializeAsync(
            Path.Combine(config.TranslateModelsDir, "encoder_model.onnx"),
            Path.Combine(config.TranslateModelsDir, "decoder_model.onnx"),
            Path.Combine(config.TranslateModelsDir, "tokenizer.json"));
        logger.LogInformation("[Boot] Translate service ready.");

        // Dictionary extraction runs in background to avoid blocking startup
        logger.LogInformation("[Boot] Extracting dictionary (background)...");
        var dict = app.Services.GetRequiredService<DictionaryService>();
        _ = dict.InitializeAsync()
                .ContinueWith(t => logger.LogError(t.Exception, "Dictionary init failed"),
                              TaskContinuationOptions.OnlyOnFaulted);

        logger.LogInformation("[Boot] Server is ready.");
    }

    // ── Download plan summary ─────────────────────────────────────────────────

    private static void PrintDownloadPlan(AppConfig config)
    {
        var ocrFiles       = new[] { "encoder_model.onnx", "decoder_model.onnx", "vocab.txt" };
        var translateFiles = new[] { "encoder_model.onnx", "decoder_model.onnx", "tokenizer.json" };
        var dictFile       = Path.Combine(config.DictDir, "jitendex-yomitan.zip");

        bool anyMissing = ocrFiles.Any(f => !File.Exists(Path.Combine(config.OcrModelsDir, f)))
                       || translateFiles.Any(f => !File.Exists(Path.Combine(config.TranslateModelsDir, f)))
                       || !File.Exists(dictFile);

        if (!anyMissing) return;

        Console.WriteLine();
        Console.WriteLine("[Boot] ─── Models to download ─────────────────────────────────────────────");
        Console.WriteLine($"[Boot]   Root: {Path.GetDirectoryName(config.OcrModelsDir)}");
        Console.WriteLine();

        foreach (var f in ocrFiles)
        {
            var path = Path.Combine(config.OcrModelsDir, f);
            var mark = File.Exists(path) ? "✓" : "↓";
            Console.WriteLine($"[Boot]   {mark} OCR/{f,-30}  {path}");
        }
        foreach (var f in translateFiles)
        {
            var path = Path.Combine(config.TranslateModelsDir, f);
            var mark = File.Exists(path) ? "✓" : "↓";
            Console.WriteLine($"[Boot]   {mark} Translate/{f,-26}  {path}");
        }
        {
            var mark = File.Exists(dictFile) ? "✓" : "↓";
            Console.WriteLine($"[Boot]   {mark} Dict/jitendex-yomitan.zip             {dictFile}");
        }
        Console.WriteLine("[Boot] ─────────────────────────────────────────────────────────────────────");
        Console.WriteLine();
    }

    // ── Model download helpers ────────────────────────────────────────────────

    private const string HfBase = "https://huggingface.co";

    private static async Task DownloadOcrModelsAsync(
        HttpClient http, AppConfig config, ILogger logger)
    {
        const string repo  = "mayocream/manga-ocr-onnx";
        string[]     files = ["encoder_model.onnx", "decoder_model.onnx", "vocab.txt"];

        foreach (var file in files)
        {
            await ModelDownloader.EnsureAsync(
                http,
                url:      $"{HfBase}/{repo}/resolve/main/{file}",
                destPath: Path.Combine(config.OcrModelsDir, file),
                label:    $"OCR/{file}");
        }
    }

    private static async Task DownloadTranslateModelsAsync(
        HttpClient http, AppConfig config, ILogger logger)
    {
        const string repo = "Xenova/opus-mt-ja-en";

        // ONNX files are under the onnx/ subfolder; spm and tokenizer are at root
        string[] onnxFiles = ["encoder_model.onnx", "decoder_model.onnx"];
        foreach (var file in onnxFiles)
        {
            await ModelDownloader.EnsureAsync(
                http,
                url:      $"{HfBase}/{repo}/resolve/main/onnx/{file}",
                destPath: Path.Combine(config.TranslateModelsDir, file),
                label:    $"Translate/{file}");
        }

        await ModelDownloader.EnsureAsync(
            http,
            url:      $"{HfBase}/{repo}/resolve/main/tokenizer.json",
            destPath: Path.Combine(config.TranslateModelsDir, "tokenizer.json"),
            label:    "Translate/tokenizer.json");
    }

    private static async Task DownloadDictionaryAsync(
        HttpClient http, AppConfig config, ILogger logger)
    {
        var destPath = Path.Combine(config.DictDir, "jitendex-yomitan.zip");
        if (File.Exists(destPath)) return;

        logger.LogInformation("[Boot] Resolving Jitendex release URL...");
        try
        {
            var url = await ModelDownloader.FindGitHubReleaseAssetAsync(
                http, "stephenmk", "Jitendex", "yomitan");

            await ModelDownloader.EnsureAsync(http, url, destPath, "Dict/jitendex-yomitan.zip");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not download Jitendex; dictionary will be unavailable.");
        }
    }
}
