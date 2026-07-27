using SkiaSharp;

namespace WebOcrServer;

/// <summary>A translated bubble ready for typesetting.</summary>
/// <param name="Box">Bounding box in the page's pixel coordinates.</param>
/// <param name="SourceText">Original OCR text (Japanese).</param>
/// <param name="TranslatedText">Translated text (English).</param>
public record BubbleTranslation(BubbleBox Box, string SourceText, string TranslatedText);

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
    public byte[] RenderTranslations(byte[] imagePng, IReadOnlyList<BubbleTranslation> translations)
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
            RenderTextInBubble(canvas, t.Box, t.TranslatedText);
        }

        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    // ── Private render helpers ─────────────────────────────────────────────────

    private static void RenderTextInBubble(SKCanvas canvas, BubbleBox box, string text)
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

        // Binary-search the largest font size that fits
        float fontSize = BestFitFontSize(text, targetW, targetH, minSize: 8f, maxSize: 36f);

        using var typeface = SKTypeface.FromFamilyName(
            "sans-serif",
            SKFontStyleWeight.Bold,
            SKFontStyleWidth.Normal,
            SKFontStyleSlant.Upright) ?? SKTypeface.Default;

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
        string text, float maxW, float maxH, float minSize, float maxSize)
    {
        float lo = minSize, hi = maxSize, best = minSize;
        for (int iter = 0; iter < 14; iter++)
        {
            float mid = (lo + hi) / 2f;
            if (TextFits(text, mid, maxW, maxH)) { best = mid; lo = mid; }
            else hi = mid;
            if (hi - lo < 0.5f) break;
        }
        return best;
    }

    private static bool TextFits(string text, float fontSize, float maxW, float maxH)
    {
        using var font   = new SKFont(SKTypeface.Default, fontSize);
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
