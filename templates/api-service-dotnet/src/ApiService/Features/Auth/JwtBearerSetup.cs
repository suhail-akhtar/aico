using ApiService.Platform;
using ApiService.SharedKernel;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace ApiService.Features.Auth;

/// <summary>
/// The one place the bearer scheme is configured, for whichever mode is active. There are two configurations and
/// never both at once, so a token the other mode would accept cannot be replayed against this one.
/// <list type="bullet">
/// <item>Local: HS256 with the service's own key, issuer and audience from <c>Jwt</c> settings.</item>
/// <item>Oidc: RS256 pinned (no <c>none</c>, no HS*, so no algorithm confusion with the public key used as an HMAC secret),
/// keys from the JWKS URL, issuer and audience compared exactly, <c>exp</c> required, <c>sub</c> required to be a UUID.
/// The principal is then mapped to a user row (<see cref="OidcUserProvisioner"/>) in OnTokenValidated.</item>
/// </list>
/// Both validate time with the injected clock and 30 s of skew, and keep inbound claim names as issued so <c>sub</c> stays <c>sub</c>.
/// Validation is done here, in this process, even when a gateway already checked the token: a proxy's say-so is not authentication.
/// </summary>
internal sealed class JwtBearerSetup(
    IOptions<AuthOptions> auth,
    IOptions<JwtOptions> jwt,
    IOptions<OidcOptions> oidc,
    TimeProvider clock,
    IHttpClientFactory httpClients,
    ILoggerFactory loggers) : IConfigureNamedOptions<JwtBearerOptions>
{
    private static readonly TimeSpan Skew = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan KeyCacheLifetime = TimeSpan.FromHours(1);

    public void Configure(JwtBearerOptions options) => Configure(JwtBearerDefaults.AuthenticationScheme, options);

    public void Configure(string? name, JwtBearerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (name != JwtBearerDefaults.AuthenticationScheme)
        {
            return;
        }

        options.MapInboundClaims = false;
        if (auth.Value.Mode == AuthMode.Oidc)
        {
            ConfigureOidc(options, oidc.Value);
        }
        else
        {
            ConfigureLocal(options, jwt.Value);
        }
    }

    /// <summary>Token lifetime judged by the injected clock (so tests can move time), with a 30 s skew.</summary>
    internal static bool IsCurrent(DateTimeOffset now, DateTime? notBefore, DateTime? expires) =>
        expires is { } exp
            && new DateTimeOffset(DateTime.SpecifyKind(exp, DateTimeKind.Utc)) + Skew > now
            && (notBefore is not { } nbf || new DateTimeOffset(DateTime.SpecifyKind(nbf, DateTimeKind.Utc)) - Skew <= now);

    private void ConfigureLocal(JwtBearerOptions options, JwtOptions settings) =>
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = settings.Issuer,
            ValidateAudience = true,
            ValidAudience = settings.Audience,
            ValidateLifetime = true,
            RequireExpirationTime = true,
            RequireSignedTokens = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = TokenService.KeyFor(settings),
            ValidAlgorithms = [SecurityAlgorithms.HmacSha256],
            ClockSkew = Skew,
            LifetimeValidator = (notBefore, expires, _, _) => IsCurrent(clock.GetUtcNow(), notBefore, expires),
        };

    private void ConfigureOidc(JwtBearerOptions options, OidcOptions settings)
    {
        // JwtBearer fetches keys through this manager: it caches them, refetches when a token names a key it does not
        // hold, and refuses to refetch more often than the refresh interval however many such tokens arrive.
        options.ConfigurationManager = new JwksKeyManager(
            settings.JwksUri,
            settings.Issuer,
            new JwksConfigurationRetriever(settings.Issuer),
            new JwksDocumentRetriever(httpClients, TimeSpan.FromSeconds(settings.JwksTimeoutSeconds)),
            clock,
            KeyCacheLifetime,
            TimeSpan.FromSeconds(settings.JwksRefreshIntervalSeconds),
            loggers.CreateLogger<JwksKeyManager>());
        options.RefreshOnIssuerKeyNotFound = false; // unknown key ids are handled before validation, in OnMessageReceived
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = settings.Issuer,
            ValidateAudience = true,
            ValidAudience = settings.Audience,
            ValidateLifetime = true,
            RequireExpirationTime = true,
            RequireSignedTokens = true,
            ValidateIssuerSigningKey = true,
            ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
            // The token's kid must name a published key. The default (try every key when the kid is unknown) would
            // let a forged kid pass whenever any cached key verifies, and would hide an unknown kid from the
            // refetch-on-unknown-kid logic, so a rotated-in key would never be picked up.
            TryAllIssuerSigningKeys = false,
            ClockSkew = Skew,
            LifetimeValidator = (notBefore, expires, _, _) => IsCurrent(clock.GetUtcNow(), notBefore, expires),
        };
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = RefreshKeysForUnknownKeyIdAsync,
            OnTokenValidated = ProvisionAsync,
            OnChallenge = ReportIdentityConflict,
        };
    }

    /// <summary>
    /// Key rotation without a failed request: when the token names a key id the cached key set does not hold, ask the
    /// manager to refetch BEFORE validating, so the first token signed by a freshly rotated key succeeds. (The library's own
    /// refresh-on-unknown-kid only schedules a refetch for the next request, so that first token would be a 401.)
    /// The manager still enforces the refresh interval, so any number of forged key ids costs at most one fetch per interval.
    /// Failures here are deliberately ignored: validation runs next and rejects the token with the normal 401.
    /// </summary>
    private static async Task RefreshKeysForUnknownKeyIdAsync(MessageReceivedContext context)
    {
        var header = context.Request.Headers.Authorization.ToString();
        const string prefix = "Bearer ";
        if (!header.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || context.Options.ConfigurationManager is not JwksKeyManager keys)
        {
            return;
        }

#pragma warning disable CA1031 // Anything wrong here (an unreadable token, an unreachable provider) falls through to normal validation, which answers 401.
        try
        {
            var keyId = new JsonWebToken(header[prefix.Length..].Trim()).Kid;
            if (!string.IsNullOrEmpty(keyId))
            {
                _ = await keys.GetConfigurationForKeyAsync(keyId, context.HttpContext.RequestAborted);
            }
        }
        catch (Exception)
        {
            // handled by validation
        }
#pragma warning restore CA1031
    }

    private static async Task ProvisionAsync(TokenValidatedContext context)
    {
        // The subject must be a canonical UUID: it becomes the primary key of the user row and every owner id.
        var subject = context.Principal?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
        if (!Guid.TryParseExact(subject, "D", out var id) || id == Guid.Empty)
        {
            context.Fail("The token subject is missing or is not a UUID.");
            return;
        }

        var email = context.Principal!.FindFirst(JwtRegisteredClaimNames.Email)?.Value;
        var provisioner = context.HttpContext.RequestServices.GetRequiredService<OidcUserProvisioner>();
        try
        {
            await provisioner.EnsureAsync(id, email, context.HttpContext.RequestAborted);
        }
        catch (ConflictException conflict)
        {
            // Authentication cannot answer 409 itself (the handler turns every failure into a 401), so the
            // failure is carried to the challenge, which rethrows it for the shared exception handler.
            context.Fail(conflict);
        }
    }

    private static Task ReportIdentityConflict(JwtBearerChallengeContext context)
    {
        if (context.AuthenticateFailure is ConflictException conflict)
        {
            context.HandleResponse();
            throw conflict;
        }

        return Task.CompletedTask;
    }
}
