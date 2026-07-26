using System.Text.Json;
using System.Text.Json.Serialization;

namespace WebOcrServer;

/// <summary>Configuration for a single downloadable ONNX model.</summary>
public sealed class ModelEntry
{
    /// <summary>HuggingFace repo (owner/name). Empty string disables download.</summary>
    public string Repo    { get; set; } = "";

    /// <summary>Absolute local directory where model files are stored.</summary>
    public string Dir     { get; set; } = "";

    /// <summary>Whether this model is enabled (downloaded and initialised at boot).</summary>
    public bool   Enabled { get; set; }

    /// <summary>
    /// Comma-separated list of file paths to fetch from the HuggingFace repo.
    /// Paths may include subdirectories (e.g. "onnx/encoder_model.onnx") — the file
    /// is always stored flat inside <see cref="Dir"/> using only its filename.
    /// </summary>
    public string Files   { get; set; } = "model.onnx";

    [JsonIgnore]
    public string[] FileList =>
        Files.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>True when the model should actually be downloaded this run.</summary>
    [JsonIgnore]
    public bool ShouldDownload => Enabled && !string.IsNullOrWhiteSpace(Repo);
}

/// <summary>
/// Complete model configuration snapshot — JSON-serialisable, safe to expose via the settings API.
/// </summary>
public sealed class AllModelSettings
{
    public ModelEntry Ocr       { get; set; } = new();
    public ModelEntry Translate { get; set; } = new();
    public ModelEntry Inpaint   { get; set; } = new();
    public ModelEntry Bubble    { get; set; } = new();
}

/// <summary>
/// Singleton service that holds mutable model settings.
/// <para>
/// Priority (highest → lowest):
/// 1. Environment variables (set before process start or in .env)
/// 2. Persisted JSON at <c>data/model-settings.json</c> (written by the settings API)
/// 3. Hard-coded defaults
/// </para>
/// Changes made via <see cref="UpdateAsync"/> are persisted immediately and take
/// effect on the next server restart (hot model-swap is not yet implemented).
/// </summary>
public sealed class ModelSettingsStore
{
    private AllModelSettings _current;
    private readonly string  _filePath;
    private readonly ILogger<ModelSettingsStore> _logger;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented        = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    private ModelSettingsStore(AllModelSettings settings, string filePath, ILogger<ModelSettingsStore> logger)
    {
        _current  = settings;
        _filePath = filePath;
        _logger   = logger;
    }

    /// <summary>Current (thread-safe read) model settings.</summary>
    public AllModelSettings Current => _current;

    /// <summary>
    /// Factory: loads settings by merging env vars → persisted JSON → defaults.
    /// </summary>
    public static ModelSettingsStore Create(AppConfig config, ILogger<ModelSettingsStore> logger)
    {
        // GetDirectoryName returns "" (not null) for a bare filename like "ocr.db"
        var dataRoot = Path.GetDirectoryName(config.DatabasePath) is { Length: > 0 } d
                     ? d
                     : Path.Combine(Directory.GetCurrentDirectory(), "data");
        var filePath = Path.Combine(dataRoot, "model-settings.json");

        var fromEnv  = FromEnv(config);
        var fromFile = TryLoadFile(filePath, logger);
        var merged   = fromFile is null ? fromEnv : Merge(fromEnv, fromFile);

        return new ModelSettingsStore(merged, filePath, logger);
    }

    /// <summary>
    /// Atomically replace current settings and persist to disk.
    /// Takes effect on the next restart (model services are not hot-reloaded).
    /// </summary>
    public async Task<AllModelSettings> UpdateAsync(AllModelSettings updated)
    {
        await _writeLock.WaitAsync();
        try
        {
            _current = updated;
            var dir = Path.GetDirectoryName(_filePath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            await File.WriteAllTextAsync(_filePath, JsonSerializer.Serialize(updated, JsonOpts));
            _logger.LogInformation("[ModelSettings] Persisted to {Path}", _filePath);
            return _current;
        }
        finally { _writeLock.Release(); }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// <summary>Build settings from env vars, using AppConfig-derived paths as dir defaults.</summary>
    private static AllModelSettings FromEnv(AppConfig config)
    {
        static string? Ev(string k) =>
            Environment.GetEnvironmentVariable(k) is { Length: > 0 } v ? v : null;
        static bool EvBool(string k, bool @default) =>
            Ev(k) is { } v ? v.Equals("true", StringComparison.OrdinalIgnoreCase) : @default;

        return new AllModelSettings
        {
            Ocr = new ModelEntry
            {
                Repo    = Ev("OCR_MODEL_REPO")  ?? "mayocream/manga-ocr-onnx",
                Dir     = config.OcrModelsDir,
                Enabled = EvBool("OCR_MODEL_ENABLED", true),
                Files   = Ev("OCR_MODEL_FILES") ?? "encoder_model.onnx,decoder_model.onnx,vocab.txt",
            },
            Translate = new ModelEntry
            {
                Repo    = Ev("TRANSLATE_MODEL_REPO")  ?? "Xenova/opus-mt-ja-en",
                Dir     = config.TranslateModelsDir,
                Enabled = EvBool("TRANSLATE_MODEL_ENABLED", true),
                // Xenova/opus-mt-ja-en stores ONNX files under onnx/ but tokenizer is at root.
                // Stored locally as flat filenames (the onnx/ prefix is URL-path only).
                Files   = Ev("TRANSLATE_MODEL_FILES") ?? "onnx/encoder_model.onnx,onnx/decoder_model.onnx,tokenizer.json",
            },
            Inpaint = new ModelEntry
            {
                // Carve/LaMa-ONNX — Apache-2.0, 208 MB, fixed 512×512 input
                Repo    = Ev("INPAINT_MODEL_REPO")  ?? "Carve/LaMa-ONNX",
                Dir     = config.InpaintModelsDir,
                Enabled = EvBool("INPAINT_MODEL_ENABLED", false),
                Files   = Ev("INPAINT_MODEL_FILES") ?? "lama_fp32.onnx",
            },
            Bubble = new ModelEntry
            {
                // ogkalu/comic-text-and-bubble-detector — Apache-2.0, 11 MB INT8 quantised RT-DETR
                // 3 classes: 0=bubble, 1=text-in-bubble, 2=text-outside-bubble
                Repo    = Ev("BUBBLE_MODEL_REPO")  ?? "ogkalu/comic-text-and-bubble-detector",
                Dir     = config.BubbleModelsDir,
                Enabled = EvBool("BUBBLE_MODEL_ENABLED", false),
                Files   = Ev("BUBBLE_MODEL_FILES") ?? "detector-v4-s_int8.onnx",
            },
        };
    }

    private static AllModelSettings? TryLoadFile(string filePath, ILogger logger)
    {
        if (!File.Exists(filePath)) return null;
        try
        {
            return JsonSerializer.Deserialize<AllModelSettings>(File.ReadAllText(filePath), JsonOpts);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[ModelSettings] Could not parse {Path}; falling back to env defaults.", filePath);
            return null;
        }
    }

    /// <summary>
    /// Env vars win; file value used when env var is absent (allows dashboard-saved settings
    /// to survive restarts without re-setting every env var).
    /// </summary>
    private static AllModelSettings Merge(AllModelSettings env, AllModelSettings file)
    {
        return new AllModelSettings
        {
            Ocr       = MergeEntry(env.Ocr,       file.Ocr,       "OCR_MODEL_REPO",       "OCR_MODELS_DIR",       "OCR_MODEL_ENABLED",       "OCR_MODEL_FILES"),
            Translate = MergeEntry(env.Translate,  file.Translate,  "TRANSLATE_MODEL_REPO", "TRANSLATE_MODELS_DIR", "TRANSLATE_MODEL_ENABLED", "TRANSLATE_MODEL_FILES"),
            Inpaint   = MergeEntry(env.Inpaint,    file.Inpaint,    "INPAINT_MODEL_REPO",   "INPAINT_MODELS_DIR",   "INPAINT_MODEL_ENABLED",   "INPAINT_MODEL_FILES"),
            Bubble    = MergeEntry(env.Bubble,     file.Bubble,     "BUBBLE_MODEL_REPO",    "BUBBLE_MODELS_DIR",    "BUBBLE_MODEL_ENABLED",    "BUBBLE_MODEL_FILES"),
        };
    }

    private static ModelEntry MergeEntry(
        ModelEntry env, ModelEntry file,
        string repoKey, string dirKey, string enabledKey, string filesKey)
    {
        static string? Ev(string k) =>
            Environment.GetEnvironmentVariable(k) is { Length: > 0 } v ? v : null;

        // Treat empty strings from JSON the same as absent — don't let "" shadow env defaults.
        static string? NonEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

        return new ModelEntry
        {
            // Env wins for string fields; fall back to file (only if non-empty), then env default
            Repo  = Ev(repoKey)  ?? NonEmpty(file.Repo)  ?? env.Repo,
            Dir   = Ev(dirKey)   ?? NonEmpty(file.Dir)   ?? env.Dir,
            Files = Ev(filesKey) ?? NonEmpty(file.Files) ?? env.Files,
            // For bool: env wins if set; otherwise use the persisted file value
            Enabled = Ev(enabledKey) is { } v
                           ? v.Equals("true", StringComparison.OrdinalIgnoreCase)
                           : file.Enabled,
        };
    }
}
