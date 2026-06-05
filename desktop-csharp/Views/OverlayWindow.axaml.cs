using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Threading;
using WebOcrDesktop.ViewModels;

namespace WebOcrDesktop.Views;

public partial class OverlayWindow : Window
{
    private OverlayViewModel? _vm;
    private bool _dragging;

    public event Action<int, int, int, int>? RegionSelected;
    public event Action? Cancelled;

    public OverlayWindow()
    {
        InitializeComponent();
    }

    public void ShowWithScreenshot(Bitmap screenshot)
    {
        _vm = new OverlayViewModel
        {
            CanvasWidth  = screenshot.PixelSize.Width,
            CanvasHeight = screenshot.PixelSize.Height,
        };
        DataContext = _vm;

        // Set screenshot as image source
        ScreenshotImage.Source = screenshot;

        _vm.Reset();

        // Position and size window to fill primary screen
        var screen = Screens.Primary;
        if (screen is not null)
        {
            Position = new PixelPoint(screen.Bounds.X, screen.Bounds.Y);
            Width    = screen.Bounds.Width;
            Height   = screen.Bounds.Height;
        }

        WindowState = WindowState.FullScreen;
        Show();
        Activate();
        Focus();
    }

    protected override void OnPointerPressed(PointerPressedEventArgs e)
    {
        base.OnPointerPressed(e);
        if (e.GetCurrentPoint(OverlayCanvas).Properties.IsLeftButtonPressed)
        {
            _dragging = true;
            e.Pointer.Capture(OverlayCanvas);
            _vm?.BeginSelection(e.GetPosition(OverlayCanvas));
        }
    }

    protected override void OnPointerMoved(PointerEventArgs e)
    {
        base.OnPointerMoved(e);
        if (_dragging) _vm?.UpdateSelection(e.GetPosition(OverlayCanvas));
    }

    protected override void OnPointerReleased(PointerReleasedEventArgs e)
    {
        base.OnPointerReleased(e);
        if (!_dragging) return;
        _dragging = false;
        e.Pointer.Capture(null);

        _vm?.EndSelection(e.GetPosition(OverlayCanvas));

        if (_vm?.HasValidSelection == true)
        {
            var r = _vm.SelectionRect;

            // Scale display coords → actual screenshot pixel coords
            double scaleX = (_vm.CanvasWidth)  / Width;
            double scaleY = (_vm.CanvasHeight) / Height;

            int x = (int)(r.X      * scaleX);
            int y = (int)(r.Y      * scaleY);
            int w = (int)(r.Width  * scaleX);
            int h = (int)(r.Height * scaleY);

            Hide();
            RegionSelected?.Invoke(x, y, w, h);
        }
    }

    protected override void OnPointerCaptureLost(PointerCaptureLostEventArgs e)
    {
        base.OnPointerCaptureLost(e);
        if (!_dragging) return;
        _dragging = false;
        _vm?.Reset(); // treat lost capture the same as Escape — cancel the selection
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.Key == Key.Escape)
        {
            _dragging = false;
            _vm?.Reset();
            Hide();
            Cancelled?.Invoke();
        }
    }
}
