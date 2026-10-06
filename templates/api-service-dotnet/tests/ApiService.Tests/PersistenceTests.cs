using ApiService.Persistence;
using ApiService.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace ApiService.Tests;

public sealed class PersistenceTests
{
    [Fact]
    public void The_committed_migrations_match_the_model()
    {
        // If this fails you changed an entity or its mapping without adding a migration:
        //   make migration name=<WhatChanged>
        using var db = new DesignTimeDbContextFactory().CreateDbContext([]);

        Assert.False(db.Database.HasPendingModelChanges(), "the model has changes no migration describes");
        Assert.Contains(db.Database.GetMigrations(), m => m.EndsWith("_InitialCreate", StringComparison.Ordinal));
    }

    [Fact]
    public void The_sqlite_development_schema_has_the_unique_constraints_the_service_relies_on()
    {
        using var factory = new ApiFactory();
        using var client = factory.CreateApiClient();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var users = db.Model.FindEntityType(typeof(ApiService.Features.Auth.User))!;
        var tokens = db.Model.FindEntityType(typeof(ApiService.Features.Auth.RefreshToken))!;

        Assert.Contains(users.GetIndexes(), i => i.IsUnique && i.Properties.Single().Name == "Email");
        Assert.Contains(tokens.GetIndexes(), i => i.IsUnique && i.Properties.Single().Name == "TokenHash");
    }

    [Fact]
    public async Task Deleting_a_user_removes_their_items_and_tokens()
    {
        using var factory = new ApiFactory();
        var session = await Session.SignUpAsync(factory);
        await session.CreateItemAsync();

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (db.Database.IsSqlite())
        {
            await db.Database.ExecuteSqlRawAsync("PRAGMA foreign_keys = ON"); // SQLite enforces foreign keys per connection, only when asked
        }

        await db.Users.ExecuteDeleteAsync();

        Assert.Empty(await db.Items.ToListAsync());
        Assert.Empty(await db.RefreshTokens.ToListAsync());
    }

    [Fact]
    public async Task Postgres_applies_every_migration_and_has_nothing_pending()
    {
        Assert.SkipUnless(PostgresServer.Enabled, "Set TEST_POSTGRES=1 (needs Docker) to run the suite against PostgreSQL.");

        using var factory = new ApiFactory();
        using var client = factory.CreateApiClient();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        Assert.Empty(await db.Database.GetPendingMigrationsAsync());
        Assert.NotEmpty(await db.Database.GetAppliedMigrationsAsync());
        Assert.Equal("Npgsql.EntityFrameworkCore.PostgreSQL", db.Database.ProviderName);
    }
}
