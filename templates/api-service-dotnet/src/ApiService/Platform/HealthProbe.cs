namespace ApiService.Platform;

/// <summary>
/// <c>ApiService --healthcheck</c>: ask the local instance for /healthz and exit 0 or 1. It exists
/// because the runtime image is distroless (no shell, no curl, no wget), so the container HEALTHCHECK
/// has to be the application itself. It reads the same port variables the server does.
/// </summary>
internal static class HealthProbe
{
    public static bool IsRequested(string[] args)
    {
        ArgumentNullException.ThrowIfNull(args);
        return args.Contains("--healthcheck", StringComparer.Ordinal);
    }

    public static async Task<int> RunAsync(Func<string, string?> getVariable, HttpMessageHandler? handler = null)
    {
        ArgumentNullException.ThrowIfNull(getVariable);
        using var client = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        client.Timeout = TimeSpan.FromSeconds(3);
        try
        {
            using var response = await client.GetAsync(new Uri($"http://127.0.0.1:{Port(getVariable)}/healthz"));
            return response.IsSuccessStatusCode ? 0 : 1;
        }
#pragma warning disable CA1031 // The probe's contract is an exit code; any failure means unhealthy.
        catch (Exception)
#pragma warning restore CA1031
        {
            return 1;
        }
    }

    internal static int Port(Func<string, string?> getVariable)
    {
        var candidates = new[]
        {
            getVariable("PORT"),
            getVariable("ASPNETCORE_HTTP_PORTS")?.Split(';', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(),
        };
        foreach (var candidate in candidates)
        {
            if (int.TryParse(candidate, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var port) && port is > 0 and < 65536)
            {
                return port;
            }
        }

        return 8080;
    }
}
