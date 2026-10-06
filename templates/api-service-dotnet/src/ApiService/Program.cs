using ApiService.Features.Auth;
using ApiService.Features.Items;
using ApiService.Persistence;
using ApiService.Platform;
using Microsoft.Extensions.Options;

// Composition root: the only file that knows every part. Each call below is one concern; the
// order of the middleware pipeline lives in UsePlatform, where it is documented and tested.

// Container HEALTHCHECK: the runtime image has no shell or curl, so the app probes itself.
if (HealthProbe.IsRequested(args))
{
    return await HealthProbe.RunAsync(Environment.GetEnvironmentVariable);
}

// Development only: read .env.local / .env (what AICO and `cp .env.example .env` produce).
DotEnv.LoadForDevelopment(Environment.GetEnvironmentVariable, Environment.SetEnvironmentVariable, Directory.GetCurrentDirectory());

var builder = WebApplication.CreateBuilder(args);
builder.AddPlatform();
builder.AddPersistence();
builder.AddAuthFeature();
builder.AddItemsFeature();

var app = builder.Build();

// Fail fast: every ValidateOnStart option is checked before the database is touched or a port opened.
app.Services.GetRequiredService<IStartupValidator>().Validate();

// `ApiService --migrate`: apply migrations and exit (the production one-shot job).
if (args.Contains("--migrate", StringComparer.Ordinal))
{
    return await app.MigrateAndExitAsync();
}

await app.InitializeDatabaseAsync();
app.UsePlatform();
app.UseAuthFeature();
app.MapAuthEndpoints();
app.MapItemEndpoints();
await app.RunAsync();
return 0;

#pragma warning disable CA1515 // WebApplicationFactory<Program> needs a type the test assembly can name publicly.
/// <summary>Marker so the integration tests can host the application in memory.</summary>
public partial class Program;
#pragma warning restore CA1515
