using Npgsql;
using Testcontainers.PostgreSql;

namespace ApiService.Tests.Infrastructure;

/// <summary>
/// One throwaway PostgreSQL container per test run, shared by every factory, each of which gets its own
/// database. Opt-in (TEST_POSTGRES=1) so the default suite needs no Docker and no network; CI and
/// `make test-pg` turn it on. The image tag is pinned (the same version as compose.yaml); the container is
/// removed by Testcontainers' reaper when the process exits.
/// </summary>
internal static class PostgresServer
{
    private static readonly Lazy<PostgreSqlContainer> Container = new(Start);

    public static bool Enabled => Environment.GetEnvironmentVariable("TEST_POSTGRES") == "1";

    public static string CreateDatabase()
    {
        var name = "t_" + Guid.NewGuid().ToString("N");
        Execute($"CREATE DATABASE {name}");
        return name;
    }

    public static void DropDatabase(string name) => Execute($"DROP DATABASE IF EXISTS {name} WITH (FORCE)");

    public static string ConnectionString(string database) =>
        new NpgsqlConnectionStringBuilder(Container.Value.GetConnectionString()) { Database = database, Pooling = false }.ConnectionString;

    private static PostgreSqlContainer Start()
    {
        var container = new PostgreSqlBuilder("postgres:18.6-alpine").Build();
        container.StartAsync().GetAwaiter().GetResult();
        return container;
    }

    private static void Execute(string sql)
    {
        using var connection = new NpgsqlConnection(Container.Value.GetConnectionString());
        connection.Open();
        using var command = new NpgsqlCommand(sql, connection);
        command.ExecuteNonQuery();
    }
}
