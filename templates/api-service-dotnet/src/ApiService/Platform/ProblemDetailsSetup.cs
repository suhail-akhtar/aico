using System.Diagnostics;
using System.Text.Json;
using ApiService.SharedKernel;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;

namespace ApiService.Platform;

/// <summary>
/// The one place an exception becomes a response. Every error the API sends is an RFC 9457
/// <c>application/problem+json</c> document with a stable <c>code</c> and the request id; validation
/// errors (400), unknown routes (404), 401/403/405/429 and unhandled exceptions all take the same shape.
/// An unexpected exception is logged in full and answered with a fixed message: no type name, no
/// stack trace, no inner exception ever reaches the client, in any environment.
/// </summary>
internal sealed partial class GlobalExceptionHandler(IProblemDetailsService problems, ILogger<GlobalExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        ArgumentNullException.ThrowIfNull(exception);

        if (exception is OperationCanceledException && httpContext.RequestAborted.IsCancellationRequested)
        {
            return true; // the client went away; nobody to answer.
        }

        var (status, title, code, detail) = exception switch
        {
            AppException app => (app.StatusCode, Reason(app.StatusCode), app.Code, app.Message),
            _ when Innermost(exception) is { } bad => (bad.StatusCode, Reason(bad.StatusCode), bad.StatusCode == StatusCodes.Status413PayloadTooLarge ? "body_too_large" : "bad_request", "The request could not be read."),
            _ => (StatusCodes.Status500InternalServerError, "An unexpected error occurred", "internal_error", "The server failed to process the request. Quote the request id when reporting this."),
        };

        if (status >= StatusCodes.Status500InternalServerError)
        {
            LogUnhandled(logger, exception);
        }
        else
        {
            LogHandled(logger, status, code, exception);
        }

        httpContext.Response.StatusCode = status;
        if (exception is UnauthorizedException)
        {
            httpContext.Response.Headers.WWWAuthenticate = "Bearer";
        }

        return await problems.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = null, // never let the framework attach exception details to the document
            ProblemDetails =
            {
                Status = status,
                Title = title,
                Detail = detail,
                Extensions = { ["code"] = code },
            },
        });
    }

    /// <summary>The framework wraps body-read failures: a Kestrel 413 arrives inside a 400 "failed to read parameter". The innermost one is the real cause.</summary>
    internal static BadHttpRequestException? Innermost(Exception exception)
    {
        BadHttpRequestException? found = null;
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is BadHttpRequestException bad)
            {
                found = bad;
            }
        }

        return found;
    }

    private static string Reason(int status) => status switch
    {
        StatusCodes.Status400BadRequest => "Bad request",
        StatusCodes.Status401Unauthorized => "Authentication required",
        StatusCodes.Status404NotFound => "Not found",
        StatusCodes.Status409Conflict => "Conflict",
        StatusCodes.Status413PayloadTooLarge => "Request body too large",
        StatusCodes.Status415UnsupportedMediaType => "Unsupported media type",
        _ => "Request failed",
    };

    [LoggerMessage(Level = LogLevel.Debug, Message = "Request answered {Status} ({Code})")]
    private static partial void LogHandled(ILogger logger, int status, string code, Exception exception);

    [LoggerMessage(Level = LogLevel.Error, Message = "Unhandled exception while processing a request")]
    private static partial void LogUnhandled(ILogger logger, Exception exception);
}

internal static class ProblemDetailsSetup
{
    /// <summary>Adds the request id and trace id to every problem document, whoever produced it.</summary>
    public static void Customize(ProblemDetailsContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        var problem = context.ProblemDetails;

        // The wire format is snake_case everywhere; validation keys come from C# member names ("RefreshToken"),
        // so rename them to match the JSON the client sent ("refresh_token").
        if (problem is HttpValidationProblemDetails validation)
        {
            var renamed = validation.Errors.ToDictionary(e => JsonNamingPolicy.SnakeCaseLower.ConvertName(e.Key), e => e.Value, StringComparer.Ordinal);
            validation.Errors = renamed;
        }

        problem.Extensions["request_id"] = RequestIdMiddleware.Get(context.HttpContext) ?? context.HttpContext.TraceIdentifier;
        var traceId = Activity.Current?.TraceId.ToString();
        if (traceId is not null)
        {
            problem.Extensions["trace_id"] = traceId;
        }

    }
}
