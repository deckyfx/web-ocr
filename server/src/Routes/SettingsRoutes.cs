namespace WebOcrServer;

/// <summary>Narrow patch body for updating only the preferred translation engine.</summary>
public record EngineUpdateRequest(string Engine);

/// <summary>Narrow patch body for updating only the preferred inpaint engine.</summary>
public record InpaintEngineUpdateRequest(string Engine);

public static class SettingsRoutes
{
    public static void MapSettingsRoutes(this WebApplication app)
    {
        // GET /api/settings — returns current model configuration
        app.MapGet("/api/settings", (ModelSettingsStore store) =>
            Results.Ok(store.Current));

        // PUT /api/settings — updates and persists model configuration
        // Changes take effect on the next server restart (hot model-swap not yet implemented).
        app.MapPut("/api/settings", async (AllModelSettings updated, ModelSettingsStore store) =>
        {
            if (updated is null)
                return Results.BadRequest(new { error = "Request body is required" });

            var saved = await store.UpdateAsync(updated);
            return Results.Ok(saved);
        });

        // PATCH /api/settings/engine — updates only preferred_translation_engine without
        // touching other settings, avoiding the read-modify-write footgun on env-derived values.
        app.MapMethods("/api/settings/engine", ["PATCH"], async (
            EngineUpdateRequest req, ModelSettingsStore store) =>
        {
            if (string.IsNullOrWhiteSpace(req.Engine))
                return Results.BadRequest(new { error = "engine is required" });

            var saved = await store.UpdateEngineAsync(req.Engine);
            return Results.Ok(new { preferred_translation_engine = saved.PreferredTranslationEngine });
        });

        // PATCH /api/settings/inpaint-engine — updates only preferred_inpaint_engine.
        app.MapMethods("/api/settings/inpaint-engine", ["PATCH"], async (
            InpaintEngineUpdateRequest req, ModelSettingsStore store) =>
        {
            if (string.IsNullOrWhiteSpace(req.Engine))
                return Results.BadRequest(new { error = "engine is required" });

            try
            {
                var saved = await store.UpdateInpaintEngineAsync(req.Engine);
                return Results.Ok(new { preferred_inpaint_engine = saved.PreferredInpaintEngine });
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });
    }
}
