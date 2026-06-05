using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;

namespace WebOcrDesktop.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
    }

    private void OnHideClick(object? sender, RoutedEventArgs e) => Hide();

    private void OnSettingsClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not ViewModels.MainViewModel vm) return;
        var win = new SettingsWindow();
        win.LoadSettings(vm.Settings);
        win.SettingsSaved += s => vm.SaveSettingsCommand.Execute(s);
        win.ShowDialog(this);
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        // Intercept close — hide to tray instead
        e.Cancel = true;
        Hide();
    }

    /// <summary>Positions the window near the bottom-right of the primary screen.</summary>
    public void PositionNearTray()
    {
        var screen = Screens.Primary;
        if (screen is null) return;

        // Height is NaN until SizeToContent has run (first layout pass).
        // Use MinHeight as fallback so the window always lands on-screen.
        var h  = double.IsNaN(Height) || Height < 1.0 ? MinHeight : Height;
        var wa = screen.WorkingArea;
        Position = new PixelPoint(
            wa.X + wa.Width  - (int)Width - 20,
            wa.Y + wa.Height - (int)h     - 20);
    }
}
