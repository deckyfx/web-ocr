using System;
using Avalonia.Controls;
using Avalonia.Interactivity;
using WebOcrDesktop.Models;
using WebOcrDesktop.ViewModels;

namespace WebOcrDesktop.Views;

public partial class SettingsWindow : Window
{
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

    private async void OnSaveClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not SettingsViewModel vm) return;
        try
        {
            SettingsSaved?.Invoke(vm.ToSettings());
            Close();
        }
        catch (ArgumentException ex)
        {
            // Surface URL validation errors instead of crashing.
            var dlg = new Window
            {
                Title         = "Invalid Settings",
                Width         = 360,
                SizeToContent = SizeToContent.Height,
                CanResize     = false,
            };
            var okBtn = new Button
            {
                Content             = "OK",
                HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right,
                Margin              = new Avalonia.Thickness(16, 0, 16, 16),
            };
            okBtn.Click += (_, _) => dlg.Close();
            dlg.Content = new StackPanel
            {
                Children =
                {
                    new TextBlock
                    {
                        Text         = ex.Message,
                        Margin       = new Avalonia.Thickness(16),
                        TextWrapping = Avalonia.Media.TextWrapping.Wrap,
                    },
                    okBtn,
                }
            };
            await dlg.ShowDialog(this);
        }
    }

    private void OnCancelClick(object? sender, RoutedEventArgs e) => Close();
}
