namespace WebOcrServer;

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
    }
}
