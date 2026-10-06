using System.ComponentModel.DataAnnotations;

namespace ApiService.Platform;

// Every setting the service reads, as a typed section. They bind from environment variables
// (Section__Key), are validated when the host starts, and a bad value stops the process with a
// message naming the key. Defaults live here or in appsettings.json; secrets never do.

internal enum DatabaseProvider
{
    Postgres,

    /// <summary>Development and tests only: zero set-up, no migrations (EnsureCreated). Refused in production.</summary>
    Sqlite,
}

internal sealed class DatabaseOptions
{
    public const string Section = "Database";

    public DatabaseProvider Provider { get; set; } = DatabaseProvider.Postgres;

    /// <summary>Apply migrations when the process starts. Fine for compose and development; in production run `ApiService --migrate` as a one-shot job instead.</summary>
    public bool MigrateOnStartup { get; set; }
}

internal sealed class JwtOptions
{
    public const string Section = "Jwt";

    /// <summary>Local mode only. Required (at least 32 characters) there and checked in <see cref="JwtOptionsSafety"/>, not by an
    /// annotation, because in oidc mode this service signs nothing and must start without it.</summary>
    public string SigningKey { get; set; } = string.Empty;

    [Required]
    public string Issuer { get; set; } = "api-service";

    [Required]
    public string Audience { get; set; } = "api-service";

    [Range(1, 60)]
    public int AccessTokenMinutes { get; set; } = 15;

    [Range(1, 90)]
    public int RefreshTokenDays { get; set; } = 14;
}

internal sealed class CorsSettings
{
    public const string Section = "Cors";

    /// <summary>Comma-separated exact origins, e.g. https://app.example.com. Empty means no cross-origin access.</summary>
    public string AllowedOrigins { get; set; } = string.Empty;

    public IReadOnlyList<string> Origins() =>
        AllowedOrigins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

internal sealed class RateLimitSettings
{
    public const string Section = "RateLimit";

    /// <summary>Requests per client address per window, across the API.</summary>
    [Range(1, 1_000_000)]
    public int PermitLimit { get; set; } = 120;

    /// <summary>Stricter budget for the /auth endpoints (credential stuffing, enumeration).</summary>
    [Range(1, 1_000_000)]
    public int AuthPermitLimit { get; set; } = 10;

    [Range(1, 3600)]
    public int WindowSeconds { get; set; } = 60;
}

internal sealed class LimitsOptions
{
    public const string Section = "Limits";

    /// <summary>Largest request body accepted, in bytes. JSON APIs rarely need more than a few KB.</summary>
    [Range(1, 100 * 1024 * 1024)]
    public long MaxRequestBodyBytes { get; set; } = 1024 * 1024;
}

internal sealed class ForwardedHeadersSettings
{
    public const string Section = "ForwardedHeaders";

    /// <summary>Trust X-Forwarded-* from the proxies in <see cref="KnownNetworks"/>. Off by default: trusting them from anyone lets a client spoof its address and dodge rate limits.</summary>
    public bool Enabled { get; set; }

    /// <summary>Comma-separated CIDR ranges of the reverse proxies, e.g. 10.0.0.0/8,172.16.0.0/12.</summary>
    public string KnownNetworks { get; set; } = string.Empty;
}

internal sealed class OpenApiSettings
{
    public const string Section = "OpenApi";

    /// <summary>Serve /openapi/v1.json. Turn off for an API whose shape you do not want to publish.</summary>
    public bool Enabled { get; set; } = true;
}

internal sealed class SeedOptions
{
    public const string Section = "Seed";

    /// <summary>Create a demo user and a few items. Development only; ignored elsewhere.</summary>
    public bool Enabled { get; set; }

    public string DemoEmail { get; set; } = "demo@example.test";

    /// <summary>From the environment (Seed__DemoPassword). Empty means no seed is created.</summary>
    public string DemoPassword { get; set; } = string.Empty;
}

/// <summary>How callers are authenticated. <c>Local</c> is the starter's own login and tokens (the default);
/// <c>Oidc</c> makes the service a plain resource server for an external identity provider.</summary>
internal enum AuthMode
{
    Local,
    Oidc,
}

internal sealed class AuthOptions
{
    public const string Section = "Auth";

    /// <summary>Auth__Mode (or the flat alias AUTH_MODE): <c>local</c> or <c>oidc</c>.</summary>
    public AuthMode Mode { get; set; } = AuthMode.Local;
}

/// <summary>
/// Settings for <see cref="AuthMode.Oidc"/>. The three identity settings are required in that mode and the
/// process refuses to start without them. Each also reads its flat, provider-neutral environment name
/// (OIDC_ISSUER, OIDC_JWKS_URI, OIDC_AUDIENCE) so one set of variables serves every starter in a bundle.
/// </summary>
internal sealed class OidcOptions
{
    public const string Section = "Oidc";

    /// <summary>The exact <c>iss</c> the provider puts in access tokens: the PUBLIC issuer URL, compared as a string.</summary>
    public string Issuer { get; set; } = string.Empty;

    /// <summary>Where to fetch the signing keys. Often an internal URL, so it is never derived from <see cref="Issuer"/>.</summary>
    public string JwksUri { get; set; } = string.Empty;

    /// <summary>The value an access token's <c>aud</c> must contain.</summary>
    public string Audience { get; set; } = string.Empty;

    /// <summary>Give up on a key fetch after this long, so a hung identity provider cannot hold requests open.</summary>
    [Range(1, 60)]
    public int JwksTimeoutSeconds { get; set; } = 5;

    /// <summary>Minimum seconds between key refetches that an unknown <c>kid</c> may trigger: a flood of forged key ids costs one fetch, not thousands.</summary>
    [Range(1, 3600)]
    public int JwksRefreshIntervalSeconds { get; set; } = 30;
}
