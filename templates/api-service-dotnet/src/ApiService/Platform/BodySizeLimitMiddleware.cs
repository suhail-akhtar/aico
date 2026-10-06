using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Options;

namespace ApiService.Platform;

/// <summary>
/// Refuses an oversized request body before anything reads it. Kestrel enforces the same limit on the
/// real server, but a declared Content-Length is answered here with a proper 413 problem document, and
/// the limit also holds under the in-memory test server, which has no Kestrel. Chunked bodies are
/// capped through the request-size feature where the server supports it.
/// </summary>
internal sealed class BodySizeLimitMiddleware(RequestDelegate next, IOptions<LimitsOptions> options, IProblemDetailsService problems)
{
    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var max = options.Value.MaxRequestBodyBytes;

        if (context.Request.ContentLength is { } length && length > max)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            await problems.TryWriteAsync(new ProblemDetailsContext
            {
                HttpContext = context,
                ProblemDetails =
                {
                    Status = StatusCodes.Status413PayloadTooLarge,
                    Title = "Request body too large",
                    Detail = $"The request body may be at most {max} bytes.",
                    Extensions = { ["code"] = "body_too_large" },
                },
            });
            return;
        }

        var feature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (feature is { IsReadOnly: false })
        {
            feature.MaxRequestBodySize = max;
        }

        await next(context);
    }
}
