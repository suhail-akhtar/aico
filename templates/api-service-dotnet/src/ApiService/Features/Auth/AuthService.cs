using ApiService.Persistence;
using ApiService.SharedKernel;
using Microsoft.EntityFrameworkCore;

namespace ApiService.Features.Auth;

/// <summary>
/// Registration, login, refresh-token rotation and logout.
/// Rules that are easy to get wrong and are tested one by one:
/// <list type="bullet">
/// <item>Login answers the same way for an unknown account and a wrong password, and spends the same time (the Argon2 work is done either way).</item>
/// <item>A refresh token works once. Presenting a token that was already used means it leaked or was replayed, so the whole family is revoked and the real owner must log in again.</item>
/// <item>Redeeming is one atomic UPDATE ... WHERE revoked_at IS NULL, so two concurrent refreshes cannot both win.</item>
/// <item>Logout is idempotent and reveals nothing about whether the token existed.</item>
/// </list>
/// </summary>
internal sealed partial class AuthService(AppDbContext db, IPasswordHasher hasher, TokenService tokens, TimeProvider clock, ILogger<AuthService> logger)
{
    private static readonly UnauthorizedException InvalidCredentials = new("invalid_credentials", "Email or password is incorrect.");
    private static readonly UnauthorizedException InvalidRefresh = new("invalid_refresh_token", "The refresh token is invalid, expired or already used. Log in again.");

    public async Task<TokenResponse> RegisterAsync(string email, string password, CancellationToken cancellationToken)
    {
        var normalized = User.NormalizeEmail(email);
        if (await db.Users.AnyAsync(u => u.Email == normalized, cancellationToken))
        {
            throw EmailTaken();
        }

        var user = User.Create(Ids.New(clock), normalized, await hasher.HashAsync(password), clock.GetUtcNow());
        db.Users.Add(user);
        try
        {
            return await IssueAsync(user, Guid.NewGuid(), cancellationToken);
        }
        catch (DbUpdateException)
        {
            // Either we lost a race with a concurrent registration of the same address (the unique index
            // decided), or something else failed. Only the first is a conflict; the second must surface.
            db.ChangeTracker.Clear();
            if (await db.Users.AsNoTracking().AnyAsync(u => u.Email == normalized, cancellationToken))
            {
                throw EmailTaken();
            }

            throw;
        }
    }

    public async Task<TokenResponse> LoginAsync(string email, string password, CancellationToken cancellationToken)
    {
        var normalized = User.NormalizeEmail(email);
        var user = await db.Users.SingleOrDefaultAsync(u => u.Email == normalized, cancellationToken);
        if (user is null || !user.HasUsablePassword)
        {
            // Same cost as a real check: no timing oracle for "does this account exist", and none for "this account
            // signs in through the identity provider" (an OIDC-provisioned row has no password hash to verify).
            _ = await hasher.HashAsync(password);
            throw InvalidCredentials;
        }

        var result = await hasher.VerifyAsync(user.PasswordHash, password);
        if (result == PasswordVerification.Failed)
        {
            throw InvalidCredentials;
        }

        if (result == PasswordVerification.SuccessRehashNeeded)
        {
            user.ReplacePasswordHash(await hasher.HashAsync(password));
        }

        return await IssueAsync(user, Guid.NewGuid(), cancellationToken);
    }

    public async Task<TokenResponse> RefreshAsync(string rawToken, CancellationToken cancellationToken)
    {
        var now = clock.GetUtcNow();
        var hash = TokenService.HashRefreshToken(rawToken);
        var stored = await db.RefreshTokens.AsNoTracking().SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken)
            ?? throw InvalidRefresh;

        // Atomic claim: exactly one caller flips RevokedAt from null. Anyone else is a replay.
        var claimed = await db.RefreshTokens
            .Where(t => t.Id == stored.Id && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, now), cancellationToken);
        if (claimed == 0)
        {
            await RevokeFamilyAsync(stored.FamilyId, now, cancellationToken);
            LogReuse(logger, stored.UserId);
            throw InvalidRefresh;
        }

        if (stored.IsExpired(now))
        {
            throw InvalidRefresh;
        }

        var user = await db.Users.SingleOrDefaultAsync(u => u.Id == stored.UserId, cancellationToken)
            ?? throw InvalidRefresh;
        return await IssueAsync(user, stored.FamilyId, cancellationToken);
    }

    public async Task LogoutAsync(string rawToken, CancellationToken cancellationToken)
    {
        var hash = TokenService.HashRefreshToken(rawToken);
        var stored = await db.RefreshTokens.AsNoTracking().SingleOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (stored is not null)
        {
            await RevokeFamilyAsync(stored.FamilyId, clock.GetUtcNow(), cancellationToken);
        }
    }

    public async Task<UserResponse> GetProfileAsync(Guid userId, CancellationToken cancellationToken)
    {
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId, cancellationToken)
            ?? throw new NotFoundException("user_not_found", "The account no longer exists.");
        return new UserResponse(user.Id, user.Email, user.CreatedAt);
    }

    private async Task<TokenResponse> IssueAsync(User user, Guid familyId, CancellationToken cancellationToken)
    {
        var (accessToken, expiresIn) = tokens.CreateAccessToken(user);
        var (raw, hash) = TokenService.NewRefreshToken();
        db.RefreshTokens.Add(RefreshToken.Create(Ids.New(clock), user.Id, familyId, hash, clock.GetUtcNow(), tokens.RefreshLifetime));
        await db.SaveChangesAsync(cancellationToken);
        return new TokenResponse(accessToken, "Bearer", expiresIn, raw);
    }

    private Task<int> RevokeFamilyAsync(Guid familyId, DateTimeOffset now, CancellationToken cancellationToken) =>
        db.RefreshTokens
            .Where(t => t.FamilyId == familyId && t.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedAt, now), cancellationToken);

    private static ConflictException EmailTaken() => new("email_taken", "An account with this email already exists.");

    [LoggerMessage(Level = LogLevel.Warning, Message = "Refresh token reuse detected for user {UserId}; the token family was revoked")]
    private static partial void LogReuse(ILogger logger, Guid userId);
}
