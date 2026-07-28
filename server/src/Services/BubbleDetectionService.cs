using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using SkiaSharp;

namespace WebOcrServer;

/// <summary>A speech-bubble bounding box in the original image's pixel coordinates.</summary>
/// <param name="X">Left edge, in pixels.</param>
/// <param name="Y">Top edge, in pixels.</param>
/// <param name="Width">Box width, in pixels.</param>
/// <param name="Height">Box height, in pixels.</param>
/// <param name="Confidence">Detection confidence 0–1.</param>
public record BubbleBox(float X, float Y, float Width, float Height, float Confidence);

/// <summary>
/// Speech-bubble detector supporting two ONNX model families:
/// <list type="bullet">
///   <item>RT-DETR (ogkalu/comic-text-and-bubble-detector) — 3 output tensors: labels, boxes, scores</item>
///   <item>YOLOv8 — single output tensor in channels-first or channels-last layout</item>
/// </list>
/// Falls back gracefully — <see cref="Detect"/> returns an empty list when no model is loaded,
/// which the caller (<see cref="PageTranslationService"/>) treats as "no bubbles found"
/// and falls back to treating the whole image as a single region.
/// </summary>
public sealed class BubbleDetectionService : IDisposable
{
    private volatile InferenceSession?               _session;
    private ModelFamily                              _family = ModelFamily.Unknown;
    private readonly ILogger<BubbleDetectionService> _logger;

    private enum ModelFamily { Unknown, RtDetr, YoloV8 }

    public BubbleDetectionService(ILogger<BubbleDetectionService> logger)
    {
        _logger = logger;
    }

    /// <summary>Load (or reload) the ONNX model from disk.</summary>
    public void LoadModel(string modelPath)
    {
        var opts = new Microsoft.ML.OnnxRuntime.SessionOptions();
        opts.GraphOptimizationLevel = GraphOptimizationLevel.ORT_ENABLE_ALL;
        opts.ExecutionMode          = ExecutionMode.ORT_PARALLEL;
        opts.InterOpNumThreads      = Environment.ProcessorCount;
        opts.IntraOpNumThreads      = Environment.ProcessorCount;
        var newSession = new InferenceSession(modelPath, opts);

        // Swap atomically so Detect() never sees a disposed session
        var old = Interlocked.Exchange(ref _session, newSession);
        old?.Dispose();

        // Auto-detect model family from number of outputs
        _family = newSession.OutputMetadata.Count >= 3 ? ModelFamily.RtDetr : ModelFamily.YoloV8;

        _logger.LogInformation(
            "BubbleDetectionService: loaded {Family} model from {Path}  (outputs={N})",
            _family, modelPath, newSession.OutputMetadata.Count);
    }

    /// <summary>Whether a model has been loaded.</summary>
    public bool IsLoaded => _session is not null;

    /// <summary>
    /// Run bubble detection on a PNG image.
    /// Returns pixel-coordinate bounding boxes in the original image dimensions.
    /// Returns an empty list when no model is loaded.
    /// </summary>
    public List<BubbleBox> Detect(byte[] imagePng, float confidenceThreshold = 0.35f, CancellationToken ct = default)
    {
        // Capture session once; field is volatile so this read has acquire semantics
        var session = _session;
        if (session is null) return [];

        using var bitmap = SKBitmap.Decode(imagePng);
        if (bitmap is null) return [];

        return _family == ModelFamily.RtDetr
            ? DetectRtDetr(session, bitmap, confidenceThreshold, ct)
            : DetectYolo(session, bitmap, confidenceThreshold, ct);
    }

    // ── RT-DETR inference ─────────────────────────────────────────────────────
    // Model: ogkalu/comic-text-and-bubble-detector (detector-v4-s_int8.onnx, 11 MB, Apache-2.0)
    // Classes: 0=bubble, 1=text-in-bubble, 2=text-outside-bubble
    // Inputs:  images [1,3,640,640] float32 normalised, orig_target_sizes [1,2] int64 (H, W)
    // Outputs: labels [1,N] int64, boxes [1,N,4] float32 (x1,y1,x2,y2 pixel coords), scores [1,N] float32

    private List<BubbleBox> DetectRtDetr(InferenceSession session, SKBitmap bitmap, float confidenceThreshold, CancellationToken ct)
    {
        const int InputSize = 640;
        int origW = bitmap.Width, origH = bitmap.Height;

        // Letterbox-resize to 640×640
        float scale = Math.Min((float)InputSize / origW, (float)InputSize / origH);
        int scaledW = (int)(origW * scale), scaledH = (int)(origH * scale);
        int padX    = (InputSize - scaledW) / 2, padY = (InputSize - scaledH) / 2;

        using var resized = bitmap.Resize(new SKImageInfo(scaledW, scaledH), new SKSamplingOptions(SKCubicResampler.Mitchell));
        using var padded  = new SKBitmap(new SKImageInfo(InputSize, InputSize, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(padded))
        {
            canvas.Clear(new SKColor(114, 114, 114));
            canvas.DrawBitmap(resized, padX, padY);
        }

        var imgTensor = new DenseTensor<float>([1, 3, InputSize, InputSize]);
        // Use GetPixelSpan for a single contiguous read instead of per-pixel GetPixel calls
        var span = padded.GetPixelSpan();
        for (int y = 0; y < InputSize; y++)
        for (int x = 0; x < InputSize; x++)
        {
            int offset = (y * InputSize + x) * 4; // RGBA8888: R,G,B,A
            imgTensor[0, 0, y, x] = span[offset]     / 255f; // R
            imgTensor[0, 1, y, x] = span[offset + 1] / 255f; // G
            imgTensor[0, 2, y, x] = span[offset + 2] / 255f; // B
        }

        // orig_target_sizes must reflect the padded input dimensions (640×640),
        // as box coordinates are returned in padded-image space.
        var sizeTensor = new DenseTensor<long>([1, 2]);
        sizeTensor[0, 0] = InputSize; // H
        sizeTensor[0, 1] = InputSize; // W

        // Bind by name so order in InputMetadata doesn't matter
        var inputKeys   = session.InputMetadata.Keys.ToList();
        string imgInput  = inputKeys.Find(n => n.Contains("image")) ?? inputKeys[0];
        string sizeInput = inputKeys.Find(n => n.Contains("size") || n.Contains("target")) ?? inputKeys[1];
        var inputs = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor(imgInput, imgTensor),
            NamedOnnxValue.CreateFromTensor(sizeInput, sizeTensor),
        };

        using var outputs = session.Run(inputs);
        var outputList = outputs.ToList();

        // Locate output tensors by name (order: labels, boxes, scores)
        IDisposableReadOnlyCollection<DisposableNamedOnnxValue>? outs = outputs;
        var labelsVal = outputList.FirstOrDefault(o => o.Name.Contains("label")) ?? outputList[0];
        var boxesVal  = outputList.FirstOrDefault(o => o.Name.Contains("box"))   ?? outputList[1];
        var scoresVal = outputList.FirstOrDefault(o => o.Name.Contains("score"))  ?? outputList[2];

        var labels = labelsVal.AsTensor<long>();
        var boxes  = boxesVal.AsTensor<float>();
        var scores = scoresVal.AsTensor<float>();

        int n = scores.Dimensions[1];
        var result = new List<BubbleBox>();

        for (int i = 0; i < n; i++)
        {
            float score = scores[0, i];
            if (score < confidenceThreshold) continue;

            long label = labels[0, i];
            if (label != 0) continue; // class 0 = bubble

            // Boxes are in padded image pixel coords; convert to original image coords
            float x1 = (boxes[0, i, 0] - padX) / scale;
            float y1 = (boxes[0, i, 1] - padY) / scale;
            float x2 = (boxes[0, i, 2] - padX) / scale;
            float y2 = (boxes[0, i, 3] - padY) / scale;

            x1 = Math.Clamp(x1, 0f, origW);
            y1 = Math.Clamp(y1, 0f, origH);
            x2 = Math.Clamp(x2, 0f, origW);
            y2 = Math.Clamp(y2, 0f, origH);

            float bw = x2 - x1, bh = y2 - y1;
            if (bw <= 1f || bh <= 1f) continue;

            result.Add(new BubbleBox(x1, y1, bw, bh, score));
        }

        // NMS first to eliminate overlapping duplicates, then refine surviving boxes
        return Nms(result, iouThreshold: 0.45f)
            .ConvertAll(b => RefineToInnerBoundary(bitmap, b, ct: ct));
    }

    // ── YOLOv8 inference ──────────────────────────────────────────────────────
    // Handles both channels-first [1,5+cls,anchors] and channels-last [1,anchors,5+cls] layouts.

    private List<BubbleBox> DetectYolo(InferenceSession session, SKBitmap bitmap, float confidenceThreshold, CancellationToken ct)
    {
        const int InputSize = 640;
        int origW = bitmap.Width, origH = bitmap.Height;

        float scale = Math.Min((float)InputSize / origW, (float)InputSize / origH);
        int scaledW = (int)(origW * scale), scaledH = (int)(origH * scale);
        int padX    = (InputSize - scaledW) / 2, padY = (InputSize - scaledH) / 2;

        using var resized = bitmap.Resize(new SKImageInfo(scaledW, scaledH), new SKSamplingOptions(SKCubicResampler.Mitchell));
        using var padded  = new SKBitmap(new SKImageInfo(InputSize, InputSize, SKColorType.Rgba8888, SKAlphaType.Premul));
        using (var canvas = new SKCanvas(padded))
        {
            canvas.Clear(new SKColor(114, 114, 114));
            canvas.DrawBitmap(resized, padX, padY);
        }

        var tensor = new DenseTensor<float>([1, 3, InputSize, InputSize]);
        var yoloSpan = padded.GetPixelSpan();
        for (int y = 0; y < InputSize; y++)
        for (int x = 0; x < InputSize; x++)
        {
            int offset = (y * InputSize + x) * 4; // RGBA8888: R,G,B,A
            tensor[0, 0, y, x] = yoloSpan[offset]     / 255f; // R
            tensor[0, 1, y, x] = yoloSpan[offset + 1] / 255f; // G
            tensor[0, 2, y, x] = yoloSpan[offset + 2] / 255f; // B
        }

        var inputs = new List<NamedOnnxValue>
            { NamedOnnxValue.CreateFromTensor(session.InputMetadata.Keys.First(), tensor) };

        using var outputs = session.Run(inputs);
        var output = outputs.First().AsTensor<float>();
        var shape  = output.Dimensions;
        var boxes  = new List<BubbleBox>();

        if (shape.Length == 3)
        {
            int d1 = shape[1], d2 = shape[2];

            // [1, 5, anchors] — channels-first (standard YOLOv8 single-class export)
            if (d1 <= 10 && d2 > 100)
            {
                for (int i = 0; i < d2; i++)
                {
                    float conf = output[0, 4, i];
                    if (conf < confidenceThreshold) continue;
                    boxes.Add(ToPixelBox(
                        output[0, 0, i], output[0, 1, i],
                        output[0, 2, i], output[0, 3, i],
                        conf, padX, padY, scale, origW, origH));
                }
            }
            // [1, anchors, 5+classes] — channels-last
            else if (d2 <= 10 && d1 > 100)
            {
                for (int i = 0; i < d1; i++)
                {
                    float conf = output[0, i, 4];
                    if (conf < confidenceThreshold) continue;
                    boxes.Add(ToPixelBox(
                        output[0, i, 0], output[0, i, 1],
                        output[0, i, 2], output[0, i, 3],
                        conf, padX, padY, scale, origW, origH));
                }
            }
        }

        // NMS first to eliminate overlapping duplicates, then refine surviving boxes
        return Nms(boxes, iouThreshold: 0.45f)
            .ConvertAll(b => RefineToInnerBoundary(bitmap, b, ct: ct));
    }

    // ── Inner-boundary refinement ─────────────────────────────────────────────

    /// <summary>
    /// Refines a model bounding box to the actual white inner region of a speech bubble
    /// by BFS flood-filling bright pixels from the box centre in the original image.
    /// Returns <paramref name="box"/> unchanged when the centre pixel is not bright,
    /// the box area exceeds <see cref="MaxBfsArea"/>, or refinement yields a degenerate rect.
    /// </summary>
    private static BubbleBox RefineToInnerBoundary(
        SKBitmap src, BubbleBox box, byte brightnessThreshold = 200, CancellationToken ct = default)
    {
        int x0 = Math.Max(0, (int)box.X);
        int y0 = Math.Max(0, (int)box.Y);
        int w  = Math.Min((int)box.Width,  src.Width  - x0);
        int h  = Math.Min((int)box.Height, src.Height - y0);
        if (w <= 0 || h <= 0) return box;

        // Guard against unbounded allocation for very large boxes.
        const int MaxBfsArea = 1_000_000; // ~1000×1000 pixels
        if (w * h > MaxBfsArea) return box;

        ct.ThrowIfCancellationRequested();

        bool IsBright(int px, int py)
        {
            if ((uint)px >= (uint)src.Width || (uint)py >= (uint)src.Height) return false;
            var c = src.GetPixel(px, py);
            return c.Red   > brightnessThreshold
                && c.Green > brightnessThreshold
                && c.Blue  > brightnessThreshold;
        }

        // Sample a 3×3 grid of candidate seeds at 25/50/75 % of the box dimensions.
        // The exact centre is often occupied by a text glyph (dark), so we probe
        // multiple points and take the first bright one as the BFS seed.
        (int lx, int ly) seed = (-1, -1);
        for (int gy = 1; gy <= 3 && seed.lx < 0; gy++)
            for (int gx2 = 1; gx2 <= 3 && seed.lx < 0; gx2++)
            {
                int tx = x0 + gx2 * w / 4;
                int ty = y0 + gy  * h / 4;
                if (IsBright(tx, ty))
                    seed = (tx - x0, ty - y0);
            }

        if (seed.lx < 0) return box; // no bright pixel found in bbox

        var visited = new bool[w, h];
        var queue   = new Queue<(int lx, int ly)>();

        visited[seed.lx, seed.ly] = true;
        queue.Enqueue(seed);

        int minX = seed.lx + x0, maxX = minX;
        int minY = seed.ly + y0, maxY = minY;

        void TryExpand(int nx, int ny)
        {
            if ((uint)nx >= (uint)w || (uint)ny >= (uint)h || visited[nx, ny]) return;
            visited[nx, ny] = true;
            if (IsBright(nx + x0, ny + y0)) queue.Enqueue((nx, ny));
        }

        int bfsCount = 0;
        while (queue.Count > 0)
        {
            if (++bfsCount % 1_000 == 0) ct.ThrowIfCancellationRequested();

            var (lx, ly) = queue.Dequeue();
            int gx = lx + x0, gy2 = ly + y0;
            if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
            if (gy2 < minY) minY = gy2; if (gy2 > maxY) maxY = gy2;
            TryExpand(lx + 1, ly);
            TryExpand(lx - 1, ly);
            TryExpand(lx,     ly + 1);
            TryExpand(lx,     ly - 1);
        }

        // Shrink 2 px inward on each side to leave border pixels intact.
        const int EdgeInset = 2;
        minX += EdgeInset; minY += EdgeInset;
        maxX -= EdgeInset; maxY -= EdgeInset;
        if (maxX <= minX || maxY <= minY) return box;

        // +1 converts inclusive pixel coordinates to pixel counts.
        return new BubbleBox(minX, minY, maxX - minX + 1, maxY - minY + 1, box.Confidence);
    }

    // ── Coordinate helpers ────────────────────────────────────────────────────

    private static BubbleBox ToPixelBox(
        float cx, float cy, float w, float h, float conf,
        int padX, int padY, float scale,
        int origW, int origH)
    {
        float x1 = ((cx - w / 2f) - padX) / scale;
        float y1 = ((cy - h / 2f) - padY) / scale;
        float bw = w / scale;
        float bh = h / scale;

        // Clamp origin to image bounds before computing width/height extents
        x1 = Math.Clamp(x1, 0f, origW);
        y1 = Math.Clamp(y1, 0f, origH);
        bw = Math.Clamp(bw, 0f, origW - x1);
        bh = Math.Clamp(bh, 0f, origH - y1);

        return new BubbleBox(x1, y1, bw, bh, conf);
    }

    private static List<BubbleBox> Nms(List<BubbleBox> boxes, float iouThreshold)
    {
        var sorted  = boxes.OrderByDescending(b => b.Confidence).ToList();
        var kept    = new List<BubbleBox>();
        var removed = new bool[sorted.Count];

        for (int i = 0; i < sorted.Count; i++)
        {
            if (removed[i]) continue;
            kept.Add(sorted[i]);
            for (int j = i + 1; j < sorted.Count; j++)
            {
                if (!removed[j] && Iou(sorted[i], sorted[j]) > iouThreshold)
                    removed[j] = true;
            }
        }
        return kept;
    }

    private static float Iou(BubbleBox a, BubbleBox b)
    {
        float ax2 = a.X + a.Width,  ay2 = a.Y + a.Height;
        float bx2 = b.X + b.Width,  by2 = b.Y + b.Height;
        float ix1 = Math.Max(a.X, b.X),  iy1 = Math.Max(a.Y, b.Y);
        float ix2 = Math.Min(ax2, bx2),  iy2 = Math.Min(ay2, by2);
        if (ix2 <= ix1 || iy2 <= iy1) return 0f;
        float inter = (ix2 - ix1) * (iy2 - iy1);
        float union = a.Width * a.Height + b.Width * b.Height - inter;
        return union <= 0f ? 0f : inter / union;
    }

    public void Dispose() => _session?.Dispose();
}
