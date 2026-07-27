using SkiaSharp;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class OcrRoutes
{
    public static void MapOcrRoutes(this WebApplication app)
    {
        app.MapPost("/ocr", async (
            OcrRequest             req,
            BootState              boot,
            InferenceQueue         queue,
            PageTranslationQueue   translationQueue,
            IServiceScopeFactory   scopeFactory,
            AppConfig              config,
            ILogger<OcrEngine>     logger,
            CancellationToken      ct) =>
        {
            if (!boot.OcrReady)
                return Results.Json(new { error = "OCR model not ready" }, statusCode: 503);

            if (string.IsNullOrWhiteSpace(req.Image))
                return Results.BadRequest(new { error = "image is required" });

            // Strip optional data-URL prefix
            var imageData = req.Image;
            var commaIdx  = imageData.IndexOf(',');
            if (commaIdx >= 0) imageData = imageData[(commaIdx + 1)..];

            byte[] imageBytes;
            try   { imageBytes = Convert.FromBase64String(imageData); }
            catch { return Results.BadRequest(new { error = "image must be valid base64" }); }

            const int MaxPayloadBytes = 10 * 1024 * 1024; // 10 MB decoded
            if (imageBytes.Length > MaxPayloadBytes)
                return Results.BadRequest(new { error = "image payload exceeds 10 MB limit" });

            var engine = req.TranslateEngine ?? "none";

            // Enqueue and await background worker
            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new OcrJob(imageBytes, engine, tcs));
            OcrResponse result;
            try   { result = (OcrResponse)await tcs.Task; }
            catch (Exception ex)
            {
                logger.LogError(ex, "OCR job failed");
                return Results.Problem("OCR processing failed", statusCode: 500);
            }

            logger.LogInformation(
                "POST /ocr  engine={Engine}  {ElapsedMs}ms  text={Preview}",
                engine, result.ElapsedMs,
                result.Text.Length > 40 ? result.Text[..40] + "…" : result.Text);

            // Fire-and-forget DB log (non-blocking)
            _ = LogOcrAsync(scopeFactory, result, engine);

            // Optional background page-translation job (for extension result push)
            string? jobId = null;
            if (req.TrackJob == true && boot.IsReady)
            {
                jobId = Guid.NewGuid().ToString("N");
                var pngBytes = JpegToPng(imageBytes);
                await translationQueue.Writer.WriteAsync(new PageTranslationItem(jobId, pngBytes), ct);
            }

            return Results.Ok(result with { JobId = jobId });
        });

        // ── Job status (extension-accessible, default CORS) ───────────────────

        app.MapGet("/jobs/{id}/status", async (string id, AppDbContext db) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();
            return Results.Ok(new { status = job.Status, job_id = id });
        });

        // ── Job result image (extension-accessible, default CORS) ─────────────

        app.MapGet("/jobs/{id}/result-image", async (
            string      id,
            AppDbContext db,
            AppConfig   config,
            HttpContext  ctx) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null || string.IsNullOrEmpty(job.ResultImagePath))
                return Results.NotFound();

            var dataDir  = Path.GetDirectoryName(Path.GetFullPath(config.DatabasePath))!;
            var fullPath = Path.Combine(dataDir, job.ResultImagePath);
            if (!File.Exists(fullPath)) return Results.NotFound();

            ctx.Response.Headers["Cache-Control"] = "no-cache";
            return Results.File(fullPath, "image/png");
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static byte[] JpegToPng(byte[] jpeg)
    {
        using var bmp = SKBitmap.Decode(jpeg);
        if (bmp is null) return jpeg;
        using var imgData = bmp.Encode(SKEncodedImageFormat.Png, 100);
        return imgData.ToArray();
    }

    private static async Task LogOcrAsync(
        IServiceScopeFactory scopeFactory, OcrResponse result, string engine)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.OcrLogs.Add(new OcrLog
            {
                Text        = result.Text,
                Translation = result.Translation,
                TargetLang  = engine == "none" ? null : "en",
                ElapsedMs   = result.ElapsedMs,
            });
            await db.SaveChangesAsync();
        }
        catch { /* logging failures are non-fatal */ }
    }
}
