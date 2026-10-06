using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace ApiService.Features.Auth;

/// <summary>
/// An account. The password is only ever stored as an Argon2id hash; the email is stored lower-cased and is unique.
/// An account created on first sight of an identity-provider token (OIDC mode) has no password at all: it stores
/// <see cref="UnusablePasswordHash"/>, which is not a valid hash, so no input can ever verify against it.
/// </summary>
internal sealed class User
{
    public const int EmailMaxLength = 254;

    /// <summary>"!" can never start a PHC string ("$argon2id$..."), so the hasher answers "failed" for every password.</summary>
    public const string UnusablePasswordHash = "!oidc-account-has-no-local-password";

    /// <summary>The address given to an OIDC account whose token carries no email claim. ".invalid" is reserved (RFC 2606) and can never receive mail.</summary>
    public static string PlaceholderEmail(Guid subject) => $"{subject:D}@oidc.invalid";

    private User()
    {
    }

    public Guid Id { get; private set; }

    public string Email { get; private set; } = string.Empty;

    public string PasswordHash { get; private set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; private set; }

    public static string NormalizeEmail(string email)
    {
        ArgumentNullException.ThrowIfNull(email);
        return email.Trim().ToLowerInvariant();
    }

    public static User Create(Guid id, string email, string passwordHash, DateTimeOffset now) => new()
    {
        Id = id,
        Email = NormalizeEmail(email),
        PasswordHash = passwordHash,
        CreatedAt = now,
    };

    /// <summary>An account provisioned from an identity-provider token: id is the token's <c>sub</c>, and there is no local password.</summary>
    public static User CreateExternal(Guid subject, string email, DateTimeOffset now) => Create(subject, email, UnusablePasswordHash, now);

    public bool HasUsablePassword => !string.Equals(PasswordHash, UnusablePasswordHash, StringComparison.Ordinal);

    public void ReplacePasswordHash(string passwordHash) => PasswordHash = passwordHash;
}

internal sealed class UserConfiguration : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable("users");
        builder.HasKey(u => u.Id);
        builder.Property(u => u.Id).ValueGeneratedNever();
        builder.Property(u => u.Email).HasMaxLength(User.EmailMaxLength).IsRequired();
        builder.Property(u => u.PasswordHash).HasMaxLength(255).IsRequired();
        builder.HasIndex(u => u.Email).IsUnique();
    }
}
