namespace WebOcrServer;

public sealed record AppConfig(
    int Port,
    string OcrModelsDir,
    string TranslateModelsDir,
    string DictDir,
    string DatabasePath,
    string DeeplApiKey
)
{
    public bool DeeplAvailable => !string.IsNullOrWhiteSpace(DeeplApiKey);

    public static AppConfig FromEnvironment()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var root    = Path.Combine(appData, "WebOcrServer");

        return new AppConfig(
            Port:              int.TryParse(Env("PORT"), out var p) ? p : 3579,
            OcrModelsDir:      Env("OCR_MODELS_DIR")       ?? Path.Combine(root, "models", "ocr"),
            TranslateModelsDir: Env("TRANSLATE_MODELS_DIR") ?? Path.Combine(root, "models", "translate"),
            DictDir:           Env("DICT_DIR")              ?? Path.Combine(root, "models", "jdict"),
            DatabasePath:      Env("DATABASE_URL")          ?? Path.Combine(root, "ocr.db"),
            DeeplApiKey:       Env("DEEPL_API_KEY")         ?? ""
        );
    }

    private static string? Env(string key) =>
        Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : null;
}
