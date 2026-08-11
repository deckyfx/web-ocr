using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalTextSegRoutes
{
    public static void MapPortalTextSegRoutes(this IEndpointRouteBuilder g)
    {
        g.MapGet("/jobs/{id}/textseg-blocks", async (
            string               id,
            AppDbContext         db,
            AppConfig            config,
            PageTranslationService pipeline,
            TextSegmentationService textSegSvc,
            InferenceQueue       queue) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var jobDir    = pipeline.GetJobDir(id);
            var cacheFile = Path.Combine(jobDir, "textseg_blocks.json");

            if (File.Exists(cacheFile))
            {
                var cached = await File.ReadAllTextAsync(cacheFile);
                return Results.Content(cached, "application/json");
            }

            if (!textSegSvc.IsReady)
                return Results.Json(new { error = "TextSeg model not ready" }, statusCode: 503);

            var originalPath = Path.Combine(
                Path.GetDirectoryName(Path.GetFullPath(config.DatabasePath))!,
                job.OriginalImagePath ?? "");
            if (!File.Exists(originalPath))
                return Results.NotFound();

            var imagePng = await File.ReadAllBytesAsync(originalPath);
            var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            await queue.Writer.WriteAsync(new TextSegJob(imagePng, tcs));
            var seg = (TextSegResult)await tcs.Task;

            var json = System.Text.Json.JsonSerializer.Serialize(
                seg.TextBlocks.Select(b => new
                {
                    x = (int)b.X, y = (int)b.Y,
                    w = (int)b.Width, h = (int)b.Height,
                }),
                new System.Text.Json.JsonSerializerOptions
                {
                    PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
                });
            await File.WriteAllTextAsync(cacheFile, json);
            return Results.Content(json, "application/json");
        });

        g.MapDelete("/jobs/{id}/textseg-blocks/{index}", async (
            string id, int index,
            AppDbContext db,
            PageTranslationService pipeline) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var cacheFile = Path.Combine(pipeline.GetJobDir(id), "textseg_blocks.json");
            if (!File.Exists(cacheFile)) return Results.NotFound();

            var raw = await File.ReadAllTextAsync(cacheFile);
            var blocks = System.Text.Json.JsonSerializer.Deserialize<List<System.Text.Json.JsonElement>>(raw);
            if (blocks is null || index < 0 || index >= blocks.Count)
                return Results.BadRequest(new { error = "Index out of range" });

            blocks.RemoveAt(index);

            var updated = System.Text.Json.JsonSerializer.Serialize(blocks,
                new System.Text.Json.JsonSerializerOptions
                {
                    PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
                });
            await File.WriteAllTextAsync(cacheFile, updated);
            return Results.Ok(System.Text.Json.JsonSerializer.Deserialize<object>(updated));
        });
    }
}
