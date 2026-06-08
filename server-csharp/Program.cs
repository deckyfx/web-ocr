using WebOcrServer;
using WebOcrServer.Components;

var builder = WebApplication.CreateBuilder(args);

builder.AddWebOcrServices();

var app = builder.Build();

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

// Map routes BEFORE RunBootTasksAsync so /health responds during model download/init
// (health returns "starting" status until BootState.IsReady is set)
app.MapWebOcrRoutes();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode();

// Boot tasks run as BootBackgroundService — HTTP server starts immediately,
// /health returns "starting" until BootState.IsReady is set
app.Run();
