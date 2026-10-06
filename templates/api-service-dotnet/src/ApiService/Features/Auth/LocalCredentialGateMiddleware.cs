using ApiService.Platform;
using ApiService.SharedKernel;
using Microsoft.Extensions.Options;

namespace ApiService.Features.Auth;

/// <summary>Endpoint metadata marking an endpoint that only makes sense with local authentication (register, login, refresh, logout).</summary>
internal sealed class LocalCredentialEndpointMetadata
{
    public static LocalCredentialEndpointMetadata Instance { get; } = new();
}

/// <summary>
/// In OIDC mode the identity provider owns credentials, so the local credential endpoints answer 404 (a problem
/// document naming the setting) instead of quietly minting tokens this service would then refuse. It is a middleware
/// rather than an endpoint filter because filters run after model binding: a malformed body would answer 400 first.
/// The endpoints stay mapped in both modes so the OpenAPI document is identical.
/// </summary>
internal sealed class LocalCredentialGateMiddleware(RequestDelegate next, IOptions<AuthOptions> auth)
{
    public Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (auth.Value.Mode == AuthMode.Oidc && context.GetEndpoint()?.Metadata.GetMetadata<LocalCredentialEndpointMetadata>() is not null)
        {
            throw new NotFoundException("local_auth_disabled", "Local authentication is disabled: AUTH_MODE=oidc");
        }

        return next(context);
    }
}
