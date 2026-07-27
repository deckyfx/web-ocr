using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalRoutes
{
    public static void MapPortalRoutes(this WebApplication app)
    {
        var g = app.MapGroup("/api/portal")
                   .RequireCors("portal")
                   .RequireAuthorization("portal");

        // ── Jobs ──────────────────────────────────────────────────────────────

        g.MapGet("/jobs", async (
            AppDbContext db,
            int?    page,
            int?    pageSize,
            string? status,
            int?    chapterId) =>
        {
            var q = db.PageTranslationJobs.AsQueryable();
            if (!string.IsNullOrEmpty(status))   q = q.Where(j => j.Status    == status);
            if (chapterId.HasValue)               q = q.Where(j => j.ChapterId == chapterId);

            var total = await q.CountAsync();
            var ps    = Math.Clamp(pageSize ?? 24, 1, 100);
            var pg    = Math.Max(page ?? 1, 1);

            var items = await q
                .OrderByDescending(j => j.CreatedAt)
                .Skip((pg - 1) * ps)
                .Take(ps)
                .ToListAsync();

            return Results.Ok(new { items, total, page = pg, page_size = ps });
        });

        g.MapGet("/jobs/{id}", async (string id, AppDbContext db) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            return job is null ? Results.NotFound() : Results.Ok(job);
        });

        g.MapDelete("/jobs/{id}", async (string id, AppDbContext db, AppConfig config) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            // Remove DB rows
            var bubbles = db.PageTranslationLogs.Where(l => l.JobId == id);
            db.PageTranslationLogs.RemoveRange(bubbles);
            db.PageTranslationJobs.Remove(job);
            await db.SaveChangesAsync();

            // Remove files
            var jobDir = Path.Combine(config.JobsDir, id);
            if (Directory.Exists(jobDir))
                Directory.Delete(jobDir, recursive: true);

            return Results.NoContent();
        });

        g.MapPut("/jobs/{id}", async (string id, UpdateJobRequest req, AppDbContext db) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            if (req.Title     is not null) job.Title     = req.Title;
            if (req.ChapterId is not null) job.ChapterId = req.ChapterId == -1 ? null : req.ChapterId;
            if (req.PageOrder is not null) job.PageOrder = req.PageOrder.Value;

            await db.SaveChangesAsync();
            return Results.Ok(job);
        });

        // ── Job images ────────────────────────────────────────────────────────

        g.MapGet("/jobs/{id}/original", async (string id, AppDbContext db, AppConfig config, HttpContext ctx) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null || string.IsNullOrEmpty(job.OriginalImagePath)) return Results.NotFound();

            var fullPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(config.DatabasePath))!, job.OriginalImagePath);
            if (!File.Exists(fullPath)) return Results.NotFound();

            ctx.Response.Headers["Cache-Control"] = "public, max-age=86400";
            return Results.File(fullPath, "image/png");
        });

        g.MapGet("/jobs/{id}/result", async (string id, AppDbContext db, AppConfig config, HttpContext ctx) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null || string.IsNullOrEmpty(job.ResultImagePath)) return Results.NotFound();

            var fullPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(config.DatabasePath))!, job.ResultImagePath);
            if (!File.Exists(fullPath)) return Results.NotFound();

            ctx.Response.Headers["Cache-Control"] = "no-cache";
            return Results.File(fullPath, "image/png");
        });

        // ── Bubbles ───────────────────────────────────────────────────────────

        g.MapGet("/jobs/{id}/bubbles", async (string id, AppDbContext db) =>
        {
            var bubbles = await db.PageTranslationLogs
                .Where(l => l.JobId == id)
                .OrderBy(l => l.BubbleIndex)
                .ToListAsync();
            return Results.Ok(bubbles);
        });

        g.MapPost("/jobs/{id}/bubbles", async (string id, AddBubbleRequest req, AppDbContext db) =>
        {
            if (!await db.PageTranslationJobs.AnyAsync(j => j.Id == id))
                return Results.NotFound();

            var maxIndex = await db.PageTranslationLogs
                .Where(l => l.JobId == id)
                .Select(l => (int?)l.BubbleIndex)
                .MaxAsync() ?? -1;

            var bubble = new PageTranslationLog
            {
                JobId           = id,
                BubbleIndex     = maxIndex + 1,
                BubbleX         = req.X,
                BubbleY         = req.Y,
                BubbleW         = req.W,
                BubbleH         = req.H,
                Confidence      = 1f,
                IsManuallyAdded = true,
            };
            db.PageTranslationLogs.Add(bubble);
            await db.SaveChangesAsync();
            return Results.Ok(bubble);
        });

        g.MapPut("/jobs/{jobId}/bubbles/{bubbleIndex:int}", async (
            string jobId, int bubbleIndex, UpdateBubbleRequest req, AppDbContext db) =>
        {
            var bubble = await db.PageTranslationLogs
                .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex);
            if (bubble is null) return Results.NotFound();

            if (req.BubbleX        is not null) bubble.BubbleX        = req.BubbleX.Value;
            if (req.BubbleY        is not null) bubble.BubbleY        = req.BubbleY.Value;
            if (req.BubbleW        is not null) bubble.BubbleW        = req.BubbleW.Value;
            if (req.BubbleH        is not null) bubble.BubbleH        = req.BubbleH.Value;
            if (req.SourceText     is not null) bubble.SourceText     = req.SourceText;
            if (req.TranslatedText is not null) bubble.TranslatedText = req.TranslatedText;
            if (req.IsExcluded     is not null) bubble.IsExcluded     = req.IsExcluded.Value;

            bubble.LastEditedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            return Results.Ok(bubble);
        });

        g.MapDelete("/jobs/{jobId}/bubbles/{bubbleIndex:int}", async (
            string jobId, int bubbleIndex, AppDbContext db) =>
        {
            var bubble = await db.PageTranslationLogs
                .FirstOrDefaultAsync(l => l.JobId == jobId && l.BubbleIndex == bubbleIndex);
            if (bubble is null) return Results.NotFound();

            db.PageTranslationLogs.Remove(bubble);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

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

                    // Re-OCR + re-translate all non-excluded bubbles
                    var imagePng = await File.ReadAllBytesAsync(
                        Path.Combine(pipeline.GetJobDir(id), "original.png"));

                    var bubbles = db2.PageTranslationLogs
                        .Where(l => l.JobId == id && !l.IsExcluded)
                        .OrderBy(l => l.BubbleIndex)
                        .ToList();

                    foreach (var b in bubbles)
                    {
                        // OCR
                        var crop   = PageTranslationService.CropBubblePublic(imagePng,
                            new BubbleBox(b.BubbleX, b.BubbleY, b.BubbleW, b.BubbleH, b.Confidence), 0.05f);
                        var ocrTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                        await queue.Writer.WriteAsync(new OcrJob(crop, "none", ocrTcs));
                        var ocrResult = (OcrResponse)await ocrTcs.Task;
                        var source = ocrResult.Text?.Trim() ?? "";
                        if (string.IsNullOrEmpty(source)) continue;

                        // Translate
                        var trTcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
                        await queue.Writer.WriteAsync(new TranslateJob(source, "local", trTcs));
                        var trResult    = (TranslateResponse)await trTcs.Task;
                        b.SourceText    = source;
                        b.TranslatedText = trResult.Translation;
                        b.LastEditedAt  = DateTime.UtcNow;
                    }

                    await db2.SaveChangesAsync();
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
                    catch { /* swallow — don't mask the original error */ }
                }
            });

            return Results.Accepted(null, new { id });
        });

        g.MapPost("/jobs/{id}/rerender", async (
            string                 id,
            PageTranslationService pipeline,
            AppDbContext           db,
            ILoggerFactory         loggerFactory) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var logger = loggerFactory.CreateLogger("PortalRerender");
            _ = Task.Run(async () =>
            {
                try
                {
                    using var scope = pipeline.CreateScope();
                    var db2 = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var j   = await db2.PageTranslationJobs.FindAsync(id);
                    if (j is not null) { j.Status = "processing"; await db2.SaveChangesAsync(); }

                    await pipeline.RerenderAsync(id);

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

        // ── Volumes ───────────────────────────────────────────────────────────

        g.MapGet("/volumes", async (AppDbContext db) =>
        {
            var vols = await db.Volumes
                .OrderBy(v => v.SortOrder).ThenBy(v => v.CreatedAt)
                .Select(v => new
                {
                    v.Id, v.Title, v.Synopsis, v.CoverImagePath, v.SortOrder, v.CreatedAt,
                    ChapterCount = v.Chapters.Count,
                })
                .ToListAsync();
            return Results.Ok(vols);
        });

        g.MapPost("/volumes", async (CreateVolumeRequest req, AppDbContext db) =>
        {
            var maxOrder = await db.Volumes.Select(v => (int?)v.SortOrder).MaxAsync() ?? 0;
            var vol = new Volume { Title = req.Title, Synopsis = req.Synopsis, SortOrder = maxOrder + 1 };
            db.Volumes.Add(vol);
            await db.SaveChangesAsync();
            return Results.Ok(vol);
        });

        g.MapPut("/volumes/{id:int}", async (int id, UpdateVolumeRequest req, AppDbContext db) =>
        {
            var vol = await db.Volumes.FindAsync(id);
            if (vol is null) return Results.NotFound();

            if (req.Title     is not null) vol.Title     = req.Title;
            if (req.Synopsis  is not null) vol.Synopsis  = req.Synopsis;
            if (req.SortOrder is not null) vol.SortOrder = req.SortOrder.Value;

            await db.SaveChangesAsync();
            return Results.Ok(vol);
        });

        g.MapDelete("/volumes/{id:int}", async (int id, AppDbContext db) =>
        {
            var vol = await db.Volumes.FindAsync(id);
            if (vol is null) return Results.NotFound();
            // Orphan child chapters (set VolumeId = null) rather than violating the FK constraint
            await db.Chapters.Where(c => c.VolumeId == id)
                .ExecuteUpdateAsync(s => s.SetProperty(c => c.VolumeId, (int?)null));
            db.Volumes.Remove(vol);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        // ── Chapters ──────────────────────────────────────────────────────────

        g.MapGet("/chapters", async (AppDbContext db, int? volumeId, bool? standalone) =>
        {
            var q = db.Chapters.AsQueryable();
            if (volumeId.HasValue)         q = q.Where(c => c.VolumeId == volumeId);
            else if (standalone == true)   q = q.Where(c => c.VolumeId == null);

            var chapters = await q
                .OrderBy(c => c.SortOrder).ThenBy(c => c.CreatedAt)
                .Select(c => new
                {
                    c.Id, c.VolumeId, c.Title, c.ChapterNumber, c.SortOrder, c.CreatedAt,
                    PageCount = c.Jobs.Count,
                })
                .ToListAsync();
            return Results.Ok(chapters);
        });

        g.MapPost("/chapters", async (CreateChapterRequest req, AppDbContext db) =>
        {
            var maxOrder = await db.Chapters
                .Where(c => c.VolumeId == req.VolumeId)
                .Select(c => (int?)c.SortOrder).MaxAsync() ?? 0;

            var chapter = new Chapter
            {
                VolumeId      = req.VolumeId,
                Title         = req.Title,
                ChapterNumber = req.ChapterNumber,
                SortOrder     = maxOrder + 1,
            };
            db.Chapters.Add(chapter);
            await db.SaveChangesAsync();
            return Results.Ok(chapter);
        });

        g.MapPut("/chapters/{id:int}", async (int id, UpdateChapterRequest req, AppDbContext db) =>
        {
            var chapter = await db.Chapters.FindAsync(id);
            if (chapter is null) return Results.NotFound();

            if (req.Title         is not null) chapter.Title         = req.Title;
            if (req.ChapterNumber is not null) chapter.ChapterNumber = req.ChapterNumber;
            if (req.SortOrder     is not null) chapter.SortOrder     = req.SortOrder.Value;
            if (req.VolumeId      is not null) chapter.VolumeId      = req.VolumeId == -1 ? null : req.VolumeId;

            await db.SaveChangesAsync();
            return Results.Ok(chapter);
        });

        g.MapDelete("/chapters/{id:int}", async (int id, AppDbContext db) =>
        {
            var chapter = await db.Chapters.FindAsync(id);
            if (chapter is null) return Results.NotFound();
            // Unassign jobs (set ChapterId = null) rather than violating the FK constraint
            await db.PageTranslationJobs.Where(j => j.ChapterId == id)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.ChapterId, (int?)null));
            db.Chapters.Remove(chapter);
            await db.SaveChangesAsync();
            return Results.NoContent();
        });

        g.MapGet("/chapters/{id:int}/jobs", async (int id, AppDbContext db) =>
        {
            var jobs = await db.PageTranslationJobs
                .Where(j => j.ChapterId == id)
                .OrderBy(j => j.PageOrder)
                .ToListAsync();
            return Results.Ok(jobs);
        });

        g.MapPut("/chapters/{id:int}/jobs/reorder", async (int id, string[] jobIds, AppDbContext db) =>
        {
            var jobs = await db.PageTranslationJobs
                .Where(j => j.ChapterId == id)
                .ToListAsync();

            for (int i = 0; i < jobIds.Length; i++)
            {
                var job = jobs.FirstOrDefault(j => j.Id == jobIds[i]);
                if (job is not null) job.PageOrder = i;
            }

            await db.SaveChangesAsync();
            return Results.Ok();
        });
    }

    // ── Request / Response records ────────────────────────────────────────────

    private record UpdateJobRequest(string? Title, int? ChapterId, int? PageOrder);
    private record AddBubbleRequest(float X, float Y, float W, float H);
    private record UpdateBubbleRequest(
        float?  BubbleX, float? BubbleY, float? BubbleW, float? BubbleH,
        string? SourceText, string? TranslatedText, bool? IsExcluded);
    private record CreateVolumeRequest(string Title, string? Synopsis);
    private record UpdateVolumeRequest(string? Title, string? Synopsis, int? SortOrder);
    private record CreateChapterRequest(string Title, string ChapterNumber, int? VolumeId);
    private record UpdateChapterRequest(string? Title, string? ChapterNumber, int? SortOrder, int? VolumeId);
}
