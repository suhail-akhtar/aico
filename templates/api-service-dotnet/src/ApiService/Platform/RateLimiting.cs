using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace ApiService.Platform;

/// <summary>
/// Built-in rate limiting, partitioned by client address: a broad budget for the whole API and a much
/// tighter one for /auth (login guessing, sign-up abuse). Probes are exempt so a busy service is never
/// reported dead. Behind a reverse proxy, enable ForwardedHeaders or every client shares the proxy's
/// address and one noisy caller exhausts everyone's budget.
/// </summary>
internal static class RateLimiting
{
    public const string AuthPolicy = "auth";

    public static void Configure(RateLimiterOptions options, RateLimitSettings settings)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(settings);
        var window = TimeSpan.FromSeconds(settings.WindowSeconds);

        options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
        options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
            IsProbe(context.Request.Path)
                ? RateLimitPartition.GetNoLimiter("probes")
                : RateLimitPartition.GetFixedWindowLimiter("api:" + Client(context), _ => Fixed(settings.PermitLimit, window)));

        options.AddPolicy(AuthPolicy, context =>
            RateLimitPartition.GetFixedWindowLimiter("auth:" + Client(context), _ => Fixed(settings.AuthPermitLimit, window)));

        options.OnRejected = async (context, cancellationToken) =>
        {
            var http = context.HttpContext;
            if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            {
                http.Response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
            }

            http.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            await http.RequestServices.GetRequiredService<IProblemDetailsService>().TryWriteAsync(new ProblemDetailsContext
            {
                HttpContext = http,
                ProblemDetails =
                {
                    Status = StatusCodes.Status429TooManyRequests,
                    Title = "Too many requests",
                    Detail = "Slow down and retry after the delay in the Retry-After header.",
                    Extensions = { ["code"] = "rate_limited" },
                },
            });
            _ = cancellationToken;
        };
    }

    internal static bool IsProbe(PathString path) =>
        path.StartsWithSegments("/healthz", StringComparison.Ordinal) || path.StartsWithSegments("/readyz", StringComparison.Ordinal);

    private static string Client(HttpContext context) => context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    private static FixedWindowRateLimiterOptions Fixed(int permits, TimeSpan window) => new()
    {
        PermitLimit = permits,
        Window = window,
        QueueLimit = 0,
        AutoReplenishment = true,
    };
}

internal sealed class RateLimiterOptionsSetup(IOptions<RateLimitSettings> settings) : IConfigureOptions<RateLimiterOptions>
{
    public void Configure(RateLimiterOptions options) => RateLimiting.Configure(options, settings.Value);
}
