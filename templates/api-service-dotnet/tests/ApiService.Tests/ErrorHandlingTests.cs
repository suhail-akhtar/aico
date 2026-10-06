using ApiService.Platform;
using ApiService.SharedKernel;
using ApiService.Tests.Infrastructure;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace ApiService.Tests;

/// <summary>The exception handler on its own, for cases a real request cannot easily produce.</summary>
public sealed class ErrorHandlingTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private async Task<(int Status, string Body)> HandleAsync(Exception exception, bool aborted = false)
    {
        using var cts = new CancellationTokenSource();
        var context = new DefaultHttpContext { RequestServices = factory.Services };
        context.Response.Body = new MemoryStream();
        if (aborted)
        {
            await cts.CancelAsync();
            context.RequestAborted = cts.Token;
        }

        var handler = new GlobalExceptionHandler(factory.Services.GetRequiredService<IProblemDetailsService>(), NullLogger<GlobalExceptionHandler>.Instance);
        var handled = await handler.TryHandleAsync(context, exception, CancellationToken.None);
        Assert.True(handled);

        context.Response.Body.Position = 0;
        return (context.Response.StatusCode, await new StreamReader(context.Response.Body).ReadToEndAsync());
    }

    [Fact]
    public async Task A_kestrel_413_wrapped_in_a_400_is_reported_as_the_413_it_is()
    {
        var wrapped = new BadHttpRequestException("Failed to read parameter", StatusCodes.Status400BadRequest, new BadHttpRequestException("Request body too large.", StatusCodes.Status413PayloadTooLarge));

        var (status, body) = await HandleAsync(wrapped);

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, status);
        Assert.Contains("body_too_large", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_plain_bad_request_stays_a_400_with_a_generic_message()
    {
        var (status, body) = await HandleAsync(new BadHttpRequestException("secret internal detail: Host=db", StatusCodes.Status400BadRequest));

        Assert.Equal(StatusCodes.Status400BadRequest, status);
        Assert.DoesNotContain("secret internal detail", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Domain_exceptions_keep_their_status_and_code()
    {
        var (status, body) = await HandleAsync(new ConflictException("email_taken", "An account with this email already exists."));

        Assert.Equal(StatusCodes.Status409Conflict, status);
        Assert.Contains("email_taken", body, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_client_that_went_away_gets_no_response_body()
    {
        var (_, body) = await HandleAsync(new OperationCanceledException(), aborted: true);

        Assert.Equal(string.Empty, body);
    }
}
