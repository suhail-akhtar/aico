using ApiService.Features.Auth;
using ApiService.Features.Items;
using ApiService.Platform;
using ApiService.SharedKernel;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace ApiService.Persistence;

/// <summary>
/// Development seed: one demo user with a few items, so a fresh clone has something to list. It is
/// double-gated (Seed:Enabled and the Development environment, and never in OIDC mode) and the password must come from the
/// environment (Seed__DemoPassword); there is no default credential in the repository. Idempotent.
/// </summary>
internal sealed partial class DevSeeder(AppDbContext db, IPasswordHasher hasher, IOptions<SeedOptions> options, IOptions<AuthOptions> auth, IHostEnvironment environment, TimeProvider clock, ILogger<DevSeeder> logger)
{
    public async Task SeedAsync(CancellationToken cancellationToken)
    {
        var seed = options.Value;
        // In OIDC mode accounts come from the identity provider; a seeded password user could never sign in.
        if (!seed.Enabled || !environment.IsDevelopment() || auth.Value.Mode == AuthMode.Oidc)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(seed.DemoPassword) || seed.DemoPassword.Length < AuthRules.PasswordMinLength)
        {
            LogSkipped(logger);
            return;
        }

        var email = User.NormalizeEmail(seed.DemoEmail);
        if (await db.Users.AnyAsync(u => u.Email == email, cancellationToken))
        {
            return;
        }

        var now = clock.GetUtcNow();
        var user = User.Create(Ids.New(clock), email, await hasher.HashAsync(seed.DemoPassword), now);
        db.Users.Add(user);
        foreach (var (name, quantity) in new[] { ("Notebook", 12), ("Pen", 40), ("Stapler", 3) })
        {
            db.Items.Add(Item.Create(Ids.New(clock), user.Id, name, null, quantity, now));
        }

        await db.SaveChangesAsync(cancellationToken);
        LogSeeded(logger, email);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Seed skipped: set Seed__DemoPassword (12+ characters) to create the demo user")]
    private static partial void LogSkipped(ILogger logger);

    [LoggerMessage(Level = LogLevel.Information, Message = "Seeded demo user {Email}")]
    private static partial void LogSeeded(ILogger logger, string email);
}
