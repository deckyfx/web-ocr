using Microsoft.EntityFrameworkCore;
using SkiaSharp;
using WebOcrServer.Data;

namespace WebOcrServer;

/// <summary>
/// Per-bubble action methods extracted from <see cref="PageTranslationService"/>.
/// These handle single-bubble re-OCR, re-translation, re-inpaint, and re-patch operations.
/// </summary>
public static class PageTranslationActions
{
    /// <summary>Re-runs OCR on a single bubble, updates <see cref="PageTranslationLog.SourceText"/>.</summary>
    public static async Task<PageTranslationLog> ReocrBubbleAsync(
        this PageTranslationService svc,
        string jobId,
        int bubbleIndex,
        CancellationToken ct = default)
    {
        using var scope = svc.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        var imagePng = await File.ReadAllBytesAsync(Path.Combine(svc.GetJobDir(jobId), "original.png"), ct);
        var cropped  = PageTranslationService.CropBubblePublic(imagePng,
            new BubbleBox(bubble.BubbleX, bubble.BubbleY, bubble.BubbleW, bubble.BubbleH, bubble.Confidence), 0.05f);

        var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        await svc.Queue.Writer.WriteAsync(new OcrJob(cropped, "none", ocrTcs), ct);
        var ocrResult = (OcrResponse)await ocrTcs.Task;

        bubble.SourceText   = ocrResult.Text?.Trim() ?? "";
        bubble.LastEditedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return bubble;
    }

    /// <summary>Translates the stored source text for a single bubble.</summary>
    public static async Task<PageTranslationLog> RetranslateBubbleAsync(
        this PageTranslationService svc,
        string jobId,
        int bubbleIndex,
        CancellationToken ct = default)
    {
        using var scope = svc.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        if (!string.IsNullOrEmpty(bubble.SourceText))
        {
            var trTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await svc.Queue.Writer.WriteAsync(
                new TranslateJob(bubble.SourceText, svc.ModelSettings.Current.PreferredTranslationEngine, trTcs), ct);
            var trResult = (TranslateResponse)await trTcs.Task;

            bubble.TranslatedText = trResult.Translation;
            bubble.LastEditedAt   = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        return bubble;
    }

    /// <summary>White-fills a single bubble in the stored result image.</summary>
    public static async Task ReinpaintBubbleAsync(
        this PageTranslationService svc,
        string jobId,
        int bubbleIndex,
        int padding = 0,
        CancellationToken ct = default)
    {
        using var scope = svc.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        var jobDir       = Path.Combine(svc.GetJobDir(jobId));
        var resultPath   = Path.Combine(jobDir, "result.png");
        var originalPath = Path.Combine(jobDir, "original.png");

        var box = padding > 0
            ? new BubbleBox(bubble.BubbleX + padding, bubble.BubbleY + padding,
                Math.Max(1, bubble.BubbleW - 2 * padding), Math.Max(1, bubble.BubbleH - 2 * padding), bubble.Confidence)
            : new BubbleBox(bubble.BubbleX, bubble.BubbleY, bubble.BubbleW, bubble.BubbleH, bubble.Confidence);

        var imgLock = PageTranslationHelpers.GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            if (!File.Exists(resultPath)) File.Copy(originalPath, resultPath);
            var imagePng  = await File.ReadAllBytesAsync(resultPath, ct);
            var resultPng = await Task.Run(() => svc.Typesetter.WhiteFillBubble(imagePng, box), ct);
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

    /// <summary>Re-renders a single bubble onto the stored result image.</summary>
    public static async Task RepatchBubbleAsync(
        this PageTranslationService svc,
        string jobId,
        int bubbleIndex,
        int padding = 0,
        CancellationToken ct = default)
    {
        using var scope = svc.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var bubble = await db.PageTranslationLogs
            .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex, ct)
            ?? throw new KeyNotFoundException($"Bubble {bubbleIndex} not found in job {jobId}");

        var jobDir       = svc.GetJobDir(jobId);
        var resultPath   = Path.Combine(jobDir, "result.png");
        var originalPath = Path.Combine(jobDir, "original.png");

        var t = new BubbleTranslation(
            new BubbleBox(bubble.BubbleX, bubble.BubbleY, bubble.BubbleW, bubble.BubbleH, bubble.Confidence),
            bubble.SourceText, bubble.TranslatedText, bubble.FontFamily, bubble.FontSizeOverride,
            bubble.FontColor, bubble.StrokeColor, bubble.StrokeWidth, bubble.Rotation, bubble.TextAlign);

        var imgLock = PageTranslationHelpers.GetImageLock(jobId);
        await imgLock.WaitAsync(ct);
        try
        {
            if (!File.Exists(resultPath)) File.Copy(originalPath, resultPath);
            var imagePng  = await File.ReadAllBytesAsync(resultPath, ct);
            var resultPng = await Task.Run(() => svc.Typesetter.RenderOneBubble(imagePng, t, padding), ct);
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
}
