using System.Buffers.Text;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using ApiService.Platform;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace ApiService.Features.Auth;

/// <summary>
/// Mints the two tokens. The access token is a short-lived signed JWT (HS256, 15 minutes by default)
/// that carries only <c>sub</c>, <c>email</c> and <c>jti</c>: nothing that can go stale. The refresh token
/// is 32 random bytes, opaque to the client, and only its SHA-256 hash is stored.
/// HS256 with a shared secret is right while this service is the only one that verifies tokens; when other
/// services must verify them, switch to an asymmetric key or an OIDC provider (docs/EXTENDING.md).
/// </summary>
internal sealed class TokenService(IOptions<JwtOptions> options, TimeProvider clock)
{
    private readonly JsonWebTokenHandler handler = new();

    public SymmetricSecurityKey SigningKey() => KeyFor(options.Value);

    public static SymmetricSecurityKey KeyFor(JwtOptions jwt)
    {
        ArgumentNullException.ThrowIfNull(jwt);
        return new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SigningKey));
    }

    public (string Token, int ExpiresInSeconds) CreateAccessToken(User user)
    {
        ArgumentNullException.ThrowIfNull(user);
        var jwt = options.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        var lifetime = TimeSpan.FromMinutes(jwt.AccessTokenMinutes);
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = jwt.Issuer,
            Audience = jwt.Audience,
            IssuedAt = now,
            NotBefore = now,
            Expires = now + lifetime,
            Subject = new ClaimsIdentity(
            [
                new Claim(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
                new Claim(JwtRegisteredClaimNames.Email, user.Email),
                new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            ]),
            SigningCredentials = new SigningCredentials(KeyFor(jwt), SecurityAlgorithms.HmacSha256),
        };
        return (handler.CreateToken(descriptor), (int)lifetime.TotalSeconds);
    }

    public static (string Raw, string Hash) NewRefreshToken()
    {
        var raw = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        return (raw, HashRefreshToken(raw));
    }

    public static string HashRefreshToken(string raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
    }

    public TimeSpan RefreshLifetime => TimeSpan.FromDays(options.Value.RefreshTokenDays);

}
