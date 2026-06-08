using System.Text;
using System.Text.Json;

namespace WebOcrServer;

/// <summary>
/// Minimal Unigram SentencePiece tokenizer reading from HuggingFace tokenizer.json.
/// Handles MarianMT (opus-mt-*) models where model.type == "Unigram".
/// Uses the Viterbi algorithm (max-sum of log-probabilities) for segmentation.
/// </summary>
public sealed class UnigramTokenizer
{
    private readonly string[] _idToToken;
    private readonly float[]  _scores;
    private readonly Dictionary<string, int> _tokenToId;
    private readonly int _unkId;

    // Heavy penalty for a single OOV character — keeps it in the path but discourages it
    private const float UnkPenalty = -100f;
    // SentencePiece default max token length
    private const int   MaxTokLen  = 16;
    // U+2581 LOWER ONE EIGHTH BLOCK — the Metaspace / SentencePiece space marker (▁)
    private const char  SpaceMark  = '▁';

    private UnigramTokenizer(string[] idToToken, float[] scores, int unkId)
    {
        _idToToken = idToToken;
        _scores    = scores;
        _unkId     = unkId;
        _tokenToId = new Dictionary<string, int>(idToToken.Length, StringComparer.Ordinal);
        for (int i = 0; i < idToToken.Length; i++)
            _tokenToId.TryAdd(idToToken[i], i); // first occurrence wins on duplicates
    }

    /// <summary>
    /// Create from a HuggingFace <c>tokenizer.json</c> file.
    /// Expects <c>model.type == "Unigram"</c> and <c>model.vocab</c> as
    /// an array of <c>[token_string, log_prob]</c> pairs ordered by token ID.
    /// </summary>
    public static UnigramTokenizer FromJson(string jsonPath)
    {
        using var stream = File.OpenRead(jsonPath);
        using var doc    = JsonDocument.Parse(stream);

        var model = doc.RootElement.GetProperty("model");
        var vArr  = model.GetProperty("vocab");
        int n     = vArr.GetArrayLength();

        var tokens = new string[n];
        var scores = new float[n];
        int i = 0;
        foreach (var entry in vArr.EnumerateArray())
        {
            tokens[i] = entry[0].GetString()!;
            scores[i] = entry[1].GetSingle();
            i++;
        }

        int unkId = model.TryGetProperty("unk_id", out var up) ? up.GetInt32() : 0;
        Console.WriteLine($"[Translate] Unigram vocab loaded: {n} tokens, unk_id={unkId}");
        return new UnigramTokenizer(tokens, scores, unkId);
    }

    /// <summary>
    /// Encode <paramref name="text"/> to token IDs using Viterbi Unigram segmentation.
    /// Prepends ▁ (Metaspace) to mark the start of the sentence.
    /// </summary>
    public IReadOnlyList<int> EncodeToIds(string text)
    {
        if (string.IsNullOrEmpty(text)) return Array.Empty<int>();

        // Metaspace: prepend ▁ — for Japanese there are no spaces so the entire
        // text is one "word" from the pre-tokenizer's perspective
        var s = SpaceMark + text;
        int n = s.Length;

        var dp   = new float[n + 1];
        var from = new int[n + 1];
        var tl   = new int[n + 1];
        Array.Fill(dp, float.NegativeInfinity);
        dp[0] = 0f;

        for (int i = 0; i < n; i++)
        {
            if (float.IsNegativeInfinity(dp[i])) continue;
            int maxLen = Math.Min(MaxTokLen, n - i);
            for (int len = 1; len <= maxLen; len++)
            {
                var   tok = s.Substring(i, len);
                float tokScore;
                if (_tokenToId.TryGetValue(tok, out int tid))
                    tokScore = _scores[tid];
                else if (len == 1)
                    tokScore = UnkPenalty; // single-char OOV: keep path alive with penalty
                else
                    continue;             // multi-char OOV: skip this span

                float cand = dp[i] + tokScore;
                int   end  = i + len;
                if (cand > dp[end])
                {
                    dp[end]   = cand;
                    from[end] = i;
                    tl[end]   = len;
                }
            }
        }

        // Backtrack to recover the winning token sequence
        var ids = new List<int>();
        int pos  = n;
        while (pos > 0)
        {
            int start = from[pos];
            var tok   = s.Substring(start, tl[pos]);
            ids.Add(_tokenToId.TryGetValue(tok, out int id) ? id : _unkId);
            pos = start;
        }
        ids.Reverse();
        return ids;
    }

    /// <summary>
    /// Decode token IDs back to a string, stripping the ▁ Metaspace markers.
    /// </summary>
    public string? Decode(IEnumerable<int> ids)
    {
        var sb = new StringBuilder();
        foreach (var id in ids)
        {
            if ((uint)id >= (uint)_idToToken.Length) continue;
            sb.Append(_idToToken[id]);
        }
        return sb.ToString()
                 .Replace(SpaceMark.ToString(), " ", StringComparison.Ordinal)
                 .TrimStart();
    }
}
