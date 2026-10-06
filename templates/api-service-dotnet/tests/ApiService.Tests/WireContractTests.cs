using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using ApiService.Tests.Infrastructure;

namespace ApiService.Tests;

/// <summary>
/// The wire contract a shared front end depends on, asserted on raw JSON so the server's own types cannot hide a change:
/// snake_case property names everywhere, <c>limit</c> and <c>cursor</c> paging with <c>next_cursor</c>, an optional
/// <c>quantity</c>, full-replace PUT, and a problem document with a snake_case request id.
/// </summary>
public sealed class WireContractTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private static string[] Names(JsonElement element) => [.. element.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal)];

    [Fact]
    public async Task Token_responses_use_snake_case_names()
    {
        using var client = factory.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/register", new { email = $"wire-{Guid.NewGuid():N}@example.test", password = Session.DefaultPassword });

        var body = await response.ReadJsonAsync();

        Assert.Equal(["access_token", "expires_in", "refresh_token", "token_type"], Names(body));
    }

    [Fact]
    public async Task Me_returns_id_and_email_in_snake_case()
    {
        var session = await Session.SignUpAsync(factory);

        var body = await (await session.Client.GetAsync("/auth/me")).ReadJsonAsync();

        Assert.Equal(["created_at", "email", "id"], Names(body));
    }

    [Fact]
    public async Task An_item_has_exactly_the_contract_fields_and_a_location_header()
    {
        var session = await Session.SignUpAsync(factory);

        var response = await session.Client.PostAsJsonAsync("/items", new { name = "Pen", description = "blue", quantity = 4 });
        var body = await response.ReadJsonAsync();

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal(["created_at", "description", "id", "name", "quantity", "updated_at"], Names(body));
        Assert.Equal($"/items/{body.GetProperty("id").GetGuid()}", response.Headers.Location?.ToString());
        Assert.True(body.GetProperty("created_at").TryGetDateTimeOffset(out _));
        Assert.True(body.GetProperty("updated_at").TryGetDateTimeOffset(out _));
    }

    [Fact]
    public async Task Quantity_and_description_are_optional_on_create_and_a_put_replaces_the_whole_item()
    {
        var session = await Session.SignUpAsync(factory);

        var created = await (await session.Client.PostAsJsonAsync("/items", new { name = "Minimal" })).ReadJsonAsync();
        Assert.Equal(0, created.GetProperty("quantity").GetInt32());
        Assert.Equal(JsonValueKind.Null, created.GetProperty("description").ValueKind);

        var id = created.GetProperty("id").GetGuid();
        _ = await session.Client.PutAsJsonAsync($"/items/{id}", new { name = "Full", description = "d", quantity = 9 });
        var replaced = await (await session.Client.PutAsJsonAsync($"/items/{id}", new { name = "Only a name" })).ReadJsonAsync();

        Assert.Equal("Only a name", replaced.GetProperty("name").GetString());
        Assert.Equal(0, replaced.GetProperty("quantity").GetInt32()); // full replace: what the body omits is reset
        Assert.Equal(JsonValueKind.Null, replaced.GetProperty("description").ValueKind);
    }

    [Fact]
    public async Task The_list_pages_with_limit_and_cursor_and_ends_with_a_null_next_cursor()
    {
        var session = await Session.SignUpAsync(factory);
        var created = new List<Guid>();
        for (var i = 0; i < 7; i++)
        {
            factory.Clock.Advance(TimeSpan.FromSeconds(1));
            created.Add((await session.CreateItemAsync($"item {i}")).Id);
        }

        var seen = new List<Guid>();
        var sizes = new List<int>();
        string? cursor = null;
        do
        {
            var url = cursor is null ? "/items?limit=3" : $"/items?limit=3&cursor={Uri.EscapeDataString(cursor)}";
            var page = await (await session.Client.GetAsync(url)).ReadJsonAsync();
            Assert.Equal(["items", "next_cursor"], Names(page));
            var items = page.GetProperty("items").EnumerateArray().ToList();
            sizes.Add(items.Count);
            seen.AddRange(items.Select(i => i.GetProperty("id").GetGuid()));
            var next = page.GetProperty("next_cursor");
            cursor = next.ValueKind == JsonValueKind.Null ? null : next.GetString();
        }
        while (cursor is not null);

        Assert.Equal([3, 3, 1], sizes);
        Assert.Equal(Enumerable.Reverse(created), seen); // newest first, no gaps, no repeats
    }

    [Fact]
    public async Task The_default_page_size_is_fifty_and_one_hundred_is_the_maximum()
    {
        var session = await Session.SignUpAsync(factory);
        for (var i = 0; i < 52; i++)
        {
            _ = await session.CreateItemAsync($"bulk {i}");
        }

        var first = await (await session.Client.GetAsync("/items")).ReadJsonAsync();
        Assert.Equal(50, first.GetProperty("items").GetArrayLength());
        var cursor = first.GetProperty("next_cursor").GetString()!;

        var second = await (await session.Client.GetAsync($"/items?cursor={Uri.EscapeDataString(cursor)}")).ReadJsonAsync();
        Assert.Equal(2, second.GetProperty("items").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, second.GetProperty("next_cursor").ValueKind);

        Assert.Equal(HttpStatusCode.OK, (await session.Client.GetAsync("/items?limit=100")).StatusCode);
        await Problems.AssertAsync(await session.Client.GetAsync("/items?limit=101"), HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData("/auth/refresh", "{\"refreshToken\":\"x\"}")]
    [InlineData("/auth/register", "{\"email\":\"a@example.test\",\"password\":\"correct horse battery staple\",\"createdAt\":\"x\"}")]
    public async Task Camel_case_request_members_are_not_part_of_the_contract(string path, string body)
    {
        using var client = factory.CreateApiClient();

        var response = await client.PostAsync(path, new StringContent(body, Encoding.UTF8, "application/json"));

        await Problems.AssertAsync(response, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Problem_documents_carry_a_snake_case_request_id_and_validation_errors_use_snake_case_names()
    {
        using var client = factory.CreateApiClient();

        var response = await client.PostAsync("/auth/refresh", new StringContent("{}", Encoding.UTF8, "application/json"));
        var problem = await Problems.AssertAsync(response, HttpStatusCode.BadRequest);

        Assert.False(problem.TryGetProperty("requestId", out _));
        Assert.True(problem.GetProperty("errors").TryGetProperty("refresh_token", out _));
        Assert.False(problem.GetProperty("errors").TryGetProperty("refreshToken", out _));
    }
}
