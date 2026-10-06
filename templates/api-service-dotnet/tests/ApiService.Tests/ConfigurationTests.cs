using ApiService.Platform;
using ApiService.Tests.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using OpenTelemetry.Trace;

namespace ApiService.Tests;

/// <summary>Bad configuration must stop the process at startup, with a message naming the key. Never later, never silently.</summary>
public sealed class ConfigurationTests
{
    private static ApiFactory With(string environment, params (string Key, string? Value)[] settings) =>
        new(environment, settings.ToDictionary(s => s.Key, s => s.Value, StringComparer.Ordinal));

    private static async Task<string> StartupFailureAsync(ApiFactory factory)
    {
        using (factory)
        {
            var failure = await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                using var client = factory.CreateApiClient();
                return Task.CompletedTask;
            });
            return failure.ToString();
        }
    }

    [Fact]
    public async Task A_missing_signing_key_stops_startup()
    {
        var text = await StartupFailureAsync(With("Testing", ("Jwt:SigningKey", "")));

        Assert.Contains("SigningKey", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_short_signing_key_stops_startup()
    {
        var text = await StartupFailureAsync(With("Testing", ("Jwt:SigningKey", "too-short")));

        Assert.Contains("at least 32 characters", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_placeholder_key_from_the_example_file_is_refused_outside_development()
    {
        var text = await StartupFailureAsync(With("Production", ("Jwt:SigningKey", "change-me-change-me-change-me-change-me"), ("Database:Provider", "Postgres"), ("ConnectionStrings:Default", "Host=x")));

        Assert.Contains("placeholder", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_development_only_sqlite_provider_is_refused_in_production()
    {
        var text = await StartupFailureAsync(With("Production", ("Database:Provider", "Sqlite")));

        Assert.Contains("development and tests only", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_missing_connection_string_stops_startup()
    {
        var text = await StartupFailureAsync(With("Testing", ("ConnectionStrings:Default", "")));

        Assert.Contains("ConnectionStrings__Default", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("*")]
    [InlineData("https://app.example.test/")]
    [InlineData("https://app.example.test/path")]
    [InlineData("app.example.test")]
    public async Task Cors_origins_must_be_exact_origins(string origin)
    {
        var text = await StartupFailureAsync(With("Testing", ("Cors:AllowedOrigins", origin)));

        Assert.Contains("exact origin", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("RateLimit:PermitLimit", "0")]
    [InlineData("RateLimit:WindowSeconds", "-1")]
    [InlineData("Limits:MaxRequestBodyBytes", "0")]
    [InlineData("Jwt:AccessTokenMinutes", "600")]
    public async Task Out_of_range_numbers_stop_startup(string key, string value)
    {
        var text = await StartupFailureAsync(With("Testing", (key, value)));

        Assert.Contains(key.Split(':')[1], text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Trusting_forwarded_headers_requires_naming_the_proxies()
    {
        var missing = await StartupFailureAsync(With("Testing", ("ForwardedHeaders:Enabled", "true")));
        Assert.Contains("KnownNetworks", missing, StringComparison.Ordinal);

        var bad = await StartupFailureAsync(With("Testing", ("ForwardedHeaders:Enabled", "true"), ("ForwardedHeaders:KnownNetworks", "not-a-cidr")));
        Assert.Contains("not a CIDR", bad, StringComparison.Ordinal);
    }

    [Fact]
    public void Forwarded_headers_trust_only_the_configured_networks()
    {
        using var factory = With("Testing", ("ForwardedHeaders:Enabled", "true"), ("ForwardedHeaders:KnownNetworks", "10.0.0.0/8, 172.16.0.0/12"));
        using var client = factory.CreateApiClient();

        var options = factory.Services.GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value;

        Assert.Equal(2, options.KnownIPNetworks.Count);
        Assert.Empty(options.KnownProxies);
        Assert.Equal(1, options.ForwardLimit);
    }

    [Fact]
    public void OpenTelemetry_is_off_unless_an_endpoint_is_configured()
    {
        using var off = new ApiFactory();
        using var offClient = off.CreateApiClient();
        Assert.Null(off.Services.GetService<TracerProvider>());

        using var on = With("Testing", ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4317"));
        using var onClient = on.CreateApiClient();
        Assert.NotNull(on.Services.GetService<TracerProvider>());
    }

    [Fact]
    public void The_telemetry_switch_reads_the_standard_otel_variable()
    {
        var empty = new ConfigurationBuilder().Build();
        var set = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.Ordinal) { ["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://collector:4317" }).Build();

        Assert.False(Telemetry.IsConfigured(empty));
        Assert.True(Telemetry.IsConfigured(set));
    }

    [Fact]
    public void Dotenv_applies_only_in_development_and_never_overrides_the_real_environment()
    {
        var dir = Directory.CreateTempSubdirectory("dotenv-test-");
        try
        {
            File.WriteAllLines(Path.Combine(dir.FullName, ".env"), ["# comment", "A=1", "B=\"two words\"", "C='quoted'", "EXISTING=from-file", "no-equals-line", "=novalue"]);
            File.WriteAllLines(Path.Combine(dir.FullName, ".env.local"), ["A=from-local"]);
            File.WriteAllText(Path.Combine(dir.FullName, "x.slnx"), "<Solution />");

            var env = new Dictionary<string, string?>(StringComparer.Ordinal) { ["ASPNETCORE_ENVIRONMENT"] = "Production", ["EXISTING"] = "from-real-env" };
            DotEnv.LoadForDevelopment(k => env.GetValueOrDefault(k), (k, v) => env[k] = v, dir.FullName);
            Assert.False(env.ContainsKey("A"), "nothing is read outside Development");

            env["ASPNETCORE_ENVIRONMENT"] = "Development";
            DotEnv.LoadForDevelopment(k => env.GetValueOrDefault(k), (k, v) => env[k] = v, dir.FullName);

            Assert.Equal("from-local", env["A"]); // .env.local is read first and wins over .env
            Assert.Equal("two words", env["B"]);
            Assert.Equal("quoted", env["C"]);
            Assert.Equal("from-real-env", env["EXISTING"]);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
