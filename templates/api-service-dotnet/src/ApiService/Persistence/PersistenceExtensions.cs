using ApiService.Platform;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace ApiService.Persistence;

/// <summary>
/// Database wiring and the three ways the schema comes into being:
/// <list type="bullet">
/// <item>Postgres: EF migrations (<c>ApiService --migrate</c> as a one-shot job, or MigrateOnStartup in compose and development).</item>
/// <item>Sqlite (development and tests only): <c>EnsureCreated</c> from the model, so a new clone runs with no database server.</item>
/// <item>Seed: a demo user and items, Development only, only when a demo password is supplied.</item>
/// </list>
/// The provider is chosen lazily from configuration, so tests can swap it without touching Program.cs.
/// </summary>
internal static class PersistenceExtensions
{
    public static WebApplicationBuilder AddPersistence(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var services = builder.Services;

        PlatformExtensions.AddValidated<DatabaseOptions>(services, DatabaseOptions.Section).Services
            .AddSingleton<IValidateOptions<DatabaseOptions>, DatabaseOptionsSafety>();
        PlatformExtensions.AddValidated<SeedOptions>(services, SeedOptions.Section);

        services.AddDbContext<AppDbContext>((provider, options) =>
        {
            var database = provider.GetRequiredService<IOptions<DatabaseOptions>>().Value;
            var connectionString = provider.GetRequiredService<IConfiguration>().GetConnectionString("Default")!;
            switch (database.Provider)
            {
                case DatabaseProvider.Sqlite:
                    options.UseSqlite(connectionString);
                    break;
                default:
                    options.UseNpgsql(connectionString, npgsql => npgsql.EnableRetryOnFailure(maxRetryCount: 3));
                    break;
            }
        });

        services.AddScoped<DevSeeder>();
        services.AddHealthChecks().AddCheck<DatabaseReadinessCheck>("database", tags: [HealthEndpoints.ReadyTag]);
        return builder;
    }

    /// <summary>Create or migrate the schema as configured, then seed. Called once at startup, before the host listens.</summary>
    public static async Task InitializeDatabaseAsync(this WebApplication app, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(app);
        using var scope = app.Services.CreateScope();
        var provider = scope.ServiceProvider;
        var database = provider.GetRequiredService<IOptions<DatabaseOptions>>().Value;
        var db = provider.GetRequiredService<AppDbContext>();

        if (database.Provider == DatabaseProvider.Sqlite)
        {
            EnsureSqliteDirectory(provider.GetRequiredService<IConfiguration>().GetConnectionString("Default")!);
            await db.Database.EnsureCreatedAsync(cancellationToken);
        }
        else if (database.MigrateOnStartup)
        {
            await db.Database.MigrateAsync(cancellationToken);
        }

        await provider.GetRequiredService<DevSeeder>().SeedAsync(cancellationToken);
    }

    /// <summary>`ApiService --migrate`: apply pending migrations and exit. The production way to change a schema: run it before the new version starts.</summary>
    public static async Task<int> MigrateAndExitAsync(this WebApplication app, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(app);
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (scope.ServiceProvider.GetRequiredService<IOptions<DatabaseOptions>>().Value.Provider == DatabaseProvider.Sqlite)
        {
            await Console.Error.WriteLineAsync("--migrate applies migrations to Postgres; the Sqlite development provider creates its schema at startup.");
            return 2;
        }

        await db.Database.MigrateAsync(cancellationToken);
        return 0;
    }

    private static void EnsureSqliteDirectory(string connectionString)
    {
        var file = new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder(connectionString).DataSource;
        if (string.IsNullOrWhiteSpace(file) || file.StartsWith(':') || file.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var directory = Path.GetDirectoryName(Path.GetFullPath(file));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
    }
}
