using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using SkiaSharp;

namespace WebOcrDesktop.Services;

/// <summary>
/// Cross-platform screen capture. Captures the primary monitor as PNG bytes
/// and provides a crop utility. Linux: X11 P/Invoke. Windows: GDI BitBlt.
/// Pixel conversion uses SkiaSharp (already a transitive Avalonia dependency).
/// </summary>
public sealed class ScreenCaptureService
{
    public async Task<byte[]> CaptureAsync()
    {
        return await Task.Run(() =>
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
                ? CaptureWindows()
                : CaptureLinuxX11());
    }

    /// <summary>Crops a PNG and re-encodes it. Coordinates are in screen pixels.</summary>
    public byte[] CropPng(byte[] png, int x, int y, int width, int height)
    {
        using var src = SKBitmap.Decode(png);

        // Clamp to image bounds
        x      = Math.Max(0, Math.Min(x,      src.Width  - 1));
        y      = Math.Max(0, Math.Min(y,      src.Height - 1));
        width  = Math.Max(1, Math.Min(width,  src.Width  - x));
        height = Math.Max(1, Math.Min(height, src.Height - y));

        using var dst    = new SKBitmap(width, height);
        using var canvas = new SKCanvas(dst);
        // Drawing src offset to (-x, -y) makes pixel (x,y) land at canvas origin
        canvas.DrawBitmap(src, -x, -y);
        canvas.Flush();

        using var image = SKImage.FromBitmap(dst);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    // ── Windows ──────────────────────────────────────────────────────────────

    private static byte[] CaptureWindows()
    {
        int w = GetSystemMetrics(SM_CXSCREEN);
        int h = GetSystemMetrics(SM_CYSCREEN);

        nint hScreen = GetDC(0);
        nint hDC     = CreateCompatibleDC(hScreen);
        nint hBitmap = CreateCompatibleBitmap(hScreen, w, h);
        nint hOld    = SelectObject(hDC, hBitmap);

        BitBlt(hDC, 0, 0, w, h, hScreen, 0, 0, SRCCOPY);
        SelectObject(hDC, hOld);

        var bi    = new BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32, biCompression = 0 };
        var bytes = new byte[w * h * 4];
        GetDIBits(hDC, hBitmap, 0, (uint)h, bytes, ref bi, DIB_RGB_COLORS);

        DeleteObject(hBitmap);
        DeleteDC(hDC);
        ReleaseDC(0, hScreen);

        return BgraToPng(bytes, w, h);
    }

    // ── Linux X11 ────────────────────────────────────────────────────────────

    private static byte[] CaptureLinuxX11()
    {
        nint display = XOpenDisplay(0);
        if (display == 0) throw new InvalidOperationException("Cannot open X11 display");

        int  screen = XDefaultScreen(display);
        nint root   = XRootWindow(display, screen);

        XGetWindowAttributes(display, root, out var attrs);
        int w = attrs.width;
        int h = attrs.height;

        // ZPixmap=2, AllPlanes=0xFFFFFFFFFFFFFFFF
        nint ximg = XGetImage(display, root, 0, 0, (uint)w, (uint)h, 0xFFFFFFFFFFFFFFFF, 2);
        if (ximg == 0)
        {
            XCloseDisplay(display);
            throw new InvalidOperationException("XGetImage returned null");
        }

        // XImage layout: data ptr at offset 16, bytes_per_line at offset 36
        nint dataPtr = Marshal.ReadIntPtr(ximg, 16);
        int  bpl     = Marshal.ReadInt32(ximg, 36);

        var raw = new byte[bpl * h];
        Marshal.Copy(dataPtr, raw, 0, raw.Length);

        XDestroyImage(ximg);
        XCloseDisplay(display);

        // X11 ZPixmap = BGRA/BGRx 32-bit
        return BgraToPng(raw[..(w * h * 4)], w, h);
    }

    // ── Pixel conversion ─────────────────────────────────────────────────────

    /// <summary>Converts a raw BGRA byte array to a PNG-encoded byte array.</summary>
    private static byte[] BgraToPng(byte[] bgraBytes, int w, int h)
    {
        var info = new SKImageInfo(w, h, SKColorType.Bgra8888, SKAlphaType.Premul);
        using var bitmap = new SKBitmap(info);
        Marshal.Copy(bgraBytes, 0, bitmap.GetPixels(), bgraBytes.Length);
        using var image = SKImage.FromBitmap(bitmap);
        using var data  = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    // ── X11 P/Invoke ─────────────────────────────────────────────────────────

    [StructLayout(LayoutKind.Sequential)]
    private struct XWindowAttributes { public int x, y, width, height; }

    [DllImport("libX11.so.6")] private static extern nint XOpenDisplay(nint displayName);
    [DllImport("libX11.so.6")] private static extern int  XDefaultScreen(nint display);
    [DllImport("libX11.so.6")] private static extern nint XRootWindow(nint display, int screen);
    [DllImport("libX11.so.6")] private static extern int  XGetWindowAttributes(nint display, nint window, out XWindowAttributes attrs);
    [DllImport("libX11.so.6")] private static extern nint XGetImage(nint display, nint drawable, int x, int y, uint width, uint height, ulong planeMask, int format);
    [DllImport("libX11.so.6")] private static extern void XDestroyImage(nint image);
    [DllImport("libX11.so.6")] private static extern void XCloseDisplay(nint display);

    // ── Windows GDI P/Invoke ─────────────────────────────────────────────────

    const int SM_CXSCREEN    = 0;
    const int SM_CYSCREEN    = 1;
    const int SRCCOPY        = 0x00CC0020;
    const int DIB_RGB_COLORS = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER { public int biSize, biWidth, biHeight; public short biPlanes, biBitCount; public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant; }

    [DllImport("user32.dll")] private static extern int  GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")] private static extern nint GetDC(nint hwnd);
    [DllImport("user32.dll")] private static extern int  ReleaseDC(nint hwnd, nint hdc);
    [DllImport("gdi32.dll")]  private static extern nint CreateCompatibleDC(nint hdc);
    [DllImport("gdi32.dll")]  private static extern nint CreateCompatibleBitmap(nint hdc, int w, int h);
    [DllImport("gdi32.dll")]  private static extern nint SelectObject(nint hdc, nint hgdiobj);
    [DllImport("gdi32.dll")]  private static extern bool BitBlt(nint hdc, int x, int y, int w, int h, nint hdcSrc, int xs, int ys, int rop);
    [DllImport("gdi32.dll")]  private static extern int  GetDIBits(nint hdc, nint hbmp, uint start, uint lines, byte[] bits, ref BITMAPINFOHEADER bi, int usage);
    [DllImport("gdi32.dll")]  private static extern bool DeleteObject(nint hgdiobj);
    [DllImport("gdi32.dll")]  private static extern bool DeleteDC(nint hdc);
}
