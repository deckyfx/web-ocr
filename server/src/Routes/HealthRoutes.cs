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
                ["ocr"]        = new(ms.Ocr.Repo,       boot.OcrReady,        Enabled: ms.Ocr.Enabled),
                ["translate"]  = new(ms.Translate.Repo,  boot.TranslateReady,  Enabled: ms.Translate.Enabled),
                ["dictionary"] = new("stephenmk/Jitendex", boot.DictionaryReady, Enabled: true),
                ["inpaint"]    = new(
                    string.IsNullOrWhiteSpace(ms.Inpaint.Repo) ? "(not configured)" : ms.Inpaint.Repo,
                    boot.InpaintReady,
                    Enabled: boot.InpaintEnabled),
                ["bubble"] = new(
                    string.IsNullOrWhiteSpace(ms.Bubble.Repo) ? "(not configured)" : ms.Bubble.Repo,
                    boot.BubbleReady,
                    Enabled: boot.BubbleEnabled),
                ["text_seg"] = new(
                    string.IsNullOrWhiteSpace(ms.TextSeg.Repo) ? "(not configured)" : ms.TextSeg.Repo,
                    boot.TextSegReady,
                    Enabled: boot.TextSegEnabled),
            };

            // "degraded" if any enabled model hasn't finished loading
            bool optionalsMissing =
                !boot.DictionaryReady ||
                (ms.Ocr.Enabled       && !boot.OcrReady)        ||
                (ms.Translate.Enabled && !boot.TranslateReady)  ||
                (boot.InpaintEnabled  && !boot.InpaintReady)    ||
                (boot.BubbleEnabled   && !boot.BubbleReady)     ||
                (boot.TextSegEnabled  && !boot.TextSegReady);

            return Results.Ok(new HealthResponse(
                Status:                      boot.IsReady ? (optionalsMissing ? "degraded" : "ok") : "starting",
                Version:                     version,
                DataDir:                     config.DataDir,
                DeeplAvailable:              config.DeeplAvailable,
                PreferredTranslationEngine:  ms.PreferredTranslationEngine,
                PreferredInpaintEngine:      ms.PreferredInpaintEngine,
                Models:                      models));
        });
    }
}
