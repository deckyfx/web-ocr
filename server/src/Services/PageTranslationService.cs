using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using SkiaSharp;
using WebOcrServer.Data;

namespace WebOcrServer;

/// <summary>Pipeline stage name + fractional progress (0–1) for the poll endpoint.</summary>
public record PageTranslationProgress(string Stage, double Progress);

/// <summary>
/// Orchestrates the full manga-page translation pipeline:
/// <list type="number">
///   <item>Bubble detection (RT-DETR ONNX or whole-image fallback)</item>
///   <item>OCR (manga-ocr ONNX, via InferenceQueue)</item>
///   <item>Translation (Opus-MT ONNX, via InferenceQueue)</item>
///   <item>White-fill inpainting (LaMa placeholder)</item>
///   <item>Typesetting (SkiaSharp)</item>
/// </list>
/// All ONNX work is routed through <see cref="InferenceQueue"/> to keep CPU sessions serialised.
/// Per-bubble results are persisted to <see cref="PageTranslationLog"/> for analysis.
/// Full job images (original + result) are stored under <see cref="AppConfig.JobsDir"/>.
/// </summary>
public sealed class PageTranslationService(
    BubbleDetectionService          bubbleDetector,
    TypesettingService              typesetter,
    InferenceQueue                  queue,
    AppConfig                       config,
    ModelSettingsStore              modelSettings,
    IServiceScopeFactory            scopeFactory,
    ILogger<PageTranslationService> logger)
{
    /// <summary>
    /// Run the full pipeline and return the typeset PNG image bytes.
    /// Saves original + result images to disk and maintains a <see cref="PageTranslationJob"/> DB row.
    /// </summary>
    /// <param name="jobId">Job ID used to group DB rows and files.</param>
    /// <param name="imagePng">Raw bytes of the input PNG.</param>
    /// <param name="progress">Receives coarse-grained stage/progress updates for the poll endpoint.</param>
    /// <param name="log">Receives fine-grained <see cref="JobLogEntry"/> entries for SSE streaming. Optional.</param>
    /// <param name="ct">Cancellation token.</param>
    public async Task<byte[]> TranslatePageAsync(
        string                             jobId,
        byte[]                             imagePng,
        IProgress<PageTranslationProgress> progress,
        Action<JobLogEntry>?               log = null,
        CancellationToken                  ct  = default)
    {
        // ── 0. Persist original image + create job row ────────────────────────
        var jobDir = Path.Combine(config.JobsDir, jobId);
        Directory.CreateDirectory(jobDir);
        var originalPath = Path.Combine(jobDir, "original.png");
        await File.WriteAllBytesAsync(originalPath, imagePng, ct);

        int imgWidth = 0, imgHeight = 0;
        using (var bmpInfo = SKBitmap.Decode(imagePng))
        {
            if (bmpInfo is not null) { imgWidth = bmpInfo.Width; imgHeight = bmpInfo.Height; }
        }

        var relOriginal = Path.Combine("jobs", jobId, "original.png");
        await CreateJobRowAsync(jobId, relOriginal, imgWidth, imgHeight);

        // ── 1. Detect bubbles ─────────────────────────────────────────────────
        log?.Invoke(new("log", "Detecting speech bubbles...", "detecting", 0.05));
        progress.Report(new("detecting", 0.05));

        var bubbles = await Task.Run(() => bubbleDetector.Detect(imagePng), ct);
        logger.LogInformation("Detected {Count} bubbles", bubbles.Count);

        if (bubbles.Count == 0)
        {
            // No model loaded or nothing detected — treat whole image as one region.
            // Reuse imgWidth/imgHeight decoded above to avoid a second SKBitmap.Decode.
            log?.Invoke(new("log", "No bubbles detected — processing full image as one region", "detecting", 0.12));
            if (imgWidth > 0 && imgHeight > 0)
                bubbles = [new BubbleBox(0, 0, imgWidth, imgHeight, 1f)];
        }
        else
        {
            log?.Invoke(new("log", $"Found {bubbles.Count} bubble{(bubbles.Count == 1 ? "" : "s")} ✓",
                "detecting", 0.12, Count: bubbles.Count));
        }

        progress.Report(new("detecting", 0.12));

        // ── 2. OCR + translate each bubble ────────────────────────────────────
        var translations = new List<BubbleTranslation>();

        for (int i = 0; i < bubbles.Count; i++)
        {
            ct.ThrowIfCancellationRequested();

            double ocrFrac = (double)(i + 1) / bubbles.Count;

            // ── OCR ───────────────────────────────────────────────────────────
            log?.Invoke(new("log", $"Reading text: bubble {i + 1} / {bubbles.Count}...",
                "ocr", 0.15 + 0.30 * (double)i / bubbles.Count));
            progress.Report(new("ocr", 0.15 + 0.30 * (double)i / bubbles.Count));

            var cropped = CropBubble(imagePng, bubbles[i], padding: 0.05f);

            var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new OcrJob(cropped, "none", ocrTcs), ct);

            OcrResponse ocrResult;
            try   { ocrResult = (OcrResponse)await ocrTcs.Task; }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "OCR failed for bubble {I} — skipping", i);
                continue;
            }

            var sourceText = ocrResult.Text?.Trim() ?? "";
            if (string.IsNullOrEmpty(sourceText))
            {
                log?.Invoke(new("log", $"Bubble {i + 1}: no text found", "ocr", 0.15 + 0.30 * ocrFrac));
                continue;
            }

            // ── Translate ─────────────────────────────────────────────────────
            log?.Invoke(new("log", $"Translating bubble {i + 1}...",
                "translating", 0.45 + 0.20 * (double)i / bubbles.Count));
            progress.Report(new("translating", 0.45 + 0.20 * (double)i / bubbles.Count));

            var translateTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new TranslateJob(sourceText, modelSettings.Current.PreferredTranslationEngine, translateTcs), ct);

            string translated;
            try
            {
                var translateResult = (TranslateResponse)await translateTcs.Task;
                translated = translateResult.Translation;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Translation failed for bubble {I} — using source text", i);
                translated = sourceText; // graceful fallback: show original text
            }

            if (!string.IsNullOrEmpty(translated))
                translations.Add(new BubbleTranslation(bubbles[i], sourceText, translated));

            // Log each bubble result immediately so partial results survive cancellation
            await LogBubbleAsync(jobId, i, bubbles[i], sourceText, translated);
        }

        // ── 3. Inpainting placeholder ─────────────────────────────────────────
        // White-fill is applied inside TypesettingService.RenderTranslations per bubble.
        // A real LaMa inpaint model would go here once available.
        log?.Invoke(new("log", "Removing original text (white-fill)...", "inpainting", 0.72));
        progress.Report(new("inpainting", 0.72));

        // ── 4. Typeset ────────────────────────────────────────────────────────
        log?.Invoke(new("log", "Rendering translated text...", "typesetting", 0.88));
        progress.Report(new("typesetting", 0.88));

        var resultPng = await Task.Run(
            () => typesetter.RenderTranslations(imagePng, translations), ct);

        // ── 5. Persist result image + update job row ──────────────────────────
        var resultPath = Path.Combine(jobDir, "result.png");
        await File.WriteAllBytesAsync(resultPath, resultPng, ct);
        var relResult = Path.Combine("jobs", jobId, "result.png");
        await FinalizeJobRowAsync(jobId, relResult, translations.Count);

        log?.Invoke(new("log", "Done ✓", "done", 1.0));
        progress.Report(new("done", 1.0));

        return resultPng;
    }

    /// <summary>
    /// Marks the persisted <see cref="PageTranslationJob"/> row as failed.
    /// Called by the route handler when <see cref="TranslatePageAsync"/> throws.
    /// </summary>
    public async Task MarkJobFailedAsync(string jobId, string errorMessage)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null)
            {
                job.Status       = "error";
                job.ErrorMessage = errorMessage;
                job.CompletedAt  = DateTime.UtcNow;
                await db.SaveChangesAsync();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to mark job {JobId} as failed in DB", jobId);
        }
    }

    /// <summary>Re-runs bubble detection on the stored original image and replaces model-detected bubbles in the DB.</summary>
    public async Task RedetectAsync(string jobId, CancellationToken ct = default)
    {
        var originalPath = Path.Combine(config.JobsDir, jobId, "original.png");
        if (!File.Exists(originalPath)) throw new FileNotFoundException("Original image not found for job", originalPath);

        var imagePng = await File.ReadAllBytesAsync(originalPath, ct);
        var bubbles  = await Task.Run(() => bubbleDetector.Detect(imagePng), ct);

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Remove all non-manual bubbles, keep user-added ones
        await db.PageTranslationLogs
            .Where(l => l.JobId == jobId && !l.IsManuallyAdded)
            .ExecuteDeleteAsync(ct);

        for (int i = 0; i < bubbles.Count; i++)
        {
            db.PageTranslationLogs.Add(new PageTranslationLog
            {
                JobId      = jobId,
                BubbleIndex = i,
                BubbleX    = bubbles[i].X,
                BubbleY    = bubbles[i].Y,
                BubbleW    = bubbles[i].Width,
                BubbleH    = bubbles[i].Height,
                Confidence = bubbles[i].Confidence,
            });
        }

        var job = await db.PageTranslationJobs.FindAsync(jobId);
        if (job is not null) job.BubbleCount = bubbles.Count;

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Re-runs typesetting on the current DB bubble data and overwrites the stored result image.</summary>
    public async Task RerenderAsync(string jobId, int padding = 0, CancellationToken ct = default)
    {
        var originalPath = Path.Combine(config.JobsDir, jobId, "original.png");
        if (!File.Exists(originalPath)) throw new FileNotFoundException("Original image not found for job", originalPath);

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubbleLogs = db.PageTranslationLogs
            .Where(l => l.JobId == jobId && !l.IsExcluded && !string.IsNullOrEmpty(l.TranslatedText))
            .OrderBy(l => l.BubbleIndex)
            .ToList();

        var translations = bubbleLogs.Select(l => new BubbleTranslation(
            new BubbleBox(l.BubbleX, l.BubbleY, l.BubbleW, l.BubbleH, l.Confidence),
            l.SourceText, l.TranslatedText, l.FontFamily, l.FontSizeOverride)).ToList();

        var imgLock = GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            var imagePng  = await File.ReadAllBytesAsync(originalPath, ct);
            var resultPng = await Task.Run(() => typesetter.RenderTranslations(imagePng, translations, padding), ct);
            var resultPath = Path.Combine(config.JobsDir, jobId, "result.png");
            await File.WriteAllBytesAsync(resultPath, resultPng, ct);

            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null)
            {
                job.ResultImagePath = Path.Combine("jobs", jobId, "result.png");
                await db.SaveChangesAsync(ct);
            }
        }
        finally { imgLock.Release(); }
    }

    // ── Public helpers used by PortalRoutes ───────────────────────────────────

    /// <summary>Absolute path to the per-job directory containing original.png and result.png.</summary>
    public string GetJobDir(string jobId) => Path.Combine(config.JobsDir, jobId);

    /// <summary>Creates a new DI scope — used by retranslate route to get scoped DbContext.</summary>
    public IServiceScope CreateScope() => scopeFactory.CreateScope();

    /// <summary>Crop helper exposed for use in retranslate route.</summary>
    public static byte[] CropBubblePublic(byte[] imagePng, BubbleBox box, float padding) =>
        CropBubble(imagePng, box, padding);

    // ── Per-bubble actions ────────────────────────────────────────────────────

    /// <summary>Re-runs OCR on a single bubble, updates <see cref="Data.PageTranslationLog.SourceText"/>.</summary>
    public async Task<Data.PageTranslationLog> ReocrBubbleAsync(string jobId, int bubbleIndex, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        var imagePng = await File.ReadAllBytesAsync(Path.Combine(config.JobsDir, jobId, "original.png"), ct);
        var cropped  = CropBubble(imagePng,
            new BubbleBox(bubble.BubbleX, bubble.BubbleY, bubble.BubbleW, bubble.BubbleH, bubble.Confidence), 0.05f);

        var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        await queue.Writer.WriteAsync(new OcrJob(cropped, "none", ocrTcs), ct);
        var ocrResult = (OcrResponse)await ocrTcs.Task;

        bubble.SourceText   = ocrResult.Text?.Trim() ?? "";
        bubble.LastEditedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return bubble;
    }

    /// <summary>Translates the stored source text for a single bubble, updates <see cref="Data.PageTranslationLog.TranslatedText"/>.</summary>
    public async Task<Data.PageTranslationLog> RetranslateBubbleAsync(string jobId, int bubbleIndex, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        if (!string.IsNullOrEmpty(bubble.SourceText))
        {
            var trTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(
                new TranslateJob(bubble.SourceText, modelSettings.Current.PreferredTranslationEngine, trTcs), ct);
            var trResult = (TranslateResponse)await trTcs.Task;

            bubble.TranslatedText = trResult.Translation;
            bubble.LastEditedAt   = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        return bubble;
    }

    /// <summary>
    /// White-fills a single bubble in the stored result image (per-bubble re-inpaint).
    /// If no result image exists yet, copies the original first.
    /// </summary>
    public async Task ReinpaintBubbleAsync(string jobId, int bubbleIndex, int padding = 0, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        var jobDir       = Path.Combine(config.JobsDir, jobId);
        var resultPath   = Path.Combine(jobDir, "result.png");
        var originalPath = Path.Combine(jobDir, "original.png");

        var box = padding > 0
            ? new BubbleBox(bubble.BubbleX + padding, bubble.BubbleY + padding,
                Math.Max(1, bubble.BubbleW - 2 * padding), Math.Max(1, bubble.BubbleH - 2 * padding), bubble.Confidence)
            : new BubbleBox(bubble.BubbleX, bubble.BubbleY, bubble.BubbleW, bubble.BubbleH, bubble.Confidence);

        var imgLock = GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            if (!File.Exists(resultPath)) File.Copy(originalPath, resultPath);
            var imagePng  = await File.ReadAllBytesAsync(resultPath, ct);
            var resultPng = await Task.Run(() => typesetter.WhiteFillBubble(imagePng, box), ct);
            await File.WriteAllBytesAsync(resultPath, resultPng, ct);

            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null && string.IsNullOrEmpty(job.ResultImagePath))
            {
                job.ResultImagePath = Path.Combine("jobs", jobId, "result.png");
                await db.SaveChangesAsync(ct);
            }
        }
        finally { imgLock.Release(); }
    }

    /// <summary>
    /// Re-renders (white-fill + typeset) a single bubble onto the stored result image.
    /// If no result image exists yet, copies the original first.
    /// </summary>
    public async Task RepatchBubbleAsync(string jobId, int bubbleIndex, int padding = 0, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        var jobDir       = Path.Combine(config.JobsDir, jobId);
        var resultPath   = Path.Combine(jobDir, "result.png");
        var originalPath = Path.Combine(jobDir, "original.png");

        var t = new BubbleTranslation(
            new BubbleBox(bubble.BubbleX, bubble.BubbleY, bubble.BubbleW, bubble.BubbleH, bubble.Confidence),
            bubble.SourceText, bubble.TranslatedText, bubble.FontFamily, bubble.FontSizeOverride);

        var imgLock = GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            if (!File.Exists(resultPath)) File.Copy(originalPath, resultPath);
            var imagePng  = await File.ReadAllBytesAsync(resultPath, ct);
            var resultPng = await Task.Run(() => typesetter.RenderOneBubble(imagePng, t, padding), ct);
            await File.WriteAllBytesAsync(resultPath, resultPng, ct);

            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null && string.IsNullOrEmpty(job.ResultImagePath))
            {
                job.ResultImagePath = Path.Combine("jobs", jobId, "result.png");
                await db.SaveChangesAsync(ct);
            }
        }
        finally { imgLock.Release(); }
    }

    // ── Per-job image lock (serialises rerender/reinpaint/repatch) ───────────

    private static readonly ConcurrentDictionary<string, SemaphoreSlim> ImageLocks = new();

    private static SemaphoreSlim GetImageLock(string jobId) =>
        ImageLocks.GetOrAdd(jobId, _ => new SemaphoreSlim(1, 1));

    // ── DB helpers ────────────────────────────────────────────────────────────

    private async Task CreateJobRowAsync(string jobId, string originalPath, int width, int height)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            // Upsert-safe: skip if already exists (e.g. retry scenario)
            if (await db.PageTranslationJobs.FindAsync(jobId) is null)
            {
                db.PageTranslationJobs.Add(new Data.PageTranslationJob
                {
                    Id                = jobId,
                    Title             = $"Job {jobId[..Math.Min(8, jobId.Length)]}",
                    Status            = "processing",
                    OriginalImagePath = originalPath,
                    OriginalWidth     = width,
                    OriginalHeight    = height,
                });
                await db.SaveChangesAsync();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to create PageTranslationJob row for {JobId}", jobId);
        }
    }

    private async Task FinalizeJobRowAsync(string jobId, string resultPath, int bubbleCount)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null)
            {
                job.Status          = "done";
                job.ResultImagePath = resultPath;
                job.BubbleCount     = bubbleCount;
                job.CompletedAt     = DateTime.UtcNow;
                await db.SaveChangesAsync();
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to finalize PageTranslationJob row for {JobId}", jobId);
        }
    }

    private async Task LogBubbleAsync(
        string jobId, int index, BubbleBox box, string source, string translated)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.PageTranslationLogs.Add(new PageTranslationLog
            {
                JobId          = jobId,
                BubbleIndex    = index,
                BubbleX        = box.X,
                BubbleY        = box.Y,
                BubbleW        = box.Width,
                BubbleH        = box.Height,
                Confidence     = box.Confidence,
                SourceText     = source,
                TranslatedText = translated,
            });
            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to persist PageTranslationLog for job {JobId} bubble {I}", jobId, index);
        }
    }

    private static byte[] CropBubble(byte[] imagePng, BubbleBox box, float padding)
    {
        using var src = SKBitmap.Decode(imagePng);
        if (src is null) return imagePng;

        float padX = box.Width  * padding;
        float padY = box.Height * padding;

        int x = Math.Max(0, (int)(box.X - padX));
        int y = Math.Max(0, (int)(box.Y - padY));
        int w = Math.Min(src.Width  - x, (int)(box.Width  + padX * 2));
        int h = Math.Min(src.Height - y, (int)(box.Height + padY * 2));

        if (w <= 0 || h <= 0) return imagePng;

        using var cropped = new SKBitmap(w, h);
        using var canvas  = new SKCanvas(cropped);
        canvas.DrawBitmap(src, new SKRect(x, y, x + w, y + h), new SKRect(0, 0, w, h));
        canvas.Flush();

        using var img  = SKImage.FromBitmap(cropped);
        using var data = img.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }
}
