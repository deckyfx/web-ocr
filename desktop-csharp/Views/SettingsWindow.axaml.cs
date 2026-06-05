using System;
using Avalonia.Controls;
using Avalonia.Interactivity;
using WebOcrDesktop.Models;
using WebOcrDesktop.ViewModels;

namespace WebOcrDesktop.Views;

public partial class SettingsWindow : Window
{
    // Static option arrays let the XAML compiler infer string item type
    // so SelectedItem binding to string ViewModel properties works correctly.
    public static readonly string[] TranslateEngines = ["none", "local", "deepl"];
    public static readonly string[] DictionaryModes  = ["local", "jisho"];

    public event Action<AppSettings>? SettingsSaved;

    public SettingsWindow()
    {
        InitializeComponent();
    }

    public void LoadSettings(AppSettings settings)
    {
        DataContext = new SettingsViewModel(settings);
    }

    private void OnSaveClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not SettingsViewModel vm) return;
        try
        {
            SettingsSaved?.Invoke(vm.ToSettings());
            Close();
        }
        catch (ArgumentException ex)
        {
            // Surface URL validation errors instead of crashing
            var dlg = new Avalonia.Controls.Window
            {
                Title   = "Invalid Settings",
                Width   = 360,
                SizeToContent = Avalonia.Controls.SizeToContent.Height,
                Content = new Avalonia.Controls.TextBlock
                {
                    Text   = ex.Message,
                    Margin = new Avalonia.Thickness(16),
                    TextWrapping = Avalonia.Media.TextWrapping.Wrap,
                },
            };
            dlg.ShowDialog(this);
        }
    }

    private void OnCancelClick(object? sender, RoutedEventArgs e) => Close();
}
