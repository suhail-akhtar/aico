using ApiService.Features.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Time.Testing;

namespace ApiService.Tests.Infrastructure;

/// <summary>
/// Hosts the real application in memory (no port, no network) with its own database and a fake clock.
/// By default the database is a private in-memory SQLite; with TEST_POSTGRES=1 the same suite runs against
/// a real PostgreSQL in a throwaway container with the real migrations (make test-pg). Every setting is
/// overridable per test, which is how the configuration and rate-limit tests get their own hosts.
/// </summary>
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    // A fake signing key for tests only. standards-allow: secret
    public const string JwtKey = "test-only-signing-key-0123456789-abcdefghij";

    private readonly Dictionary<string, string?> settings;
    private readonly string environment;
    private readonly SqliteConnection? keeper;
    private readonly string? postgresDatabase;

    public ApiFactory()
        : this("Testing", null)
    {
    }

    private readonly Action<IServiceCollection>? configureServices;

    internal ApiFactory(string environment, IReadOnlyDictionary<string, string?>? overrides, Action<IServiceCollection>? configureServices = null)
    {
        this.environment = environment;
        this.configureServices = configureServices;
        settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Jwt:SigningKey"] = JwtKey,
            ["RateLimit:PermitLimit"] = "100000",
            ["RateLimit:AuthPermitLimit"] = "100000",
            ["Cors:AllowedOrigins"] = "https://app.example.test",
            ["Seed:Enabled"] = "false",
            ["Logging:LogLevel:Default"] = "Warning",
        };

        if (PostgresServer.Enabled)
        {
            postgresDatabase = PostgresServer.CreateDatabase();
            settings["Database:Provider"] = "Postgres";
            settings["Database:MigrateOnStartup"] = "true";
            settings["ConnectionStrings:Default"] = PostgresServer.ConnectionString(postgresDatabase);
        }
        else
        {
            var name = $"file:test-{Guid.NewGuid():N}?mode=memory&cache=shared";
            keeper = new SqliteConnection($"Data Source={name}");
            keeper.Open();
            settings["Database:Provider"] = "Sqlite";
            settings["ConnectionStrings:Default"] = $"Data Source={name}";
        }

        if (overrides is not null)
        {
            foreach (var (key, value) in overrides)
            {
                settings[key] = value;
            }
        }
    }

    /// <summary>Time for the whole host: token lifetimes, refresh expiry, row timestamps.</summary>
    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 1, 15, 10, 0, 0, TimeSpan.Zero));

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment(environment);
        // UseSetting (not AddInMemoryCollection): Program.cs reads a few values while building the host, and
        // only host settings are visible that early.
        foreach (var (key, value) in settings)
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            configureServices?.Invoke(services);

            // Argon2id at production cost is ~100 ms and 64 MiB per call; the suite would spend minutes in it.
            // The production parameters are pinned by PasswordHasherTests instead.
            services.Configure<PasswordHashingOptions>(options =>
            {
                options.MemoryKiB = 64;
                options.Iterations = 1;
            });
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            keeper?.Dispose();
            if (postgresDatabase is not null)
            {
                PostgresServer.DropDatabase(postgresDatabase);
            }
        }
    }

    public HttpClient CreateApiClient() => CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
}
