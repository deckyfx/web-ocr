using System.Diagnostics;

namespace WebOcrServer;

public static class AnalyzeRoutes
{
    // Limit concurrent Jisho API calls to avoid hammering the external service
    private static readonly SemaphoreSlim _dictSemaphore = new(5, 5);

    public static void MapAnalyzeRoutes(this WebApplication app)
    {
        app.MapPost("/analyze", async (
            AnalyzeRequest   req,
            AnalyzeService   analyzer,
            DictionaryService dict,
            ILogger<AnalyzeService> logger) =>
        {
            if (string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { error = "text is required" });

            var sw       = Stopwatch.StartNew();
            var original = req.Text;
            var sanitized = req.Sanitize ? Sanitizer.Clean(original) : original;
            var sentences = Sanitizer.SplitSentences(sanitized);

            // Tokenize — NMeCab is synchronous and fast
            var tokens = analyzer.Tokenize(sanitized);

            // Parallel dictionary lookups with a concurrency cap to avoid
            // unbounded fan-out when mode=="jisho" makes external HTTP calls
            var defTasks = tokens.Select(async t =>
            {
                if (analyzer.ShouldSkip(t.Pos)) return (Definition?)null;
                await _dictSemaphore.WaitAsync();
                try   { return await dict.LookupAsync(t.DictionaryForm, req.Mode); }
                finally { _dictSemaphore.Release(); }
            });

            var definitions = await Task.WhenAll(defTasks);

            sw.Stop();
            logger.LogInformation(
                "POST /analyze  mode={Mode}  {ElapsedMs}ms  tokens={Count}",
                req.Mode, sw.ElapsedMilliseconds, tokens.Count);

            return Results.Ok(new AnalyzeResponse(
                Original:    original,
                Sanitized:   sanitized,
                Sentences:   sentences,
                Tokens:      tokens,
                Definitions: definitions,
                ElapsedMs:   sw.ElapsedMilliseconds));
        });
    }
}
