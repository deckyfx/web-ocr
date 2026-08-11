using System.Collections.Concurrent;
using SkiaSharp;

namespace WebOcrServer;

/// <summary>
/// Helper methods and shared state for <see cref="PageTranslationService"/>.
/// </summary>
public static class PageTranslationHelpers
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> ImageLocks = new();

    /// <summary>Per-job image lock (serialises rerender/reinpaint/repatch).</summary>
    public static SemaphoreSlim GetImageLock(string jobId) =>
        ImageLocks.GetOrAdd(jobId, _ => new SemaphoreSlim(1, 1));

    /// <summary>Crops an image to a bubble box with optional padding.</summary>
    public static byte[] CropBubble(byte[] imagePng, BubbleBox box, float padding)
    {
        using var src = SKBitmap.Decode(imagePng);
        if (src is null) return imagePng;

        float padX = box.Width  * padding;
        float padY = box.Height * padding;

        int x = Math.Max(0, (int)(box.X - padX));
        int y = Math.Max(0, (int)(box.Y - padY));
        int w = Math.Min(src.Width  - x, (int)(box.Width  + padX * 2));
        int h = Math.Min(src.Height - y, (int)(box.Height + padY * 2));

        if (w <= 0 || h <= 0) return imagePng;

        using var cropped = new SKBitmap(w, h);
        using var canvas  = new SKCanvas(cropped);
        canvas.DrawBitmap(src, new SKRect(x, y, x + w, y + h), new SKRect(0, 0, w, h));
        canvas.Flush();

        using var img  = SKImage.FromBitmap(cropped);
        using var data = img.Encode(SKEncodedImageFormat.Png, 95);
        return data.ToArray();
    }

    /// <summary>Returns true when a TextSeg block's center point lies inside at least one bubble box.</summary>
    public static bool IsInsideAnyBubble(BubbleBox block, IReadOnlyList<BubbleBox> bubbles)
    {
        float cx = block.X + block.Width  / 2f;
        float cy = block.Y + block.Height / 2f;
        return bubbles.Any(b =>
            cx >= b.X && cx <= b.X + b.Width &&
            cy >= b.Y && cy <= b.Y + b.Height);
    }

    /// <summary>
    /// Finds the best typesetting target for a text region.
    /// If a detected bubble box contains the text region's centre, return that bubble box.
    /// Otherwise return the text region itself.
    /// </summary>
    public static BubbleBox GetTypesettingBox(BubbleBox textRegion, IReadOnlyList<BubbleBox> bubbles)
    {
        float cx = textRegion.X + textRegion.Width  / 2f;
        float cy = textRegion.Y + textRegion.Height / 2f;
        foreach (var bubble in bubbles)
        {
            if (cx >= bubble.X && cx <= bubble.X + bubble.Width &&
                cy >= bubble.Y && cy <= bubble.Y + bubble.Height)
                return bubble;
        }
        return textRegion;
    }
}

/// <summary>
/// Equality comparer for <see cref="BubbleBox"/> that treats two boxes as
/// identical when their rounded integer coordinates match.
/// </summary>
public sealed class BubbleBoxComparer : IEqualityComparer<BubbleBox>
{
    public static readonly BubbleBoxComparer Instance = new();

    public bool Equals(BubbleBox? a, BubbleBox? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;
        return (int)a.X == (int)b.X && (int)a.Y == (int)b.Y
            && (int)a.Width == (int)b.Width && (int)a.Height == (int)b.Height;
    }

    public int GetHashCode(BubbleBox box) =>
        HashCode.Combine((int)box.X, (int)box.Y, (int)box.Width, (int)box.Height);
}
