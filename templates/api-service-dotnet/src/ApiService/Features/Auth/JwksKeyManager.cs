using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace ApiService.Features.Auth;

/// <summary>
/// Caches the provider's signing keys and decides, in one place, when to fetch them again:
/// <list type="bullet">
/// <item>Routinely every <c>cacheLifetime</c> (an hour), so a key retired at the provider is eventually dropped.</item>
/// <item>When a token names a key id the cache does not hold (a rotation), BEFORE that token is validated, so the first
/// token signed by the new key succeeds. At most once per <c>minRefresh</c>: a flood of forged key ids costs one fetch.</item>
/// <item>Never at all while a fetch is failing and keys are cached: the last good keys keep working (an identity-provider
/// outage must not log everybody out), and the next attempt waits <c>minRefresh</c>.</item>
/// </list>
/// Why not <c>ConfigurationManager&lt;T&gt;</c> from the IdentityModel package: its refresh runs in the background and the
/// current request still sees the stale keys, which turns the first request after a rotation into a 401, and it has no
/// clock seam, so none of this could be tested without sleeping. This class is small and uses the injected clock.
/// With nothing cached and the provider down, the manager answers with an EMPTY key set (so every token fails
/// validation with the normal 401) and does not try again for a second, instead of queueing each request behind a fetch
/// timeout. It never throws: JwtBearer does not catch an exception from a custom manager, and the answer would be a 500.
/// </summary>
internal sealed partial class JwksKeyManager(
    string address,
    string issuer,
    IConfigurationRetriever<OpenIdConnectConfiguration> retriever,
    IDocumentRetriever documents,
    TimeProvider clock,
    TimeSpan cacheLifetime,
    TimeSpan minRefresh,
    ILogger<JwksKeyManager> logger) : IConfigurationManager<OpenIdConnectConfiguration>, IDisposable
{
    private static readonly TimeSpan FailureBackoff = TimeSpan.FromSeconds(1);

    private readonly SemaphoreSlim gate = new(1, 1);
    private OpenIdConnectConfiguration? current;
    private long expiresAtTicks;
    private long lastAttemptTicks = long.MinValue;
    private long retryAfterTicks;

    public async Task<OpenIdConnectConfiguration> GetConfigurationAsync(CancellationToken cancel)
    {
        var cached = Volatile.Read(ref current);
        return cached is not null && clock.GetUtcNow().UtcTicks < Interlocked.Read(ref expiresAtTicks)
            ? cached
            : await FetchAsync(force: false, cancel);
    }

    /// <summary>Unknown key ids are handled by <see cref="GetConfigurationForKeyAsync"/> before validation, so there is nothing to schedule here.</summary>
    public void RequestRefresh()
    {
    }

    /// <summary>The cached keys, refetched first (rate limited) if none of them has this key id.</summary>
    public async Task<OpenIdConnectConfiguration> GetConfigurationForKeyAsync(string keyId, CancellationToken cancel)
    {
        var configuration = await GetConfigurationAsync(cancel);
        if (configuration.SigningKeys.Any(k => string.Equals(k.KeyId, keyId, StringComparison.Ordinal))
            || !RefreshAllowed(clock.GetUtcNow()))
        {
            return configuration;
        }

        return await FetchAsync(force: true, cancel);
    }

    public void Dispose() => gate.Dispose();

    [LoggerMessage(Level = LogLevel.Warning, Message = "Fetching the identity provider's signing keys (OIDC_JWKS_URI) failed: {Outcome}")]
    private static partial void LogFetchFailed(ILogger logger, string outcome, Exception exception);

    private bool RefreshAllowed(DateTimeOffset now)
    {
        var last = Interlocked.Read(ref lastAttemptTicks);
        return last == long.MinValue || now.UtcTicks - last >= minRefresh.Ticks;
    }

    private async Task<OpenIdConnectConfiguration> FetchAsync(bool force, CancellationToken cancel)
    {
        await gate.WaitAsync(cancel);
        try
        {
            var now = clock.GetUtcNow();
            var cached = current;
            var due = cached is null || now.UtcTicks >= Interlocked.Read(ref expiresAtTicks);
            if (!due && !(force && RefreshAllowed(now)))
            {
                return cached!; // another request refreshed while this one waited
            }

            if (cached is null && now.UtcTicks < Interlocked.Read(ref retryAfterTicks))
            {
                return new OpenIdConnectConfiguration { Issuer = issuer }; // still backing off after a failed fetch
            }

            _ = Interlocked.Exchange(ref lastAttemptTicks, now.UtcTicks);
#pragma warning disable CA1031 // A failed fetch is recorded and either papered over with the cached keys or rethrown below.
            try
            {
                var fresh = await retriever.GetConfigurationAsync(address, documents, cancel);
                Volatile.Write(ref current, fresh);
                _ = Interlocked.Exchange(ref expiresAtTicks, (now + cacheLifetime).UtcTicks);
                return fresh;
            }
            catch (Exception ex) when (!cancel.IsCancellationRequested)
            {
                if (cached is not null)
                {
                    LogFetchFailed(logger, "serving the cached keys and retrying later", ex);
                    _ = Interlocked.Exchange(ref expiresAtTicks, (now + minRefresh).UtcTicks);
                    return cached;
                }

                LogFetchFailed(logger, "no keys are cached, so tokens are refused until it succeeds", ex);
                _ = Interlocked.Exchange(ref retryAfterTicks, (now + FailureBackoff).UtcTicks);
                return new OpenIdConnectConfiguration { Issuer = issuer };
            }
#pragma warning restore CA1031
        }
        finally
        {
            _ = gate.Release();
        }
    }
}
