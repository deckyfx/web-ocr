namespace WebOcrServer;

public sealed record AppConfig(
    int Port,
    string? SocketPath,
    string OcrModelsDir,
    string TranslateModelsDir,
    string InpaintModelsDir,
    string BubbleModelsDir,
    string TextSegModelsDir,
    string DictDir,
    string DatabasePath,
    string DeeplApiKey
)
{
    public bool DeeplAvailable => !string.IsNullOrWhiteSpace(DeeplApiKey);

    /// <summary>True when the server should bind to a Unix socket instead of a TCP port.</summary>
    public bool UseUnixSocket => !string.IsNullOrWhiteSpace(SocketPath);

    /// <summary>Root data directory (parent of the SQLite database file).</summary>
    public string DataDir => Path.GetDirectoryName(Path.GetFullPath(DatabasePath))!;

    /// <summary>Root directory for per-job image files. Each job gets a sub-folder named by its GUID.</summary>
    public string JobsDir => Path.Combine(DataDir, "jobs");

    public static AppConfig FromEnvironment()
    {
        LoadDotEnv();
        var root = Path.Combine(Directory.GetCurrentDirectory(), "data");

        var rawPort = Env("PORT");
        int port = 3579;
        if (rawPort is not null && !int.TryParse(rawPort, out port))
        {
            Console.Error.WriteLine($"[Config] Warning: PORT='{rawPort}' is not a valid integer; using default 3579.");
            port = 3579;
        }

        return new AppConfig(
            Port:              port,
            SocketPath:        Env("SOCKET_PATH"),
            OcrModelsDir:      Env("OCR_MODELS_DIR")       ?? Path.Combine(root, "models", "ocr"),
            TranslateModelsDir: Env("TRANSLATE_MODELS_DIR") ?? Path.Combine(root, "models", "translate"),
            InpaintModelsDir:  Env("INPAINT_MODELS_DIR")    ?? Path.Combine(root, "models", "inpaint"),
            BubbleModelsDir:   Env("BUBBLE_MODELS_DIR")     ?? Path.Combine(root, "models", "bubble"),
            TextSegModelsDir:  Env("TEXT_SEG_MODELS_DIR")   ?? Path.Combine(root, "models", "textseg"),
            DictDir:           Env("DICT_DIR")               ?? Path.Combine(root, "models", "jdict"),
            DatabasePath:      Env("DATABASE_URL")          ?? Path.Combine(root, "ocr.db"),
            DeeplApiKey:       Env("DEEPL_API_KEY")         ?? ""
        );
    }

    private static string? Env(string key) =>
        Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : null;

    // Loads KEY=VALUE pairs from a .env file in the working directory.
    // Already-set env vars take precedence (docker / systemd injected values win).
    // internal so Program.cs can call it before WebApplication.CreateBuilder.
    internal static void LoadDotEnv()
    {
        var path = Path.Combine(Directory.GetCurrentDirectory(), ".env");
        if (!File.Exists(path)) return;

        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;

            var eq = line.IndexOf('=');
            if (eq <= 0) continue;

            var key = line[..eq].Trim();
            var val = line[(eq + 1)..].Trim();

            // Don't overwrite values already in the environment
            if (Environment.GetEnvironmentVariable(key) is null)
                Environment.SetEnvironmentVariable(key, val);
        }
    }
}
