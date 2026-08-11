using Microsoft.EntityFrameworkCore;
using SkiaSharp;
using WebOcrServer.Data;

namespace WebOcrServer;

/// <summary>Pipeline stage name + fractional progress (0–1) for the poll endpoint.</summary>
public record PageTranslationProgress(string Stage, double Progress);

/// <summary>
/// Orchestrates the full manga-page translation pipeline:
/// <list type="number">
///   <item>TextSeg (primary driver — precise ink blocks + pixel mask)</item>
///   <item>Bubble detection (concurrent — provides speech-bubble shapes for typesetting)</item>
///   <item>OCR per TextSeg block (falls back to bubble boxes when TextSeg unavailable)</item>
///   <item>Translation (Opus-MT ONNX, via InferenceQueue)</item>
///   <item>Inpainting using TextSeg pixel mask (or flood-fill on bubble boxes as fallback)</item>
///   <item>Typeset: match each text block to its containing bubble; use block as fallback</item>
/// </list>
/// </summary>
public sealed class PageTranslationService(
    BubbleDetectionService          bubbleDetector,
    TypesettingService              typesetter,
    InpaintService                  inpaintSvc,
    TextSegmentationService         textSegSvc,
    InferenceQueue                  queue,
    AppConfig                       config,
    ModelSettingsStore              modelSettings,
    IServiceScopeFactory            scopeFactory,
    ILogger<PageTranslationService> logger)
{
    /// <summary>Exposed for extension methods in <see cref="PageTranslationActions"/>.</summary>
    internal InferenceQueue Queue => queue;

    /// <summary>Exposed for extension methods in <see cref="PageTranslationActions"/>.</summary>
    internal ModelSettingsStore ModelSettings => modelSettings;

    /// <summary>Exposed for extension methods in <see cref="PageTranslationActions"/>.</summary>
    internal TypesettingService Typesetter => typesetter;

    /// <summary>Absolute path to the per-job directory.</summary>
    public string GetJobDir(string jobId) => Path.Combine(config.JobsDir, jobId);

    /// <summary>Creates a new DI scope.</summary>
    public IServiceScope CreateScope() => scopeFactory.CreateScope();

    /// <summary>Crop helper exposed for use in retranslate route.</summary>
    public static byte[] CropBubblePublic(byte[] imagePng, BubbleBox box, float padding) =>
        PageTranslationHelpers.CropBubble(imagePng, box, padding);

    /// <summary>
    /// Run the full pipeline and return the typeset PNG image bytes.
    /// </summary>
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

        // ── 1. TextSeg + BubbleDetect (concurrent) ────────────────────────────
        log?.Invoke(new("log", "Segmenting text regions...", "detecting", 0.05));
        progress.Report(new("detecting", 0.05));

        var bubbleTask = Task.Run(() => bubbleDetector.Detect(imagePng), ct);

        TextSegResult? textSegResult = null;
        if (textSegSvc.IsReady)
        {
            var segTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new TextSegJob(imagePng, segTcs), ct);
            textSegResult = (TextSegResult)await segTcs.Task;
            logger.LogInformation("TextSeg: {Count} text block(s)", textSegResult.TextBlocks.Count);
        }

        if (textSegResult is not null)
        {
            var blocks = textSegResult.TextBlocks.Select(b => new TextSegBlock
            {
                Id = Guid.NewGuid().ToString("N")[..8],
                X = (int)b.X, Y = (int)b.Y,
                W = (int)b.Width, H = (int)b.Height,
            }).ToList();

            var blocksJson = System.Text.Json.JsonSerializer.Serialize(
                blocks,
                new System.Text.Json.JsonSerializerOptions
                {
                    PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
                });
            await File.WriteAllTextAsync(Path.Combine(jobDir, "textseg_blocks.json"), blocksJson, ct);

            if (textSegResult.Mask is { Length: > 0 } mask)
                await File.WriteAllBytesAsync(Path.Combine(jobDir, "textseg_mask.png"), mask, ct);
        }

        var bubbles = await bubbleTask;
        logger.LogInformation("Detected {Count} bubble(s)", bubbles.Count);

        if (bubbles.Count == 0 && (textSegResult is null || textSegResult.TextBlocks.Count == 0))
        {
            log?.Invoke(new("log", "No regions detected — processing full image as one region", "detecting", 0.12));
            if (imgWidth > 0 && imgHeight > 0)
                bubbles = [new BubbleBox(0, 0, imgWidth, imgHeight, 1f)];
        }
        else
        {
            var segCount = textSegResult?.TextBlocks.Count ?? 0;
            log?.Invoke(new("log",
                $"TextSeg: {segCount} region(s), bubbles: {bubbles.Count} ✓",
                "detecting", 0.12, Count: segCount));
        }

        progress.Report(new("detecting", 0.12));

        // ── 2. OCR each text region ───────────────────────────────────────────
        IReadOnlyList<BubbleBox> rawRegions = textSegResult?.TextBlocks.Count > 0
            ? textSegResult.TextBlocks
            : bubbles;

        var regionGroups = rawRegions
            .Select(r => (region: r, typesetBox: PageTranslationHelpers.GetTypesettingBox(r, bubbles)))
            .GroupBy(
                t => t.typesetBox,
                t => t.region,
                BubbleBoxComparer.Instance)
            .ToList();

        log?.Invoke(new("log", $"OCR: reading {rawRegions.Count} text region(s) in {regionGroups.Count} group(s)...", "ocr", 0.15));

        var translations = new List<BubbleTranslation>();

        for (int gi = 0; gi < regionGroups.Count; gi++)
        {
            ct.ThrowIfCancellationRequested();

            var typesetBox = regionGroups[gi].Key;
            var groupRegions = regionGroups[gi].ToList();

            log?.Invoke(new("log", $"Reading group {gi + 1}/{regionGroups.Count} ({groupRegions.Count} region(s))...",
                "ocr", 0.15 + 0.30 * (double)gi / regionGroups.Count));
            progress.Report(new("ocr", 0.15 + 0.30 * (double)gi / regionGroups.Count));

            var sourceParts = new List<string>();
            for (int ri = 0; ri < groupRegions.Count; ri++)
            {
                var region  = groupRegions[ri];
                var cropped = PageTranslationHelpers.CropBubble(imagePng, region, padding: 0.05f);

                var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                await queue.Writer.WriteAsync(new OcrJob(cropped, "none", ocrTcs), ct);

                OcrResponse ocrResult;
                try   { ocrResult = (OcrResponse)await ocrTcs.Task; }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "OCR failed for group {GI} region {RI} — skipping region", gi, ri);
                    continue;
                }

                var part = ocrResult.Text?.Trim() ?? "";
                if (!string.IsNullOrEmpty(part))
                    sourceParts.Add(part);
            }

            var sourceText = string.Join("\n", sourceParts);
            if (string.IsNullOrEmpty(sourceText))
            {
                log?.Invoke(new("log", $"Group {gi + 1}: no text found",
                    "ocr", 0.15 + 0.30 * (double)(gi + 1) / regionGroups.Count));
                await LogBubbleAsync(jobId, gi, typesetBox, "", "");
                continue;
            }

            // ── Translate ─────────────────────────────────────────────────────
            log?.Invoke(new("log", $"Translating group {gi + 1}: \"{sourceText[..Math.Min(20, sourceText.Length)]}\"...",
                "translating", 0.45 + 0.20 * (double)gi / regionGroups.Count));
            progress.Report(new("translating", 0.45 + 0.20 * (double)gi / regionGroups.Count));

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
                logger.LogWarning(ex, "Translation failed for group {GI} — using source text", gi);
                translated = sourceText;
            }

            if (!string.IsNullOrEmpty(translated))
                translations.Add(new BubbleTranslation(typesetBox, sourceText, translated));

            await LogBubbleAsync(jobId, gi, typesetBox, sourceText, translated);
        }

        // ── 3. Inpaint ────────────────────────────────────────────────────────
        var inpaintLabel = modelSettings.Current.PreferredInpaintEngine is "auto" or "lama" && inpaintSvc.IsReady
            ? "LaMa" : "flood-fill";
        log?.Invoke(new("log", $"Removing original text ({inpaintLabel})...", "inpainting", 0.72));
        progress.Report(new("inpainting", 0.72));

        var inpaintedPng = await RunInpaintAsync(imagePng, bubbles, ct, textSegResult);
        var inpaintedPath = Path.Combine(jobDir, "inpainted.png");
        await File.WriteAllBytesAsync(inpaintedPath, inpaintedPng, ct);
        var relInpainted = Path.Combine("jobs", jobId, "inpainted.png");

        // ── 4. Typeset ────────────────────────────────────────────────────────
        log?.Invoke(new("log", "Rendering translated text...", "typesetting", 0.88));
        progress.Report(new("typesetting", 0.88));

        var resultPng = await Task.Run(
            () => typesetter.RenderTextOnly(inpaintedPng, translations), ct);

        // ── 5. Persist result ─────────────────────────────────────────────────
        var resultPath = Path.Combine(jobDir, "result.png");
        await File.WriteAllBytesAsync(resultPath, resultPng, ct);
        var relResult = Path.Combine("jobs", jobId, "result.png");
        await FinalizeJobRowAsync(jobId, relInpainted, relResult, translations.Count);

        log?.Invoke(new("log", "Done ✓", "done", 1.0));
        progress.Report(new("done", 1.0));

        return resultPng;
    }

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

    public async Task RedetectAsync(string jobId, CancellationToken ct = default)
    {
        var originalPath = Path.Combine(config.JobsDir, jobId, "original.png");
        if (!File.Exists(originalPath)) throw new FileNotFoundException("Original image not found for job", originalPath);

        var imagePng = await File.ReadAllBytesAsync(originalPath, ct);
        var bubbles  = await Task.Run(() => bubbleDetector.Detect(imagePng), ct);

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

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
            l.SourceText, l.TranslatedText, l.FontFamily, l.FontSizeOverride,
            l.FontColor, l.StrokeColor, l.StrokeWidth, l.Rotation, l.TextAlign)).ToList();

        var allBubbleLogs = db.PageTranslationLogs
            .Where(l => l.JobId == jobId && !l.IsExcluded)
            .OrderBy(l => l.BubbleIndex)
            .ToList();
        var allBubbleFills = allBubbleLogs
            .Select(l => new BubbleTranslation(
                new BubbleBox(l.BubbleX, l.BubbleY, l.BubbleW, l.BubbleH, l.Confidence), "", ""))
            .ToList();

        var imgLock = PageTranslationHelpers.GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            var originalPng   = await File.ReadAllBytesAsync(originalPath, ct);
            var inpaintedPath = Path.Combine(config.JobsDir, jobId, "inpainted.png");

            if (allBubbleFills.Count > 0)
            {
                var preSegRerender = await LoadCachedTextSegAsync(jobId, ct);
                var freshInpainted = await RunInpaintAsync(
                    originalPng, allBubbleFills.ConvertAll(t => t.Box), ct, preSegRerender);
                await File.WriteAllBytesAsync(inpaintedPath, freshInpainted, ct);

                var job2 = await db.PageTranslationJobs.FindAsync(jobId);
                if (job2 is not null)
                    job2.InpaintedImagePath = Path.Combine("jobs", jobId, "inpainted.png");
            }
            else if (File.Exists(inpaintedPath))
            {
                File.Delete(inpaintedPath);
                var job2 = await db.PageTranslationJobs.FindAsync(jobId);
                if (job2 is not null)
                    job2.InpaintedImagePath = null;
            }

            var basePng   = File.Exists(inpaintedPath)
                ? await File.ReadAllBytesAsync(inpaintedPath, ct)
                : originalPng;
            var resultPng = File.Exists(inpaintedPath)
                ? await Task.Run(() => typesetter.RenderTextOnly(basePng, translations, padding), ct)
                : await Task.Run(() => typesetter.RenderTranslations(basePng, translations, padding), ct);

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

    public async Task InpaintOnlyAsync(string jobId, CancellationToken ct = default)
    {
        var originalPath = Path.Combine(config.JobsDir, jobId, "original.png");
        if (!File.Exists(originalPath)) throw new FileNotFoundException("Original image not found for job", originalPath);

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var allBubbleLogs = await db.PageTranslationLogs
            .Where(l => l.JobId == jobId && !l.IsExcluded)
            .OrderBy(l => l.BubbleIndex)
            .ToListAsync(ct);

        var allBubbleFills = allBubbleLogs
            .Select(l => new BubbleTranslation(
                new BubbleBox(l.BubbleX, l.BubbleY, l.BubbleW, l.BubbleH, l.Confidence), "", ""))
            .ToList();

        var imgLock = PageTranslationHelpers.GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            var originalPng = await File.ReadAllBytesAsync(originalPath, ct);
            var preSegInpaint = await LoadCachedTextSegAsync(jobId, ct);

            var inpaintedPng = allBubbleFills.Count > 0 || preSegInpaint is not null
                ? await RunInpaintAsync(originalPng, allBubbleFills.ConvertAll(t => t.Box), ct, preSegInpaint)
                : originalPng;

            var inpaintedPath = Path.Combine(config.JobsDir, jobId, "inpainted.png");
            await File.WriteAllBytesAsync(inpaintedPath, inpaintedPng, ct);

            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null)
            {
                job.InpaintedImagePath = Path.Combine("jobs", jobId, "inpainted.png");
                await db.SaveChangesAsync(ct);
            }
        }
        finally { imgLock.Release(); }
    }

    // ── Inpaint routing ───────────────────────────────────────────────────────

    private async Task<byte[]> RunInpaintAsync(
        byte[]                   imagePng,
        IReadOnlyList<BubbleBox> boxes,
        CancellationToken        ct,
        TextSegResult?           preSeg = null)
    {
        if (preSeg?.TextBlocks.Count > 0)
        {
            var nonBubble = preSeg.TextBlocks
                .Where(b => !PageTranslationHelpers.IsInsideAnyBubble(b, boxes))
                .ToList();
            if (nonBubble.Count > 0)
            {
                logger.LogInformation("[Inpaint] Telea erasing {N} non-bubble block(s)", nonBubble.Count);
                imagePng = await Task.Run(() => typesetter.TeleaInpaintBlocks(imagePng, nonBubble), ct);
            }
        }

        var engine = modelSettings.Current.PreferredInpaintEngine;
        if (engine is "auto" or "lama" && inpaintSvc.IsReady)
        {
            if (preSeg?.Mask is { Length: > 0 } || (preSeg is null && textSegSvc.IsReady))
            {
                byte[] textMaskPng;
                if (preSeg?.Mask is { Length: > 0 } existingMask)
                {
                    textMaskPng = existingMask;
                }
                else
                {
                    var segTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                    await queue.Writer.WriteAsync(new TextSegJob(imagePng, segTcs), ct);
                    textMaskPng = ((TextSegResult)await segTcs.Task).Mask;
                }

                var inpaintTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                await queue.Writer.WriteAsync(new InpaintWithMaskJob(imagePng, textMaskPng, boxes, MaskDilate: 2, inpaintTcs), ct);
                return (byte[])await inpaintTcs.Task;
            }

            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new InpaintJob(imagePng, boxes, MaskDilate: 4, tcs), ct);
            return (byte[])await tcs.Task;
        }

        if (preSeg?.Mask is not null)
            return await Task.Run(() => typesetter.WhiteFillWithMask(imagePng, preSeg.Mask), ct);

        var fills = boxes.Select(b => new BubbleTranslation(b, "", "")).ToList();
        return await Task.Run(() => typesetter.WhiteFillAll(imagePng, fills), ct);
    }

    // ── DB helpers ────────────────────────────────────────────────────────────

    private async Task CreateJobRowAsync(string jobId, string originalPath, int width, int height)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
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

    private async Task FinalizeJobRowAsync(string jobId, string inpaintedPath, string resultPath, int bubbleCount)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var job = await db.PageTranslationJobs.FindAsync(jobId);
            if (job is not null)
            {
                job.Status             = "done";
                job.InpaintedImagePath = inpaintedPath;
                job.ResultImagePath    = resultPath;
                job.BubbleCount        = bubbleCount;
                job.CompletedAt        = DateTime.UtcNow;
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

    private async Task<TextSegResult?> LoadCachedTextSegAsync(string jobId, CancellationToken ct = default)
    {
        var maskPath = Path.Combine(config.JobsDir, jobId, "textseg_mask.png");
        if (!File.Exists(maskPath)) return null;

        var mask = await File.ReadAllBytesAsync(maskPath, ct);

        var blocks = new List<BubbleBox>();
        var blocksPath = Path.Combine(config.JobsDir, jobId, "textseg_blocks.json");
        if (File.Exists(blocksPath))
        {
            try
            {
                var json = await File.ReadAllTextAsync(blocksPath, ct);
                var raw  = System.Text.Json.JsonSerializer.Deserialize<List<System.Text.Json.JsonElement>>(json);
                if (raw is not null)
                    foreach (var el in raw)
                        blocks.Add(new BubbleBox(
                            el.GetProperty("x").GetInt32(),
                            el.GetProperty("y").GetInt32(),
                            el.GetProperty("w").GetInt32(),
                            el.GetProperty("h").GetInt32(),
                            1f));
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "[Rerender] Failed to load cached TextSeg blocks for job {JobId}", jobId);
            }
        }

        return new TextSegResult(mask, blocks);
    }
}
