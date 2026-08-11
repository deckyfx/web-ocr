using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using SkiaSharp;

namespace WebOcrServer;

/// <summary>
/// LaMa ONNX per-bubble inpainting service.
/// For each speech bubble, crops the region (plus a context margin) from the original page,
/// pads (or scales if too large) to the model's fixed 512×512 input, runs LaMa inference,
/// then composites the result back onto the original at full resolution.
/// <para>
/// Callers must dispatch <see cref="InpaintPage"/> via <c>InferenceQueue</c>/<c>InferenceWorker</c>
/// (through <c>InpaintJob</c>) so LaMa shares the same single-reader serialisation budget as
/// OCR and translation and cannot oversubscribe the CPU when running concurrently.
/// </para>
/// </summary>
public sealed class InpaintService(ILogger<InpaintService> logger)
{
    private const int ModelSize     = 512;  // Carve/LaMa-ONNX fixed input
    private const int ContextMargin = 64;   // extra pixels of context around each bubble

    private InferenceSession? _session;

    public bool IsReady => _session is not null;

    /// <summary>Load the LaMa ONNX model from disk.</summary>
    public void LoadModel(string modelPath)
    {
        var opts = new Microsoft.ML.OnnxRuntime.SessionOptions();
        opts.GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL;
        opts.EnableMemoryPattern    = true;
        opts.InterOpNumThreads      = Environment.ProcessorCount;
        opts.IntraOpNumThreads      = Environment.ProcessorCount;
        _session = new InferenceSession(modelPath, opts);
        logger.LogInformation("[Inpaint] Loaded model from {Path}", modelPath);
    }

    /// <summary>
    /// Inpaint each speech bubble using LaMa ONNX.
    /// Processes each bubble independently at the model's native 512×512 resolution,
    /// then composites all results back onto the original full-resolution page.
    /// </summary>
    /// <param name="imagePng">Input PNG bytes (full page, any resolution).</param>
    /// <param name="bubbles">Bubble bounding boxes to inpaint.</param>
    /// <param name="maskDilate">Pixels to expand each bubble mask rectangle inside the 512×512 crop.</param>
    public byte[] InpaintPage(byte[] imagePng, IReadOnlyList<BubbleBox> bubbles, int maskDilate = 4)
    {
        if (_session is null) throw new InvalidOperationException("InpaintService not initialized.");
        if (bubbles.Count == 0) return imagePng;

        using var srcBitmap = SKBitmap.Decode(imagePng);
        if (srcBitmap is null) throw new InvalidOperationException("Failed to decode input image.");

        int origW = srcBitmap.Width;
        int origH = srcBitmap.Height;

        // Work on a mutable BGRA8888 copy of the original that we'll patch bubble by bubble.
        // Force BGRA8888 explicitly: SKBitmap.Decode's color type is platform-dependent,
        // but CopyRegion below does raw BGRA8888 pointer arithmetic.
        using var resultBitmap = srcBitmap.Copy(SKColorType.Bgra8888)
            ?? throw new InvalidOperationException("Failed to convert source bitmap to BGRA8888.");

        foreach (var bubble in bubbles)
        {
            // ── 1. Compute crop rect (bubble + context margin, clamped to image bounds) ──
            int cropX0 = Math.Max(0,       (int)bubble.X                    - ContextMargin);
            int cropY0 = Math.Max(0,       (int)bubble.Y                    - ContextMargin);
            int cropX1 = Math.Min(origW,   (int)(bubble.X + bubble.Width)  + ContextMargin);
            int cropY1 = Math.Min(origH,   (int)(bubble.Y + bubble.Height) + ContextMargin);
            int cropW  = cropX1 - cropX0;
            int cropH  = cropY1 - cropY0;
            if (cropW <= 0 || cropH <= 0) continue;

            // ── 2. Extract crop from original ────────────────────────────────────────────
            using var cropBmp = new SKBitmap(cropW, cropH, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(cropBmp))
            {
                var srcRect = SKRectI.Create(cropX0, cropY0, cropW, cropH);
                canvas.DrawBitmap(srcBitmap, srcRect, SKRect.Create(0, 0, cropW, cropH));
            }

            // ── 3. Prepare 512×512 canvas (pad or scale) ─────────────────────────────────
            double scale = Math.Min(1.0, (double)ModelSize / Math.Max(cropW, cropH));
            int fitW = Math.Max(1, (int)(cropW * scale));
            int fitH = Math.Max(1, (int)(cropH * scale));

            // Scale crop to fit dimensions if needed (upscale or downscale)
            using var fitBmp = cropBmp.Resize(
                new SKImageInfo(fitW, fitH, SKColorType.Bgra8888, SKAlphaType.Opaque),
                new SKSamplingOptions(SKCubicResampler.Mitchell))
                ?? throw new InvalidOperationException($"Failed to resize crop to {fitW}×{fitH}.");

            using var modelBmp = new SKBitmap(ModelSize, ModelSize, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(modelBmp))
            {
                // Fill with white (neutral background for padding area)
                canvas.Clear(SKColors.White);
                // Draw fitted crop top-left inside 512×512
                canvas.DrawBitmap(fitBmp, 0, 0);
            }

            // ── 4. Build 512×512 mask for this bubble ────────────────────────────────────
            // Bubble coords relative to crop, then scaled to fitW/fitH inside 512×512
            float bubRelX0 = bubble.X - cropX0;
            float bubRelY0 = bubble.Y - cropY0;
            float bubRelX1 = bubRelX0 + bubble.Width;
            float bubRelY1 = bubRelY0 + bubble.Height;

            int mx0 = Math.Max(0,           (int)(bubRelX0 * scale) - maskDilate);
            int my0 = Math.Max(0,           (int)(bubRelY0 * scale) - maskDilate);
            int mx1 = Math.Min(ModelSize - 1, (int)(bubRelX1 * scale) + maskDilate);
            int my1 = Math.Min(ModelSize - 1, (int)(bubRelY1 * scale) + maskDilate);

            var maskTensor = new DenseTensor<float>(new[] { 1, 1, ModelSize, ModelSize });
            var maskSpan   = maskTensor.Buffer.Span;
            for (int y = my0; y <= my1; y++)
            for (int x = mx0; x <= mx1; x++)
                maskSpan[y * ModelSize + x] = 1f;

            // ── 5. Convert bitmap → float32 RGB NCHW tensor ──────────────────────────────
            var imageTensor = BgraToRgbTensor(modelBmp);

            // ── 6. Run ONNX inference ─────────────────────────────────────────────────────
            var inputs = new[]
            {
                NamedOnnxValue.CreateFromTensor("image", imageTensor),
                NamedOnnxValue.CreateFromTensor("mask",  maskTensor),
            };

            using var results    = _session.Run(inputs);
            var       outTensor  = results.First().AsTensor<float>();

            // ── 7. Convert output → BGRA bitmap ──────────────────────────────────────────
            using var inpaintedModel = RgbTensorToBgra(outTensor, ModelSize, ModelSize);

            // ── 8. Extract the fitted region and scale back to crop size ──────────────────
            // First crop the fitted area from the 512×512 output (the rest is white padding).
            using var fittedResult = new SKBitmap(fitW, fitH, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(fittedResult))
                canvas.DrawBitmap(inpaintedModel, SKRectI.Create(0, 0, fitW, fitH),
                    SKRect.Create(0, 0, fitW, fitH));

            // Scale fitted result back to the original crop dimensions.
            using var inpaintedCrop = fittedResult.Resize(
                new SKImageInfo(cropW, cropH, SKColorType.Bgra8888, SKAlphaType.Opaque),
                new SKSamplingOptions(SKCubicResampler.Mitchell))
                ?? throw new InvalidOperationException($"Failed to resize inpainted result to {cropW}×{cropH}.");

            // ── 9. Composite: paste only the bubble mask pixels into result ───────────────
            // Clamp to the crop rectangle (not just image bounds) so srcOffsetX/Y passed to
            // CopyRegion are never negative when maskDilate exceeds ContextMargin.
            int bx0 = Math.Max(cropX0, (int)bubble.X - maskDilate);
            int by0 = Math.Max(cropY0, (int)bubble.Y - maskDilate);
            int bx1 = Math.Min(cropX1, (int)(bubble.X + bubble.Width)  + maskDilate);
            int by1 = Math.Min(cropY1, (int)(bubble.Y + bubble.Height) + maskDilate);

            CopyRegion(inpaintedCrop, resultBitmap,
                srcOffsetX: bx0 - cropX0, srcOffsetY: by0 - cropY0,
                dstX: bx0, dstY: by0,
                width: bx1 - bx0, height: by1 - by0);
        }

        using var encoded = resultBitmap.Encode(SKEncodedImageFormat.Png, 100);
        return encoded.ToArray();
    }

    /// <summary>
    /// Inpaint each speech bubble using LaMa ONNX, but use the provided pixel-level text mask
    /// (from <see cref="TextSegmentationService"/>) instead of a coarse bubble rectangle.
    /// This preserves speech-bubble outlines and avoids the white-block artefact.
    /// </summary>
    /// <param name="imagePng">Input PNG bytes (full page, any resolution).</param>
    /// <param name="textMaskPng">Binary mask PNG (white = text ink) at original image resolution.</param>
    /// <param name="bubbles">Bubble bounding boxes defining the crop regions for LaMa.</param>
    /// <param name="maskDilate">Pixels to expand each text mask region inside the 512×512 crop.</param>
    public byte[] InpaintPageWithPixelMask(
        byte[] imagePng, byte[] textMaskPng, IReadOnlyList<BubbleBox> bubbles, int maskDilate = 2)
    {
        if (_session is null) throw new InvalidOperationException("InpaintService not initialized.");
        if (bubbles.Count == 0) return imagePng;

        using var srcBitmap  = SKBitmap.Decode(imagePng)
            ?? throw new InvalidOperationException("Failed to decode input image.");
        using var maskBitmap = SKBitmap.Decode(textMaskPng)
            ?? throw new InvalidOperationException("Failed to decode text mask PNG.");

        int origW = srcBitmap.Width;
        int origH = srcBitmap.Height;

        using var resultBitmap = srcBitmap.Copy(SKColorType.Bgra8888)
            ?? throw new InvalidOperationException("Failed to convert source bitmap to BGRA8888.");

        foreach (var bubble in bubbles)
        {
            // ── 1. Compute crop rect (bubble + context margin, clamped to image bounds) ──
            int cropX0 = Math.Max(0,     (int)bubble.X                    - ContextMargin);
            int cropY0 = Math.Max(0,     (int)bubble.Y                    - ContextMargin);
            int cropX1 = Math.Min(origW, (int)(bubble.X + bubble.Width)  + ContextMargin);
            int cropY1 = Math.Min(origH, (int)(bubble.Y + bubble.Height) + ContextMargin);
            int cropW  = cropX1 - cropX0;
            int cropH  = cropY1 - cropY0;
            if (cropW <= 0 || cropH <= 0) continue;

            // ── 2. Extract image crop ────────────────────────────────────────────────────
            using var cropBmp = new SKBitmap(cropW, cropH, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(cropBmp))
                canvas.DrawBitmap(srcBitmap, SKRectI.Create(cropX0, cropY0, cropW, cropH),
                    SKRect.Create(0, 0, cropW, cropH));

            // ── 3. Prepare 512×512 canvas (pad or scale) ─────────────────────────────────
            double scale = Math.Min(1.0, (double)ModelSize / Math.Max(cropW, cropH));
            int fitW = Math.Max(1, (int)(cropW * scale));
            int fitH = Math.Max(1, (int)(cropH * scale));

            using var fitBmp = cropBmp.Resize(
                new SKImageInfo(fitW, fitH, SKColorType.Bgra8888, SKAlphaType.Opaque),
                new SKSamplingOptions(SKCubicResampler.Mitchell))
                ?? throw new InvalidOperationException($"Failed to resize crop to {fitW}×{fitH}.");

            using var modelBmp = new SKBitmap(ModelSize, ModelSize, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(modelBmp))
            {
                canvas.Clear(SKColors.White);
                canvas.DrawBitmap(fitBmp, 0, 0);
            }

            // ── 4. Extract & scale text mask for this crop ────────────────────────────────
            using var maskCropBmp = new SKBitmap(cropW, cropH, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(maskCropBmp))
            {
                canvas.Clear(SKColors.Black);
                canvas.DrawBitmap(maskBitmap, SKRectI.Create(cropX0, cropY0, cropW, cropH),
                    SKRect.Create(0, 0, cropW, cropH));
            }

            using var maskFitBmp = maskCropBmp.Resize(
                new SKImageInfo(fitW, fitH, SKColorType.Bgra8888, SKAlphaType.Opaque),
                new SKSamplingOptions(SKCubicResampler.Mitchell));

            using var maskModelBmp = new SKBitmap(ModelSize, ModelSize, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(maskModelBmp))
            {
                canvas.Clear(SKColors.Black);
                if (maskFitBmp is not null) canvas.DrawBitmap(maskFitBmp, 0, 0);
            }

            // ── 5. Build float mask tensor — use text pixels, dilated by maskDilate ─────
            var rawMask = ExtractMaskBits(maskModelBmp);
            if (maskDilate > 0) rawMask = DilateMask(rawMask, ModelSize, maskDilate);

            // Skip bubble if no text pixels detected in this region (no inpaint needed)
            bool anyText = false;
            for (int i = 0; i < rawMask.Length; i++) if (rawMask[i]) { anyText = true; break; }
            if (!anyText) continue;

            var maskTensor = new DenseTensor<float>(new[] { 1, 1, ModelSize, ModelSize });
            var maskSpan   = maskTensor.Buffer.Span;
            for (int i = 0; i < ModelSize * ModelSize; i++)
                maskSpan[i] = rawMask[i] ? 1f : 0f;

            // ── 6. Convert image → float32 RGB NCHW tensor ───────────────────────────────
            var imageTensor = BgraToRgbTensor(modelBmp);

            // ── 7. Run ONNX inference ─────────────────────────────────────────────────────
            var inputs = new[]
            {
                NamedOnnxValue.CreateFromTensor("image", imageTensor),
                NamedOnnxValue.CreateFromTensor("mask",  maskTensor),
            };
            using var lamaResults = _session.Run(inputs);
            var       outTensor   = lamaResults.First().AsTensor<float>();

            // ── 8. Convert output → BGRA bitmap ──────────────────────────────────────────
            using var inpaintedModel = RgbTensorToBgra(outTensor, ModelSize, ModelSize);

            // ── 9. Extract fitted region and scale back to crop size ──────────────────────
            using var fittedResult = new SKBitmap(fitW, fitH, SKColorType.Bgra8888, SKAlphaType.Opaque);
            using (var canvas = new SKCanvas(fittedResult))
                canvas.DrawBitmap(inpaintedModel, SKRectI.Create(0, 0, fitW, fitH),
                    SKRect.Create(0, 0, fitW, fitH));

            using var inpaintedCrop = fittedResult.Resize(
                new SKImageInfo(cropW, cropH, SKColorType.Bgra8888, SKAlphaType.Opaque),
                new SKSamplingOptions(SKCubicResampler.Mitchell))
                ?? throw new InvalidOperationException($"Failed to resize inpainted result to {cropW}×{cropH}.");

            // ── 10. Composite: paste ONLY masked (text) pixels from LaMa output ────────────
            // rawMask is in model space (ModelSize×ModelSize). Map each crop pixel (x,y)
            // → model pixel via `scale`, then only overwrite dst where rawMask is true.
            // This preserves bubble outlines and artwork that LaMa would otherwise overwrite.
            MaskComposite(inpaintedCrop, resultBitmap, rawMask, ModelSize, scale,
                cropX0, cropY0, cropW, cropH);
        }

        using var encoded = resultBitmap.Encode(SKEncodedImageFormat.Png, 100);
        return encoded.ToArray();
    }

    /// <summary>Extract a boolean mask from the R channel of a BGRA8888 bitmap (R > 127 = true).</summary>
    private static bool[] ExtractMaskBits(SKBitmap bmp)
    {
        int w        = bmp.Width;
        int h        = bmp.Height;
        var bits     = new bool[w * h];
        int rowBytes = bmp.RowBytes;
        unsafe
        {
            byte* ptr = (byte*)bmp.GetPixels().ToPointer();
            for (int y = 0; y < h; y++)
            {
                byte* row = ptr + (nint)y * rowBytes;
                int   yo  = y * w;
                for (int x = 0; x < w; x++)
                    bits[yo + x] = row[x * 4 + 2] > 127; // R channel
            }
        }
        return bits;
    }

    /// <summary>Morphological dilation of a boolean mask by <paramref name="radius"/> pixels.</summary>
    private static bool[] DilateMask(bool[] mask, int size, int radius)
    {
        var out_ = new bool[size * size];
        for (int y = 0; y < size; y++)
        for (int x = 0; x < size; x++)
        {
            if (!mask[y * size + x]) continue;
            for (int dy = -radius; dy <= radius; dy++)
            for (int dx = -radius; dx <= radius; dx++)
            {
                int ny = y + dy, nx = x + dx;
                if ((uint)ny < (uint)size && (uint)nx < (uint)size)
                    out_[ny * size + nx] = true;
            }
        }
        return out_;
    }

    // ── Private helpers ───────────────────────────────────────────────────────────

    /// <summary>Convert BGRA8888 bitmap to float32 RGB NCHW tensor, normalised to [0,1].</summary>
    private static DenseTensor<float> BgraToRgbTensor(SKBitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
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
                    // SkiaSharp BGRA8888: B=+0, G=+1, R=+2, A=+3
                    int px = x * 4;
                    int i  = yo + x;
                    buf[0 * planeSize + i] = row[px + 2] / 255f; // R
                    buf[1 * planeSize + i] = row[px + 1] / 255f; // G
                    buf[2 * planeSize + i] = row[px]     / 255f; // B
                }
            }
        }
        return tensor;
    }

    /// <summary>Convert float32 RGB NCHW tensor → BGRA8888 bitmap.</summary>
    private static SKBitmap RgbTensorToBgra(Tensor<float> tensor, int w, int h)
    {
        var bmp       = new SKBitmap(w, h, SKColorType.Bgra8888, SKAlphaType.Opaque);
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
                    int i  = yo + x;
                    int px = x * 4;
                    row[px]     = Clamp01(tensor[0, 2, y, x]); // B
                    row[px + 1] = Clamp01(tensor[0, 1, y, x]); // G
                    row[px + 2] = Clamp01(tensor[0, 0, y, x]); // R
                    row[px + 3] = 255;
                }
            }
        }
        return bmp;
    }

    /// <summary>
    /// Copy a rectangular region from <paramref name="src"/> into <paramref name="dst"/>
    /// at the specified destination offset. Both bitmaps must be BGRA8888.
    /// </summary>
    /// <summary>
    /// Copy pixels from <paramref name="src"/> to <paramref name="dst"/> only where
    /// <paramref name="mask"/> (model-space boolean array, size <paramref name="maskSize"/>²)
    /// is <c>true</c>. Coordinates map via <paramref name="scale"/> (crop→model).
    /// </summary>
    private static unsafe void MaskComposite(
        SKBitmap src, SKBitmap dst, bool[] mask, int maskSize, double scale,
        int dstX0, int dstY0, int srcW, int srcH)
    {
        int srcRowBytes = src.RowBytes;
        int dstRowBytes = dst.RowBytes;
        byte* srcPtr    = (byte*)src.GetPixels().ToPointer();
        byte* dstPtr    = (byte*)dst.GetPixels().ToPointer();

        for (int y = 0; y < srcH; y++)
        {
            int dstY = dstY0 + y;
            if ((uint)dstY >= (uint)dst.Height) continue;

            int maskY = Math.Min((int)(y * scale), maskSize - 1);

            byte* srcRow = srcPtr + (nint)y    * srcRowBytes;
            byte* dstRow = dstPtr + (nint)dstY * dstRowBytes;

            for (int x = 0; x < srcW; x++)
            {
                int dstX = dstX0 + x;
                if ((uint)dstX >= (uint)dst.Width) continue;

                int maskX = Math.Min((int)(x * scale), maskSize - 1);
                if (!mask[maskY * maskSize + maskX]) continue; // not a text pixel — preserve original

                int srcOff = x    * 4;
                int dstOff = dstX * 4;
                dstRow[dstOff]     = srcRow[srcOff];
                dstRow[dstOff + 1] = srcRow[srcOff + 1];
                dstRow[dstOff + 2] = srcRow[srcOff + 2];
                dstRow[dstOff + 3] = srcRow[srcOff + 3];
            }
        }
    }

    private static unsafe void CopyRegion(
        SKBitmap src, SKBitmap dst,
        int srcOffsetX, int srcOffsetY,
        int dstX, int dstY,
        int width, int height)
    {
        int srcRowBytes = src.RowBytes;
        int dstRowBytes = dst.RowBytes;
        byte* srcPtr    = (byte*)src.GetPixels().ToPointer();
        byte* dstPtr    = (byte*)dst.GetPixels().ToPointer();

        for (int row = 0; row < height; row++)
        {
            int sy = srcOffsetY + row;
            int dy = dstY + row;
            if (sy < 0 || sy >= src.Height || dy < 0 || dy >= dst.Height) continue;

            byte* srcRow = srcPtr + (nint)sy * srcRowBytes + (nint)srcOffsetX * 4;
            byte* dstRow = dstPtr + (nint)dy * dstRowBytes + (nint)dstX * 4;

            int copyW = Math.Min(width,
                Math.Min(src.Width  - srcOffsetX, dst.Width  - dstX));
            if (copyW <= 0) continue;

            Buffer.MemoryCopy(srcRow, dstRow, (long)copyW * 4, (long)copyW * 4);
        }
    }

    private static byte Clamp01(float v)
        => v <= 0f ? (byte)0 : v >= 1f ? (byte)255 : (byte)(v * 255f + 0.5f);
}
