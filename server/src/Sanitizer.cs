using System.Text;
using System.Text.RegularExpressions;

namespace WebOcrServer;

/// <summary>
/// Port of server/src/sanitize.rs — cleans raw manga OCR output.
/// </summary>
public static class Sanitizer
{
    // Step 2: furigana in brackets e.g. 食（た）べる → 食べる
    private static readonly Regex ReFurigana =
        new(@"[（(《][\p{IsHiragana}\p{IsKatakana}ー]+[）)》]",
            RegexOptions.Compiled);

    // Step 3: visual noise artifacts
    private static readonly Regex ReArtifacts =
        new(@"[・.．|｜_＿◆◇▲△▽▼●○□■✦✧※♦♠♣♥♡★☆→←↑↓]",
            RegexOptions.Compiled);

    // Step 4: repeated long vowel mark
    private static readonly Regex ReDoubleBar =
        new(@"ー{2,}", RegexOptions.Compiled);

    // Step 6: multiple whitespace
    private static readonly Regex ReMultiSpace =
        new(@"\s{2,}", RegexOptions.Compiled);

    // Sentence split on Japanese/ASCII sentence-ending punctuation
    private static readonly Regex ReSentence =
        new(@"[^。！？!?]*[。！？!?]+", RegexOptions.Compiled);

    /// <summary>
    /// 6-step manga text cleaning pipeline (exact port of clean_manga_text).
    /// </summary>
    public static string Clean(string text)
    {
        // 1. NFKC normalisation
        text = text.Normalize(NormalizationForm.FormKC);

        // 2. Strip furigana
        text = ReFurigana.Replace(text, "");

        // 3. Remove noise characters
        text = ReArtifacts.Replace(text, "");

        // 4. Collapse elongation: ーー… → ー
        text = ReDoubleBar.Replace(text, "ー");

        // 5. Remove newlines
        text = text.Replace("\r", "").Replace("\n", "");

        // 6. Collapse multiple spaces, trim
        text = ReMultiSpace.Replace(text, " ").Trim();

        return text;
    }

    /// <summary>
    /// Splits cleaned text into sentences on 。！？!? boundaries.
    /// Trailing fragment (no terminator) is included as a final sentence.
    /// </summary>
    public static List<string> SplitSentences(string text)
    {
        var results  = new List<string>();
        var pos      = 0;

        foreach (Match m in ReSentence.Matches(text))
        {
            if (!string.IsNullOrWhiteSpace(m.Value))
                results.Add(m.Value.Trim());
            pos = m.Index + m.Length;
        }

        // Trailing fragment with no terminator
        if (pos < text.Length)
        {
            var tail = text[pos..].Trim();
            if (!string.IsNullOrWhiteSpace(tail))
                results.Add(tail);
        }

        return results;
    }
}
