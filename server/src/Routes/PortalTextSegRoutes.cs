using Microsoft.EntityFrameworkCore;
using WebOcrServer.Data;

namespace WebOcrServer;

public static class PortalTextSegRoutes
{
    private static readonly System.Text.Json.JsonSerializerOptions SnakeCaseOpts = new()
    {
        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
    };

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

            // Generate blocks with stable IDs
            var blocks = seg.TextBlocks.Select(b => new TextSegBlock
            {
                Id = Guid.NewGuid().ToString("N")[..8],
                X = (int)b.X, Y = (int)b.Y,
                W = (int)b.Width, H = (int)b.Height,
            }).ToList();

            var opts = new System.Text.Json.JsonSerializerOptions
            {
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.SnakeCaseLower,
            };
            var json = System.Text.Json.JsonSerializer.Serialize(blocks, opts);
            await File.WriteAllTextAsync(cacheFile, json);
            return Results.Content(json, "application/json");
        });

        g.MapDelete("/jobs/{id}/textseg-blocks/{blockId}", async (
            string id, string blockId,
            AppDbContext db,
            PageTranslationService pipeline) =>
        {
            var job = await db.PageTranslationJobs.FindAsync(id);
            if (job is null) return Results.NotFound();

            var cacheFile = Path.Combine(pipeline.GetJobDir(id), "textseg_blocks.json");
            if (!File.Exists(cacheFile)) return Results.NotFound();

            var raw = await File.ReadAllTextAsync(cacheFile);
            var blocks = System.Text.Json.JsonSerializer.Deserialize<List<TextSegBlock>>(raw, SnakeCaseOpts);
            if (blocks is null) return Results.NotFound();

            var removed = blocks.RemoveAll(b => b.Id == blockId);
            if (removed == 0) return Results.NotFound();

            var updated = System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts);
            await File.WriteAllTextAsync(cacheFile, updated);
            return Results.Ok(blocks);
        });

        g.MapPost("/jobs/{id}/textseg-blocks", async (
            string id, AddTextSegRequest req,
            PageTranslationService pipeline) =>
        {
            var jobDir = pipeline.GetJobDir(id);
            Directory.CreateDirectory(jobDir);
            var cacheFile = Path.Combine(jobDir, "textseg_blocks.json");

            List<TextSegBlock> blocks;
            if (File.Exists(cacheFile))
            {
                var raw = await File.ReadAllTextAsync(cacheFile);
                blocks = System.Text.Json.JsonSerializer.Deserialize<List<TextSegBlock>>(raw, SnakeCaseOpts) ?? [];
            }
            else
            {
                blocks = [];
            }

            blocks.Add(new TextSegBlock
            {
                Id = Guid.NewGuid().ToString("N")[..8],
                X = (int)req.X, Y = (int)req.Y,
                W = (int)req.W, H = (int)req.H,
            });

            var updated = System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts);
            await File.WriteAllTextAsync(cacheFile, updated);
            return Results.Ok(blocks);
        });

        g.MapPut("/jobs/{id}/textseg-blocks/{blockId}", async (
            string id, string blockId, UpdateTextSegRequest req,
            PageTranslationService pipeline) =>
        {
            var cacheFile = Path.Combine(pipeline.GetJobDir(id), "textseg_blocks.json");
            if (!File.Exists(cacheFile)) return Results.NotFound();

            var raw = await File.ReadAllTextAsync(cacheFile);
            var blocks = System.Text.Json.JsonSerializer.Deserialize<List<TextSegBlock>>(raw, SnakeCaseOpts);
            if (blocks is null) return Results.NotFound();

            var block = blocks.FirstOrDefault(b => b.Id == blockId);
            if (block is null) return Results.NotFound();

            if (req.SourceText is not null) block.SourceText = req.SourceText;
            if (req.TranslatedText is not null) block.TranslatedText = req.TranslatedText;

            var updated = System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts);
            await File.WriteAllTextAsync(cacheFile, updated);
            return Results.Ok(block);
        });
    }

    internal record AddTextSegRequest(float X, float Y, float W, float H);
    internal record UpdateTextSegRequest(string? SourceText, string? TranslatedText);
}

/// <summary>TextSeg block stored in textseg_blocks.json.</summary>
public class TextSegBlock
{
    public string Id { get; set; } = "";
    public int X { get; set; }
    public int Y { get; set; }
    public int W { get; set; }
    public int H { get; set; }
    public string? SourceText { get; set; }
    public string? TranslatedText { get; set; }
}
