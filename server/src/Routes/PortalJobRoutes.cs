using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalJobRoutes
{
    public static void MapPortalJobRoutes(this IEndpointRouteBuilder g)
    {
        // ── Jobs CRUD ──────────────────────────────────────────────────────────

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

            var bubbles = db.PageTranslationLogs.Where(l => l.JobId == id);
            db.PageTranslationLogs.RemoveRange(bubbles);
            db.PageTranslationJobs.Remove(job);
            await db.SaveChangesAsync();

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

        g.MapGet("/jobs/{id}/inpainted", async (string id, AppDbContext db, AppConfig config, HttpContext ctx) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null || string.IsNullOrEmpty(job.InpaintedImagePath)) return Results.NotFound();

            var fullPath = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(config.DatabasePath))!, job.InpaintedImagePath);
            if (!File.Exists(fullPath)) return Results.NotFound();

            ctx.Response.Headers["Cache-Control"] = "no-cache";
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
    }

    internal record UpdateJobRequest(string? Title, int? ChapterId, int? PageOrder);
}
