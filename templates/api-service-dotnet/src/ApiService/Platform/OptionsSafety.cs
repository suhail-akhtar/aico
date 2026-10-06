using System.Net;
using Microsoft.Extensions.Options;

namespace ApiService.Platform;

// Cross-field rules a data annotation cannot express. The point is to refuse to start in a
// configuration that is unsafe in production, rather than to discover it from an incident:
// a placeholder signing key, a missing connection string, the development-only SQLite provider.

internal static class Environments
{
    public const string Testing = "Testing";

    public static bool IsRelaxed(this IHostEnvironment env)
    {
        ArgumentNullException.ThrowIfNull(env);
        return env.IsDevelopment() || env.IsEnvironment(Testing);
    }
}

internal sealed class JwtOptionsSafety(IHostEnvironment env, IOptions<AuthOptions> auth) : IValidateOptions<JwtOptions>
{
    public const int SigningKeyMinLength = 32;

    public ValidateOptionsResult Validate(string? name, JwtOptions options)
    {
        if (auth.Value.Mode == AuthMode.Oidc)
        {
            return ValidateOptionsResult.Success; // tokens come from the identity provider; there is no local key to check
        }

        if (string.IsNullOrWhiteSpace(options.SigningKey))
        {
            return ValidateOptionsResult.Fail("Jwt:SigningKey is required (environment variable Jwt__SigningKey), or set Auth__Mode=oidc to use an identity provider.");
        }

        if (options.SigningKey.Length < SigningKeyMinLength)
        {
            return ValidateOptionsResult.Fail("Jwt:SigningKey must be at least 32 characters (use a random 48-byte value).");
        }

        if (!env.IsRelaxed() && options.SigningKey.StartsWith("change-me", StringComparison.OrdinalIgnoreCase))
        {
            return ValidateOptionsResult.Fail("Jwt:SigningKey is still the placeholder from .env.example; set a random value.");
        }

        return ValidateOptionsResult.Success;
    }
}

internal sealed class DatabaseOptionsSafety(IHostEnvironment env, IConfiguration configuration) : IValidateOptions<DatabaseOptions>
{
    public ValidateOptionsResult Validate(string? name, DatabaseOptions options)
    {
        if (string.IsNullOrWhiteSpace(configuration.GetConnectionString("Default")))
        {
            return ValidateOptionsResult.Fail("ConnectionStrings:Default is required (environment variable ConnectionStrings__Default).");
        }

        if (options.Provider == DatabaseProvider.Sqlite && !env.IsRelaxed())
        {
            return ValidateOptionsResult.Fail("Database:Provider=Sqlite is for development and tests only; use Postgres.");
        }

        return ValidateOptionsResult.Success;
    }
}

internal sealed class CorsSettingsSafety : IValidateOptions<CorsSettings>
{
    public ValidateOptionsResult Validate(string? name, CorsSettings options)
    {
        foreach (var origin in options.Origins())
        {
            var ok = Uri.TryCreate(origin, UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
                && uri.AbsolutePath == "/"
                && string.IsNullOrEmpty(uri.Query)
                && !origin.EndsWith('/');
            if (!ok)
            {
                return ValidateOptionsResult.Fail($"Cors:AllowedOrigins entry '{origin}' must be an exact origin like https://app.example.com (no wildcard, path or trailing slash).");
            }
        }

        return ValidateOptionsResult.Success;
    }
}

internal sealed class ForwardedHeadersSafety : IValidateOptions<ForwardedHeadersSettings>
{
    public ValidateOptionsResult Validate(string? name, ForwardedHeadersSettings options)
    {
        if (!options.Enabled)
        {
            return ValidateOptionsResult.Success;
        }

        var parts = options.KnownNetworks.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
        {
            return ValidateOptionsResult.Fail("ForwardedHeaders:Enabled needs ForwardedHeaders:KnownNetworks (CIDR list of your proxies); trusting every sender would let clients spoof their address.");
        }

        foreach (var part in parts)
        {
            if (!IPNetwork.TryParse(part, out _))
            {
                return ValidateOptionsResult.Fail($"ForwardedHeaders:KnownNetworks entry '{part}' is not a CIDR range.");
            }
        }

        return ValidateOptionsResult.Success;
    }
}

/// <summary>
/// OIDC mode refuses to start half-configured: a missing or malformed identity setting is a startup failure
/// that names the variable, never a service that boots and then answers 401 to everyone (or, worse, trusts too much).
/// Nothing is checked in local mode.
/// </summary>
internal sealed class OidcOptionsSafety(IOptions<AuthOptions> auth) : IValidateOptions<OidcOptions>
{
    public ValidateOptionsResult Validate(string? name, OidcOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (auth.Value.Mode != AuthMode.Oidc)
        {
            return ValidateOptionsResult.Success;
        }

        if (string.IsNullOrWhiteSpace(options.Issuer))
        {
            return ValidateOptionsResult.Fail("OIDC_ISSUER is required when Auth__Mode=oidc: the exact `iss` your identity provider puts in access tokens (also Oidc__Issuer).");
        }

        if (string.IsNullOrWhiteSpace(options.JwksUri))
        {
            return ValidateOptionsResult.Fail("OIDC_JWKS_URI is required when Auth__Mode=oidc: the URL of the provider's signing keys (JWKS) as reachable from this service (also Oidc__JwksUri).");
        }

        if (!Uri.TryCreate(options.JwksUri, UriKind.Absolute, out var jwks) || (jwks.Scheme != Uri.UriSchemeHttp && jwks.Scheme != Uri.UriSchemeHttps))
        {
            return ValidateOptionsResult.Fail("OIDC_JWKS_URI must be an absolute http(s) URL.");
        }

        if (string.IsNullOrWhiteSpace(options.Audience))
        {
            return ValidateOptionsResult.Fail("OIDC_AUDIENCE is required when Auth__Mode=oidc: the `aud` value an access token must carry for this API (also Oidc__Audience).");
        }

        return ValidateOptionsResult.Success;
    }
}

/// <summary>
/// The flat names (AUTH_MODE, OIDC_ISSUER, OIDC_JWKS_URI, OIDC_AUDIENCE) fill in whatever the sectioned names
/// (Auth__Mode, Oidc__Issuer, ...) left empty. A typo in the mode must not silently fall back to local
/// authentication, so an unrecognised value stops the process.
/// </summary>
internal sealed class AuthOptionsAliases(IConfiguration configuration) : IPostConfigureOptions<AuthOptions>, IPostConfigureOptions<OidcOptions>
{
    public void PostConfigure(string? name, AuthOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (!string.IsNullOrWhiteSpace(configuration[$"{AuthOptions.Section}:{nameof(AuthOptions.Mode)}"]))
        {
            return;
        }

        var flat = configuration["AUTH_MODE"];
        if (string.IsNullOrWhiteSpace(flat))
        {
            return;
        }

        options.Mode = Enum.TryParse<AuthMode>(flat.Trim(), ignoreCase: true, out var mode) && Enum.IsDefined(mode)
            ? mode
            : throw new InvalidOperationException($"AUTH_MODE must be 'local' or 'oidc', not '{flat}'.");
    }

    public void PostConfigure(string? name, OidcOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.Issuer = First(options.Issuer, "OIDC_ISSUER");
        options.JwksUri = First(options.JwksUri, "OIDC_JWKS_URI");
        options.Audience = First(options.Audience, "OIDC_AUDIENCE");
    }

    private string First(string current, string flatName) =>
        string.IsNullOrWhiteSpace(current) ? (configuration[flatName] ?? string.Empty).Trim() : current;
}
