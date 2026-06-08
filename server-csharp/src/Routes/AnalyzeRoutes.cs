using System.Diagnostics;

namespace WebOcrServer;

public static class AnalyzeRoutes
{
    public static void MapAnalyzeRoutes(this WebApplication app)
    {
        app.MapPost("/analyze", async (
            AnalyzeRequest   req,
            AnalyzeService   analyzer,
            DictionaryService dict) =>
        {
            if (string.IsNullOrWhiteSpace(req.Text))
                return Results.BadRequest(new { error = "text is required" });

            var sw       = Stopwatch.StartNew();
            var original = req.Text;
            var sanitized = req.Sanitize ? Sanitizer.Clean(original) : original;
            var sentences = Sanitizer.SplitSentences(sanitized);

            // Tokenize — NMeCab is synchronous and fast
            var tokens = analyzer.Tokenize(sanitized);

            // Parallel dictionary lookups (I/O-bound; safe to fan-out)
            var defTasks = tokens.Select(t =>
                analyzer.ShouldSkip(t.Pos)
                    ? Task.FromResult<Definition?>(null)
                    : dict.LookupAsync(t.DictionaryForm, req.Mode));

            var definitions = await Task.WhenAll(defTasks);

            sw.Stop();
            return Results.Ok(new AnalyzeResponse(
                Original:    original,
                Sanitized:   sanitized,
                Sentences:   sentences,
                Tokens:      tokens,
                Definitions: definitions.ToList(),
                ElapsedMs:   sw.ElapsedMilliseconds));
        });
    }
}
