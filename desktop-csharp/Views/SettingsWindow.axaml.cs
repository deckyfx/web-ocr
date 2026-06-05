using System;
using Avalonia.Controls;
using Avalonia.Interactivity;
using WebOcrDesktop.Models;
using WebOcrDesktop.ViewModels;

namespace WebOcrDesktop.Views;

public partial class SettingsWindow : Window
{
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
        if (DataContext is SettingsViewModel vm)
            SettingsSaved?.Invoke(vm.ToSettings());
        Close();
    }

    private void OnCancelClick(object? sender, RoutedEventArgs e) => Close();
}
