using ApiService.Features.Auth;
using ApiService.Features.Items;
using Microsoft.EntityFrameworkCore;

namespace ApiService.Persistence;

/// <summary>
/// The one DbContext (EF Core is already a repository plus a unit of work, so no wrapper is added on
/// top). Each feature owns the mapping of its own entities (an IEntityTypeConfiguration next to the
/// entity); the relationships BETWEEN features are declared here, so the features themselves never
/// reference each other. When a feature becomes a module of its own, it takes its entities and
/// configuration with it and gets its own DbContext and schema (docs/ARCHITECTURE.md).
/// </summary>
internal sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();

    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();

    public DbSet<Item> Items => Set<Item>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);

        // Cross-feature relationships: deleting a user removes their tokens and items.
        modelBuilder.Entity<RefreshToken>().HasOne<User>().WithMany().HasForeignKey(t => t.UserId).OnDelete(DeleteBehavior.Cascade);
        modelBuilder.Entity<Item>().HasOne<User>().WithMany().HasForeignKey(i => i.OwnerId).OnDelete(DeleteBehavior.Cascade);
    }
}
