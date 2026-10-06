using System.ComponentModel.DataAnnotations;

namespace ApiService.Features.Auth;

// Request and response shapes. Every JSON name is snake_case (Platform wires the naming policy once, so RefreshToken is
// refresh_token and CreatedAt is created_at): the same contract the other API starters speak. Request properties are
// nullable + [Required] on purpose: a missing JSON member then becomes a field-level validation error ("Email is
// required") instead of an opaque deserialisation failure.

public sealed record RegisterRequest
{
    [Required]
    [EmailAddress]
    [StringLength(User.EmailMaxLength)]
    public string? Email { get; init; }

    /// <summary>Length is what matters (NIST SP 800-63B, OWASP ASVS 5.0): 12 to 128 characters, no composition rules.</summary>
    [Required]
    [StringLength(AuthRules.PasswordMaxLength, MinimumLength = AuthRules.PasswordMinLength)]
    public string? Password { get; init; }
}

public sealed record LoginRequest
{
    [Required]
    [StringLength(User.EmailMaxLength)]
    public string? Email { get; init; }

    [Required]
    [StringLength(AuthRules.PasswordMaxLength)]
    public string? Password { get; init; }
}

public sealed record RefreshRequest
{
    [Required]
    [StringLength(256)]
    public string? RefreshToken { get; init; }
}

internal sealed record TokenResponse(string AccessToken, string TokenType, int ExpiresIn, string RefreshToken);

internal sealed record UserResponse(Guid Id, string Email, DateTimeOffset CreatedAt);

internal static class AuthRules
{
    public const int PasswordMinLength = 12;
    public const int PasswordMaxLength = 128;
}
