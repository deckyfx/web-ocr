using System.IO.Compression;
using System.Text.Json;

namespace WebOcrServer;

/// <summary>
/// Port of server/src/services/dictionary.rs.
/// Loads Jitendex Yomitan ZIP for offline lookups; falls back to Jisho API.
/// </summary>
public sealed class DictionaryService(AppConfig config, HttpClient http, ILogger<DictionaryService> logger)
{
    // Yomitan term-bank row indices
    private const int ColExpression = 0;
    private const int ColReading    = 1;
    private const int ColDefTags    = 2;
    private const int ColTermTags   = 7;
    private const int ColDefs       = 5;

    private static readonly HashSet<string> CommonTags =
        new(StringComparer.Ordinal) { "news1", "ichi1", "spec1", "spec2", "gai1" };

    // Term expression → list of entries, loaded in background at boot
    private Dictionary<string, List<JitendexEntry>>? _index;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private record JitendexEntry(
        string      Expression,
        string      Reading,
        bool        IsCommon,
        string?     Jlpt,
        List<string> Glosses
    );

    // ── Initialisation ────────────────────────────────────────────────────────

    /// <summary>Extracts the ZIP and builds the in-memory index. Safe to call multiple times.</summary>
    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            if (_index is not null) return;

            var zipPath       = Path.Combine(config.DictDir, "jitendex-yomitan.zip");
            var extractedDir  = Path.Combine(config.DictDir, "extracted");
            var doneMarker    = Path.Combine(config.DictDir, ".done");

            if (!File.Exists(doneMarker) && File.Exists(zipPath))
            {
                Console.WriteLine("[Dict] Extracting jitendex-yomitan.zip...");
                Directory.CreateDirectory(extractedDir);
                await Task.Run(() =>
                    ZipFile.ExtractToDirectory(zipPath, extractedDir, overwriteFiles: true), ct);
                File.WriteAllText(doneMarker, "");
                Console.WriteLine("[Dict] Extraction complete.");
            }

            if (Directory.Exists(extractedDir))
            {
                Console.WriteLine("[Dict] Building term index...");
                _index = await Task.Run(() => BuildIndex(extractedDir), ct);
                Console.WriteLine($"[Dict] Indexed {_index.Count} expressions.");
            }
            else
            {
                logger.LogWarning("Dictionary extracted dir not found; Jitendex lookups will be unavailable.");
                _index = new Dictionary<string, List<JitendexEntry>>();
            }
        }
        finally
        {
            _lock.Release();
        }
    }

    private static Dictionary<string, List<JitendexEntry>> BuildIndex(string dir)
    {
        var index = new Dictionary<string, List<JitendexEntry>>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(dir, "term_bank_*.json"))
        {
            using var stream = File.OpenRead(file);
            using var doc    = JsonDocument.Parse(stream);

            foreach (var row in doc.RootElement.EnumerateArray())
            {
                var entry = ParseRow(row);
                if (entry is null) continue;

                if (!index.TryGetValue(entry.Expression, out var list))
                    index[entry.Expression] = list = new List<JitendexEntry>();
                list.Add(entry);
            }
        }

        return index;
    }

    private static JitendexEntry? ParseRow(JsonElement row)
    {
        if (row.ValueKind != JsonValueKind.Array) return null;
        var arr = row.EnumerateArray().ToArray();
        if (arr.Length < 8) return null;

        var expression = arr[ColExpression].GetString() ?? "";
        var reading    = arr[ColReading].GetString()    ?? "";
        var defTags    = arr[ColDefTags].GetString()    ?? "";
        var termTags   = arr[ColTermTags].GetString()   ?? "";

        var allTags = (defTags + " " + termTags).Split(' ',
            StringSplitOptions.RemoveEmptyEntries);

        bool   isCommon = allTags.Any(t => CommonTags.Contains(t));
        string? jlpt    = allTags.FirstOrDefault(t => t.StartsWith("jlpt-", StringComparison.Ordinal));

        var glosses = CollectGlosses(arr[ColDefs]);

        if (string.IsNullOrEmpty(expression) || glosses.Count == 0) return null;

        return new JitendexEntry(expression, reading, isCommon, jlpt, glosses);
    }

    private static List<string> CollectGlosses(JsonElement defsElem)
    {
        var results = new List<string>();

        if (defsElem.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in defsElem.EnumerateArray())
                ExtractText(item, results);
        }

        return results;
    }

    private static void ExtractText(JsonElement elem, List<string> results)
    {
        switch (elem.ValueKind)
        {
            case JsonValueKind.String:
                var s = elem.GetString();
                if (!string.IsNullOrWhiteSpace(s)) results.Add(s);
                break;

            case JsonValueKind.Object:
                // Structured-content: { "type": "structured-content", "content": ... }
                if (elem.TryGetProperty("content", out var content))
                    ExtractText(content, results);
                // li-style lists
                else if (elem.TryGetProperty("data", out var data))
                    ExtractText(data, results);
                // text nodes
                else if (elem.TryGetProperty("text", out var text))
                    ExtractText(text, results);
                break;

            case JsonValueKind.Array:
                foreach (var child in elem.EnumerateArray())
                    ExtractText(child, results);
                break;
        }
    }

    // ── Lookup ────────────────────────────────────────────────────────────────

    /// <summary>
    /// Returns a Definition for the given dictionary form, using the local index
    /// or falling back to Jisho API.  Returns null if nothing found.
    /// </summary>
    public async Task<Definition?> LookupAsync(
        string word, string mode = "local", CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(word)) return null;

        // Try local index
        if (_index is not null && _index.TryGetValue(word, out var entries) && entries.Count > 0)
        {
            var top = entries[0];
            return new Definition(
                Word:     top.Expression,
                Reading:  top.Reading,
                IsCommon: top.IsCommon,
                Jlpt:     top.Jlpt,
                Glosses:  top.Glosses.Take(6).ToList()
            );
        }

        // Jisho fallback (mode="jisho" or nothing found locally)
        if (mode == "jisho" || _index?.Count == 0)
            return await FetchJishoAsync(word, ct);

        return null;
    }

    private async Task<Definition?> FetchJishoAsync(string word, CancellationToken ct)
    {
        try
        {
            var url = $"https://jisho.org/api/v1/search/words?keyword={Uri.EscapeDataString(word)}";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Add("User-Agent", "WebOcrServer/1.0");

            using var resp = await http.SendAsync(req, ct);
            if (!resp.IsSuccessStatusCode) return null;

            using var doc  = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var data = doc.RootElement.GetProperty("data");
            if (data.GetArrayLength() == 0) return null;

            var first   = data[0];
            var isCommon = first.TryGetProperty("is_common", out var ic) && ic.GetBoolean();

            string? jlpt = null;
            if (first.TryGetProperty("jlpt", out var jlptArr) &&
                jlptArr.GetArrayLength() > 0)
                jlpt = jlptArr[0].GetString();

            var glosses = new List<string>();
            if (first.TryGetProperty("senses", out var senses))
            {
                foreach (var sense in senses.EnumerateArray())
                {
                    if (sense.TryGetProperty("english_definitions", out var defs))
                        foreach (var d in defs.EnumerateArray())
                            if (d.GetString() is { } g)
                                glosses.Add(g);
                    if (glosses.Count >= 6) break;
                }
            }

            string expression = "", reading = "";
            if (first.TryGetProperty("japanese", out var japanese) &&
                japanese.GetArrayLength() > 0)
            {
                var jp = japanese[0];
                expression = jp.TryGetProperty("word",    out var w) ? w.GetString() ?? word : word;
                reading    = jp.TryGetProperty("reading", out var r) ? r.GetString() ?? ""   : "";
            }

            return glosses.Count > 0
                ? new Definition(expression, reading, isCommon, jlpt, glosses)
                : null;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Jisho lookup failed for {Word}", word);
            return null;
        }
    }
}
