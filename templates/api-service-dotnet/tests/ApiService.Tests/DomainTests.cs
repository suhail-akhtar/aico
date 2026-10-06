using System.Net;
using System.Net.Http.Json;
using ApiService.Features.Auth;
using ApiService.Features.Items;
using ApiService.Tests.Infrastructure;

namespace ApiService.Tests;

public sealed class DomainTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void An_item_trims_its_text_and_blanks_become_null()
    {
        var item = Item.Create(Guid.NewGuid(), Guid.NewGuid(), "  Pen ", "   ", 3, Now);

        Assert.Equal("Pen", item.Name);
        Assert.Null(item.Description);
    }

    [Theory]
    [InlineData("", 1)]
    [InlineData("   ", 1)]
    [InlineData("x", -1)]
    [InlineData("x", Item.MaxQuantity + 1)]
    public void An_item_cannot_be_put_in_an_invalid_state(string name, int quantity)
    {
        Assert.ThrowsAny<ArgumentException>(() => Item.Create(Guid.NewGuid(), Guid.NewGuid(), name, null, quantity, Now));
    }

    [Fact]
    public void An_item_enforces_the_length_limits_the_dtos_advertise()
    {
        Assert.ThrowsAny<ArgumentException>(() => Item.Create(Guid.NewGuid(), Guid.NewGuid(), new string('a', Item.NameMaxLength + 1), null, 1, Now));
        Assert.ThrowsAny<ArgumentException>(() => Item.Create(Guid.NewGuid(), Guid.NewGuid(), "ok", new string('a', Item.DescriptionMaxLength + 1), 1, Now));
        Assert.NotNull(Item.Create(Guid.NewGuid(), Guid.NewGuid(), new string('a', Item.NameMaxLength), null, 1, Now));
    }

    [Fact]
    public void Email_addresses_are_normalised_for_comparison()
    {
        Assert.Equal("ada@example.test", User.NormalizeEmail("  Ada@Example.TEST "));
    }

    [Fact]
    public void Refresh_tokens_are_random_urlsafe_and_stored_as_a_sha256_hex_digest()
    {
        var (raw, hash) = TokenService.NewRefreshToken();
        var (raw2, _) = TokenService.NewRefreshToken();

        Assert.NotEqual(raw, raw2);
        Assert.Matches("^[A-Za-z0-9_-]{43}$", raw);
        Assert.Matches("^[0-9a-f]{64}$", hash);
        Assert.Equal(hash, TokenService.HashRefreshToken(raw));
    }

    [Theory]
    [InlineData(0, 5, true)] // well inside the lifetime
    [InlineData(299, 5, true)]
    [InlineData(329, 5, true)] // expired 29 s ago: inside the 30 s skew
    [InlineData(331, 5, false)] // expired 31 s ago
    public void Token_lifetime_is_judged_by_the_injected_clock_with_a_30_second_skew(int secondsAfterIssue, int lifetimeMinutes, bool valid)
    {
        var issued = Now.UtcDateTime;
        var current = Now.AddSeconds(secondsAfterIssue);

        Assert.Equal(valid, JwtBearerSetup.IsCurrent(current, issued, issued.AddMinutes(lifetimeMinutes)));
    }

    [Fact]
    public void A_token_without_an_expiry_is_never_current()
    {
        Assert.False(JwtBearerSetup.IsCurrent(Now, Now.UtcDateTime, null));
    }

    [Fact]
    public async Task Seeding_creates_a_demo_user_only_in_development_with_a_password_and_only_once()
    {
        var seed = new Dictionary<string, string?>
        {
            ["Seed:Enabled"] = "true",
            ["Seed:DemoEmail"] = "demo@example.test",
            ["Seed:DemoPassword"] = "a-demo-password-for-tests", // standards-allow: secret
        };

        using (var testing = new ApiFactory("Testing", seed))
        {
            using var client = testing.CreateApiClient();
            var login = await client.PostAsJsonAsync("/auth/login", new { email = "demo@example.test", password = "a-demo-password-for-tests" });
            Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode); // not Development: no seed
        }

        using (var noPassword = new ApiFactory("Development", new Dictionary<string, string?> { ["Seed:Enabled"] = "true", ["Seed:DemoPassword"] = string.Empty }))
        {
            using var client = noPassword.CreateApiClient();
            var login = await client.PostAsJsonAsync("/auth/login", new { email = "demo@example.test", password = "anything long enough" });
            Assert.Equal(HttpStatusCode.Unauthorized, login.StatusCode); // no password supplied: no seed
        }

        using var dev = new ApiFactory("Development", seed);
        using var devClient = dev.CreateApiClient();
        var ok = await devClient.PostAsJsonAsync("/auth/login", new { email = "demo@example.test", password = "a-demo-password-for-tests" });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var tokens = await ok.ReadAsync<TokensDto>();

        using var authed = Session.WithBearer(dev, tokens.AccessToken);
        var items = await (await authed.GetAsync("/items")).ReadAsync<ItemPageDto>();
        Assert.Equal(3, items.Items.Count);
    }
}
