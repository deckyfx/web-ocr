using SkiaSharp;

namespace WebOcrServer;

/// <summary>A translated bubble ready for typesetting.</summary>
/// <param name="Box">Bounding box in the page's pixel coordinates.</param>
/// <param name="SourceText">Original OCR text (Japanese).</param>
/// <param name="TranslatedText">Translated text (English).</param>
/// <param name="FontFamily">Optional font family override (null = default sans-serif).</param>
/// <param name="FontSizeOverride">Optional fixed font size override (null or 0 = auto-fit).</param>
public record BubbleTranslation(
    BubbleBox Box,
    string    SourceText,
    string    TranslatedText,
    string?   FontFamily       = null,
    int?      FontSizeOverride = null);

/// <summary>
/// Renders translated text into speech-bubble regions of an image using SkiaSharp.
/// Each bubble's original area is filled white before the translated text is drawn,
/// acting as a simple inpainting fallback until a real LaMa inpaint model is available.
/// </summary>
public sealed class TypesettingService
{
    private readonly ILogger<TypesettingService> _logger;

    public TypesettingService(ILogger<TypesettingService> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Returns PNG bytes of <paramref name="imagePng"/> with translated text rendered
    /// inside each bubble region. Returns the original bytes unchanged if no translations
    /// are provided or if decoding fails.
    /// </summary>
    public byte[] RenderTranslations(byte[] imagePng, IReadOnlyList<BubbleTranslation> translations, int padding = 0)
    {
        if (translations.Count == 0) return imagePng;

        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null)
        {
            _logger.LogWarning("TypesettingService: failed to decode image — returning original");
            return imagePng;
        }

        using var canvas = new SKCanvas(bitmap);

        foreach (var t in translations)
        {
            if (string.IsNullOrWhiteSpace(t.TranslatedText)) continue;
            var box = padding > 0
                ? new BubbleBox(t.Box.X + padding, t.Box.Y + padding,
                    Math.Max(1, t.Box.Width - 2 * padding),
                    Math.Max(1, t.Box.Height - 2 * padding),
                    t.Box.Confidence)
                : t.Box;
            RenderTextInBubble(canvas, box, t.TranslatedText, t.FontFamily, t.FontSizeOverride);
        }

        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>
    /// White-fills a single bubble region (no text). Used for per-bubble re-inpaint.
    /// </summary>
    public byte[] WhiteFillBubble(byte[] imagePng, BubbleBox box)
    {
        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null) return imagePng;

        using var canvas = new SKCanvas(bitmap);
        using var paint  = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill };
        canvas.DrawRect(box.X, box.Y, box.Width, box.Height, paint);
        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>
    /// White-fills then typesets a single bubble onto <paramref name="imagePng"/>.
    /// Used for per-bubble re-patch.
    /// </summary>
    public byte[] RenderOneBubble(byte[] imagePng, BubbleTranslation t, int padding = 0)
    {
        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null) return imagePng;

        using var canvas = new SKCanvas(bitmap);
        var box = padding > 0
            ? new BubbleBox(t.Box.X + padding, t.Box.Y + padding,
                Math.Max(1, t.Box.Width - 2 * padding),
                Math.Max(1, t.Box.Height - 2 * padding),
                t.Box.Confidence)
            : t.Box;
        RenderTextInBubble(canvas, box, t.TranslatedText, t.FontFamily, t.FontSizeOverride);
        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    // ── Private render helpers ─────────────────────────────────────────────────

    private static void RenderTextInBubble(
        SKCanvas canvas,
        BubbleBox box,
        string text,
        string? fontFamily       = null,
        int?    fontSizeOverride = null)
    {
        // Target area = 85 % of the bubble so text has some margin
        float targetW = box.Width  * 0.85f;
        float targetH = box.Height * 0.85f;
        float centerX = box.X + box.Width  / 2f;
        float centerY = box.Y + box.Height / 2f;

        if (targetW < 20 || targetH < 20) return;

        // White-fill the bubble region (removes original Japanese text)
        using var fillPaint = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill };
        canvas.DrawRect(box.X, box.Y, box.Width, box.Height, fillPaint);

        var family = string.IsNullOrWhiteSpace(fontFamily) ? "sans-serif" : fontFamily;
        using var typeface = SKTypeface.FromFamilyName(
            family,
            SKFontStyleWeight.Bold,
            SKFontStyleWidth.Normal,
            SKFontStyleSlant.Upright) ?? SKTypeface.Default;

        // Use override size when set and > 0, otherwise binary-search the best fit
        float fontSize = fontSizeOverride is > 0
            ? (float)fontSizeOverride
            : BestFitFontSize(text, targetW, targetH, minSize: 8f, maxSize: 36f, typeface);

        using var font  = new SKFont(typeface, fontSize);
        var lines = WordWrap(text, font, targetW);

        float lineH  = fontSize * 1.25f;
        float totalH = lines.Count * lineH;
        float startY = centerY - totalH / 2f + fontSize; // baseline of first line

        using var textPaint = new SKPaint
        {
            Color       = new SKColor(26, 26, 26),
            IsAntialias = true,
        };

        // Clip to the bubble bounds so text can never overflow into adjacent bubbles
        canvas.Save();
        canvas.ClipRect(new SKRect(box.X, box.Y, box.X + box.Width, box.Y + box.Height));

        for (int i = 0; i < lines.Count; i++)
        {
            float textW = font.MeasureText(lines[i]);
            float x = centerX - textW / 2f;
            float y = startY + i * lineH;
            canvas.DrawText(lines[i], x, y, font, textPaint);
        }

        canvas.Restore();
    }

    // ── Font-size search ──────────────────────────────────────────────────────

    private static float BestFitFontSize(
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

    private static bool TextFits(string text, float fontSize, float maxW, float maxH, SKTypeface? typeface = null)
    {
        using var font   = new SKFont(typeface ?? SKTypeface.Default, fontSize);
        var       lines  = WordWrap(text, font, maxW);
        float     totalH = lines.Count * fontSize * 1.25f;
        return totalH <= maxH;
    }

    // ── Word-wrap ─────────────────────────────────────────────────────────────

    private static List<string> WordWrap(string text, SKFont font, float maxWidth)
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
