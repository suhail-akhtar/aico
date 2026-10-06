using ApiService.Persistence;
using ApiService.SharedKernel;
using Microsoft.EntityFrameworkCore;

namespace ApiService.Features.Auth;

/// <summary>
/// Just-in-time provisioning for OIDC mode: the user's id IS the token's <c>sub</c>, so the first request that
/// carries a valid token for a new subject inserts the account row the rest of the service (items, ownership)
/// hangs off. Nothing is synchronised afterwards: the identity provider owns the identity, this table only
/// anchors foreign keys, so a later email change at the provider does not rewrite the row.
/// Rules that are easy to get wrong, each covered by a test:
/// <list type="bullet">
/// <item>Race-safe: two simultaneous first requests both succeed. The unique primary key decides; the loser re-reads.</item>
/// <item>If another account already owns the email, answer 409 (identity_conflict) rather than merging two people.
/// An account is an identity, and an email claim is not proof of owning a local account that registered the same address.</item>
/// <item>The row stores <see cref="User.UnusablePasswordHash"/>: local login for it is the normal 401, never an exception.</item>
/// </list>
/// One primary-key read per authenticated request is the cost; a cache of known subjects is the first thing to add if that shows up in a profile.
/// </summary>
internal sealed class OidcUserProvisioner(AppDbContext db, TimeProvider clock)
{
    private const int Attempts = 3;

    public static ConflictException IdentityConflict() =>
        new("identity_conflict", "Another account already uses this email address. It cannot be linked to this sign-in automatically.");

    /// <summary>The email an account gets from a token: the claim lower-cased, or a placeholder when it is absent or unusable.</summary>
    public static string EmailFor(Guid subject, string? claim)
    {
        var email = claim?.Trim().ToLowerInvariant();
        return string.IsNullOrEmpty(email) || email.Length > User.EmailMaxLength
            ? User.PlaceholderEmail(subject)
            : email;
    }

    public async Task EnsureAsync(Guid subject, string? emailClaim, CancellationToken cancellationToken)
    {
        if (await db.Users.AsNoTracking().AnyAsync(u => u.Id == subject, cancellationToken))
        {
            return;
        }

        var email = EmailFor(subject, emailClaim);
        for (var attempt = 1; ; attempt++)
        {
            if (await db.Users.AsNoTracking().AnyAsync(u => u.Email == email && u.Id != subject, cancellationToken))
            {
                throw IdentityConflict();
            }

            db.Users.Add(User.CreateExternal(subject, email, clock.GetUtcNow()));
            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return;
            }
            catch (DbUpdateException) when (attempt < Attempts)
            {
                // A concurrent first request inserted the same subject (or the same email) between our check and
                // our insert, or the database refused for a transient reason. Forget our attempt and look again:
                // the row being there now is success, another owner of the email is a conflict, anything else retries.
                db.ChangeTracker.Clear();
                if (await db.Users.AsNoTracking().AnyAsync(u => u.Id == subject, cancellationToken))
                {
                    return;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(20 * attempt), cancellationToken);
            }
        }
    }
}
