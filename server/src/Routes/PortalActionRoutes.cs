using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalActionRoutes
{
    public static void MapPortalActionRoutes(this IEndpointRouteBuilder g)
    {
        // ── Job actions (fire-and-forget; caller polls job status) ────────────

        g.MapPost("/jobs/{id}/redetect", async (
            string                 id,
            PageTranslationService pipeline,
            AppDbContext           db,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var logger = loggerFactory.CreateLogger("PortalRedetect");
            _ = Task.Run(async () =>
            {
                try
                {
                    using var scope = pipeline.CreateScope();
                    var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var j   = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    await pipeline.RedetectAsync(id);

                    j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "done"; await db2.SaveChangesAsync(); }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Redetect failed for job {Id}", id);
                    try
                    {
                        using var scope = pipeline.CreateScope();
                        var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                        var j   = await db2.PageTranslationJobs.FindAsync(id);
                        if (j is not null) { j.Status = "error"; j.ErrorMessage = ex.Message; await db2.SaveChangesAsync(); }
                    }
                    catch { /* swallow */ }
                }
            });

            return Results.Accepted(null, new { id });
        });

        g.MapPost("/jobs/{id}/retranslate", async (
            string                 id,
            PageTranslationService pipeline,
            AppDbContext           db,
            InferenceQueue         queue,
            ModelSettingsStore     modelSettings,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var logger = loggerFactory.CreateLogger("PortalRetranslate");
            _ = Task.Run(async () =>
            {
                using var scope = pipeline.CreateScope();
                var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                try
                {
                    var j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    var imagePng = await File.ReadAllBytesAsync(
                        Path.Combine(pipeline.GetJobDir(id), "original.png"));

                    var bubbles = db2.PageTranslationLogs
                        .Where(l => l.JobId == id && !l.IsExcluded)
                        .OrderBy(l => l.BubbleIndex)
                        .ToList();

                    foreach (var b in bubbles)
                    {
                        var crop   = PageTranslationService.CropBubblePublic(imagePng,
                            new BubbleBox(b.BubbleX, b.BubbleY, b.BubbleW, b.BubbleH, b.Confidence), 0.05f);
                        var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                        await queue.Writer.WriteAsync(new OcrJob(crop, "none", ocrTcs));
                        var ocrResult = (OcrResponse)await ocrTcs.Task;
                        var source = ocrResult.Text?.Trim() ?? "";
                        if (string.IsNullOrEmpty(source)) continue;

                        var trTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                        await queue.Writer.WriteAsync(new TranslateJob(source, modelSettings.Current.PreferredTranslationEngine, trTcs));
                        var trResult    = (TranslateResponse)await trTcs.Task;
                        b.SourceText    = source;
                        b.TranslatedText = trResult.Translation;
                        b.LastEditedAt  = DateTime.UtcNow;
                    }

                    await db2.SaveChangesAsync();

                    await PageTranslationService.SyncTextSegBlocksFromLogsAsync(
                        pipeline.GetJobDir(id), bubbles);

                    j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "done"; await db2.SaveChangesAsync(); }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Retranslate failed for job {Id}", id);
                    try
                    {
                        var j = await db2.PageTranslationJobs.FindAsync(id);
                        if (j is not null) { j.Status = "error"; j.ErrorMessage = ex.Message; await db2.SaveChangesAsync(); }
                    }
                    catch { /* swallow */ }
                }
            });

            return Results.Accepted(null, new { id });
        });

        g.MapPost("/jobs/{id}/reocr", async (
            string                 id,
            PageTranslationService pipeline,
            AppDbContext           db,
            InferenceQueue         queue,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var logger = loggerFactory.CreateLogger("PortalReocr");
            _ = Task.Run(async () =>
            {
                using var scope = pipeline.CreateScope();
                var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                try
                {
                    var j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    var imagePng = await File.ReadAllBytesAsync(
                        Path.Combine(pipeline.GetJobDir(id), "original.png"));

                    var bubbles = db2.PageTranslationLogs
                        .Where(l => l.JobId == id && !l.IsExcluded)
                        .OrderBy(l => l.BubbleIndex)
                        .ToList();

                    foreach (var b in bubbles)
                    {
                        try
                        {
                            var crop   = PageTranslationService.CropBubblePublic(imagePng,
                                new BubbleBox(b.BubbleX, b.BubbleY, b.BubbleW, b.BubbleH, b.Confidence), 0.05f);
                            var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                            await queue.Writer.WriteAsync(new OcrJob(crop, "none", ocrTcs));
                            var ocrResult   = (OcrResponse)await ocrTcs.Task;
                            var source      = ocrResult.Text?.Trim() ?? "";
                            b.SourceText    = source;
                            b.LastEditedAt  = DateTime.UtcNow;
                        }
                        catch (Exception bex)
                        {
                            logger.LogWarning(bex, "Re-OCR skipped bubble {Idx} in job {Id}", b.BubbleIndex, id);
                        }
                    }

                    await db2.SaveChangesAsync();

                    await PageTranslationService.SyncTextSegBlocksFromLogsAsync(
                        pipeline.GetJobDir(id), bubbles);

                    j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "done"; await db2.SaveChangesAsync(); }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Re-OCR failed for job {Id}", id);
                    try
                    {
                        var j = await db2.PageTranslationJobs.FindAsync(id);
                        if (j is not null) { j.Status = "error"; j.ErrorMessage = ex.Message; await db2.SaveChangesAsync(); }
                    }
                    catch { /* swallow */ }
                }
            });

            return Results.Accepted(null, new { id });
        });

        g.MapPost("/jobs/{id}/translate", async (
            string                 id,
            PageTranslationService pipeline,
            AppDbContext           db,
            InferenceQueue         queue,
            ModelSettingsStore     modelSettings,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var logger = loggerFactory.CreateLogger("PortalTranslate");
            _ = Task.Run(async () =>
            {
                using var scope = pipeline.CreateScope();
                var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                try
                {
                    var j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    var bubbles = db2.PageTranslationLogs
                        .Where(l => l.JobId == id && !l.IsExcluded && l.SourceText != null && l.SourceText != "")
                        .OrderBy(l => l.BubbleIndex)
                        .ToList();

                    foreach (var b in bubbles)
                    {
                        try
                        {
                            var trTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                            await queue.Writer.WriteAsync(new TranslateJob(b.SourceText!, modelSettings.Current.PreferredTranslationEngine, trTcs));
                            var trResult     = (TranslateResponse)await trTcs.Task;
                            b.TranslatedText = trResult.Translation;
                            b.LastEditedAt   = DateTime.UtcNow;
                        }
                        catch (Exception bex)
                        {
                            logger.LogWarning(bex, "Translate skipped bubble {Idx} in job {Id}", b.BubbleIndex, id);
                        }
                    }

                    await db2.SaveChangesAsync();
                    j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "done"; await db2.SaveChangesAsync(); }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Translate failed for job {Id}", id);
                    try
                    {
                        var j = await db2.PageTranslationJobs.FindAsync(id);
                        if (j is not null) { j.Status = "error"; j.ErrorMessage = ex.Message; await db2.SaveChangesAsync(); }
                    }
                    catch { /* swallow */ }
                }
            });

            return Results.Accepted(null, new { id });
        });

        g.MapPost("/jobs/{id}/rerender", async (
            string                 id,
            RerenderRequest?       body,
            PageTranslationService pipeline,
            AppDbContext           db,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            int padding = Math.Max(0, body?.Padding ?? 0);
            var logger = loggerFactory.CreateLogger("PortalRerender");
            _ = Task.Run(async () =>
            {
                try
                {
                    using var scope = pipeline.CreateScope();
                    var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var j   = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    await pipeline.RerenderAsync(id, padding);

                    j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "done"; await db2.SaveChangesAsync(); }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Rerender failed for job {Id}", id);
                    try
                    {
                        using var scope = pipeline.CreateScope();
                        var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                        var j   = await db2.PageTranslationJobs.FindAsync(id);
                        if (j is not null) { j.Status = "error"; j.ErrorMessage = ex.Message; await db2.SaveChangesAsync(); }
                    }
                    catch { /* swallow */ }
                }
            });

            return Results.Accepted(null, new { id });
        });

        g.MapPost("/jobs/{id}/inpaint", async (
            string                 id,
            PageTranslationService pipeline,
            AppDbContext           db,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var logger = loggerFactory.CreateLogger("PortalInpaint");
            _ = Task.Run(async () =>
            {
                try
                {
                    using var scope = pipeline.CreateScope();
                    var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var j   = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    await pipeline.InpaintOnlyAsync(id);

                    j = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "done"; await db2.SaveChangesAsync(); }
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Inpaint failed for job {Id}", id);
                    try
                    {
                        using var scope = pipeline.CreateScope();
                        var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                        var j   = await db2.PageTranslationJobs.FindAsync(id);
                        if (j is not null) { j.Status = "error"; j.ErrorMessage = ex.Message; await db2.SaveChangesAsync(); }
                    }
                    catch { /* swallow */ }
                }
            });

            return Results.Accepted(null, new { id });
        });
    }

    internal record RerenderRequest(int Padding = 0);
}
