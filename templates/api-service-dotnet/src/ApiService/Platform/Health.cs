using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace ApiService.Platform;

/// <summary>
/// Liveness (/healthz) answers "is the process up" and checks nothing else, so a database outage never
/// makes an orchestrator kill a healthy process. Readiness (/readyz) runs the checks tagged "ready"
/// (the database, see Persistence). Bodies carry a status word only; never an exception message.
/// </summary>
internal static class HealthEndpoints
{
    public const string ReadyTag = "ready";

    public static void MapOperationalEndpoints(this WebApplication app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapHealthChecks("/healthz", new HealthCheckOptions
        {
            Predicate = _ => false,
            ResponseWriter = WriteStatus,
        });
        app.MapHealthChecks("/readyz", new HealthCheckOptions
        {
            Predicate = check => check.Tags.Contains(ReadyTag),
            ResponseWriter = WriteStatus,
        });
    }

    private static Task WriteStatus(HttpContext context, HealthReport report)
    {
        context.Response.ContentType = "application/json";
        var status = report.Status == HealthStatus.Healthy ? "ok" : "unavailable";
        return context.Response.WriteAsync(JsonSerializer.Serialize(new { status }));
    }
}
