using WebOcrServer;

var builder = WebApplication.CreateBuilder(args);

builder.AddWebOcrServices();

var app = builder.Build();

app.UseCors();

await app.RunBootTasksAsync();

app.MapWebOcrRoutes();

app.Run();
