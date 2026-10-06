using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Scalar.AspNetCore;

namespace ApiService.Platform;

/// <summary>
/// The cross-cutting platform, composed in two calls so Program.cs stays a table of contents:
/// <see cref="AddPlatform"/> registers services, <see cref="UsePlatform"/> builds the middleware
/// pipeline. The order of the pipeline is a security property (see the comments in UsePlatform), which
/// is why it is written once, here, and covered by tests.
/// </summary>
internal static class PlatformExtensions
{
    public static WebApplicationBuilder AddPlatform(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var services = builder.Services;

        ConfigureLogging(builder);
        ConfigureKestrel(builder);
        builder.AddTelemetry();

        services.AddSingleton(TimeProvider.System);
        services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(25));

        // Typed, validated configuration. ValidateOnStart makes a bad value a startup failure, not a 3 a.m. surprise.
        AddValidated<CorsSettings>(services, CorsSettings.Section).Services.AddSingleton<IValidateOptions<CorsSettings>, CorsSettingsSafety>();
        AddValidated<RateLimitSettings>(services, RateLimitSettings.Section);
        AddValidated<LimitsOptions>(services, LimitsOptions.Section);
        AddValidated<OpenApiSettings>(services, OpenApiSettings.Section);
        AddValidated<ForwardedHeadersSettings>(services, ForwardedHeadersSettings.Section).Services
            .AddSingleton<IValidateOptions<ForwardedHeadersSettings>, ForwardedHeadersSafety>();

        // Errors: one handler, one document shape (RFC 9457).
        services.AddProblemDetails(options => options.CustomizeProblemDetails = ProblemDetailsSetup.Customize);
        services.AddExceptionHandler<GlobalExceptionHandler>();

        // Input: DataAnnotations validated by the framework, unknown JSON members rejected (no mass assignment).
        services.AddValidation();
        // Wire format: snake_case for every property, in requests and responses (created_at, next_cursor, access_token),
        // the contract shared with the other API starters. One policy here, so no DTO spells a name by hand.
        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower;
            options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
        });

        services.AddCors();
        services.AddSingleton<IConfigureOptions<CorsOptions>, CorsOptionsSetup>();
        services.AddRateLimiter();
        services.AddSingleton<IConfigureOptions<RateLimiterOptions>, RateLimiterOptionsSetup>();
        services.AddSingleton<IConfigureOptions<ForwardedHeadersOptions>, ForwardedHeadersOptionsSetup>();

        services.AddHealthChecks();
        services.AddOpenApi("v1", options =>
        {
            options.AddDocumentTransformer<OpenApiSetup.ServiceInfoTransformer>();
            options.AddOperationTransformer<OpenApiSetup.BearerOperationTransformer>();
        });

        return builder;
    }

    public static WebApplication UsePlatform(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // 1. Real client address first: rate limiting and logs below depend on it. A no-op unless enabled and configured.
        if (app.Services.GetRequiredService<IOptions<ForwardedHeadersSettings>>().Value.Enabled)
        {
            app.UseForwardedHeaders();
        }

        // 2. Correlation id before anything can log or fail.
        app.UseMiddleware<RequestIdMiddleware>();

        // 3. Anything thrown below becomes a problem document; empty 401/403/404/405 bodies are filled in.
        app.UseExceptionHandler();
        app.UseStatusCodePages();

        // 4. Response hardening, then cheap rejections (body size, CORS, rate limit) before any real work.
        if (!app.Environment.IsDevelopment())
        {
            app.UseHsts();
        }

        app.UseMiddleware<SecurityHeadersMiddleware>();
        app.UseMiddleware<BodySizeLimitMiddleware>();
        app.UseCors();
        app.UseRateLimiter();

        // 5. Who is calling, then whether they may.
        app.UseAuthentication();
        app.UseAuthorization();

        if (app.Services.GetRequiredService<IOptions<OpenApiSettings>>().Value.Enabled)
        {
            app.MapOpenApi();
            if (app.Environment.IsDevelopment())
            {
                app.MapScalarApiReference(options => options.WithTitle("API service"));
            }
        }

        app.MapOperationalEndpoints();
        return app;
    }

    internal static OptionsBuilder<T> AddValidated<T>(IServiceCollection services, string section)
        where T : class =>
        services.AddOptions<T>().BindConfiguration(section).ValidateDataAnnotations().ValidateOnStart();

    private static void ConfigureLogging(WebApplicationBuilder builder)
    {
        // Structured JSON by default: one object per line, scopes included (request id, trace id).
        // Development can ask for readable lines with Logging:Format=simple.
        builder.Logging.ClearProviders();
        if (string.Equals(builder.Configuration["Logging:Format"], "simple", StringComparison.OrdinalIgnoreCase))
        {
            builder.Logging.AddSimpleConsole(options => options.SingleLine = true);
        }
        else
        {
            builder.Logging.AddJsonConsole(options =>
            {
                options.IncludeScopes = true;
                options.UseUtcTimestamp = true;
                options.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ ";
            });
        }
    }

    private static void ConfigureKestrel(WebApplicationBuilder builder)
    {
        var limits = builder.Configuration.GetSection(LimitsOptions.Section).Get<LimitsOptions>() ?? new LimitsOptions();
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.AddServerHeader = false;
            kestrel.Limits.MaxRequestBodySize = limits.MaxRequestBodyBytes;
            kestrel.Limits.MaxRequestHeadersTotalSize = 32 * 1024;
            kestrel.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(15);
        });

        // PaaS convention: honour PORT when nothing more specific was configured. Explicit URLs win.
        var configuration = builder.Configuration;
        var port = configuration["PORT"];
        if (!string.IsNullOrWhiteSpace(port)
            && string.IsNullOrWhiteSpace(configuration["urls"])
            && string.IsNullOrWhiteSpace(configuration["ASPNETCORE_URLS"])
            && string.IsNullOrWhiteSpace(configuration["HTTP_PORTS"])
            && string.IsNullOrWhiteSpace(configuration["ASPNETCORE_HTTP_PORTS"])
            && int.TryParse(port, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number)
            && number is > 0 and < 65536)
        {
            builder.WebHost.UseUrls($"http://0.0.0.0:{number}");
        }
    }
}

internal sealed class CorsOptionsSetup(IOptions<CorsSettings> settings) : IConfigureOptions<CorsOptions>
{
    public void Configure(CorsOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var origins = settings.Value.Origins().ToArray();
        options.AddDefaultPolicy(policy =>
        {
            // Exact origins only, no credentials, a short list of methods and headers. With no origins
            // configured the policy matches nobody and the browser blocks every cross-origin call.
            policy.WithOrigins(origins)
                .WithMethods("GET", "POST", "PUT", "DELETE")
                .WithHeaders("Authorization", "Content-Type", RequestIdMiddleware.HeaderName)
                .WithExposedHeaders(RequestIdMiddleware.HeaderName, "Retry-After")
                .SetPreflightMaxAge(TimeSpan.FromMinutes(10));
        });
    }
}

internal sealed class ForwardedHeadersOptionsSetup(IOptions<ForwardedHeadersSettings> settings) : IConfigureOptions<ForwardedHeadersOptions>
{
    public void Configure(ForwardedHeadersOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
        options.ForwardLimit = 1;
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
        foreach (var network in settings.Value.KnownNetworks.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            options.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
        }
    }
}
