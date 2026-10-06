using System.Net;
using System.Net.Http.Json;
using System.Text;
using ApiService.Persistence;
using ApiService.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace ApiService.Tests;

public sealed class AuthTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Register_signs_in_and_me_returns_the_account()
    {
        var email = $"Ada-{Guid.NewGuid():N}@Example.Test";
        var session = await Session.SignUpAsync(factory, email);

        Assert.Equal("Bearer", session.Tokens.TokenType);
        Assert.Equal(15 * 60, session.Tokens.ExpiresIn);
        Assert.False(string.IsNullOrEmpty(session.Tokens.RefreshToken));

        var me = await session.Client.GetAsync("/auth/me");
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        var body = await me.ReadJsonAsync();
        Assert.Equal(email.ToLowerInvariant(), body.GetProperty("email").GetString());
        Assert.False(body.TryGetProperty("password_hash", out _), "the hash never leaves the server");
    }

    [Fact]
    public async Task Register_twice_with_the_same_email_is_a_conflict_whatever_the_case()
    {
        var email = $"dup-{Guid.NewGuid():N}@example.test";
        await Session.SignUpAsync(factory, email);

        using var client = factory.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/register", new { email = email.ToUpperInvariant(), password = Session.DefaultPassword });

        await Problems.AssertAsync(response, HttpStatusCode.Conflict, "email_taken");
    }

    [Theory]
    [InlineData("not-an-email", "correct horse battery staple", "email")]
    [InlineData("a@example.test", "short", "password")]
    [InlineData("", "", "email")]
    public async Task Register_validates_fields_and_names_them(string email, string password, string expectedField)
    {
        using var client = factory.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/register", new { email, password });

        var problem = await Problems.AssertAsync(response, HttpStatusCode.BadRequest);
        Assert.True(problem.GetProperty("errors").TryGetProperty(expectedField, out _), $"errors names {expectedField}");
    }

    [Fact]
    public async Task Register_rejects_members_the_api_does_not_define()
    {
        using var client = factory.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/register", new { email = "x@example.test", password = Session.DefaultPassword, isAdmin = true });

        await Problems.AssertAsync(response, HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Passwords_are_stored_only_as_argon2id_hashes()
    {
        var session = await Session.SignUpAsync(factory);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var stored = await db.Users.AsNoTracking().Where(u => u.Email == session.Email).Select(u => u.PasswordHash).SingleAsync();

        Assert.StartsWith("$argon2id$v=19$m=", stored, StringComparison.Ordinal);
        Assert.DoesNotContain(session.Password, stored, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Refresh_tokens_are_stored_only_as_hashes()
    {
        var session = await Session.SignUpAsync(factory);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var hashes = await db.RefreshTokens.AsNoTracking().Select(t => t.TokenHash).ToListAsync();

        Assert.DoesNotContain(session.Tokens.RefreshToken, hashes);
        Assert.All(hashes, h => Assert.Equal(64, h.Length));
    }

    [Fact]
    public async Task Login_works_and_a_wrong_password_looks_exactly_like_an_unknown_account()
    {
        var session = await Session.SignUpAsync(factory);
        using var client = factory.CreateApiClient();

        var ok = await client.PostAsJsonAsync("/auth/login", new { email = session.Email, password = session.Password });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

        var wrong = await client.PostAsJsonAsync("/auth/login", new { email = session.Email, password = "wrong password entirely" });
        var unknown = await client.PostAsJsonAsync("/auth/login", new { email = "nobody@example.test", password = "wrong password entirely" });

        var wrongBody = await Problems.AssertAsync(wrong, HttpStatusCode.Unauthorized, "invalid_credentials");
        var unknownBody = await Problems.AssertAsync(unknown, HttpStatusCode.Unauthorized, "invalid_credentials");
        Assert.Equal(wrongBody.GetProperty("detail").GetString(), unknownBody.GetProperty("detail").GetString());
        Assert.Equal(wrongBody.GetProperty("title").GetString(), unknownBody.GetProperty("title").GetString());
        Assert.Contains("Bearer", wrong.Headers.WwwAuthenticate.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Refresh_rotates_the_token_and_replaying_the_old_one_revokes_the_whole_family()
    {
        var session = await Session.SignUpAsync(factory);
        using var client = factory.CreateApiClient();

        var first = await client.PostAsJsonAsync("/auth/refresh", new { refresh_token = session.Tokens.RefreshToken });
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var rotated = await first.ReadAsync<TokensDto>();
        Assert.NotEqual(session.Tokens.RefreshToken, rotated.RefreshToken);

        // The first token was already used: whoever presents it now is either a thief or a replay.
        var replay = await client.PostAsJsonAsync("/auth/refresh", new { refresh_token = session.Tokens.RefreshToken });
        await Problems.AssertAsync(replay, HttpStatusCode.Unauthorized, "invalid_refresh_token");

        // ...and that taints the family: the rotated token no longer works either.
        var afterReplay = await client.PostAsJsonAsync("/auth/refresh", new { refresh_token = rotated.RefreshToken });
        await Problems.AssertAsync(afterReplay, HttpStatusCode.Unauthorized, "invalid_refresh_token");
    }

    [Fact]
    public async Task Concurrent_refreshes_of_one_token_let_exactly_one_win()
    {
        var session = await Session.SignUpAsync(factory);
        using var client = factory.CreateApiClient();

        var results = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ =>
            client.PostAsJsonAsync("/auth/refresh", new { refresh_token = session.Tokens.RefreshToken })));

        Assert.True(results.Count(r => r.StatusCode == HttpStatusCode.OK) <= 1, "at most one refresh may succeed");
        Assert.All(results.Where(r => r.StatusCode != HttpStatusCode.OK), r => Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode));
    }

    [Fact]
    public async Task Unknown_refresh_token_is_refused()
    {
        using var client = factory.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/refresh", new { refresh_token = "not-a-real-token" });

        await Problems.AssertAsync(response, HttpStatusCode.Unauthorized, "invalid_refresh_token");
    }

    [Fact]
    public async Task Logout_revokes_the_family_and_is_idempotent()
    {
        var session = await Session.SignUpAsync(factory);
        using var client = factory.CreateApiClient();

        var first = await client.PostAsJsonAsync("/auth/logout", new { refresh_token = session.Tokens.RefreshToken });
        var again = await client.PostAsJsonAsync("/auth/logout", new { refresh_token = session.Tokens.RefreshToken });
        var unknown = await client.PostAsJsonAsync("/auth/logout", new { refresh_token = "never-issued" });
        var refresh = await client.PostAsJsonAsync("/auth/refresh", new { refresh_token = session.Tokens.RefreshToken });

        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, unknown.StatusCode);
        await Problems.AssertAsync(refresh, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_refresh_token_expires()
    {
        using var own = new ApiFactory();
        var session = await Session.SignUpAsync(own);
        own.Clock.Advance(TimeSpan.FromDays(14) + TimeSpan.FromMinutes(1));

        using var client = own.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/refresh", new { refresh_token = session.Tokens.RefreshToken });

        await Problems.AssertAsync(response, HttpStatusCode.Unauthorized, "invalid_refresh_token");
    }

    [Fact]
    public async Task An_access_token_expires_after_its_lifetime()
    {
        using var own = new ApiFactory();
        var session = await Session.SignUpAsync(own);
        Assert.Equal(HttpStatusCode.OK, (await session.Client.GetAsync("/auth/me")).StatusCode);

        own.Clock.Advance(TimeSpan.FromMinutes(15) + TimeSpan.FromSeconds(31));

        await Problems.AssertAsync(await session.Client.GetAsync("/auth/me"), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_request_without_a_token_is_a_401_problem_with_a_bearer_challenge()
    {
        using var client = factory.CreateApiClient();
        var response = await client.GetAsync("/auth/me");

        await Problems.AssertAsync(response, HttpStatusCode.Unauthorized);
        Assert.Contains("Bearer", response.Headers.WwwAuthenticate.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("signature")]
    [InlineData("other-key")]
    [InlineData("other-audience")]
    [InlineData("other-issuer")]
    [InlineData("alg-none")]
    [InlineData("garbage")]
    public async Task Forged_or_foreign_tokens_are_rejected(string kind)
    {
        var session = await Session.SignUpAsync(factory);
        var token = kind switch
        {
            "signature" => session.Tokens.AccessToken[..^4] + "AAAA",
            "other-key" => Mint(Key("a-different-signing-key-0123456789-abcdef"), "api-service", "api-service"),
            "other-audience" => Mint(Key(ApiFactory.JwtKey), "api-service", "someone-else"),
            "other-issuer" => Mint(Key(ApiFactory.JwtKey), "someone-else", "api-service"),
            "alg-none" => Unsigned(),
            _ => "not.a.jwt",
        };

        using var client = Session.WithBearer(factory, token);
        var response = await client.GetAsync("/auth/me");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_correctly_signed_token_is_accepted_control_for_the_forgery_cases()
    {
        var session = await Session.SignUpAsync(factory);
        var me = await session.Client.GetAsync("/auth/me");
        var id = (await me.ReadJsonAsync()).GetProperty("id").GetString()!;

        var token = Mint(Key(ApiFactory.JwtKey), "api-service", "api-service", id, factory.Clock.GetUtcNow());
        using var client = Session.WithBearer(factory, token);

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/auth/me")).StatusCode);
    }

    private static SymmetricSecurityKey Key(string secret) => new(Encoding.UTF8.GetBytes(secret));

    private string Mint(SymmetricSecurityKey key, string issuer, string audience, string? subject = null, DateTimeOffset? now = null)
    {
        var at = (now ?? factory.Clock.GetUtcNow()).UtcDateTime;
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Audience = audience,
            IssuedAt = at,
            NotBefore = at,
            Expires = at.AddMinutes(5),
            Claims = new Dictionary<string, object>(StringComparer.Ordinal) { [JwtRegisteredClaimNames.Sub] = subject ?? Guid.NewGuid().ToString() },
            SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256),
        });
    }

    private static string Unsigned()
    {
        static string B64(string json) => Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var exp = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds();
        return $"{B64("{\"alg\":\"none\",\"typ\":\"JWT\"}")}.{B64($"{{\"sub\":\"{Guid.NewGuid()}\",\"iss\":\"api-service\",\"aud\":\"api-service\",\"exp\":{exp}}}")}.";
    }
}
