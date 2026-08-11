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
///   <item>TextSeg (primary driver — precise ink blocks + pixel mask)</item>
///   <item>Bubble detection (concurrent — provides speech-bubble shapes for typesetting)</item>
///   <item>OCR per TextSeg block (falls back to bubble boxes when TextSeg unavailable)</item>
///   <item>Translation (Opus-MT ONNX, via InferenceQueue)</item>
///   <item>Inpainting using TextSeg pixel mask (or flood-fill on bubble boxes as fallback)</item>
///   <item>Typeset: match each text block to its containing bubble; use block as fallback</item>
/// </list>
/// All ONNX work is routed through <see cref="InferenceQueue"/> to keep CPU sessions serialised.
/// Per-region results are persisted to <see cref="PageTranslationLog"/> for analysis.
/// Full job images (original + result) are stored under <see cref="AppConfig.JobsDir"/>.
/// The TextSeg pixel mask is cached to <c>textseg_mask.png</c> so re-render paths can
/// reuse it without running the ONNX model again.
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

        // ── 1. TextSeg (primary) + BubbleDetect (secondary, concurrent) ───────
        // TextSeg → precise per-character ink blocks + pixel mask for inpainting.
        //           These blocks are the primary OCR regions.
        // BubbleDetect → speech-bubble bounding boxes used ONLY for typesetting:
        //                if a TextSeg block's centre falls inside a detected bubble,
        //                the bubble box is used as the text placement target (better
        //                shape); otherwise the TextSeg block itself is the target.
        log?.Invoke(new("log", "Segmenting text regions...", "detecting", 0.05));
        progress.Report(new("detecting", 0.05));

        // Kick off bubble detection immediately (thread pool, no queue dependency).
        var bubbleTask = Task.Run(() => bubbleDetector.Detect(imagePng), ct);

        // Run TextSeg via InferenceQueue.
        TextSegResult? textSegResult = null;
        if (textSegSvc.IsReady)
        {
            var segTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new TextSegJob(imagePng, segTcs), ct);
            textSegResult = (TextSegResult)await segTcs.Task;
            logger.LogInformation("TextSeg: {Count} text block(s)", textSegResult.TextBlocks.Count);
        }

        // Cache TextSeg blocks for the Studio overlay and persist pixel mask for
        // re-render paths so they can reuse it without running the ONNX model again.
        if (textSegResult is not null)
        {
            var blocksJson = System.Text.Json.JsonSerializer.Serialize(
                textSegResult.TextBlocks.Select(b => new
                {
                    x = (int)b.X, y = (int)b.Y,
                    w = (int)b.Width, h = (int)b.Height,
                }),
                new System.Text.Json.JsonSerializerOptions
                {
                    PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
                });
            await File.WriteAllTextAsync(Path.Combine(jobDir, "textseg_blocks.json"), blocksJson, ct);

            if (textSegResult.Mask is { Length: > 0 } mask)
                await File.WriteAllBytesAsync(Path.Combine(jobDir, "textseg_mask.png"), mask, ct);
        }

        // Await bubble detection (likely already done while TextSeg was running).
        var bubbles = await bubbleTask;
        logger.LogInformation("Detected {Count} bubble(s)", bubbles.Count);

        // Use full image as single bubble fallback only when TextSeg is also unavailable.
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
        // Primary: TextSeg blocks (catches all text including narration/SFX boxes
        //          that lie outside detected speech bubbles).
        // Fallback: bubble boxes (when TextSeg is unavailable).
        IReadOnlyList<BubbleBox> rawRegions = textSegResult?.TextBlocks.Count > 0
            ? textSegResult.TextBlocks
            : bubbles;

        // When TextSeg produces multiple blocks that all map to the same speech
        // bubble (e.g. two rows of dialogue in one balloon), grouping them first
        // prevents duplicate overlapping translations for that bubble.  Each group
        // shares a single typesetting target; their OCR crops are processed
        // independently then their text is joined before translation.
        var regionGroups = rawRegions
            .Select(r => (region: r, typesetBox: GetTypesettingBox(r, bubbles)))
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

            // OCR each region in the group independently, then join the text.
            var sourceParts = new List<string>();
            for (int ri = 0; ri < groupRegions.Count; ri++)
            {
                var region  = groupRegions[ri];
                var cropped = CropBubble(imagePng, region, padding: 0.05f);

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

        // ── 3. Inpaint — erase text ink using TextSeg pixel mask ─────────────
        // The TextSeg mask is pixel-accurate (white = text ink) so only actual
        // character strokes are erased; bubble borders and panel lines are preserved.
        // Falls back to rectangle white-fill on bubble boxes when TextSeg is unavailable.
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
            l.SourceText, l.TranslatedText, l.FontFamily, l.FontSizeOverride,
            l.FontColor, l.StrokeColor, l.StrokeWidth, l.Rotation, l.TextAlign)).ToList();

        // Fetch all bubble boxes for inpainting (includes bubbles without translations)
        var allBubbleLogs = db.PageTranslationLogs
            .Where(l => l.JobId == jobId && !l.IsExcluded)
            .OrderBy(l => l.BubbleIndex)
            .ToList();
        var allBubbleFills = allBubbleLogs
            .Select(l => new BubbleTranslation(
                new BubbleBox(l.BubbleX, l.BubbleY, l.BubbleW, l.BubbleH, l.Confidence), "", ""))
            .ToList();

        var imgLock = GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            var originalPng   = await File.ReadAllBytesAsync(originalPath, ct);
            var inpaintedPath = Path.Combine(config.JobsDir, jobId, "inpainted.png");

            if (allBubbleFills.Count > 0)
            {
                // Regenerate inpainted.png.
                // Prefer the cached TextSeg pixel mask (ink-only erasure) over
                // rectangle fills.  The mask was saved during the original pipeline
                // run; re-loading it avoids a redundant ONNX inference pass.
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
                // No non-excluded bubbles — stale inpainted.png would cause the
                // base-image check below to use RenderTextOnly on a stale file.
                // Delete it so we fall back to the original + RenderTranslations path.
                File.Delete(inpaintedPath);
                var job2 = await db.PageTranslationJobs.FindAsync(jobId);
                if (job2 is not null)
                    job2.InpaintedImagePath = null;
            }

            // Render text on the freshly regenerated inpainted base, or fall back
            // to the legacy white-fill+text path for jobs without bubble data.
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

    /// <summary>
    /// Erases text from all non-excluded bubble regions using the configured inpaint engine
    /// (LaMa ONNX when available and selected, otherwise BFS flood-fill) and saves the result
    /// as inpainted.png. Does NOT render any translated text — it is a pure inpaint-only operation.
    /// Use this when the user clicks "Inpaint All" in Stage 1 of the Studio without re-rendering.
    /// </summary>
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

        var imgLock = GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            var originalPng = await File.ReadAllBytesAsync(originalPath, ct);

            // Load cached TextSeg pixel mask so manual re-inpaint also uses
            // precision ink erasure rather than blunt rectangle fills.
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

    /// <summary>
    /// Routes inpainting to the best available engine:
    /// <list type="number">
    ///   <item>TextSeg pixel mask → LaMa (most accurate — ink-only removal)</item>
    ///   <item>Rectangle mask → LaMa (when TextSeg unavailable)</item>
    ///   <item>BFS flood-fill (no ONNX)</item>
    /// </list>
    /// <paramref name="preSeg"/> lets the caller supply a TextSeg result already computed
    /// during the detection step, avoiding a redundant second inference pass.
    /// </summary>
    private async Task<byte[]> RunInpaintAsync(
        byte[]                   imagePng,
        IReadOnlyList<BubbleBox> boxes,
        CancellationToken        ct,
        TextSegResult?           preSeg = null)
    {
        // ── Pass 0: Telea for non-bubble TextSeg blocks ───────────────────────────
        // TextSeg blocks that fall outside all detected speech bubbles (narration boxes,
        // SFX on screentones, etc.) aren't handled by LaMa because the pixel mask from
        // TextSeg only covers text on light backgrounds.  Telea samples the pixels
        // immediately surrounding each tight TextSeg bounding box, so it naturally
        // reconstructs the correct background (dark for dark narration panels,
        // white for white-background SFX) without needing a per-pixel text mask.
        if (preSeg?.TextBlocks.Count > 0)
        {
            var nonBubble = preSeg.TextBlocks
                .Where(b => !IsInsideAnyBubble(b, boxes))
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
            // Pixel-accurate path: use pre-computed mask (non-empty) or run TextSeg now.
            if (preSeg?.Mask is { Length: > 0 } || (preSeg is null && textSegSvc.IsReady))
            {
                byte[] textMaskPng;
                if (preSeg?.Mask is { Length: > 0 } existingMask)
                {
                    textMaskPng = existingMask; // reuse mask from detection step
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

            // LaMa only — rectangle mask fallback (no TextSeg)
            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new InpaintJob(imagePng, boxes, MaskDilate: 4, tcs), ct);
            return (byte[])await tcs.Task;
        }

        // Flood-fill fallback — use TextSeg pixel mask when available for precision,
        // otherwise fall back to full-rectangle white-fill.
        if (preSeg?.Mask is not null)
            return await Task.Run(() => typesetter.WhiteFillWithMask(imagePng, preSeg.Mask), ct);

        var fills = boxes.Select(b => new BubbleTranslation(b, "", "")).ToList();
        return await Task.Run(() => typesetter.WhiteFillAll(imagePng, fills), ct);
    }

    /// <summary>Returns true when a TextSeg block's center point lies inside at least one bubble box.</summary>
    private static bool IsInsideAnyBubble(BubbleBox block, IReadOnlyList<BubbleBox> bubbles)
    {
        float cx = block.X + block.Width  / 2f;
        float cy = block.Y + block.Height / 2f;
        return bubbles.Any(b =>
            cx >= b.X && cx <= b.X + b.Width &&
            cy >= b.Y && cy <= b.Y + b.Height);
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
            bubble.SourceText, bubble.TranslatedText, bubble.FontFamily, bubble.FontSizeOverride,
            bubble.FontColor, bubble.StrokeColor, bubble.StrokeWidth, bubble.Rotation, bubble.TextAlign);

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

    /// <summary>
    /// Finds the best typesetting target for a text region.
    /// If a detected bubble box contains the text region's centre, return that bubble box
    /// (larger, speech-bubble-shaped target for better text layout).
    /// Otherwise return the text region itself — covers narration boxes, SFX text, and any
    /// text that lies outside detected speech bubbles.
    /// </summary>
    private static BubbleBox GetTypesettingBox(BubbleBox textRegion, IReadOnlyList<BubbleBox> bubbles)
    {
        float cx = textRegion.X + textRegion.Width  / 2f;
        float cy = textRegion.Y + textRegion.Height / 2f;
        foreach (var bubble in bubbles)
        {
            if (cx >= bubble.X && cx <= bubble.X + bubble.Width &&
                cy >= bubble.Y && cy <= bubble.Y + bubble.Height)
                return bubble;
        }
        return textRegion;
    }

    /// <summary>
    /// Loads the cached TextSeg pixel mask written by <see cref="TranslatePageAsync"/>.
    /// Returns <see langword="null"/> when no mask file exists (first run or TextSeg was disabled).
    /// </summary>
    private async Task<byte[]?> LoadTextSegMaskAsync(string jobId)
    {
        var maskPath = Path.Combine(config.JobsDir, jobId, "textseg_mask.png");
        return File.Exists(maskPath) ? await File.ReadAllBytesAsync(maskPath) : null;
    }

    /// <summary>
    /// Loads the cached TextSeg mask and block list written by <see cref="TranslatePageAsync"/>.
    /// Returns <c>null</c> when the mask file is absent (TextSeg was not run for this job).
    /// </summary>
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
                logger.LogWarning(ex, "[Rerender] Failed to load cached TextSeg blocks for job {JobId} — Telea pass will be skipped", jobId);
            }
        }

        return new TextSegResult(mask, blocks);
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

/// <summary>
/// Equality comparer for <see cref="BubbleBox"/> that treats two boxes as
/// identical when their rounded integer coordinates match.  Used to group
/// TextSeg blocks that map to the same typesetting target.
/// </summary>
file sealed class BubbleBoxComparer : IEqualityComparer<BubbleBox>
{
    public static readonly BubbleBoxComparer Instance = new();

    public bool Equals(BubbleBox? a, BubbleBox? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;
        return (int)a.X == (int)b.X && (int)a.Y == (int)b.Y
            && (int)a.Width == (int)b.Width && (int)a.Height == (int)b.Height;
    }

    public int GetHashCode(BubbleBox box) =>
        HashCode.Combine((int)box.X, (int)box.Y, (int)box.Width, (int)box.Height);
}
