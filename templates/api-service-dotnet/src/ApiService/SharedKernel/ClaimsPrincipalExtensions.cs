using System.Security.Claims;
using Microsoft.IdentityModel.JsonWebTokens;

namespace ApiService.SharedKernel;

internal static class ClaimsPrincipalExtensions
{
    /// <summary>The authenticated user's id (the JWT <c>sub</c> claim). Throws if absent: callers sit behind RequireAuthorization.</summary>
    public static Guid GetUserId(this ClaimsPrincipal user)
    {
        ArgumentNullException.ThrowIfNull(user);
        var sub = user.FindFirstValue(JwtRegisteredClaimNames.Sub);
        return Guid.TryParse(sub, out var id)
            ? id
            : throw new InvalidOperationException("Authenticated principal has no valid 'sub' claim.");
    }
}
