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
            await db.Database.EnsureCreatedAsync();
            logger.LogInformation("Database ready at {Path}", config.DatabasePath);
        }

        // ── 3. Download models ────────────────────────────────────────────────
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };

        // OCR models (Manga-OCR)
        await DownloadOcrModelsAsync(http, config, logger);

        // Translate models (Opus-MT)
        await DownloadTranslateModelsAsync(http, config, logger);

        // Dictionary (Jitendex)
        await DownloadDictionaryAsync(http, config, logger);

        // ── 4. Initialise services ────────────────────────────────────────────
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

    // ── Model download helpers ────────────────────────────────────────────────

    private static readonly string HfBase = "https://huggingface.co";

    private static async Task DownloadOcrModelsAsync(
        HttpClient http, AppConfig config, ILogger logger)
    {
        const string repo = "mayocream/manga-ocr-onnx";
        string[] files   = ["encoder_model.onnx", "decoder_model.onnx", "vocab.txt"];

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

        // Xenova ONNX files live under the onnx/ subfolder on HuggingFace
        string[] onnxFiles = ["encoder_model.onnx", "decoder_model.onnx"];
        foreach (var file in onnxFiles)
        {
            await ModelDownloader.EnsureAsync(
                http,
                url:      $"{HfBase}/{repo}/resolve/main/onnx/{file}",
                destPath: Path.Combine(config.TranslateModelsDir, file),
                label:    $"Translate/{file}");
        }

        // tokenizer.json is at the repo root
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
            var url = await ModelDownloader.GetGitHubReleaseAssetUrlAsync(
                http, "stephenmk", "Jitendex", "jitendex-yomitan.zip");

            await ModelDownloader.EnsureAsync(http, url, destPath, "jitendex-yomitan.zip");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not download Jitendex; dictionary will be unavailable.");
        }
    }
}
