using WebOcrServer.Data;

namespace WebOcrServer;

public static class OcrRoutes
{
    public static void MapOcrRoutes(this WebApplication app)
    {
        app.MapPost("/ocr", async (
            OcrRequest             req,
            InferenceQueue         queue,
            IServiceScopeFactory   scopeFactory,
            ILogger<OcrEngine>     logger) =>
        {
            if (string.IsNullOrWhiteSpace(req.Image))
                return Results.BadRequest(new { error = "image is required" });

            // Strip optional data-URL prefix
            var imageData = req.Image;
            var commaIdx  = imageData.IndexOf(',');
            if (commaIdx >= 0) imageData = imageData[(commaIdx + 1)..];

            byte[] imageBytes;
            try   { imageBytes = Convert.FromBase64String(imageData); }
            catch { return Results.BadRequest(new { error = "image must be valid base64" }); }

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

            // Fire-and-forget DB log (non-blocking)
            _ = LogOcrAsync(scopeFactory, result, engine);

            return Results.Ok(result);
        });
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
