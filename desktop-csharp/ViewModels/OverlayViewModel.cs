using System;
using Avalonia;
using CommunityToolkit.Mvvm.ComponentModel;

namespace WebOcrDesktop.ViewModels;

public partial class OverlayViewModel : ObservableObject
{
    [ObservableProperty] private double _canvasWidth  = 1920;
    [ObservableProperty] private double _canvasHeight = 1080;

    // Selection in canvas (display) pixels
    [ObservableProperty] [NotifyPropertyChangedFor(nameof(SelectionRect))] private Point _selectionStart;
    [ObservableProperty] [NotifyPropertyChangedFor(nameof(SelectionRect))] private Point _selectionEnd;
    [ObservableProperty] private bool _isSelecting;

    public Rect SelectionRect
    {
        get
        {
            double x = Math.Min(SelectionStart.X, SelectionEnd.X);
            double y = Math.Min(SelectionStart.Y, SelectionEnd.Y);
            double w = Math.Abs(SelectionEnd.X - SelectionStart.X);
            double h = Math.Abs(SelectionEnd.Y - SelectionStart.Y);
            return new Rect(x, y, w, h);
        }
    }

    public string DimensionLabel =>
        IsSelecting && SelectionRect.Width > 4 && SelectionRect.Height > 4
            ? $"{(int)SelectionRect.Width}×{(int)SelectionRect.Height}"
            : "";

    public bool HasValidSelection => SelectionRect.Width > 4 && SelectionRect.Height > 4;

    public void BeginSelection(Point pt)
    {
        SelectionStart = pt;
        SelectionEnd   = pt;
        IsSelecting    = true;
    }

    public void UpdateSelection(Point pt)
    {
        SelectionEnd = pt;
        OnPropertyChanged(nameof(DimensionLabel));
    }

    public void EndSelection(Point pt)
    {
        SelectionEnd = pt;
        IsSelecting  = false;
        OnPropertyChanged(nameof(DimensionLabel));
    }

    public void Reset()
    {
        SelectionStart = default;
        SelectionEnd   = default;
        IsSelecting    = false;
        OnPropertyChanged(nameof(DimensionLabel));
    }
}
