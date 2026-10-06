using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ApiService.Features.Auth;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace ApiService.Tests.Infrastructure;

/// <summary>An RSA key pair the fake identity provider can sign with, and optionally publish.</summary>
internal sealed class IdpKey(string kid, RSA rsa, string use) : IDisposable
{
    public string Kid { get; } = kid;

    public RSA Rsa { get; } = rsa;

    public string Use { get; } = use;

    public void Dispose() => Rsa.Dispose();
}

/// <summary>What a minted token says. Every field is the contract a real access token from the provider would satisfy; tests vary one at a time.</summary>
internal sealed record TokenSpec
{
    /// <summary>Null omits the claim.</summary>
    public string? Subject { get; init; } = Guid.NewGuid().ToString("D");

    public string? Email { get; init; }

    public string Issuer { get; init; } = FakeIdp.Issuer;

    public string[] Audience { get; init; } = [FakeIdp.Audience];

    /// <summary>Null omits <c>exp</c>.</summary>
    public TimeSpan? Lifetime { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary><c>nbf</c> relative to "now": positive means not yet valid.</summary>
    public TimeSpan NotBefore { get; init; } = TimeSpan.Zero;

    public string Algorithm { get; init; } = SecurityAlgorithms.RsaSha256;
}

/// <summary>
/// A stand-in for the identity provider: a set of RSA keys, a JWKS document built from the published ones, a token
/// minter, and an HTTP handler that serves the document. The service under test fetches keys through the real
/// HTTP pipeline (named client, timeouts, size cap), only the network underneath is replaced, so there is no
/// socket, no Keycloak and no flakiness. The counters let a test assert how often the service went to the "network".
/// </summary>
internal sealed class FakeIdp : IDisposable
{
    public const string Issuer = "https://idp.example.test/realms/app";
    public const string JwksUri = "http://idp.internal.test:8080/realms/app/certs";
    public const string Audience = "app-api";

    private readonly List<IdpKey> published = [];
    private readonly List<IdpKey> owned = [];
    private readonly Lock gate = new();
    private int requests;

    public FakeIdp()
    {
        Primary = AddKey("key-1");
        Handler = new JwksHandler(this);
    }

    /// <summary>The key tokens are signed with unless a test says otherwise.</summary>
    public IdpKey Primary { get; }

    public HttpMessageHandler Handler { get; }

    /// <summary>How many times the service fetched the key document.</summary>
    public int JwksRequests => Volatile.Read(ref requests);

    /// <summary>When set, the JWKS endpoint answers this status instead of the document.</summary>
    public HttpStatusCode? Failure { get; set; }

    /// <summary>When true, the JWKS endpoint never answers (until the request is cancelled).</summary>
    public bool Hang { get; set; }

    public IdpKey AddKey(string kid, int bits = 2048, string use = "sig", bool publish = true)
    {
        var key = new IdpKey(kid, RSA.Create(bits), use);
        lock (gate)
        {
            owned.Add(key);
            if (publish)
            {
                published.Add(key);
            }
        }

        return key;
    }

    /// <summary>Key rotation: the provider stops publishing a key.</summary>
    public void Unpublish(IdpKey key)
    {
        lock (gate)
        {
            published.Remove(key);
        }
    }

    public void Publish(IdpKey key)
    {
        lock (gate)
        {
            published.Add(key);
        }
    }

    public string Jwks()
    {
        lock (gate)
        {
            var keys = published.Select(k =>
            {
                var p = k.Rsa.ExportParameters(includePrivateParameters: false);
                return new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["kty"] = "RSA",
                    ["use"] = k.Use,
                    ["alg"] = k.Use == "enc" ? "RSA-OAEP" : SecurityAlgorithms.RsaSha256,
                    ["kid"] = k.Kid,
                    ["n"] = Base64UrlEncoder.Encode(p.Modulus!),
                    ["e"] = Base64UrlEncoder.Encode(p.Exponent!),
                };
            });
            return JsonSerializer.Serialize(new { keys });
        }
    }

    public string Mint(DateTimeOffset now, TokenSpec? spec = null, IdpKey? key = null)
    {
        spec ??= new TokenSpec();
        key ??= Primary;
        // The payload is written by hand: the library's descriptor path fills in a default exp when none is given,
        // and a test of "no exp" needs a token that really has none.
        var claims = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            [JwtRegisteredClaimNames.Iss] = spec.Issuer,
            [JwtRegisteredClaimNames.Iat] = now.ToUnixTimeSeconds(),
            [JwtRegisteredClaimNames.Nbf] = (now + spec.NotBefore).ToUnixTimeSeconds(),
            [JwtRegisteredClaimNames.Aud] = spec.Audience.Length == 1 ? spec.Audience[0] : spec.Audience,
        };
        if (spec.Lifetime is { } life)
        {
            claims[JwtRegisteredClaimNames.Exp] = (now + life).ToUnixTimeSeconds();
        }

        if (spec.Subject is { } sub)
        {
            claims[JwtRegisteredClaimNames.Sub] = sub;
        }

        if (spec.Email is { } email)
        {
            claims[JwtRegisteredClaimNames.Email] = email;
        }

        var credentials = new SigningCredentials(new RsaSecurityKey(key.Rsa) { KeyId = key.Kid }, spec.Algorithm);
        return new JsonWebTokenHandler().CreateToken(JsonSerializer.Serialize(claims), credentials);
    }

    /// <summary>The classic algorithm-confusion forgery: an HS256 token whose HMAC secret is the provider's PUBLIC key.</summary>
    public string MintConfused(DateTimeOffset now, IdpKey? key = null)
    {
        key ??= Primary;
        var at = now.UtcDateTime;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = Audience,
            IssuedAt = at,
            NotBefore = at,
            Expires = at.AddMinutes(5),
            Claims = new Dictionary<string, object>(StringComparer.Ordinal) { [JwtRegisteredClaimNames.Sub] = Guid.NewGuid().ToString("D") },
            SigningCredentials = new SigningCredentials(
                new SymmetricSecurityKey(key.Rsa.ExportSubjectPublicKeyInfo()) { KeyId = key.Kid },
                SecurityAlgorithms.HmacSha256),
        });
    }

    /// <summary>A header that claims <c>alg: none</c> and carries no signature.</summary>
    public static string MintUnsigned(DateTimeOffset now, string? kid = null)
    {
        static string B64(string json) => Base64UrlEncoder.Encode(Encoding.UTF8.GetBytes(json));
        var header = kid is null ? "{\"alg\":\"none\",\"typ\":\"JWT\"}" : $"{{\"alg\":\"none\",\"typ\":\"JWT\",\"kid\":\"{kid}\"}}";
        var exp = now.AddHours(1).ToUnixTimeSeconds();
        return $"{B64(header)}.{B64($"{{\"sub\":\"{Guid.NewGuid()}\",\"iss\":\"{Issuer}\",\"aud\":\"{Audience}\",\"exp\":{exp}}}")}.";
    }

    /// <summary>Same header and signature, different payload: the signature no longer matches.</summary>
    public static string Tamper(string token, string newSubject)
    {
        var parts = token.Split('.');
        var payload = Encoding.UTF8.GetString(Base64UrlEncoder.DecodeBytes(parts[1]));
        using var document = JsonDocument.Parse(payload);
        var changed = document.RootElement.EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Name == "sub" ? (object)newSubject : p.Value.Clone(), StringComparer.Ordinal);
        parts[1] = Base64UrlEncoder.Encode(JsonSerializer.SerializeToUtf8Bytes(changed));
        return string.Join('.', parts);
    }

    /// <summary>Makes a host trust this provider: the three settings an operator would set, and the substituted network.</summary>
    public IReadOnlyDictionary<string, string?> Settings(params (string Key, string? Value)[] more)
    {
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Auth:Mode"] = "oidc",
            ["Oidc:Issuer"] = Issuer,
            ["Oidc:JwksUri"] = JwksUri,
            ["Oidc:Audience"] = Audience,
            ["Jwt:SigningKey"] = string.Empty, // oidc mode needs no local signing key
        };
        foreach (var (key, value) in more)
        {
            settings[key] = value;
        }

        return settings;
    }

    public ApiFactory CreateFactory(string environment = "Testing", params (string Key, string? Value)[] more) =>
        new(environment, Settings(more), Network);

    /// <summary>Replaces the network under the named key-fetch client with this provider.</summary>
    public void Network(IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddHttpClient(JwksDocumentRetriever.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => Handler);
    }

    public void Dispose()
    {
        foreach (var key in owned)
        {
            key.Dispose();
        }
    }

    private sealed class JwksHandler(FakeIdp idp) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _ = Interlocked.Increment(ref idp.requests);
            if (request.RequestUri?.ToString() != JwksUri)
            {
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }

            if (idp.Hang)
            {
                await Task.Delay(Timeout.Infinite, cancellationToken);
            }

            if (idp.Failure is { } status)
            {
                return new HttpResponseMessage(status) { Content = new StringContent("secret-looking error body that must never be echoed") };
            }

            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(idp.Jwks(), Encoding.UTF8, "application/json") };
        }
    }
}
