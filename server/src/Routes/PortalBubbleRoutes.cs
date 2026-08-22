using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalBubbleRoutes
{
    public static void MapPortalBubbleRoutes(this IEndpointRouteBuilder g)
    {
        // ── Bubble CRUD ────────────────────────────────────────────────────────

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

            if (req.BubbleX         is not null) bubble.BubbleX         = req.BubbleX.Value;
            if (req.BubbleY         is not null) bubble.BubbleY         = req.BubbleY.Value;
            if (req.BubbleW         is not null) bubble.BubbleW         = req.BubbleW.Value;
            if (req.BubbleH         is not null) bubble.BubbleH         = req.BubbleH.Value;
            if (req.SourceText      is not null) bubble.SourceText      = req.SourceText;
            if (req.TranslatedText  is not null) bubble.TranslatedText  = req.TranslatedText;
            if (req.IsExcluded      is not null) bubble.IsExcluded      = req.IsExcluded.Value;
            if (req.FontFamily        is not null) bubble.FontFamily        = req.FontFamily == "" ? null : req.FontFamily;
            if (req.FontSizeOverride  is not null) bubble.FontSizeOverride  = req.FontSizeOverride == 0 ? null : req.FontSizeOverride;
            if (req.FontColor         is not null) bubble.FontColor         = req.FontColor == "" ? null : req.FontColor;
            if (req.StrokeColor       is not null) bubble.StrokeColor       = req.StrokeColor == "" ? null : req.StrokeColor;
            if (req.StrokeWidth       is not null) bubble.StrokeWidth       = req.StrokeWidth == 0 ? null : req.StrokeWidth;
            if (req.Rotation          is not null) bubble.Rotation          = req.Rotation == 0f ? null : req.Rotation;
            if (req.TextAlign         is not null) bubble.TextAlign         = req.TextAlign == "" ? null : req.TextAlign;

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

        // ── Per-bubble actions ─────────────────────────────────────────────────

        g.MapPost("/jobs/{jobId}/bubbles/{bubbleIndex:int}/reocr", async (
            string jobId, int bubbleIndex, PageTranslationService pipeline) =>
        {
            try
            {
                var updated = await pipeline.ReocrBubbleAsync(jobId, bubbleIndex);
                return Results.Ok(updated);
            }
            catch (KeyNotFoundException) { return Results.NotFound(); }
        });

        g.MapPost("/jobs/{jobId}/bubbles/{bubbleIndex:int}/retranslate", async (
            string jobId, int bubbleIndex, PageTranslationService pipeline) =>
        {
            try
            {
                var updated = await pipeline.RetranslateBubbleAsync(jobId, bubbleIndex);
                return Results.Ok(updated);
            }
            catch (KeyNotFoundException) { return Results.NotFound(); }
        });

        g.MapPost("/jobs/{jobId}/bubbles/{bubbleIndex:int}/reinpaint", async (
            string jobId, int bubbleIndex, BubblePaddingRequest? body, PageTranslationService pipeline) =>
        {
            try
            {
                await pipeline.ReinpaintBubbleAsync(jobId, bubbleIndex, Math.Max(0, body?.Padding ?? 0));
                return Results.Ok();
            }
            catch (KeyNotFoundException) { return Results.NotFound(); }
        });

        g.MapPost("/jobs/{jobId}/bubbles/{bubbleIndex:int}/repatch", async (
            string jobId, int bubbleIndex, BubblePaddingRequest? body, PageTranslationService pipeline) =>
        {
            try
            {
                await pipeline.RepatchBubbleAsync(jobId, bubbleIndex, Math.Max(0, body?.Padding ?? 0));
                return Results.Ok();
            }
            catch (KeyNotFoundException) { return Results.NotFound(); }
        });
    }

    internal record AddBubbleRequest(float X, float Y, float W, float H);
    internal record UpdateBubbleRequest(
        float?  BubbleX, float? BubbleY, float? BubbleW, float? BubbleH,
        string? SourceText, string? TranslatedText, bool? IsExcluded,
        string? FontFamily = null, int? FontSizeOverride = null,
        string? FontColor = null, string? StrokeColor = null,
        int? StrokeWidth = null, float? Rotation = null, string? TextAlign = null);
    internal record BubblePaddingRequest(int Padding = 0);
}
