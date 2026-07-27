using WebOcrServer.Data;

namespace WebOcrServer;

public static class TranslateRoutes
{
    public static void MapTranslateRoutes(this WebApplication app)
    {
        app.MapPost("/translate", async (
            TranslateRequest       req,
            BootState              boot,
            InferenceQueue         queue,
            ModelSettingsStore     modelSettings,
            AppConfig              config,
            IServiceScopeFactory   scopeFactory,
            ILogger<TranslateService> logger) =>
        {
            if (string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { error = "text is required" });

            var rawEngine = string.IsNullOrWhiteSpace(req.TranslateEngine)
                ? modelSettings.Current.PreferredTranslationEngine
                : req.TranslateEngine;

            // Resolve "auto": prefer DeepL when configured, fall back to local.
            var engine = rawEngine.Equals("auto", StringComparison.OrdinalIgnoreCase)
                ? (config.DeeplAvailable ? "deepl" : "local")
                : rawEngine;

            // Only require the local model when the chosen engine is not an external API (DeepL).
            var needsLocal = !engine.Equals("deepl", StringComparison.OrdinalIgnoreCase);
            if (needsLocal && !boot.TranslateReady)
                return Results.Json(new { error = "Translate model not ready" }, statusCode: 503);

            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new TranslateJob(req.Text, engine, tcs));

            TranslateResponse result;
            try   { result = (TranslateResponse)await tcs.Task; }
            catch (Exception ex)
            {
                logger.LogError(ex, "Translate job failed");
                return Results.Problem("Translation processing failed", statusCode: 500);
            }

            logger.LogInformation(
                "POST /translate  engine={Engine}  {ElapsedMs}ms",
                engine, result.ElapsedMs);

            // Fire-and-forget DB log
            _ = LogTranslateAsync(scopeFactory, req.Text, result, engine);

            return Results.Ok(result);
        });
    }

    private static async Task LogTranslateAsync(
        IServiceScopeFactory scopeFactory, string sourceText, TranslateResponse result, string engine)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.TranslateLogs.Add(new TranslateLog
            {
                SourceText = sourceText,
                Translated = result.Translation,
                TargetLang = "en",
                ElapsedMs  = result.ElapsedMs,
            });
            await db.SaveChangesAsync();
        }
        catch { /* logging failures are non-fatal */ }
    }
}
