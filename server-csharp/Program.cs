using WebOcrServer;
using WebOcrServer.Components;

var builder = WebApplication.CreateBuilder(args);

builder.AddWebOcrServices();

var app = builder.Build();

app.UseCors();
app.UseAntiforgery(); // required by MapRazorComponents

await app.RunBootTasksAsync();

app.MapWebOcrRoutes();
app.MapRazorComponents<App>(); // GET / → Index.razor

app.Run();
