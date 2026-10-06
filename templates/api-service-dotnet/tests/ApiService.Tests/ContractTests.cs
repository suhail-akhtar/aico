using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using ApiService.Tests.Infrastructure;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace ApiService.Tests;

/// <summary>
/// The API contract is the generated OpenAPI document. It is committed (Snapshots/openapi.v1.json) and
/// compared on every run, so changing the API surface shows up as a diff a reviewer must accept.
/// To accept an intended change: UPDATE_SNAPSHOTS=1 dotnet test, then commit the file.
/// </summary>
public sealed partial class ContractTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    [GeneratedRegex("\\{(?<name>\\w+)(:[^}]+)?\\}", RegexOptions.CultureInvariant | RegexOptions.ExplicitCapture, matchTimeoutMilliseconds: 200)]
    private static partial Regex RouteParameter();

    private static string SnapshotPath([CallerFilePath] string testFile = "") =>
        Path.Combine(Path.GetDirectoryName(testFile)!, "Snapshots", "openapi.v1.json");

    private async Task<JsonElement> DocumentAsync()
    {
        using var client = factory.CreateApiClient();
        var response = await client.GetAsync("/openapi/v1.json");
        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        return await response.ReadJsonAsync();
    }

    [Fact]
    public async Task The_openapi_document_matches_the_committed_snapshot()
    {
        var document = await DocumentAsync();
        var actual = JsonSerializer.Serialize(document, Pretty).ReplaceLineEndings("\n") + "\n";
        var path = SnapshotPath();

        if (Environment.GetEnvironmentVariable("UPDATE_SNAPSHOTS") == "1")
        {
            await File.WriteAllTextAsync(path, actual);
            return;
        }

        Assert.True(File.Exists(path), $"No snapshot at {path}. Run once with UPDATE_SNAPSHOTS=1 and commit it.");
        var expected = (await File.ReadAllTextAsync(path)).ReplaceLineEndings("\n");
        if (expected != actual)
        {
            await File.WriteAllTextAsync(Path.ChangeExtension(path, ".received.json"), actual);
        }

        Assert.True(expected == actual, "The OpenAPI document changed. Review Snapshots/openapi.v1.received.json against openapi.v1.json; if the change is intended, run UPDATE_SNAPSHOTS=1 dotnet test and commit.");
    }

    [Fact]
    public async Task The_document_is_openapi_3_1_with_a_bearer_scheme()
    {
        var document = await DocumentAsync();

        Assert.StartsWith("3.1", document.GetProperty("openapi").GetString(), StringComparison.Ordinal);
        var scheme = document.GetProperty("components").GetProperty("securitySchemes").GetProperty("Bearer");
        Assert.Equal("http", scheme.GetProperty("type").GetString());
        Assert.Equal("bearer", scheme.GetProperty("scheme").GetString());
    }

    [Fact]
    public async Task Every_mapped_endpoint_is_documented_and_nothing_else_is()
    {
        var document = await DocumentAsync();
        var documented = new HashSet<string>(StringComparer.Ordinal);
        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                documented.Add($"{operation.Name.ToUpperInvariant()} {path.Name}");
            }
        }

        var mapped = new HashSet<string>(StringComparer.Ordinal);
        foreach (var endpoint in factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>())
        {
            var pattern = (endpoint.RoutePattern.RawText ?? string.Empty).TrimEnd('/');
            if (pattern.StartsWith("/openapi", StringComparison.Ordinal) || pattern.StartsWith("/scalar", StringComparison.Ordinal) || pattern is "/healthz" or "/readyz")
            {
                continue; // served by the framework or operational probes, not part of the API contract
            }

            var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [];
            foreach (var method in methods)
            {
                mapped.Add($"{method} {RouteParameter().Replace(pattern, "{${name}}")}");
            }
        }

        Assert.NotEmpty(mapped);
        Assert.Equal(mapped.Order(StringComparer.Ordinal), documented.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Operations_declare_their_success_and_error_responses_in_one_shape()
    {
        var document = await DocumentAsync();
        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                var where = $"{operation.Name.ToUpperInvariant()} {path.Name}";
                var responses = operation.Value.GetProperty("responses").EnumerateObject().ToList();
                Assert.Contains(responses, r => r.Name.StartsWith('2'));
                Assert.False(string.IsNullOrWhiteSpace(operation.Value.GetProperty("summary").GetString()), $"{where} has a summary");
                Assert.True(operation.Value.TryGetProperty("operationId", out _), $"{where} has an operationId");

                foreach (var response in responses.Where(r => r.Name[0] is '4' or '5'))
                {
                    var content = response.Value.GetProperty("content");
                    Assert.True(content.TryGetProperty("application/problem+json", out _), $"{where} {response.Name} is a problem document");
                }

                if (operation.Value.TryGetProperty("security", out _))
                {
                    Assert.Contains(responses, r => r.Name == "401"); // a bearer-protected operation documents its 401
                }
            }
        }
    }

    [Fact]
    public async Task Real_responses_use_only_status_codes_the_document_promises()
    {
        var document = await DocumentAsync();
        var session = await Session.SignUpAsync(factory);
        var item = await session.CreateItemAsync();

        async Task Check(string method, string path, HttpResponseMessage response)
        {
            var key = method.ToLowerInvariant();
            var promised = document.GetProperty("paths").GetProperty(path).GetProperty(key).GetProperty("responses");
            Assert.True(promised.TryGetProperty(((int)response.StatusCode).ToString(System.Globalization.CultureInfo.InvariantCulture), out _),
                $"{method} {path} answered {(int)response.StatusCode}, which the document does not list");
            await Task.CompletedTask;
        }

        await Check("GET", "/items", await session.Client.GetAsync("/items"));
        await Check("GET", "/items/{id}", await session.Client.GetAsync($"/items/{item.Id}"));
        await Check("GET", "/items/{id}", await session.Client.GetAsync($"/items/{Guid.NewGuid()}"));
        await Check("DELETE", "/items/{id}", await session.Client.DeleteAsync($"/items/{item.Id}"));
        await Check("GET", "/auth/me", await session.Client.GetAsync("/auth/me"));
    }
}
