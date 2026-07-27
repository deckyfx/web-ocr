using Scalar.AspNetCore;
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
app.UseAuthorization();
app.UseAntiforgery();

// Map routes BEFORE BootBackgroundService completes so /health responds during model download/init
// (health returns "starting" until BootState.IsReady is set)
app.MapWebOcrRoutes();
app.MapOpenApi();
app.MapScalarApiReference();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();

// ── Startup banner (fires once Kestrel is accepting connections) ──────────────
app.Lifetime.ApplicationStarted.Register(() =>
{
    var version = typeof(AppConfig).Assembly.GetName().Version?.ToString(3) ?? "?";

    // Collect all reachable IPv4 addresses for LAN access line
    var lanIps = System.Net.Dns.GetHostEntry(System.Net.Dns.GetHostName())
        .AddressList
        .Where(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        .Select(a => a.ToString())
        .ToArray();

    string listenInfo = string.IsNullOrEmpty(socketPath)
        ? $"port {port}"
        : $"socket {socketPath}";

    var lines = new List<string>
    {
        $"  Web OCR Server  v{version}",
        "",
        $"  Listening on  {listenInfo}",
    };
    if (string.IsNullOrEmpty(socketPath))
    {
        lines.Add($"  Dashboard     http://localhost:{port}");
        foreach (var ip in lanIps)
            lines.Add($"                http://{ip}:{port}");
    }
    lines.Add("");
    lines.Add("  [Boot] Server is ready.");

    int w = Math.Max(65, lines.Max(l => l.Length) + 2);
    Console.WriteLine();
    Console.WriteLine($"┌{new string('─', w)}┐");
    foreach (var line in lines)
        Console.WriteLine($"│{line.PadRight(w)}│");
    Console.WriteLine($"└{new string('─', w)}┘");
    Console.WriteLine();
});

app.Run();
