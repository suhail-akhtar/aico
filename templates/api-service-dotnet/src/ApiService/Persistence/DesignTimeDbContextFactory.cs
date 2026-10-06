using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace ApiService.Persistence;

/// <summary>
/// Lets `dotnet ef migrations add` build the context without starting the host (and so without any
/// configuration). Migrations are generated for Postgres, the production provider; the connection
/// string here is never opened and carries no credentials.
/// </summary>
internal sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Database=design_time_only")
            .Options;
        return new AppDbContext(options);
    }
}
