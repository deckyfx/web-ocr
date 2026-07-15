using WebOcrServer;
using WebOcrServer.Components;

// ── Load .env before the builder so PORT / SOCKET_PATH reach Kestrel ─────────
AppConfig.LoadDotEnv();

var socketPath = Environment.GetEnvironmentVariable("SOCKET_PATH");
var portEnv    = Environment.GetEnvironmentVariable("PORT");
int port       = 3579;
if (portEnv is not null && !int.TryParse(portEnv, out port)) port = 3579;

var builder = WebApplication.CreateBuilder(args);

// ── Kestrel binding: Unix socket (SOCKET_PATH) or TCP port (PORT) ─────────────
builder.WebHost.ConfigureKestrel(k =>
{
    if (!string.IsNullOrEmpty(socketPath))
    {
        var dir = Path.GetDirectoryName(socketPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        if (File.Exists(socketPath)) File.Delete(socketPath);
        k.ListenUnixSocket(socketPath);
    }
    else
    {
        k.ListenAnyIP(port);
    }
});

builder.AddWebOcrServices();

var app = builder.Build();

// ── Clean up Unix socket on shutdown ──────────────────────────────────────────
if (!string.IsNullOrEmpty(socketPath))
    app.Lifetime.ApplicationStopping.Register(() =>
    {
        if (File.Exists(socketPath)) File.Delete(socketPath);
    });

// Exception handling — must be first in the pipeline
if (app.Environment.IsDevelopment())
    app.UseDeveloperExceptionPage();
else
{
    app.UseExceptionHandler("/error");
    app.Map("/error", () => Results.Problem("An unexpected error occurred.", statusCode: 500));
}

app.UseCors();
app.UseStaticFiles();
app.UseAntiforgery();

// Map routes BEFORE BootBackgroundService completes so /health responds during model download/init
// (health returns "starting" until BootState.IsReady is set)
app.MapWebOcrRoutes();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();

app.Run();
