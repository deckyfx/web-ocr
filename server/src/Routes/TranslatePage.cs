using System.Text.Json;

namespace WebOcrServer;

public static class TranslatePageRoutes
{
    // Reuse across all SSE writes to avoid allocating per-event
    private static readonly JsonSerializerOptions SseJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    public static void MapTranslatePageRoutes(this WebApplication app)
    {
        // ── POST /api/translate-page ─── Submit a new job ─────────────────────
        app.MapPost("/api/translate-page", async (
            TranslatePageRequest   req,
            TranslationJobStore    jobStore,
            PageTranslationService pipeline,
            BootState              boot,
            ILoggerFactory         loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger("TranslatePage");
            if (!boot.OcrReady || !boot.TranslateReady)
                return Results.Json(new { error = "Server not ready — models still loading" }, statusCode: 503);

            if (string.IsNullOrWhiteSpace(req.Image))
                return Results.BadRequest(new { error = "image is required" });

            // Strip optional data-URL prefix (e.g. "data:image/png;base64,…")
            var imageData = req.Image;
            var comma = imageData.IndexOf(',');
            if (comma >= 0) imageData = imageData[(comma + 1)..];

            byte[] imageBytes;
            try   { imageBytes = Convert.FromBase64String(imageData); }
            catch { return Results.BadRequest(new { error = "image must be valid base64" }); }

            const int MaxBytes = 20 * 1024 * 1024; // 20 MB
            if (imageBytes.Length > MaxBytes)
                return Results.BadRequest(new { error = "image exceeds 20 MB limit" });

            var job = jobStore.Create();

            // Fire-and-forget — the HTTP response returns immediately with the job id.
            _ = Task.Run(async () =>
            {
                jobStore.Update(job, j => { j.Status = JobStatus.Running; j.Stage = "detecting"; });

                var progress = new Progress<PageTranslationProgress>(p =>
                    jobStore.Update(job, j => { j.Stage = p.Stage; j.Progress = p.Progress; }));

                Action<JobLogEntry> logEntry = entry => jobStore.AddLog(job, entry);

                try
                {
                    var resultPng = await pipeline.TranslatePageAsync(
                        job.Id, imageBytes, progress, logEntry,
                        ct: CancellationToken.None);

                    var b64 = Convert.ToBase64String(resultPng);

                    // Emit terminal SSE event with the result embedded
                    jobStore.AddLog(job, new("done", "Translation complete", "done", 1.0, Result: b64));

                    jobStore.Update(job, j =>
                    {
                        j.Status      = JobStatus.Done;
                        j.Result      = b64;
                        j.Stage       = "done";
                        j.Progress    = 1.0;
                        j.CompletedAt = DateTime.UtcNow;
                    });
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Page translation job {Id} failed", job.Id);

                    // Emit terminal SSE event signalling failure
                    jobStore.AddLog(job, new("error", ex.Message, Error: ex.Message));

                    jobStore.Update(job, j =>
                    {
                        j.Status      = JobStatus.Error;
                        j.Error       = ex.Message;
                        j.CompletedAt = DateTime.UtcNow;
                    });

                    // Persist failure to the long-lived DB row (survives TTL expiry)
                    await pipeline.MarkJobFailedAsync(job.Id, ex.Message);
                }
            });

            return Results.Accepted($"/api/translate-page/{job.Id}", new { job_id = job.Id });
        });

        // ── GET /api/translate-page/{jobId} ─── Poll job status ───────────────
        app.MapGet("/api/translate-page/{jobId}", (
            string              jobId,
            TranslationJobStore jobStore) =>
        {
            var job = jobStore.Get(jobId);
            if (job is null) return Results.NotFound(new { error = "Job not found or expired" });

            return Results.Ok(new
            {
                status   = job.Status.ToString().ToLowerInvariant(),
                stage    = job.Stage,
                progress = job.Progress,
                result   = job.Status == JobStatus.Done  ? job.Result : null,
                error    = job.Status == JobStatus.Error ? job.Error  : null,
            });
        });

        // ── GET /api/translate-page/{jobId}/events ─── SSE live log stream ────
        //
        // The client opens this EventSource and receives a stream of JSON objects:
        //   { "type": "log",   "message": "…", "stage": "…", "progress": 0.35 }  ← progress line
        //   { "type": "done",  "message": "…", "result": "<base64-png>" }         ← terminal success
        //   { "type": "error", "message": "…", "error":  "…"            }         ← terminal failure
        //
        // The stream ends automatically when the job reaches Done or Error status.
        app.MapGet("/api/translate-page/{jobId}/events", async (
            string              jobId,
            TranslationJobStore jobStore,
            HttpContext         ctx,
            CancellationToken   ct) =>
        {
            var job = jobStore.Get(jobId);
            if (job is null)
                return Results.NotFound(new { error = "Job not found or expired" });

            // SSE headers — must be set before any body bytes are written
            ctx.Response.ContentType = "text/event-stream; charset=utf-8";
            ctx.Response.Headers["Cache-Control"]     = "no-cache";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            ctx.Response.Headers["Connection"]        = "keep-alive";

            int sent = 0;

            try
            {
                while (!ct.IsCancellationRequested)
                {
                    var current = jobStore.Get(jobId);
                    if (current is null) break; // job evicted

                    // Send any new log entries since last iteration
                    var newEntries = jobStore.GetLogsFrom(current, sent);
                    foreach (var entry in newEntries)
                    {
                        var json = JsonSerializer.Serialize(entry, SseJsonOptions);
                        await ctx.Response.WriteAsync($"data: {json}\n\n", ct);
                        await ctx.Response.Body.FlushAsync(ct);
                        sent++;
                    }

                    // Exit once the job has reached a terminal state and all logs are sent
                    if (current.Status is JobStatus.Done or JobStatus.Error)
                        break;

                    await Task.Delay(150, ct);
                }
            }
            catch (OperationCanceledException)
            {
                // Client disconnected — normal path, no logging needed
            }

            return Results.Empty;
        });
    }

    private record TranslatePageRequest(string Image, string? SourceLang, string? TargetLang);
}
