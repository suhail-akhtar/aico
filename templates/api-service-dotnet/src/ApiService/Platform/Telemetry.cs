using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace ApiService.Platform;

/// <summary>
/// OpenTelemetry traces, metrics and logs over OTLP. It is OFF unless <c>OTEL_EXPORTER_OTLP_ENDPOINT</c>
/// is set, so a plain run exports nothing and opens no connection. The standard OTEL_* variables
/// (service name, headers, protocol, sampler) are honoured by the SDK; nothing here duplicates them.
/// Probes are excluded from traces: they would otherwise be most of the volume.
/// </summary>
internal static class Telemetry
{
    public static bool IsConfigured(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return !string.IsNullOrWhiteSpace(configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]);
    }

    public static void AddTelemetry(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        if (!IsConfigured(builder.Configuration))
        {
            return;
        }

        var serviceName = builder.Configuration["OTEL_SERVICE_NAME"] ?? "api-service";
        builder.Services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(serviceName))
            .WithTracing(tracing => tracing
                .AddAspNetCoreInstrumentation(options => options.Filter = context => !RateLimiting.IsProbe(context.Request.Path))
                .AddHttpClientInstrumentation()
                .AddSource("Npgsql"))
            .WithMetrics(metrics => metrics
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation())
            .WithLogging(configureBuilder: null, configureOptions: logging =>
            {
                logging.IncludeScopes = true;
                logging.IncludeFormattedMessage = true;
            })
            .UseOtlpExporter();
    }
}
