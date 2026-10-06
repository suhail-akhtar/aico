using System.Net;
using System.Net.Http.Json;
using System.Text;
using ApiService.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace ApiService.Tests;

public sealed class SecurityTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Theory]
    [InlineData("/healthz")]
    [InlineData("/nope")]
    [InlineData("/auth/me")]
    public async Task Every_response_carries_the_security_headers(string path)
    {
        using var client = factory.CreateApiClient();
        var response = await client.GetAsync(path);

        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("DENY", response.Headers.GetValues("X-Frame-Options").Single());
        Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
        Assert.Contains("default-src 'none'", response.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'none'", response.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.False(response.Headers.Contains("Server"), "no Server header");
        Assert.False(response.Headers.Contains("X-Powered-By"), "no X-Powered-By header");
    }

    [Fact]
    public async Task A_body_over_the_limit_is_refused_with_413_before_it_is_read()
    {
        var session = await Session.SignUpAsync(factory);
        var huge = new StringContent($"{{\"name\":\"{new string('a', 2 * 1024 * 1024)}\"}}", Encoding.UTF8, "application/json");

        var response = await session.Client.PostAsync("/items", huge);

        await Problems.AssertAsync(response, HttpStatusCode.RequestEntityTooLarge, "body_too_large");
    }

    [Fact]
    public async Task A_body_under_the_limit_is_accepted()
    {
        var session = await Session.SignUpAsync(factory);

        Assert.Equal(HttpStatusCode.Created, (await session.Client.PostAsJsonAsync("/items", new { name = "fits", quantity = 1 })).StatusCode);
    }

    [Fact]
    public async Task CORS_allows_the_listed_origin_and_nobody_else()
    {
        using var client = factory.CreateApiClient();

        using var allowed = new HttpRequestMessage(HttpMethod.Options, "/items");
        allowed.Headers.Add("Origin", "https://app.example.test");
        allowed.Headers.Add("Access-Control-Request-Method", "POST");
        allowed.Headers.Add("Access-Control-Request-Headers", "authorization,content-type");
        var yes = await client.SendAsync(allowed);
        Assert.Equal("https://app.example.test", yes.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.False(yes.Headers.Contains("Access-Control-Allow-Credentials"), "credentials are never allowed");

        using var foreign = new HttpRequestMessage(HttpMethod.Options, "/items");
        foreign.Headers.Add("Origin", "https://evil.example.test");
        foreign.Headers.Add("Access-Control-Request-Method", "POST");
        var no = await client.SendAsync(foreign);
        Assert.False(no.Headers.Contains("Access-Control-Allow-Origin"), "a foreign origin gets no CORS headers");

        using var simple = new HttpRequestMessage(HttpMethod.Get, "/healthz");
        simple.Headers.Add("Origin", "https://evil.example.test");
        Assert.False((await client.SendAsync(simple)).Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task With_no_origins_configured_nobody_gets_cross_origin_access()
    {
        using var own = new ApiFactory("Testing", new Dictionary<string, string?> { ["Cors:AllowedOrigins"] = string.Empty });
        using var client = own.CreateApiClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/healthz");
        request.Headers.Add("Origin", "https://app.example.test");

        Assert.False((await client.SendAsync(request)).Headers.Contains("Access-Control-Allow-Origin"));
    }

    [Fact]
    public async Task The_auth_endpoints_are_rate_limited_with_a_429_problem_and_retry_after()
    {
        using var own = new ApiFactory("Testing", new Dictionary<string, string?> { ["RateLimit:AuthPermitLimit"] = "3", ["RateLimit:PermitLimit"] = "1000" });
        using var client = own.CreateApiClient();

        var statuses = new List<HttpResponseMessage>();
        for (var i = 0; i < 5; i++)
        {
            statuses.Add(await client.PostAsJsonAsync("/auth/login", new { email = "a@example.test", password = "wrong password entirely" }));
        }

        Assert.Equal([HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized, HttpStatusCode.TooManyRequests, HttpStatusCode.TooManyRequests], statuses.Select(s => s.StatusCode));
        await Problems.AssertAsync(statuses[3], HttpStatusCode.TooManyRequests, "rate_limited");
        Assert.True(statuses[3].Headers.Contains("Retry-After"));
        Assert.False(statuses[0].Headers.Contains("Retry-After"));
    }

    [Fact]
    public async Task The_global_limit_applies_to_the_whole_api_but_never_to_the_probes()
    {
        using var own = new ApiFactory("Testing", new Dictionary<string, string?> { ["RateLimit:PermitLimit"] = "2" });
        using var client = own.CreateApiClient();

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/nope")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/nope")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.GetAsync("/nope")).StatusCode);

        for (var i = 0; i < 10; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);
        }
    }

    [Fact]
    public async Task The_request_id_is_echoed_when_safe_replaced_when_hostile_and_present_in_errors()
    {
        using var client = factory.CreateApiClient();

        using var safe = new HttpRequestMessage(HttpMethod.Get, "/nope");
        safe.Headers.Add("X-Request-Id", "trace-me_123");
        var ok = await client.SendAsync(safe);
        Assert.Equal("trace-me_123", ok.Headers.GetValues("X-Request-Id").Single());
        Assert.Equal("trace-me_123", (await ok.ReadJsonAsync()).GetProperty("request_id").GetString());

        using var hostile = new HttpRequestMessage(HttpMethod.Get, "/nope");
        hostile.Headers.TryAddWithoutValidation("X-Request-Id", "x\" injected: {\"forged\":\"log line\"}");
        var replaced = await client.SendAsync(hostile);
        var id = replaced.Headers.GetValues("X-Request-Id").Single();
        Assert.Matches("^[0-9a-f]{32}$", id);

        var generated = await client.GetAsync("/nope");
        Assert.Matches("^[0-9a-f]{32}$", generated.Headers.GetValues("X-Request-Id").Single());
    }

    [Fact]
    public async Task An_unexpected_exception_is_a_500_problem_that_leaks_nothing()
    {
        using var own = new ApiFactory();
        var session = await Session.SignUpAsync(own);

        // Break the database underneath the running app: the next query throws a provider exception whose
        // message names the table and the engine. None of that may reach the client.
        using (var scope = own.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApiService.Persistence.AppDbContext>();
            await db.Database.ExecuteSqlRawAsync("DROP TABLE items");
        }

        var response = await session.Client.GetAsync("/items");
        var problem = await Problems.AssertAsync(response, HttpStatusCode.InternalServerError, "internal_error");

        var text = problem.GetRawText();
        Assert.DoesNotContain("no such table", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Sqlite", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Exception", text, StringComparison.Ordinal);
        Assert.DoesNotContain("StackTrace", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("   at ", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Interactive_docs_exist_only_in_development()
    {
        using var client = factory.CreateApiClient();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/scalar/v1")).StatusCode);

        using var dev = new ApiFactory("Development", new Dictionary<string, string?>());
        using var devClient = dev.CreateApiClient();
        var page = await devClient.GetAsync("/scalar/v1");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.False(page.Headers.Contains("Content-Security-Policy"), "the docs page needs inline scripts, so it is the one place the strict CSP is relaxed");

        // The JSON API next to it keeps the strict policy even in Development.
        Assert.True((await devClient.GetAsync("/healthz")).Headers.Contains("Content-Security-Policy"));
    }

    [Fact]
    public async Task The_openapi_document_can_be_switched_off()
    {
        using var off = new ApiFactory("Testing", new Dictionary<string, string?> { ["OpenApi:Enabled"] = "false" });
        using var client = off.CreateApiClient();

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/openapi/v1.json")).StatusCode);
    }

    [Fact]
    public void Services_used_by_the_pipeline_are_registered_once()
    {
        // Guards the pipeline helper from silently depending on a service a refactor removed.
        using var scope = factory.Services.CreateScope();
        Assert.NotNull(scope.ServiceProvider.GetService<Microsoft.AspNetCore.Http.IProblemDetailsService>());
        Assert.NotNull(factory.Services.GetService<TimeProvider>());
    }
}
