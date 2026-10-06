using System.Text;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace ApiService.Features.Auth;

/// <summary>
/// Fetches the identity provider's signing keys from one configured URL (OIDC_JWKS_URI). No discovery document
/// is read: the issuer a token carries is the provider's PUBLIC address while the keys are usually reachable
/// only on an internal one (a container network), so deriving one from the other, which is what discovery does,
/// would be wrong exactly where this runs. The stock <c>HttpDocumentRetriever</c> is not used either: it insists
/// on HTTPS, which an in-cluster URL rarely is.
/// The fetch has a timeout, a size cap and no redirects (see the named client in AuthExtensions), and its failure
/// messages never include the response body.
/// </summary>
internal sealed class JwksDocumentRetriever(IHttpClientFactory clients, TimeSpan timeout) : IDocumentRetriever
{
    public const string HttpClientName = "oidc-jwks";
    public const int MaxBytes = 256 * 1024;

    public async Task<string> GetDocumentAsync(string address, CancellationToken cancel)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(address);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        deadline.CancelAfter(timeout);
        using var client = clients.CreateClient(HttpClientName);
        try
        {
            using var response = await client.GetAsync(new Uri(address), HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode)
            {
                throw new IOException($"The JWKS endpoint answered {(int)response.StatusCode}.");
            }

            if (response.Content.Headers.ContentLength > MaxBytes)
            {
                throw new IOException("The JWKS document is larger than the allowed maximum.");
            }

            var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(chunk, deadline.Token)) > 0)
            {
                if (buffer.Length + read > MaxBytes)
                {
                    throw new IOException("The JWKS document is larger than the allowed maximum.");
                }

                await buffer.WriteAsync(chunk.AsMemory(0, read), deadline.Token);
            }

            return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
        }
        catch (OperationCanceledException ex) when (!cancel.IsCancellationRequested)
        {
            throw new TimeoutException($"The JWKS endpoint did not answer within {timeout.TotalSeconds:0} s.", ex);
        }
    }
}

/// <summary>
/// Turns the JWKS document into the configuration object the JwtBearer middleware caches. Only keys this service
/// would accept are kept: RSA signing keys of at least 2048 bits whose declared algorithm, if any, is RS256.
/// An encryption key or a weak key in the document is therefore ignored rather than trusted.
/// </summary>
internal sealed class JwksConfigurationRetriever(string issuer) : IConfigurationRetriever<OpenIdConnectConfiguration>
{
    public const int MinRsaBits = 2048;

    public async Task<OpenIdConnectConfiguration> GetConfigurationAsync(string address, IDocumentRetriever retriever, CancellationToken cancel)
    {
        ArgumentNullException.ThrowIfNull(retriever);
        var document = await retriever.GetDocumentAsync(address, cancel);
        var keys = new JsonWebKeySet(document);

        var configuration = new OpenIdConnectConfiguration { Issuer = issuer };
        foreach (var key in keys.Keys.Where(IsAcceptable))
        {
            configuration.SigningKeys.Add(key);
        }

        return configuration;
    }

    internal static bool IsAcceptable(JsonWebKey key)
    {
        ArgumentNullException.ThrowIfNull(key);
        return string.Equals(key.Kty, JsonWebAlgorithmsKeyTypes.RSA, StringComparison.Ordinal)
            && (string.IsNullOrEmpty(key.Use) || string.Equals(key.Use, JsonWebKeyUseNames.Sig, StringComparison.Ordinal))
            && (string.IsNullOrEmpty(key.Alg) || string.Equals(key.Alg, SecurityAlgorithms.RsaSha256, StringComparison.Ordinal))
            && !string.IsNullOrEmpty(key.N)
            && Base64UrlEncoder.DecodeBytes(key.N).Length * 8 >= MinRsaBits;
    }
}
