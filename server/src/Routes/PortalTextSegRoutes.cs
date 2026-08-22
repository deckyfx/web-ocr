using System.Collections.Concurrent;
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

    // Per-job semaphores prevent concurrent read-modify-write races on textseg_blocks.json.
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> JobLocks = new();

    private static SemaphoreSlim GetJobLock(string jobId) =>
        JobLocks.GetOrAdd(jobId, _ => new SemaphoreSlim(1, 1));

    /// <summary>Atomically write <paramref name="json"/> to <paramref name="path"/> via a temp file.</summary>
    private static async Task AtomicWriteAsync(string path, string json)
    {
        var tmp = path + ".tmp";
        await File.WriteAllTextAsync(tmp, json);
        File.Move(tmp, path, overwrite: true);
    }

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

            // Fast path: cache hit (no lock needed for read-only).
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

            var blocks = seg.TextBlocks.Select(b => new TextSegBlock
            {
                Id = Guid.NewGuid().ToString("N")[..8],
                X = (int)b.X, Y = (int)b.Y,
                W = (int)b.Width, H = (int)b.Height,
            }).ToList();

            var json = System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts);

            // Acquire lock before writing to avoid racing with concurrent mutation.
            var sem = GetJobLock(id);
            await sem.WaitAsync();
            try
            {
                Directory.CreateDirectory(jobDir);
                await AtomicWriteAsync(cacheFile, json);
            }
            finally { sem.Release(); }

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

            var sem = GetJobLock(id);
            await sem.WaitAsync();
            try
            {
                if (!File.Exists(cacheFile)) return Results.NotFound();

                var raw    = await File.ReadAllTextAsync(cacheFile);
                var blocks = System.Text.Json.JsonSerializer.Deserialize<List<TextSegBlock>>(raw, SnakeCaseOpts);
                if (blocks is null) return Results.NotFound();

                var removed = blocks.RemoveAll(b => b.Id == blockId);
                if (removed == 0) return Results.NotFound();

                await AtomicWriteAsync(cacheFile, System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts));
                return Results.Ok(blocks);
            }
            finally { sem.Release(); }
        });

        g.MapPost("/jobs/{id}/textseg-blocks", async (
            string id, AddTextSegRequest req,
            PageTranslationService pipeline) =>
        {
            var jobDir    = pipeline.GetJobDir(id);
            var cacheFile = Path.Combine(jobDir, "textseg_blocks.json");

            var sem = GetJobLock(id);
            await sem.WaitAsync();
            try
            {
                List<TextSegBlock> blocks = File.Exists(cacheFile)
                    ? System.Text.Json.JsonSerializer.Deserialize<List<TextSegBlock>>(
                          await File.ReadAllTextAsync(cacheFile), SnakeCaseOpts) ?? []
                    : [];

                blocks.Add(new TextSegBlock
                {
                    Id = Guid.NewGuid().ToString("N")[..8],
                    X = (int)req.X, Y = (int)req.Y,
                    W = (int)req.W, H = (int)req.H,
                });

                Directory.CreateDirectory(jobDir);
                await AtomicWriteAsync(cacheFile, System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts));
                return Results.Ok(blocks);
            }
            finally { sem.Release(); }
        });

        g.MapPut("/jobs/{id}/textseg-blocks/{blockId}", async (
            string id, string blockId, UpdateTextSegRequest req,
            PageTranslationService pipeline) =>
        {
            var cacheFile = Path.Combine(pipeline.GetJobDir(id), "textseg_blocks.json");

            var sem = GetJobLock(id);
            await sem.WaitAsync();
            try
            {
                if (!File.Exists(cacheFile)) return Results.NotFound();

                var raw    = await File.ReadAllTextAsync(cacheFile);
                var blocks = System.Text.Json.JsonSerializer.Deserialize<List<TextSegBlock>>(raw, SnakeCaseOpts);
                if (blocks is null) return Results.NotFound();

                var block = blocks.FirstOrDefault(b => b.Id == blockId);
                if (block is null) return Results.NotFound();

                if (req.SourceText     is not null) block.SourceText     = req.SourceText;
                if (req.TranslatedText is not null) block.TranslatedText = req.TranslatedText;

                await AtomicWriteAsync(cacheFile, System.Text.Json.JsonSerializer.Serialize(blocks, SnakeCaseOpts));
                return Results.Ok(block);
            }
            finally { sem.Release(); }
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
