namespace ApiService.Platform;

/// <summary>
/// Response headers for an API that serves JSON and nothing a browser should render: no sniffing,
/// no framing, no referrer, no scripts, no caching of what may be personal. Set in OnStarting so they
/// also land on error documents and on responses written by other middleware. The only relaxation is
/// the Scalar docs page in Development, which needs inline script and style.
/// </summary>
internal sealed class SecurityHeadersMiddleware(RequestDelegate next, IHostEnvironment environment)
{
    private const string ApiCsp = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

    public Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var docsPage = environment.IsDevelopment() && context.Request.Path.StartsWithSegments("/scalar", StringComparison.Ordinal);

        context.Response.OnStarting(() =>
        {
            var headers = context.Response.Headers;
            headers["X-Content-Type-Options"] = "nosniff";
            headers["X-Frame-Options"] = "DENY";
            headers["Referrer-Policy"] = "no-referrer";
            headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
            if (!docsPage)
            {
                headers["Content-Security-Policy"] = ApiCsp;
                headers.CacheControl = "no-store";
            }

            return Task.CompletedTask;
        });

        return next(context);
    }
}
