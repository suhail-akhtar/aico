using System.Text.RegularExpressions;

namespace ApiService.Platform;

/// <summary>
/// Gives every request one correlation id: the caller's <c>X-Request-Id</c> when it is a short
/// harmless token, otherwise a fresh one. It is echoed in the response header, put in the log scope
/// (so every log line of the request carries it) and copied into error documents. The header value is
/// validated because it ends up in logs and headers: an attacker-chosen value must not be able to
/// forge log lines or split a header.
/// </summary>
internal sealed partial class RequestIdMiddleware(RequestDelegate next, ILogger<RequestIdMiddleware> logger)
{
    public const string HeaderName = "X-Request-Id";
    public const string ItemKey = "RequestId";

    private static readonly Func<ILogger, string, IDisposable?> Scope =
        LoggerMessage.DefineScope<string>("CorrelationId:{CorrelationId}");

    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)]
    private static partial Regex Safe();

    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var supplied = context.Request.Headers[HeaderName].ToString();
        var id = Safe().IsMatch(supplied) ? supplied : Guid.NewGuid().ToString("N");

        context.Items[ItemKey] = id;
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[HeaderName] = id;
            return Task.CompletedTask;
        });

        using (Scope(logger, id))
        {
            await next(context);
        }
    }

    public static string? Get(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        return context.Items.TryGetValue(ItemKey, out var value) ? value as string : null;
    }
}
