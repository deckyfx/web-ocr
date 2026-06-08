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
            Console.WriteLine($"[Boot] {label} already present — {destPath}");
            return;
        }

        Console.WriteLine($"[Boot] Downloading {label}");
        Console.WriteLine($"[Boot]   → {destPath}");

        using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();

        var total = resp.Content.Headers.ContentLength ?? -1L;
        var tmp   = destPath + "." + Guid.NewGuid().ToString("N") + ".tmp";

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
                    PrintProgress(done, total);
                    if (total > 0)
                        progress?.Report(($"Downloading {label}… {(int)(100.0 * done / total)}%",
                                          (double)done / total));
                }
            }
            Console.WriteLine(); // end progress line
            File.Move(tmp, destPath, overwrite: true);
            Console.WriteLine($"[Boot] {label} done ({FormatBytes(total > 0 ? total : new FileInfo(destPath).Length)}).");
        }
        catch
        {
            Console.WriteLine(); // end progress line on error
            if (File.Exists(tmp)) File.Delete(tmp);
            throw;
        }
    }

    private static void PrintProgress(long done, long total)
    {
        const int barWidth = 30;
        if (total > 0)
        {
            double pct    = (double)done / total;
            int    filled = (int)(pct * barWidth);
            var    bar    = new string('█', filled) + new string('░', barWidth - filled);
            Console.Write($"\r[Boot]   [{bar}] {(int)(pct * 100),3}%  {FormatBytes(done)} / {FormatBytes(total)}  ");
        }
        else
        {
            Console.Write($"\r[Boot]   {FormatBytes(done)} downloaded...  ");
        }
    }

    private static string FormatBytes(long bytes) => bytes switch
    {
        >= 1024L * 1024 * 1024 => $"{bytes / (1024.0 * 1024 * 1024):F1} GB",
        >= 1024L * 1024        => $"{bytes / (1024.0 * 1024):F1} MB",
        >= 1024L               => $"{bytes / 1024.0:F1} KB",
        _                      => $"{bytes} B",
    };

    /// <summary>
    /// Scans all GitHub releases (newest first) and returns the browser_download_url
    /// for the first asset whose name contains <paramref name="nameContains"/> (case-insensitive).
    /// Useful when release asset names change between versions or when latest has no assets.
    /// </summary>
    public static async Task<string> FindGitHubReleaseAssetAsync(
        HttpClient http,
        string     owner,
        string     repo,
        string     nameContains,
        CancellationToken ct = default)
    {
        var apiUrl = $"https://api.github.com/repos/{owner}/{repo}/releases?per_page=20";
        using var req = new HttpRequestMessage(HttpMethod.Get, apiUrl);
        req.Headers.Add("User-Agent", "WebOcrServer/1.0");

        using var resp = await http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();

        using var doc = await System.Text.Json.JsonDocument.ParseAsync(
            await resp.Content.ReadAsStreamAsync(ct), cancellationToken: ct);

        foreach (var release in doc.RootElement.EnumerateArray())
        {
            var tag = release.GetProperty("tag_name").GetString() ?? "?";
            foreach (var asset in release.GetProperty("assets").EnumerateArray())
            {
                var name = asset.GetProperty("name").GetString() ?? "";
                if (name.Contains(nameContains, StringComparison.OrdinalIgnoreCase))
                {
                    var url = asset.GetProperty("browser_download_url").GetString()
                              ?? throw new InvalidOperationException($"browser_download_url missing for {name}");
                    Console.WriteLine($"[Boot]   Found asset in release {tag}: {name}");
                    return url;
                }
            }
        }

        throw new InvalidOperationException(
            $"No asset containing '{nameContains}' found in any of the last 20 releases of {owner}/{repo}.");
    }
}
