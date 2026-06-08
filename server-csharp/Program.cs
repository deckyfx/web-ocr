using WebOcrServer;
using WebOcrServer.Components;

var builder = WebApplication.CreateBuilder(args);

builder.AddWebOcrServices();

var app = builder.Build();

app.UseCors();
app.UseStaticFiles();   // serve wwwroot/ (react-app.js, etc.)
app.UseAntiforgery();   // required by MapRazorComponents

await app.RunBootTasksAsync();

app.MapWebOcrRoutes();
app.MapRazorComponents<App>()
   .AddInteractiveServerRenderMode(); // enables IJSRuntime / SignalR circuit

app.Run();
