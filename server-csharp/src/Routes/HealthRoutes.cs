using System.Reflection;

namespace WebOcrServer;

public static class HealthRoutes
{
    public static void MapHealthRoutes(this WebApplication app)
    {
        app.MapGet("/health", (AppConfig config) =>
        {
            var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0";
            return Results.Ok(new HealthResponse(
                Status:             "ok",
                Version:            version,
                OcrModelsDir:       config.OcrModelsDir,
                TranslateModelsDir: config.TranslateModelsDir,
                DeeplAvailable:     config.DeeplAvailable));
        });
    }
}
