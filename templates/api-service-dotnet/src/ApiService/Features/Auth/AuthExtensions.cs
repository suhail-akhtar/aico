using ApiService.Platform;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;

namespace ApiService.Features.Auth;

/// <summary>
/// Wires the Auth feature. One bearer scheme, configured for the active mode by <see cref="JwtBearerSetup"/>:
/// <c>Auth__Mode=local</c> (the default) is this service's own login and HS256 tokens, <c>Auth__Mode=oidc</c> makes it a
/// resource server for an external identity provider (RS256 keys from OIDC_JWKS_URI, issuer and audience pinned).
/// Validation is strict in both: signature, issuer, audience and lifetime are all required, the algorithm is pinned
/// (no algorithm confusion, no "none"), clock skew is 30 s, and inbound claim names are kept as issued so <c>sub</c> stays <c>sub</c>.
/// </summary>
internal static class AuthExtensions
{
    public static WebApplicationBuilder AddAuthFeature(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var services = builder.Services;

        PlatformExtensions.AddValidated<AuthOptions>(services, AuthOptions.Section);
        PlatformExtensions.AddValidated<OidcOptions>(services, OidcOptions.Section).Services
            .AddSingleton<IValidateOptions<OidcOptions>, OidcOptionsSafety>();
        services.AddSingleton<AuthOptionsAliases>();
        services.AddSingleton<IPostConfigureOptions<AuthOptions>>(provider => provider.GetRequiredService<AuthOptionsAliases>());
        services.AddSingleton<IPostConfigureOptions<OidcOptions>>(provider => provider.GetRequiredService<AuthOptionsAliases>());
        PlatformExtensions.AddValidated<JwtOptions>(services, JwtOptions.Section).Services
            .AddSingleton<IValidateOptions<JwtOptions>, JwtOptionsSafety>();
        services.AddOptions<PasswordHashingOptions>();

        services.AddSingleton<IPasswordHasher, Argon2idPasswordHasher>();
        services.AddSingleton<TokenService>();
        services.AddScoped<AuthService>();
        services.AddScoped<OidcUserProvisioner>();

        // The key fetch uses a named client so it has no redirects and so tests can substitute the network.
        services.AddHttpClient(JwksDocumentRetriever.HttpClientName)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();
        services.AddSingleton<IConfigureOptions<JwtBearerOptions>, JwtBearerSetup>();
        services.AddAuthorization();
        return builder;
    }

    /// <summary>
    /// After the platform pipeline, before the endpoints: in oidc mode the local credential endpoints answer 404,
    /// and they do so before the request body is read, so a malformed body cannot turn that into a 400.
    /// </summary>
    public static WebApplication UseAuthFeature(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.UseMiddleware<LocalCredentialGateMiddleware>();
        return app;
    }
}
