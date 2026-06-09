using NMeCab;
using NMeCab.Specialized;

namespace WebOcrServer;

/// <summary>
/// Port of server/src/services/analyze.rs.
/// Tokenizes Japanese text with MeCab/IPADIC and enriches tokens with romaji.
/// </summary>
public sealed class AnalyzeService : IDisposable
{
    private readonly MeCabIpaDicTagger _tagger = MeCabIpaDicTagger.Create();

    // POS values to skip when looking up dictionary definitions
    private static readonly HashSet<string> SkipPos = new(StringComparer.Ordinal)
    {
        "助詞", "助動詞", "記号", "補助記号", "接続詞", "感動詞"
    };

    public bool ShouldSkip(string pos) => SkipPos.Contains(pos);

    /// <summary>Tokenizes text and returns enriched token list.</summary>
    public List<TokenInfo> Tokenize(string text)
    {
        var nodes   = _tagger.Parse(text);
        var results = new List<TokenInfo>(nodes.Length);

        foreach (var node in nodes)
        {
            // Skip BOS/EOS nodes (stat 2/3 or empty surface)
            if (string.IsNullOrEmpty(node.Surface)) continue;
            if (node.Stat is MeCabNodeStat.Bos or MeCabNodeStat.Eos) continue;

            string pos      = node.PartsOfSpeech         ?? "*";
            string posSub   = node.PartsOfSpeechSection1 ?? "*";
            string conjType = node.Inflection             ?? "*";
            string conjForm = node.ConjugatedForm         ?? "*";
            string dictForm = node.OriginalForm is { Length: > 0 } f && f != "*"
                                ? f : node.Surface;
            string reading  = node.Reading is { Length: > 0 } r && r != "*"
                                ? r : node.Surface;

            results.Add(new TokenInfo(
                Surface:         node.Surface,
                Pos:             pos,
                PosDetail:       posSub,
                ConjugationType: conjType,
                ConjugationForm: conjForm,
                DictionaryForm:  dictForm,
                Reading:         reading,
                Romaji:          RomajiConverter.Convert(reading),
                IsUnknown:       node.Stat == MeCabNodeStat.Unk));
        }

        return results;
    }

    public void Dispose() => _tagger.Dispose();
}
