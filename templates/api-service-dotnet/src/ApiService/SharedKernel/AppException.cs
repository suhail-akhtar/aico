namespace ApiService.SharedKernel;

/// <summary>
/// An expected failure with a stable machine-readable <see cref="Code"/> and an HTTP status.
/// Services throw these; one exception handler (Platform/ProblemDetailsSetup) turns them into
/// RFC 9457 problem documents, so no endpoint hand-writes an error body and nothing else leaks.
/// </summary>
internal abstract class AppException(string code, string message, int statusCode) : Exception(message)
{
    public string Code { get; } = code;

    public int StatusCode { get; } = statusCode;
}

internal sealed class NotFoundException(string code, string message) : AppException(code, message, StatusCodes.Status404NotFound);

internal sealed class ConflictException(string code, string message) : AppException(code, message, StatusCodes.Status409Conflict);

/// <summary>Authentication failed. Never say which half (account or secret) was wrong.</summary>
internal sealed class UnauthorizedException(string code, string message) : AppException(code, message, StatusCodes.Status401Unauthorized);
