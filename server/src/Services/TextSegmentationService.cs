using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using SkiaSharp;

namespace WebOcrServer;

/// <summary>
/// Combined result from <see cref="TextSegmentationService.SegmentText"/>:
/// the binary ink mask and tight bounding boxes around each text cluster.
/// </summary>
/// <param name="Mask">PNG-encoded binary mask (white = text ink, black = background) at original resolution.</param>
/// <param name="TextBlocks">
/// Tight bounding boxes around detected text clusters derived from connected-component analysis of the mask.
/// Used in place of bubble-detector boxes for OCR, inpaint region selection, and typesetting.
/// </param>
public record TextSegResult(byte[] Mask, IReadOnlyList<BubbleBox> TextBlocks);

/// <summary>
/// Text-pixel segmentation using the comictextdetector ONNX model
/// (zyddnys/manga-image-translator, MIT licence).
/// <para>
/// Returns a binary pixel mask (white = text ink, black = background) at the original image
/// resolution. The mask feeds directly into <see cref="InpaintService.InpaintPageWithPixelMask"/>,
/// replacing coarse bubble rectangles with character-accurate ink coverage and preserving
/// speech-bubble outlines.
/// </para>
/// <para>
/// Model I/O: input <c>[1,3,1024,1024]</c> RGB float32 letterboxed to [0,1];
/// outputs <c>blks</c> (YOLO detections), <c>mask</c> (<c>[1,1,H,W]</c> float32 sigmoid),
/// <c>lines_map</c> (<c>[1,2,H,W]</c> DBNet). Some ONNX versions swap mask and lines_map —
/// detected by channel count.
/// </para>
/// </summary>
public sealed class TextSegmentationService(ILogger<TextSegmentationService> logger)
{
    private const int   ModelInput     = 1024;
    private const float MaskThreshold  = 0.3f;
    private const byte  LetterboxGray  = 114; // ImageNet convention padding colour

    private InferenceSession? _session;
    private string?           _inputName;

    public bool IsReady => _session is not null;

    /// <summary>Load the comictextdetector ONNX model from disk.</summary>
    public void LoadModel(string modelPath)
    {
        var opts = new Microsoft.ML.OnnxRuntime.SessionOptions
        {
            GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL,
            EnableMemoryPattern    = true,
            InterOpNumThreads      = Environment.ProcessorCount,
            IntraOpNumThreads      = Environment.ProcessorCount,
        };
        _session   = new InferenceSession(modelPath, opts);
        _inputName = _session.InputNames[0]; // typically "images" for YOLO-style models
        logger.LogInformation("[TextSeg] Loaded model from {Path}; input node={Name}", modelPath, _inputName);
    }

    // Connected-component analysis tuning constants
    private const int MinComponentArea = 100; // pixels — filter noise/dust
    private const int MergeDistance    = 50;  // pixels — merge text within same bubble
    private const int BoxPadding       = 15;  // pixels — context margin added to each text block

    /// <summary>
    /// Segment text pixels on a manga page.
    /// Returns the binary ink mask AND tight bounding boxes around each text cluster
    /// derived from connected-component analysis of the mask.
    /// </summary>
    public TextSegResult SegmentText(byte[] imagePng)
    {
        if (_session is null) throw new InvalidOperationException("TextSegmentationService not initialized.");

        using var src = SKBitmap.Decode(imagePng)
            ?? throw new InvalidOperationException("Failed to decode image PNG.");

        int origW = src.Width;
        int origH = src.Height;

        // ── 1. Letterbox image to ModelInput × ModelInput ─────────────────────────
        double scale  = Math.Min((double)ModelInput / origH, (double)ModelInput / origW);
        int    newW   = (int)Math.Round(origW * scale);
        int    newH   = (int)Math.Round(origH * scale);
        int    padLeft = (int)Math.Round((ModelInput - newW) / 2.0 - 0.1);
        int    padTop  = (int)Math.Round((ModelInput - newH) / 2.0 - 0.1);

        using var letterboxed = BuildLetterbox(src, newW, newH, padLeft, padTop);

        // ── 2. Convert to float32 RGB NCHW [0,1] tensor ───────────────────────────
        var inputTensor = BgraToRgbNchw(letterboxed);
        var inputs      = new[] { NamedOnnxValue.CreateFromTensor(_inputName!, inputTensor) };

        // ── 3. Run ONNX inference ──────────────────────────────────────────────────
        using var results = _session.Run(inputs, _session.OutputNames);

        // ── 4. Identify the segmentation mask output (1 channel) ──────────────────
        // Expected order: results[0]=blks, results[1]=mask, results[2]=lines_map.
        // Some runtime versions swap mask↔lines_map; detect by channel count (mask=1, lines=2).
        var out1 = results.Count > 1 ? results[1].AsTensor<float>() : null;
        var out2 = results.Count > 2 ? results[2].AsTensor<float>() : null;

        Tensor<float>? maskTensor = out1 is not null && out1.Dimensions[1] == 1 ? out1
                                  : out2 is not null && out2.Dimensions[1] == 1 ? out2
                                  : out1; // fallback — take whatever is there

        if (maskTensor is null)
            throw new InvalidOperationException("comictextdetector produced no usable mask output.");

        int mH = maskTensor.Dimensions[2];
        int mW = maskTensor.Dimensions[3];

        // ── 5. Threshold the mask at model output resolution ──────────────────────
        using var modelMaskBmp = BuildBinaryMask(maskTensor, mW, mH);

        // ── 6. Crop out letterbox padding, resize to original dimensions ──────────
        // Content occupies [padTop:padTop+newH, padLeft:padLeft+newW] in the 1024×1024 space.
        // Model output is at mW×mH (may differ from 1024 at stride >1); scale offsets accordingly.
        double mScale  = mW == ModelInput ? 1.0 : (double)mW / ModelInput;
        int    cLeft   = (int)Math.Round(padLeft * mScale);
        int    cTop    = (int)Math.Round(padTop  * mScale);
        int    cW      = Math.Max(1, Math.Min(mW - cLeft, (int)Math.Round(newW * mScale)));
        int    cH      = Math.Max(1, Math.Min(mH - cTop,  (int)Math.Round(newH * mScale)));

        using var contentMask = new SKBitmap(cW, cH, SKColorType.Bgra8888, SKAlphaType.Opaque);
        using (var c = new SKCanvas(contentMask))
            c.DrawBitmap(modelMaskBmp, SKRectI.Create(cLeft, cTop, cW, cH), SKRect.Create(0, 0, cW, cH));

        using var finalMask = contentMask.Resize(
            new SKImageInfo(origW, origH, SKColorType.Bgra8888, SKAlphaType.Opaque),
            new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.None))
            ?? throw new InvalidOperationException("Failed to resize text segmentation mask.");

        // Re-threshold after bilinear resize (interpolated edges produce mid-gray values).
        RethresholdMask(finalMask);

        var textBlocks = FindTextBlocks(finalMask, origW, origH);

        using var encoded = finalMask.Encode(SKEncodedImageFormat.Png, 100);
        return new TextSegResult(encoded.ToArray(), textBlocks);
    }

    // ── Private helpers ───────────────────────────────────────────────────────────

    /// <summary>Create a 1024×1024 BGRA8888 letterbox canvas with gray fill.</summary>
    private static SKBitmap BuildLetterbox(SKBitmap src, int newW, int newH, int padLeft, int padTop)
    {
        var bmp = new SKBitmap(ModelInput, ModelInput, SKColorType.Bgra8888, SKAlphaType.Opaque);
        using var canvas = new SKCanvas(bmp);
        canvas.Clear(new SKColor(LetterboxGray, LetterboxGray, LetterboxGray));
        using var resized = src.Resize(
            new SKImageInfo(newW, newH, SKColorType.Bgra8888, SKAlphaType.Opaque),
            new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.None))
            ?? throw new InvalidOperationException($"Failed to resize source image to {newW}×{newH}.");
        canvas.DrawBitmap(resized, padLeft, padTop);
        return bmp;
    }

    /// <summary>Convert BGRA8888 bitmap to float32 RGB NCHW tensor normalised to [0,1].</summary>
    private static DenseTensor<float> BgraToRgbNchw(SKBitmap bmp)
    {
        int w         = bmp.Width;
        int h         = bmp.Height;
        var tensor    = new DenseTensor<float>(new[] { 1, 3, h, w });
        var buf       = tensor.Buffer.Span;
        int planeSize = h * w;
        int rowBytes  = bmp.RowBytes;
        unsafe
        {
            byte* ptr = (byte*)bmp.GetPixels().ToPointer();
            for (int y = 0; y < h; y++)
            {
                byte* row = ptr + (nint)y * rowBytes;
                int   yo  = y * w;
                for (int x = 0; x < w; x++)
                {
                    int px = x * 4;
                    int i  = yo + x;
                    // SkiaSharp BGRA8888: B=+0, G=+1, R=+2, A=+3
                    buf[0 * planeSize + i] = row[px + 2] / 255f; // R
                    buf[1 * planeSize + i] = row[px + 1] / 255f; // G
                    buf[2 * planeSize + i] = row[px]     / 255f; // B
                }
            }
        }
        return tensor;
    }

    /// <summary>
    /// Threshold float32 [1,1,H,W] mask tensor at <see cref="MaskThreshold"/>
    /// into a BGRA8888 bitmap (white = text, black = background).
    /// </summary>
    private static SKBitmap BuildBinaryMask(Tensor<float> maskTensor, int w, int h)
    {
        var bmp      = new SKBitmap(w, h, SKColorType.Bgra8888, SKAlphaType.Opaque);
        int rowBytes = bmp.RowBytes;
        unsafe
        {
            byte* ptr = (byte*)bmp.GetPixels().ToPointer();
            for (int y = 0; y < h; y++)
            {
                byte* row = ptr + (nint)y * rowBytes;
                for (int x = 0; x < w; x++)
                {
                    // mask tensor shape is [1,1,H,W]
                    byte v  = maskTensor[0, 0, y, x] > MaskThreshold ? (byte)255 : (byte)0;
                    int  px = x * 4;
                    row[px]     = v; // B
                    row[px + 1] = v; // G
                    row[px + 2] = v; // R
                    row[px + 3] = 255;
                }
            }
        }
        return bmp;
    }

    /// <summary>Re-binarize a BGRA8888 mask in-place (R channel > 127 → white, else black).</summary>
    private static void RethresholdMask(SKBitmap bmp)
    {
        int rowBytes = bmp.RowBytes;
        unsafe
        {
            byte* ptr = (byte*)bmp.GetPixels().ToPointer();
            for (int y = 0; y < bmp.Height; y++)
            {
                byte* row = ptr + (nint)y * rowBytes;
                for (int x = 0; x < bmp.Width; x++)
                {
                    byte v    = row[x * 4 + 2] > 127 ? (byte)255 : (byte)0; // R channel
                    int  px   = x * 4;
                    row[px]     = v;
                    row[px + 1] = v;
                    row[px + 2] = v;
                    row[px + 3] = 255;
                }
            }
        }
    }

    /// <summary>
    /// Finds tight bounding boxes around text clusters in a binary mask bitmap
    /// using connected-component analysis followed by proximity-based merging.
    /// </summary>
    /// <param name="maskBmp">Binary BGRA8888 mask (white = text, black = background) at original resolution.</param>
    /// <param name="imgW">Original image width — used to clamp padded box bounds.</param>
    /// <param name="imgH">Original image height — used to clamp padded box bounds.</param>
    private static IReadOnlyList<BubbleBox> FindTextBlocks(SKBitmap maskBmp, int imgW, int imgH)
    {
        int w = maskBmp.Width, h = maskBmp.Height;

        // ── 1. Read text pixels into flat bool array ──────────────────────────
        bool[] isText  = new bool[w * h];
        int rowBytes   = maskBmp.RowBytes;
        unsafe
        {
            byte* ptr = (byte*)maskBmp.GetPixels().ToPointer();
            for (int y = 0; y < h; y++)
            {
                byte* row = ptr + (nint)y * rowBytes;
                for (int x = 0; x < w; x++)
                    isText[y * w + x] = row[x * 4 + 2] > 127; // R channel
            }
        }

        // ── 2. BFS connected components (8-connectivity) ──────────────────────
        bool[] visited    = new bool[w * h];
        var    components = new List<(int X, int Y, int W, int H)>();
        var    bfsQueue   = new Queue<int>(4096);

        for (int i = 0; i < w * h; i++)
        {
            if (!isText[i] || visited[i]) continue;

            int minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
            bfsQueue.Clear();
            bfsQueue.Enqueue(i);
            visited[i] = true;

            while (bfsQueue.Count > 0)
            {
                int idx = bfsQueue.Dequeue();
                int cx  = idx % w, cy = idx / w;
                if (cx < minX) minX = cx;
                if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy;
                if (cy > maxY) maxY = cy;
                area++;

                for (int dy = -1; dy <= 1; dy++)
                for (int dx = -1; dx <= 1; dx++)
                {
                    if (dx == 0 && dy == 0) continue;
                    int nx = cx + dx, ny = cy + dy;
                    if ((uint)nx >= (uint)w || (uint)ny >= (uint)h) continue;
                    int ni = ny * w + nx;
                    if (isText[ni] && !visited[ni])
                    {
                        visited[ni] = true;
                        bfsQueue.Enqueue(ni);
                    }
                }
            }

            if (area >= MinComponentArea)
                components.Add((minX, minY, maxX - minX + 1, maxY - minY + 1));
        }

        if (components.Count == 0) return [];

        // ── 3. Merge components within MergeDistance of each other ───────────
        // Use value tuples (X, Y, W, H) for mutable list of candidate boxes.
        var rects = new List<(int X, int Y, int W, int H)>(components);

        bool anyMerged = true;
        while (anyMerged)
        {
            anyMerged = false;
            for (int i = 0; i < rects.Count; i++)
            {
                for (int j = i + 1; j < rects.Count; j++)
                {
                    var (ax, ay, aw, ah) = rects[i];
                    var (bx, by, bw, bh) = rects[j];
                    // Gap = 0 when rectangles overlap; negative values clamped to 0.
                    int gapX = Math.Max(0, Math.Max(ax, bx) - Math.Min(ax + aw, bx + bw));
                    int gapY = Math.Max(0, Math.Max(ay, by) - Math.Min(ay + ah, by + bh));
                    if (gapX <= MergeDistance && gapY <= MergeDistance)
                    {
                        int newX = Math.Min(ax, bx);
                        int newY = Math.Min(ay, by);
                        int newR = Math.Max(ax + aw, bx + bw);
                        int newB = Math.Max(ay + ah, by + bh);
                        rects[i] = (newX, newY, newR - newX, newB - newY);
                        rects.RemoveAt(j);
                        j--;
                        anyMerged = true;
                    }
                }
            }
        }

        // ── 4. Add padding, clamp to image bounds, convert to BubbleBox ──────
        var result = new List<BubbleBox>(rects.Count);
        foreach (var (rx, ry, rw, rh) in rects)
        {
            int x = Math.Max(0, rx - BoxPadding);
            int y = Math.Max(0, ry - BoxPadding);
            int r = Math.Min(imgW, rx + rw + BoxPadding);
            int b = Math.Min(imgH, ry + rh + BoxPadding);
            result.Add(new BubbleBox(x, y, r - x, b - y, 1f));
        }
        return result;
    }
}
