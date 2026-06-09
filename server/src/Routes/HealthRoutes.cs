using System.Reflection;

namespace WebOcrServer;

public static class HealthRoutes
{
    public static void MapHealthRoutes(this WebApplication app)
    {
        app.MapGet("/health", (AppConfig config, BootState boot) =>
        {
            var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0";
            return Results.Ok(new HealthResponse(
                Status:             boot.IsReady ? (boot.DictionaryReady ? "ok" : "degraded") : "starting",
                Version:            version,
                OcrModelsDir:       config.OcrModelsDir,
                TranslateModelsDir: config.TranslateModelsDir,
                DeeplAvailable:     config.DeeplAvailable));
        });
    }
}
