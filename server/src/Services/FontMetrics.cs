using SkiaSharp;

namespace WebOcrServer;

/// <summary>
/// Font measurement and text layout helpers for <see cref="TypesettingService"/>.
/// </summary>
public static class FontMetrics
{
    /// <summary>Computes the X baseline for a line given alignment.</summary>
    public static float LineX(string line, SKFont font, float centerX, float targetW, string? textAlign)
    {
        float textW = font.MeasureText(line);
        return (textAlign ?? "center") switch
        {
            "left"  => centerX - targetW / 2f,
            "right" => centerX + targetW / 2f - textW,
            _       => centerX - textW / 2f,
        };
    }

    /// <summary>Parses a CSS hex color string (#rgb, #rrggbb) into an SKColor. Returns null on failure.</summary>
    public static SKColor? ParseHexColor(string? hex)
    {
        if (string.IsNullOrWhiteSpace(hex)) return null;
        hex = hex.TrimStart('#');
        if (hex.Length == 3)
            hex = string.Concat(hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]);
        if (hex.Length != 6) return null;
        if (!uint.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var rgb)) return null;
        return new SKColor((byte)(rgb >> 16), (byte)(rgb >> 8 & 0xFF), (byte)(rgb & 0xFF));
    }

    /// <summary>Finds the largest font size that fits the text within the given bounds.</summary>
    public static float BestFitFontSize(
        string text, float maxW, float maxH, float minSize, float maxSize,
        SKTypeface? typeface = null)
    {
        float lo = minSize, hi = maxSize, best = minSize;
        for (int iter = 0; iter < 14; iter++)
        {
            float mid = (lo + hi) / 2f;
            if (TextFits(text, mid, maxW, maxH, typeface)) { best = mid; lo = mid; }
            else hi = mid;
            if (hi - lo < 0.5f) break;
        }
        return best;
    }

    /// <summary>Returns true if the text fits within the given dimensions at the specified font size.</summary>
    public static bool TextFits(string text, float fontSize, float maxW, float maxH, SKTypeface? typeface = null)
    {
        using var font   = new SKFont(typeface ?? SKTypeface.Default, fontSize);
        var       lines  = WordWrap(text, font, maxW);
        float     totalH = lines.Count * fontSize * 1.25f;
        return totalH <= maxH;
    }

    /// <summary>Wraps text into lines that fit within the given width.</summary>
    public static List<string> WordWrap(string text, SKFont font, float maxWidth)
    {
        var lines   = new List<string>();
        var words   = text.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var current = new System.Text.StringBuilder();

        foreach (var word in words)
        {
            var candidate = current.Length == 0 ? word : current + " " + word;
            if (font.MeasureText(candidate) <= maxWidth)
            {
                current.Clear();
                current.Append(candidate);
            }
            else
            {
                if (current.Length > 0) lines.Add(current.ToString());
                current.Clear();
                current.Append(word);
            }
        }

        if (current.Length > 0) lines.Add(current.ToString());
        return lines.Count == 0 ? [text] : lines;
    }
}
