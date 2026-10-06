using System.Net;
using System.Net.Http.Json;
using ApiService.Tests.Infrastructure;

namespace ApiService.Tests;

public sealed class ItemsTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Items_require_authentication()
    {
        using var client = factory.CreateApiClient();

        foreach (var response in new[]
        {
            await client.GetAsync("/items"),
            await client.PostAsJsonAsync("/items", new { name = "x" }),
            await client.GetAsync($"/items/{Guid.NewGuid()}"),
            await client.PutAsJsonAsync($"/items/{Guid.NewGuid()}", new { name = "x" }),
            await client.DeleteAsync($"/items/{Guid.NewGuid()}"),
        })
        {
            await Problems.AssertAsync(response, HttpStatusCode.Unauthorized);
        }
    }

    [Fact]
    public async Task Create_get_update_delete_round_trip()
    {
        var session = await Session.SignUpAsync(factory);

        var created = await session.CreateItemAsync("  Notebook  ", 12, "  A5, ruled ");
        Assert.Equal("Notebook", created.Name);
        Assert.Equal("A5, ruled", created.Description);
        Assert.Equal(12, created.Quantity);
        Assert.Equal(factory.Clock.GetUtcNow(), created.CreatedAt);

        var fetched = await (await session.Client.GetAsync($"/items/{created.Id}")).ReadAsync<ItemDto>();
        Assert.Equal(created, fetched);

        factory.Clock.Advance(TimeSpan.FromMinutes(5));
        var put = await session.Client.PutAsJsonAsync($"/items/{created.Id}", new { name = "Notebook XL", quantity = 7 });
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var updated = await put.ReadAsync<ItemDto>();
        Assert.Equal("Notebook XL", updated.Name);
        Assert.Null(updated.Description);
        Assert.Equal(7, updated.Quantity);
        Assert.Equal(created.CreatedAt, updated.CreatedAt);
        Assert.True(updated.UpdatedAt > created.UpdatedAt);

        Assert.Equal(HttpStatusCode.NoContent, (await session.Client.DeleteAsync($"/items/{created.Id}")).StatusCode);
        await Problems.AssertAsync(await session.Client.GetAsync($"/items/{created.Id}"), HttpStatusCode.NotFound, "item_not_found");
        await Problems.AssertAsync(await session.Client.DeleteAsync($"/items/{created.Id}"), HttpStatusCode.NotFound, "item_not_found");
    }

    [Fact]
    public async Task Create_answers_201_with_a_location_header()
    {
        var session = await Session.SignUpAsync(factory);
        var response = await session.Client.PostAsJsonAsync("/items", new { name = "Pen", quantity = 3 });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var item = await response.ReadAsync<ItemDto>();
        Assert.Equal($"/items/{item.Id}", response.Headers.Location?.OriginalString);
    }

    [Fact]
    public async Task Another_users_item_does_not_exist_for_you()
    {
        var alice = await Session.SignUpAsync(factory);
        var mallory = await Session.SignUpAsync(factory);
        var secret = await alice.CreateItemAsync("Alice's private item");

        await Problems.AssertAsync(await mallory.Client.GetAsync($"/items/{secret.Id}"), HttpStatusCode.NotFound, "item_not_found");
        await Problems.AssertAsync(await mallory.Client.PutAsJsonAsync($"/items/{secret.Id}", new { name = "pwned", quantity = 1 }), HttpStatusCode.NotFound);
        await Problems.AssertAsync(await mallory.Client.DeleteAsync($"/items/{secret.Id}"), HttpStatusCode.NotFound);

        var theirs = await (await mallory.Client.GetAsync("/items")).ReadAsync<ItemPageDto>();
        Assert.Empty(theirs.Items);

        // Alice's item is untouched by all of that.
        var still = await (await alice.Client.GetAsync($"/items/{secret.Id}")).ReadAsync<ItemDto>();
        Assert.Equal("Alice's private item", still.Name);
    }

    [Fact]
    public async Task A_client_cannot_choose_the_owner_or_the_id()
    {
        var alice = await Session.SignUpAsync(factory);
        var other = await Session.SignUpAsync(factory);

        var response = await alice.Client.PostAsJsonAsync("/items", new { name = "x", ownerId = Guid.NewGuid(), id = Guid.NewGuid() });

        await Problems.AssertAsync(response, HttpStatusCode.BadRequest);
        Assert.Empty((await (await other.Client.GetAsync("/items")).ReadAsync<ItemPageDto>()).Items);
    }

    [Fact]
    public async Task Listing_is_newest_first_and_paginates_without_gaps_or_repeats()
    {
        var session = await Session.SignUpAsync(factory);
        var created = new List<Guid>();
        for (var i = 0; i < 5; i++)
        {
            factory.Clock.Advance(TimeSpan.FromSeconds(1));
            created.Add((await session.CreateItemAsync($"item {i}")).Id);
        }

        var seen = new List<Guid>();
        string url = "/items?limit=2";
        var pages = 0;
        while (true)
        {
            var page = await (await session.Client.GetAsync(url)).ReadAsync<ItemPageDto>();
            seen.AddRange(page.Items.Select(i => i.Id));
            pages++;
            if (page.NextCursor is not { } cursor)
            {
                break;
            }

            url = $"/items?limit=2&cursor={cursor}";
        }

        Assert.Equal(3, pages);
        Assert.Equal(Enumerable.Reverse(created), seen);
    }

    [Theory]
    [InlineData("limit=0")]
    [InlineData("limit=101")]
    [InlineData("limit=-5")]
    [InlineData("limit=abc")]
    [InlineData("cursor=not-a-guid")]
    public async Task Listing_rejects_bad_paging_parameters(string query)
    {
        var session = await Session.SignUpAsync(factory);

        await Problems.AssertAsync(await session.Client.GetAsync($"/items?{query}"), HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task The_page_size_is_capped_at_the_maximum()
    {
        var session = await Session.SignUpAsync(factory);

        Assert.Equal(HttpStatusCode.OK, (await session.Client.GetAsync("/items?limit=100")).StatusCode);
    }

    [Theory]
    [InlineData("{\"name\":\"   \",\"quantity\":1}", "name")]
    [InlineData("{\"quantity\":1}", "name")]
    [InlineData("{\"name\":\"x\",\"quantity\":-1}", "quantity")]
    [InlineData("{\"name\":\"x\",\"quantity\":1000001}", "quantity")]
    public async Task Validation_errors_name_the_field(string body, string field)
    {
        var session = await Session.SignUpAsync(factory);
        var response = await session.Client.PostAsync("/items", new StringContent(body, System.Text.Encoding.UTF8, "application/json"));

        var problem = await Problems.AssertAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _), $"errors names {field}");
    }

    [Fact]
    public async Task Overlong_text_fields_are_refused()
    {
        var session = await Session.SignUpAsync(factory);

        var name = await session.Client.PostAsJsonAsync("/items", new { name = new string('n', 121), quantity = 1 });
        var description = await session.Client.PostAsJsonAsync("/items", new { name = "ok", description = new string('d', 2001), quantity = 1 });

        await Problems.AssertAsync(name, HttpStatusCode.BadRequest);
        await Problems.AssertAsync(description, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Malformed_json_is_a_400_problem_not_a_500()
    {
        var session = await Session.SignUpAsync(factory);

        var response = await session.Client.PostAsync("/items", new StringContent("{not json", System.Text.Encoding.UTF8, "application/json"));

        await Problems.AssertAsync(response, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task A_non_json_content_type_is_a_415()
    {
        var session = await Session.SignUpAsync(factory);

        var response = await session.Client.PostAsync("/items", new StringContent("name=x", System.Text.Encoding.UTF8, "application/x-www-form-urlencoded"));

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
    }

    [Theory]
    [InlineData("'; DROP TABLE items; --")]
    [InlineData("\" OR 1=1 --")]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("Robert'); DROP TABLE users;--")]
    public async Task Hostile_strings_are_stored_and_returned_as_plain_data(string hostile)
    {
        var session = await Session.SignUpAsync(factory);

        var created = await session.CreateItemAsync(hostile, 1, hostile);
        var fetched = await (await session.Client.GetAsync($"/items/{created.Id}")).ReadAsync<ItemDto>();

        Assert.Equal(hostile, fetched.Name);
        // The tables are still there and the listing still works.
        Assert.NotEmpty((await (await session.Client.GetAsync("/items")).ReadAsync<ItemPageDto>()).Items);
    }

    [Fact]
    public async Task A_route_id_that_is_not_a_guid_is_a_404_problem()
    {
        var session = await Session.SignUpAsync(factory);

        await Problems.AssertAsync(await session.Client.GetAsync("/items/1"), HttpStatusCode.NotFound);
        await Problems.AssertAsync(await session.Client.GetAsync("/items/1%27%20OR%201=1"), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task An_unknown_route_and_a_wrong_method_are_problem_documents()
    {
        var session = await Session.SignUpAsync(factory);

        await Problems.AssertAsync(await session.Client.GetAsync("/nope"), HttpStatusCode.NotFound);
        await Problems.AssertAsync(await session.Client.PatchAsync($"/items/{Guid.NewGuid()}", JsonContent.Create(new { })), HttpStatusCode.MethodNotAllowed);
    }
}
