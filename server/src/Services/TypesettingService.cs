using OpenCvSharp;
using SkiaSharp;
using CvScalar = OpenCvSharp.Scalar;

namespace WebOcrServer;

/// <summary>A translated bubble ready for typesetting.</summary>
/// <param name="Box">Bounding box in the page's pixel coordinates.</param>
/// <param name="SourceText">Original OCR text (Japanese).</param>
/// <param name="TranslatedText">Translated text (English).</param>
/// <param name="FontFamily">Optional font family override (null = default sans-serif).</param>
/// <param name="FontSizeOverride">Optional fixed font size override (null or 0 = auto-fit).</param>
/// <param name="FontColor">CSS hex fill color e.g. "#1a1a1a" (null = #1a1a1a).</param>
/// <param name="StrokeColor">CSS hex stroke/outline color (null = no stroke).</param>
/// <param name="StrokeWidth">Stroke width in pixels (null = 0).</param>
/// <param name="Rotation">Rotation in degrees around bubble center (null = 0).</param>
/// <param name="TextAlign">Text alignment: "left", "center", or "right" (null = center).</param>
public record BubbleTranslation(
    BubbleBox Box,
    string    SourceText,
    string    TranslatedText,
    string?   FontFamily       = null,
    int?      FontSizeOverride = null,
    string?   FontColor        = null,
    string?   StrokeColor      = null,
    int?      StrokeWidth      = null,
    float?    Rotation         = null,
    string?   TextAlign        = null);

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
            RenderTextInBubble(canvas, box, t.TranslatedText, t.FontFamily, t.FontSizeOverride,
                whiteFill: true, t.FontColor, t.StrokeColor, t.StrokeWidth, t.Rotation, t.TextAlign);
        }

        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>
    /// Renders translated text onto <paramref name="imagePng"/> WITHOUT white-filling
    /// the bubble regions first. The caller is responsible for supplying an already-inpainted
    /// image (e.g. inpainted.png from step 3). Text glyphs are drawn directly on whatever
    /// background exists — producing transparent-fill text when the background is already clean.
    /// </summary>
    public byte[] RenderTextOnly(byte[] imagePng, IReadOnlyList<BubbleTranslation> translations, int padding = 0)
    {
        if (translations.Count == 0) return imagePng;

        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null)
        {
            _logger.LogWarning("TypesettingService: failed to decode image for RenderTextOnly — returning original");
            return imagePng;
        }

        using var canvas = new SKCanvas(bitmap);

        foreach (var t in translations)
        {
            if (string.IsNullOrWhiteSpace(t.TranslatedText)) continue;
            var box = padding > 0
                ? new BubbleBox(t.Box.X + padding, t.Box.Y + padding,
                    Math.Max(1, t.Box.Width  - 2 * padding),
                    Math.Max(1, t.Box.Height - 2 * padding),
                    t.Box.Confidence)
                : t.Box;
            RenderTextInBubble(canvas, box, t.TranslatedText, t.FontFamily, t.FontSizeOverride,
                whiteFill: false, t.FontColor, t.StrokeColor, t.StrokeWidth, t.Rotation, t.TextAlign);
        }

        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>
    /// Removes text from all bubble regions by flood-filling each bubble interior with white,
    /// starting from the bubble center and stopping at dark border pixels.
    /// This preserves the bubble outline regardless of shape (oval, cloud, rectangular).
    /// Falls back to a 4 px inset rectangle when the center pixel is dark.
    /// </summary>
    public byte[] WhiteFillAll(byte[] imagePng, IReadOnlyList<BubbleTranslation> translations)
    {
        if (translations.Count == 0) return imagePng;

        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null)
        {
            _logger.LogWarning("TypesettingService: failed to decode image for WhiteFillAll — returning original");
            return imagePng;
        }

        foreach (var t in translations)
            FillBubbleInterior(bitmap, t.Box);

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>
    /// Erases text ink by writing white into every pixel that is bright in <paramref name="maskPng"/>.
    /// More precise than <see cref="WhiteFillAll"/> — fills only the actual text pixels, not
    /// entire bounding boxes, so bubble outlines and backgrounds are preserved.
    /// </summary>
    public byte[] WhiteFillWithMask(byte[] imagePng, byte[] maskPng)
    {
        using var srcDecoded = SKBitmap.Decode(imagePng);
        if (srcDecoded is null) return imagePng;
        using var bitmap = srcDecoded.Copy(SKColorType.Bgra8888);
        if (bitmap is null) return imagePng;

        using var maskDecoded = SKBitmap.Decode(maskPng);
        if (maskDecoded is null) return imagePng;

        bool needResize = maskDecoded.Width != bitmap.Width || maskDecoded.Height != bitmap.Height;
        SKBitmap? resized = null;
        try
        {
            if (needResize)
            {
                resized = maskDecoded.Resize(
                    new SKSizeI(bitmap.Width, bitmap.Height),
                    new SKSamplingOptions(SKFilterMode.Linear));
                if (resized is null) return imagePng; // resize failed — skip rather than out-of-bounds read
            }

            using var mask = (resized ?? maskDecoded).Copy(SKColorType.Bgra8888);
            if (mask is null) return imagePng;

            int w = bitmap.Width, h = bitmap.Height;
            int imgRowBytes  = bitmap.RowBytes;
            int maskRowBytes = mask.RowBytes;
            unsafe
            {
                byte* ip = (byte*)bitmap.GetPixels().ToPointer();
                byte* mp = (byte*)mask.GetPixels().ToPointer();
                for (int y = 0; y < h; y++)
                {
                    byte* iRow = ip + (nint)y * imgRowBytes;
                    byte* mRow = mp + (nint)y * maskRowBytes;
                    for (int x = 0; x < w; x++)
                    {
                        if (mRow[x * 4 + 2] > 127) // BGRA — R = offset 2
                            iRow[x * 4] = iRow[x * 4 + 1] = iRow[x * 4 + 2] = 255;
                    }
                }
            }

            using var image = SKImage.FromBitmap(bitmap);
            using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
            return data.ToArray();
        }
        finally { resized?.Dispose(); }
    }

    /// <summary>
    /// Removes text from a single bubble region. Used for per-bubble re-inpaint.
    /// </summary>
    public byte[] WhiteFillBubble(byte[] imagePng, BubbleBox box)
    {
        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null) return imagePng;

        FillBubbleInterior(bitmap, box);

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>
    /// Erases text in the given blocks using OpenCV's Telea inpainting algorithm.
    /// Each block's bounding box is used as the inpaint mask; Telea reconstructs the
    /// background from the pixels immediately surrounding each block, so it naturally
    /// fills dark narration boxes with dark and white speech-bubble interiors with white —
    /// without needing a separate per-pixel text mask for those regions.
    /// </summary>
    /// <param name="imagePng">Full-page PNG bytes.</param>
    /// <param name="blocks">Text blocks to erase (typically TextSeg blocks outside speech bubbles).</param>
    /// <param name="dilate">Structuring-element size (px) for morphological dilation applied to the mask (swallows anti-aliased edges).</param>
    public byte[] TeleaInpaintBlocks(byte[] imagePng, IReadOnlyList<BubbleBox> blocks, int dilate = 5)
    {
        if (blocks.Count == 0) return imagePng;

        using var src = Cv2.ImDecode(imagePng, ImreadModes.Color);
        if (src.Empty()) return imagePng;

        using var mask = new Mat(src.Rows, src.Cols, MatType.CV_8UC1, new CvScalar(0));

        foreach (var block in blocks)
        {
            int x = Math.Max(0, (int)block.X);
            int y = Math.Max(0, (int)block.Y);
            int w = Math.Min(src.Cols - x, (int)block.Width);
            int h = Math.Min(src.Rows - y, (int)block.Height);
            if (w > 0 && h > 0)
                Cv2.Rectangle(mask, new Rect(x, y, w, h), new CvScalar(255), thickness: -1);
        }

        if (dilate > 0)
        {
            using var kernel = Cv2.GetStructuringElement(MorphShapes.Ellipse, new Size(dilate, dilate));
            Cv2.Dilate(mask, mask, kernel);
        }

        if (Cv2.CountNonZero(mask) == 0) return imagePng;

        using var result = new Mat();
        Cv2.Inpaint(src, mask, result, inpaintRadius: 3, InpaintMethod.Telea);

        if (!Cv2.ImEncode(".png", result, out var bytes) || bytes.Length == 0)
            return imagePng;
        return bytes;
    }

    // ── Private inpaint helpers ────────────────────────────────────────────────

    /// <summary>
    /// Flood-fills the interior of a speech bubble with white, starting from the center
    /// and expanding only into pixels lighter than <paramref name="lightThreshold"/>.
    /// The dark border pixels stop the fill, so the outline is preserved.
    /// Falls back to a 4 px inset rectangle when the center is unexpectedly dark.
    /// </summary>
    private static void FillBubbleInterior(SKBitmap bitmap, BubbleBox box, byte lightThreshold = 200)
    {
        // Flood fill boundaries — stay inside the bounding box and bitmap
        int minX = Math.Max(0, (int)box.X);
        int minY = Math.Max(0, (int)box.Y);
        int maxX = Math.Min(bitmap.Width  - 1, (int)(box.X + box.Width));
        int maxY = Math.Min(bitmap.Height - 1, (int)(box.Y + box.Height));

        // Skip boxes entirely outside the bitmap (e.g. from Studio edits that moved a box off-page)
        if (maxX < minX || maxY < minY) return;

        // Clamp center into the clamped region so Enqueue never computes a negative index
        int cx = Math.Clamp((int)(box.X + box.Width  / 2f), minX, maxX);
        int cy = Math.Clamp((int)(box.Y + box.Height / 2f), minY, maxY);

        if (!IsPixelLight(bitmap, cx, cy, lightThreshold))
        {
            // Fallback: inset rectangle that avoids the border pixels
            const int Inset = 4;
            using var canvas = new SKCanvas(bitmap);
            using var paint  = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill };
            canvas.DrawRect(minX + Inset, minY + Inset,
                            maxX - minX - 2 * Inset, maxY - minY - 2 * Inset, paint);
            return;
        }

        int regionW = maxX - minX + 1;
        int regionH = maxY - minY + 1;
        var visited  = new bool[regionW * regionH];
        var queue    = new Queue<(int x, int y)>();

        void Enqueue(int x, int y)
        {
            int idx = (y - minY) * regionW + (x - minX);
            if (!visited[idx]) { visited[idx] = true; queue.Enqueue((x, y)); }
        }

        Enqueue(cx, cy);

        while (queue.Count > 0)
        {
            var (x, y) = queue.Dequeue();
            bitmap.SetPixel(x, y, SKColors.White);

            if (x > minX && IsPixelLight(bitmap, x - 1, y, lightThreshold)) Enqueue(x - 1, y);
            if (x < maxX && IsPixelLight(bitmap, x + 1, y, lightThreshold)) Enqueue(x + 1, y);
            if (y > minY && IsPixelLight(bitmap, x, y - 1, lightThreshold)) Enqueue(x, y - 1);
            if (y < maxY && IsPixelLight(bitmap, x, y + 1, lightThreshold)) Enqueue(x, y + 1);
        }
    }

    private static bool IsPixelLight(SKBitmap bitmap, int x, int y, byte threshold)
    {
        var c = bitmap.GetPixel(x, y);
        return c.Red > threshold && c.Green > threshold && c.Blue > threshold;
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
        RenderTextInBubble(canvas, box, t.TranslatedText, t.FontFamily, t.FontSizeOverride,
            whiteFill: true, t.FontColor, t.StrokeColor, t.StrokeWidth, t.Rotation, t.TextAlign);
        canvas.Flush();

        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    // ── Private render helpers ─────────────────────────────────────────────────

    private static void RenderTextInBubble(
        SKCanvas canvas,
        BubbleBox box,
        string  text,
        string? fontFamily       = null,
        int?    fontSizeOverride = null,
        bool    whiteFill        = true,
        string? fontColor        = null,
        string? strokeColor      = null,
        int?    strokeWidth      = null,
        float?  rotation         = null,
        string? textAlign        = null)
    {
        // Target area = 85 % of the bubble so text has some margin
        float targetW = box.Width  * 0.85f;
        float targetH = box.Height * 0.85f;
        float centerX = box.X + box.Width  / 2f;
        float centerY = box.Y + box.Height / 2f;

        if (targetW < 20 || targetH < 20) return;

        if (whiteFill)
        {
            // White-fill the bubble region (removes original Japanese text).
            // A proper inpaint model (LaMa/diffusion) replaces this step entirely;
            // when inpainted.png already exists, callers should pass whiteFill=false.
            using var fillPaint = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill };
            canvas.DrawRect(box.X, box.Y, box.Width, box.Height, fillPaint);
        }

        var family = string.IsNullOrWhiteSpace(fontFamily) ? "sans-serif" : fontFamily;
        using var typeface = SKTypeface.FromFamilyName(
            family,
            SKFontStyleWeight.Bold,
            SKFontStyleWidth.Normal,
            SKFontStyleSlant.Upright) ?? SKTypeface.Default;

        // Use override size when set and > 0, otherwise binary-search the best fit
        float fontSize = fontSizeOverride is > 0
            ? (float)fontSizeOverride
            : FontMetrics.BestFitFontSize(text, targetW, targetH, minSize: 8f, maxSize: 36f, typeface);

        using var font  = new SKFont(typeface, fontSize);
        var lines = FontMetrics.WordWrap(text, font, targetW);

        float lineH  = fontSize * 1.25f;
        float totalH = lines.Count * lineH;
        float startY = centerY - totalH / 2f + fontSize; // baseline of first line

        // Parse fill color (default #1a1a1a)
        var fillColor = FontMetrics.ParseHexColor(fontColor) ?? new SKColor(26, 26, 26);

        // Clip to the bubble bounds and optionally rotate around the bubble center.
        // When rotation is applied, skip the axis-aligned clip — the rotated text
        // extends outside the original bounding box and would be chopped off.
        canvas.Save();
        if (rotation is not null and not 0f)
            canvas.RotateDegrees(rotation.Value, centerX, centerY);
        else
            canvas.ClipRect(new SKRect(box.X, box.Y, box.X + box.Width, box.Y + box.Height));

        // Draw stroke layer first (if requested)
        var sw = strokeWidth ?? 0;
        if (sw > 0 && !string.IsNullOrEmpty(strokeColor))
        {
            var sc = FontMetrics.ParseHexColor(strokeColor);
            if (sc.HasValue)
            {
                using var strokePaint = new SKPaint
                {
                    Color       = sc.Value,
                    Style       = SKPaintStyle.Stroke,
                    StrokeWidth = sw,
                    IsAntialias = true,
                    StrokeJoin  = SKStrokeJoin.Round,
                };
                for (int i = 0; i < lines.Count; i++)
                {
                    float x = FontMetrics.LineX(lines[i], font, centerX, targetW, textAlign);
                    float y = startY + i * lineH;
                    canvas.DrawText(lines[i], x, y, font, strokePaint);
                }
            }
        }

        // Draw fill layer
        using var textPaint = new SKPaint { Color = fillColor, IsAntialias = true };
        for (int i = 0; i < lines.Count; i++)
        {
            float x = FontMetrics.LineX(lines[i], font, centerX, targetW, textAlign);
            float y = startY + i * lineH;
            canvas.DrawText(lines[i], x, y, font, textPaint);
        }

        canvas.Restore();
    }

    // ── Delegates to FontMetrics ──────────────────────────────────────────────
}
