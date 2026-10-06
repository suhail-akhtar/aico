using ApiService.Platform;
using ApiService.SharedKernel;
using Microsoft.AspNetCore.Http.HttpResults;

namespace ApiService.Features.Auth;

/// <summary>
/// /auth: register, login, refresh, logout, me. Credential endpoints sit behind the strict "auth" rate
/// limit and are anonymous by design (and answer 404 in OIDC mode, see LocalCredentialGateMiddleware); /auth/me needs a valid access token. Handlers only translate HTTP to
/// service calls: validation is declarative (the DTO attributes) and failures are exceptions the shared
/// handler renders as problem documents.
/// </summary>
internal static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var group = app.MapGroup("/auth").WithTags("Auth");

        group.MapPost("/register", Register)
            .WithName("Register")
            .WithMetadata(LocalCredentialEndpointMetadata.Instance)
            .WithSummary("Create an account and sign in")
            .RequireRateLimiting(RateLimiting.AuthPolicy)
            .Produces<TokenResponse>(StatusCodes.Status201Created)
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/login", Login)
            .WithName("Login")
            .WithMetadata(LocalCredentialEndpointMetadata.Instance)
            .WithSummary("Exchange email and password for tokens")
            .RequireRateLimiting(RateLimiting.AuthPolicy)
            .Produces<TokenResponse>()
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/refresh", Refresh)
            .WithName("Refresh")
            .WithMetadata(LocalCredentialEndpointMetadata.Instance)
            .WithSummary("Rotate a refresh token: returns a new access token and a new refresh token")
            .RequireRateLimiting(RateLimiting.AuthPolicy)
            .Produces<TokenResponse>()
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapPost("/logout", Logout)
            .WithName("Logout")
            .WithMetadata(LocalCredentialEndpointMetadata.Instance)
            .WithSummary("Revoke the refresh token and every token issued from it")
            .RequireRateLimiting(RateLimiting.AuthPolicy)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        group.MapGet("/me", Me)
            .WithName("Me")
            .WithSummary("The signed-in account")
            .RequireAuthorization()
            .Produces<UserResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return app;
    }

    private static async Task<Created<TokenResponse>> Register(RegisterRequest request, AuthService auth, CancellationToken cancellationToken)
    {
        var tokens = await auth.RegisterAsync(request.Email!, request.Password!, cancellationToken);
        return TypedResults.Created("/auth/me", tokens);
    }

    private static async Task<Ok<TokenResponse>> Login(LoginRequest request, AuthService auth, CancellationToken cancellationToken) =>
        TypedResults.Ok(await auth.LoginAsync(request.Email!, request.Password!, cancellationToken));

    private static async Task<Ok<TokenResponse>> Refresh(RefreshRequest request, AuthService auth, CancellationToken cancellationToken) =>
        TypedResults.Ok(await auth.RefreshAsync(request.RefreshToken!, cancellationToken));

    private static async Task<NoContent> Logout(RefreshRequest request, AuthService auth, CancellationToken cancellationToken)
    {
        await auth.LogoutAsync(request.RefreshToken!, cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<Ok<UserResponse>> Me(System.Security.Claims.ClaimsPrincipal user, AuthService auth, CancellationToken cancellationToken) =>
        TypedResults.Ok(await auth.GetProfileAsync(user.GetUserId(), cancellationToken));
}
