using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalLibraryRoutes
{
    public static void MapPortalLibraryRoutes(this IEndpointRouteBuilder g)
    {
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

    internal record CreateVolumeRequest(string Title, string? Synopsis);
    internal record UpdateVolumeRequest(string? Title, string? Synopsis, int? SortOrder);
    internal record CreateChapterRequest(string Title, string ChapterNumber, int? VolumeId);
    internal record UpdateChapterRequest(string? Title, string? ChapterNumber, int? SortOrder, int? VolumeId);
}
