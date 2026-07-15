using System.Reflection;

namespace WebOcrServer;

public static class HealthRoutes
{
    public static void MapHealthRoutes(this WebApplication app)
    {
        app.MapGet("/health", (AppConfig config, BootState boot, ModelSettingsStore modelSettings) =>
        {
            var ms      = modelSettings.Current;
            var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0";

            var models = new Dictionary<string, ModelStatus>
            {
                ["ocr"]        = new(ms.Ocr.Repo,       boot.OcrReady,        Enabled: true),
                ["translate"]  = new(ms.Translate.Repo,  boot.TranslateReady,  Enabled: true),
                ["dictionary"] = new("stephenmk/Jitendex", boot.DictionaryReady, Enabled: true),
                ["inpaint"]    = new(
                    string.IsNullOrWhiteSpace(ms.Inpaint.Repo) ? "(not configured)" : ms.Inpaint.Repo,
                    boot.InpaintReady,
                    Enabled: boot.InpaintEnabled),
                ["bubble"] = new(
                    string.IsNullOrWhiteSpace(ms.Bubble.Repo) ? "(not configured)" : ms.Bubble.Repo,
                    boot.BubbleReady,
                    Enabled: boot.BubbleEnabled),
            };

            return Results.Ok(new HealthResponse(
                Status:             boot.IsReady ? (boot.DictionaryReady ? "ok" : "degraded") : "starting",
                Version:            version,
                OcrModelsDir:       ms.Ocr.Dir,
                TranslateModelsDir: ms.Translate.Dir,
                DeeplAvailable:     config.DeeplAvailable,
                Models:             models));
        });
    }
}
