namespace WebOcrServer;

/// <summary>
/// Port of server/src/analyze.rs kana_to_romaji().
/// Converts hiragana/katakana reading to ASCII romaji.
/// </summary>
public static class RomajiConverter
{
    // 24 compound kana — checked before single kana
    private static readonly (string Kana, string Roma)[] Compounds =
    [
        ("きゃ", "kya"), ("きゅ", "kyu"), ("きょ", "kyo"),
        ("しゃ", "sha"), ("しゅ", "shu"), ("しょ", "sho"),
        ("ちゃ", "cha"), ("ちゅ", "chu"), ("ちょ", "cho"),
        ("にゃ", "nya"), ("にゅ", "nyu"), ("にょ", "nyo"),
        ("ひゃ", "hya"), ("ひゅ", "hyu"), ("ひょ", "hyo"),
        ("みゃ", "mya"), ("みゅ", "myu"), ("みょ", "myo"),
        ("りゃ", "rya"), ("りゅ", "ryu"), ("りょ", "ryo"),
        ("ぎゃ", "gya"), ("じゃ", "ja"),  ("びゃ", "bya"),
    ];

    // Single kana map (hiragana — katakana added at init)
    private static readonly Dictionary<string, string> Singles;

    static RomajiConverter()
    {
        var raw = new Dictionary<string, string>
        {
            ["あ"] = "a",   ["い"] = "i",   ["う"] = "u",   ["え"] = "e",   ["お"] = "o",
            ["か"] = "ka",  ["き"] = "ki",  ["く"] = "ku",  ["け"] = "ke",  ["こ"] = "ko",
            ["さ"] = "sa",  ["し"] = "shi", ["す"] = "su",  ["せ"] = "se",  ["そ"] = "so",
            ["た"] = "ta",  ["ち"] = "chi", ["つ"] = "tsu", ["て"] = "te",  ["と"] = "to",
            ["な"] = "na",  ["に"] = "ni",  ["ぬ"] = "nu",  ["ね"] = "ne",  ["の"] = "no",
            ["は"] = "ha",  ["ひ"] = "hi",  ["ふ"] = "fu",  ["へ"] = "he",  ["ほ"] = "ho",
            ["ま"] = "ma",  ["み"] = "mi",  ["む"] = "mu",  ["め"] = "me",  ["も"] = "mo",
            ["や"] = "ya",  ["ゆ"] = "yu",  ["よ"] = "yo",
            ["ら"] = "ra",  ["り"] = "ri",  ["る"] = "ru",  ["れ"] = "re",  ["ろ"] = "ro",
            ["わ"] = "wa",  ["を"] = "wo",  ["ん"] = "n",
            ["が"] = "ga",  ["ぎ"] = "gi",  ["ぐ"] = "gu",  ["げ"] = "ge",  ["ご"] = "go",
            ["ざ"] = "za",  ["じ"] = "ji",  ["ず"] = "zu",  ["ぜ"] = "ze",  ["ぞ"] = "zo",
            ["だ"] = "da",  ["ぢ"] = "ji",  ["づ"] = "zu",  ["で"] = "de",  ["ど"] = "do",
            ["ば"] = "ba",  ["び"] = "bi",  ["ぶ"] = "bu",  ["べ"] = "be",  ["ぼ"] = "bo",
            ["ぱ"] = "pa",  ["ぴ"] = "pi",  ["ぷ"] = "pu",  ["ぺ"] = "pe",  ["ぽ"] = "po",
            ["ー"] = "-",
        };

        // Add katakana variants (offset = 0x60 from hiragana)
        var katakana = new Dictionary<string, string>();
        foreach (var (k, v) in raw)
        {
            var kata = string.Concat(k.Select(c => c >= 0x3041 && c <= 0x3096
                ? (char)(c + 0x60) : c));
            if (kata != k) katakana[kata] = v;
        }
        foreach (var (k, v) in katakana) raw[k] = v;
        Singles = raw;
    }

    /// <summary>Converts a kana reading string to romaji.</summary>
    public static string Convert(string reading)
    {
        if (string.IsNullOrEmpty(reading)) return "";

        var sb  = new System.Text.StringBuilder();
        int i   = 0;

        while (i < reading.Length)
        {
            // っ/ッ: double the next consonant
            char c = reading[i];
            if (c is 'っ' or 'ッ')
            {
                i++;
                if (i < reading.Length)
                {
                    // peek at next romaji and double its first consonant
                    var next = GetNextRomaji(reading, i, out int consumed);
                    if (next.Length > 0 && next[0] != 'a' && next[0] != 'i' &&
                        next[0] != 'u' && next[0] != 'e' && next[0] != 'o')
                    {
                        sb.Append(next[0]);
                    }
                    sb.Append(next);
                    i += consumed;
                }
                continue;
            }

            var roma = GetNextRomaji(reading, i, out int adv);
            sb.Append(roma.Length > 0 ? roma : c.ToString());
            i += adv > 0 ? adv : 1;
        }

        return sb.ToString();
    }

    private static string GetNextRomaji(string s, int pos, out int consumed)
    {
        // Try 2-char compound first
        if (pos + 1 < s.Length)
        {
            var two = s.Substring(pos, 2);
            foreach (var (kana, roma) in Compounds)
            {
                if (two == kana) { consumed = 2; return roma; }
            }
        }

        // Try single
        var one = s[pos].ToString();
        if (Singles.TryGetValue(one, out var r)) { consumed = 1; return r; }

        consumed = 1;
        return "";
    }
}
