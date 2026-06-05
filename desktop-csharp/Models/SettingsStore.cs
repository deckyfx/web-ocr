using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace WebOcrDesktop.Models;

public static class SettingsStore
{
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "web-ocr-desktop",
        "settings.json");

    // Stored separately so it never appears in settings.json
    private static string ApiKeyPath => Path.Combine(
        Path.GetDirectoryName(FilePath)!, ".apikey");

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    /// <summary>Non-null when the last Save call failed.</summary>
    public static string? LastSaveError { get; private set; }

    public static AppSettings Load()
    {
        try
        {
            AppSettings base_ = !File.Exists(FilePath)
                ? new AppSettings()
                : JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath)) ?? new AppSettings();

            return base_ with { ApiKey = LoadApiKey() };
        }
        catch
        {
            return new AppSettings();
        }
    }

    /// <returns>true on success; false on failure — check <see cref="LastSaveError"/>.</returns>
    public static bool Save(AppSettings settings)
    {
        try
        {
            LastSaveError = null;
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(settings, JsonOpts));
            SaveApiKey(settings.ApiKey);
            return true;
        }
        catch (Exception ex)
        {
            LastSaveError = ex.Message;
            return false;
        }
    }

    // ── API-key secure storage ────────────────────────────────────────────────

    private static string? LoadApiKey()
    {
        try
        {
            if (!File.Exists(ApiKeyPath)) return null;
            var stored = File.ReadAllText(ApiKeyPath);
            if (string.IsNullOrEmpty(stored)) return null;

            if (OperatingSystem.IsWindows())
                return DecryptDpapi(stored);

            return Encoding.UTF8.GetString(Convert.FromBase64String(stored));
        }
        catch { return null; }
    }

    private static void SaveApiKey(string? key)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ApiKeyPath)!);

        if (string.IsNullOrEmpty(key))
        {
            if (File.Exists(ApiKeyPath)) File.Delete(ApiKeyPath);
            return;
        }

        string stored = OperatingSystem.IsWindows()
            ? EncryptDpapi(key)
            : Convert.ToBase64String(Encoding.UTF8.GetBytes(key));

        File.WriteAllText(ApiKeyPath, stored);

        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(ApiKeyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    [SupportedOSPlatform("windows")]
    private static string EncryptDpapi(string plain)
    {
        var bytes     = Encoding.UTF8.GetBytes(plain);
        var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(encrypted);
    }

    [SupportedOSPlatform("windows")]
    private static string DecryptDpapi(string stored)
    {
        var bytes     = Convert.FromBase64String(stored);
        var decrypted = ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser);
        return Encoding.UTF8.GetString(decrypted);
    }
}
