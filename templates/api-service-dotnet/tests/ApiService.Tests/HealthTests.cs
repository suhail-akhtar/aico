using System.Net;
using ApiService.Persistence;
using ApiService.Platform;
using ApiService.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;

namespace ApiService.Tests;

public sealed class HealthTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Liveness_and_readiness_answer_ok_with_a_status_word_only()
    {
        using var client = factory.CreateApiClient();

        foreach (var path in new[] { "/healthz", "/readyz" })
        {
            var response = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("{\"status\":\"ok\"}", await response.Content.ReadAsStringAsync());
        }
    }

    [Fact]
    public async Task A_failing_readiness_check_answers_503_and_liveness_stays_ok()
    {
        using var own = new ApiFactory();
        using var failing = own.WithWebHostBuilder(builder => builder.ConfigureServices(services =>
            services.AddHealthChecks().AddCheck("always-down", () => HealthCheckResult.Unhealthy("secret detail"), tags: [HealthEndpoints.ReadyTag])));
        using var client = failing.CreateClient();

        var ready = await client.GetAsync("/readyz");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, ready.StatusCode);
        Assert.Equal("{\"status\":\"unavailable\"}", await ready.Content.ReadAsStringAsync()); // no detail leaks
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);
    }

    [Fact]
    public async Task The_database_check_reports_an_unreachable_database_without_throwing_or_leaking()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>().UseSqlite("Data Source=/nonexistent-directory/x.db;Mode=ReadOnly").Options;
        await using var db = new AppDbContext(options);
        using var lifetime = new FakeLifetime();

        var result = await new DatabaseReadinessCheck(db, lifetime).CheckHealthAsync(new HealthCheckContext());

        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.Equal("database unreachable", result.Description);
        Assert.Null(result.Exception);
    }

    [Fact]
    public async Task Readiness_turns_unhealthy_as_soon_as_shutdown_begins()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        using var lifetime = new FakeLifetime();
        var check = new DatabaseReadinessCheck(db, lifetime);

        Assert.Equal(HealthStatus.Healthy, (await check.CheckHealthAsync(new HealthCheckContext())).Status);

        lifetime.Stop();

        var result = await check.CheckHealthAsync(new HealthCheckContext());
        Assert.Equal(HealthStatus.Unhealthy, result.Status);
        Assert.Equal("shutting down", result.Description);
    }

    [Fact]
    public async Task The_container_probe_exits_zero_when_healthy_and_one_otherwise()
    {
        Assert.Equal(0, await HealthProbe.RunAsync(_ => null, new StubHandler(HttpStatusCode.OK)));
        Assert.Equal(1, await HealthProbe.RunAsync(_ => null, new StubHandler(HttpStatusCode.ServiceUnavailable)));
        Assert.Equal(1, await HealthProbe.RunAsync(_ => null, new StubHandler(null)));
    }

    [Theory]
    [InlineData(null, null, 8080)]
    [InlineData("3000", null, 3000)]
    [InlineData(null, "9090;9091", 9090)]
    [InlineData("3000", "9090", 3000)]
    [InlineData("0", "70000", 8080)]
    [InlineData("abc", null, 8080)]
    public void The_probe_reads_the_same_port_variables_as_the_server(string? port, string? httpPorts, int expected)
    {
        string? Env(string name) => name switch { "PORT" => port, "ASPNETCORE_HTTP_PORTS" => httpPorts, _ => null };

        Assert.Equal(expected, HealthProbe.Port(Env));
    }

    [Fact]
    public void The_probe_flag_is_recognised()
    {
        Assert.True(HealthProbe.IsRequested(["--healthcheck"]));
        Assert.False(HealthProbe.IsRequested(["--urls", "http://x"]));
    }

    private sealed class StubHandler(HttpStatusCode? status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            status is { } code
                ? Task.FromResult(new HttpResponseMessage(code))
                : throw new HttpRequestException("connection refused");
    }

    private sealed class FakeLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource stopping = new();

        public CancellationToken ApplicationStarted => CancellationToken.None;

        public CancellationToken ApplicationStopping => stopping.Token;

        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication() => stopping.Cancel();

        public void Stop() => StopApplication();

        public void Dispose() => stopping.Dispose();
    }
}
