namespace WebOcrServer;

/// <summary>
/// Downloads model files with streaming (temp file + atomic rename), 64 KB chunks.
/// Pattern matches LocalTesseractService in desktop-csharp.
/// </summary>
public static class ModelDownloader
{
    private const int ChunkSize = 65536;

    /// <summary>Downloads a file if it does not already exist.</summary>
    public static async Task EnsureAsync(
        HttpClient      http,
        string          url,
        string          destPath,
        string          label,
        IProgress<(string status, double pct)>? progress = null,
        CancellationToken ct = default)
    {
        if (File.Exists(destPath))
        {
            Console.WriteLine($"[Boot] {label} already present, skipping download.");
            return;
        }

        Console.WriteLine($"[Boot] Downloading {label}...");
        progress?.Report(($"Downloading {label}…", 0));

        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength ?? -1L;
        var tmp   = destPath + ".download";

        try
        {
            await using (var src = await resp.Content.ReadAsStreamAsync(ct))
            await using (var dst = File.Create(tmp))
            {
                var  buf  = new byte[ChunkSize];
                long done = 0;
                int  n;
                while ((n = await src.ReadAsync(buf, ct)) > 0)
                {
                    await dst.WriteAsync(buf.AsMemory(0, n), ct);
                    done += n;
                    if (total > 0)
                        progress?.Report(($"Downloading {label}… {(int)(100.0 * done / total)}%",
                                          (double)done / total));
                }
            }
            File.Move(tmp, destPath, overwrite: true);
            Console.WriteLine($"[Boot] {label} downloaded.");
        }
        catch
        {
            if (File.Exists(tmp)) File.Delete(tmp);
            throw;
        }
    }

    /// <summary>
    /// Resolves the browser_download_url for an asset name from a GitHub release.
    /// </summary>
    public static async Task<string> GetGitHubReleaseAssetUrlAsync(
        HttpClient http,
        string     owner,
        string     repo,
        string     assetName,
        CancellationToken ct = default)
    {
        var apiUrl = $"https://api.github.com/repos/{owner}/{repo}/releases/latest";
        using var req = new HttpRequestMessage(HttpMethod.Get, apiUrl);
        req.Headers.Add("User-Agent", "WebOcrServer/1.0");

        using var resp = await http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();

        using var doc = await System.Text.Json.JsonDocument.ParseAsync(
            await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);

        foreach (var asset in doc.RootElement.GetProperty("assets").EnumerateArray())
        {
            if (asset.GetProperty("name").GetString() == assetName)
                return asset.GetProperty("browser_download_url").GetString()
                       ?? throw new InvalidOperationException($"browser_download_url missing for {assetName}");
        }

        throw new InvalidOperationException($"Asset '{assetName}' not found in {owner}/{repo} latest release.");
    }
}
