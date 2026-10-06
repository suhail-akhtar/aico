using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace ApiService.Persistence;

/// <summary>
/// Readiness: the database must answer, and the check turns unhealthy the moment shutdown begins, so a
/// load balancer drains the instance before it stops. A failure is reported as a status word, never as
/// the exception text (connection strings and hostnames live in those).
/// </summary>
internal sealed class DatabaseReadinessCheck(AppDbContext db, IHostApplicationLifetime lifetime) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        if (lifetime.ApplicationStopping.IsCancellationRequested)
        {
            return HealthCheckResult.Unhealthy("shutting down");
        }

        try
        {
            return await db.Database.CanConnectAsync(cancellationToken)
                ? HealthCheckResult.Healthy()
                : HealthCheckResult.Unhealthy("database unreachable");
        }
#pragma warning disable CA1031 // A readiness probe must turn any failure into "not ready", never throw.
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
#pragma warning restore CA1031
        {
            return HealthCheckResult.Unhealthy("database unreachable");
        }
    }
}
