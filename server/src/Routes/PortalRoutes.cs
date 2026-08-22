namespace WebOcrServer;

public static class PortalRoutes
{
    public static void MapPortalRoutes(this WebApplication app)
    {
        var g = app.MapGroup("/api/portal")
                   .RequireCors("portal")
                   .RequireAuthorization("portal");

        g.MapPortalJobRoutes();
        g.MapPortalTextSegRoutes();
        g.MapPortalBubbleRoutes();
        g.MapPortalActionRoutes();
        g.MapPortalLibraryRoutes();
    }
}
