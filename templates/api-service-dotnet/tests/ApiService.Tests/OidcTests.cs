using System.Linq.Expressions;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using ApiService.Features.Auth;
using ApiService.Persistence;
using ApiService.SharedKernel;
using ApiService.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace ApiService.Tests;

/// <summary>One fake identity provider and one host that trusts it, shared by the tests that do not change either.</summary>
public sealed class OidcFixture : IDisposable
{
    internal FakeIdp Idp { get; } = new();

    internal ApiFactory Factory { get; }

    public OidcFixture() => Factory = Idp.CreateFactory();

    public void Dispose()
    {
        Factory.Dispose();
        Idp.Dispose();
    }
}

/// <summary>
/// OIDC resource-server mode against a fake identity provider: a generated RSA key pair, a JWKS served by an in-process
/// handler, no network and no Keycloak. Each case changes ONE thing about an otherwise valid token, so a green
/// "rejected" test cannot be green for the wrong reason: the control cases next to them prove the base token is accepted.
/// </summary>
public sealed class OidcTests(OidcFixture fixture) : IClassFixture<OidcFixture>
{
    private ApiFactory Factory => fixture.Factory;

    private FakeIdp Idp => fixture.Idp;

    private DateTimeOffset Now => Factory.Clock.GetUtcNow();

    private string Mint(TokenSpec? spec = null, IdpKey? key = null) => Idp.Mint(Now, spec, key);

    private async Task<HttpResponseMessage> MeAsync(string token)
    {
        using var client = Session.WithBearer(Factory, token);
        return await client.GetAsync("/auth/me");
    }

    private static async Task<List<User>> UsersAsync(ApiFactory factory, Expression<Func<User, bool>> where)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().Users.AsNoTracking().Where(where).ToListAsync();
    }

    [Fact]
    public async Task A_valid_token_is_accepted_and_me_reflects_the_token()
    {
        var sub = Guid.NewGuid();
        var response = await MeAsync(Mint(new TokenSpec { Subject = sub.ToString("D"), Email = "Grace@Example.Test" }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.ReadJsonAsync();
        Assert.Equal(sub, body.GetProperty("id").GetGuid());
        Assert.Equal("grace@example.test", body.GetProperty("email").GetString());
    }

    [Fact]
    public async Task The_first_sight_of_a_subject_creates_one_row_with_an_unusable_password_and_later_requests_create_none()
    {
        var sub = Guid.NewGuid();
        var token = Mint(new TokenSpec { Subject = sub.ToString("D"), Email = "first@example.test" });

        Assert.Equal(HttpStatusCode.OK, (await MeAsync(token)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(token)).StatusCode);

        var rows = await UsersAsync(Factory, u => u.Id == sub);
        var row = Assert.Single(rows);
        Assert.Equal("first@example.test", row.Email);
        Assert.Equal(User.UnusablePasswordHash, row.PasswordHash);
        Assert.Equal(Factory.Clock.GetUtcNow(), row.CreatedAt);
    }

    [Fact]
    public async Task A_token_without_an_email_claim_gets_a_placeholder_address_that_cannot_receive_mail()
    {
        var sub = Guid.NewGuid();
        var response = await MeAsync(Mint(new TokenSpec { Subject = sub.ToString("D") }));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal($"{sub:D}@oidc.invalid", (await response.ReadJsonAsync()).GetProperty("email").GetString());
    }

    [Fact]
    public async Task An_audience_list_that_contains_the_required_value_is_accepted()
    {
        var token = Mint(new TokenSpec { Audience = ["account", FakeIdp.Audience] });

        Assert.Equal(HttpStatusCode.OK, (await MeAsync(token)).StatusCode);
    }

    [Fact]
    public async Task A_provisioned_user_owns_items_and_nobody_else_sees_them()
    {
        using var alice = Session.WithBearer(Factory, Mint(new TokenSpec { Email = "alice@example.test" }));
        using var bob = Session.WithBearer(Factory, Mint(new TokenSpec { Email = "bob@example.test" }));

        var created = await alice.PostAsJsonAsync("/items", new { name = "mine", quantity = 2 });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var item = await created.ReadAsync<ItemDto>();

        Assert.Equal(HttpStatusCode.OK, (await alice.GetAsync($"/items/{item.Id}")).StatusCode);
        await Problems.AssertAsync(await bob.GetAsync($"/items/{item.Id}"), HttpStatusCode.NotFound);
        Assert.Empty((await (await bob.GetAsync("/items")).ReadAsync<ItemPageDto>()).Items);
    }

    [Fact]
    public async Task Without_a_token_the_api_is_a_401_problem()
    {
        using var client = Factory.CreateApiClient();

        await Problems.AssertAsync(await client.GetAsync("/items"), HttpStatusCode.Unauthorized);
        await Problems.AssertAsync(await client.GetAsync("/auth/me"), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_probes_stay_anonymous()
    {
        using var client = Factory.CreateApiClient();

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/readyz")).StatusCode);
    }

    [Fact]
    public async Task An_expired_token_is_refused_and_one_inside_the_skew_is_not()
    {
        var expired = Idp.Mint(Now.AddMinutes(-10));
        var justExpired = Idp.Mint(Now - TimeSpan.FromMinutes(5) - TimeSpan.FromSeconds(10)); // 10 s past exp: inside the 30 s leeway

        await Problems.AssertAsync(await MeAsync(expired), HttpStatusCode.Unauthorized);
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(justExpired)).StatusCode);
    }

    [Fact]
    public async Task A_token_that_is_not_valid_yet_is_refused_and_one_inside_the_skew_is_not()
    {
        var future = Mint(new TokenSpec { NotBefore = TimeSpan.FromMinutes(10) });
        var almost = Mint(new TokenSpec { NotBefore = TimeSpan.FromSeconds(10) });

        await Problems.AssertAsync(await MeAsync(future), HttpStatusCode.Unauthorized);
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(almost)).StatusCode);
    }

    [Fact]
    public async Task A_token_without_an_expiry_is_refused()
    {
        await Problems.AssertAsync(await MeAsync(Mint(new TokenSpec { Lifetime = null })), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task The_issuer_must_match_exactly()
    {
        foreach (var issuer in new[] { "https://idp.example.test/realms/other", FakeIdp.Issuer + "/", FakeIdp.Issuer.ToUpperInvariant(), "api-service" })
        {
            await Problems.AssertAsync(await MeAsync(Mint(new TokenSpec { Issuer = issuer })), HttpStatusCode.Unauthorized);
        }
    }

    [Fact]
    public async Task The_audience_must_contain_the_required_value()
    {
        await Problems.AssertAsync(await MeAsync(Mint(new TokenSpec { Audience = ["someone-else"] })), HttpStatusCode.Unauthorized);
        await Problems.AssertAsync(await MeAsync(Mint(new TokenSpec { Audience = ["account", "master"] })), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_unsigned_token_claiming_alg_none_is_refused()
    {
        await Problems.AssertAsync(await MeAsync(FakeIdp.MintUnsigned(Now)), HttpStatusCode.Unauthorized);
        await Problems.AssertAsync(await MeAsync(FakeIdp.MintUnsigned(Now, Idp.Primary.Kid)), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task An_hs256_token_signed_with_the_public_key_as_the_secret_is_refused()
    {
        // Algorithm confusion: a verifier that picks the algorithm from the token header would accept this.
        await Problems.AssertAsync(await MeAsync(Idp.MintConfused(Now)), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Only_rs256_is_accepted_even_with_a_valid_rsa_signature()
    {
        var rs384 = Mint(new TokenSpec { Algorithm = SecurityAlgorithms.RsaSha384 });

        await Problems.AssertAsync(await MeAsync(rs384), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_token_signed_by_this_services_own_local_key_is_not_an_oidc_token()
    {
        var local = new Microsoft.IdentityModel.JsonWebTokens.JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = FakeIdp.Issuer,
            Audience = FakeIdp.Audience,
            Expires = Now.UtcDateTime.AddMinutes(5),
            Claims = new Dictionary<string, object>(StringComparer.Ordinal) { ["sub"] = Guid.NewGuid().ToString("D") },
            SigningCredentials = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(ApiFactory.JwtKey)), SecurityAlgorithms.HmacSha256),
        });

        await Problems.AssertAsync(await MeAsync(local), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_tampered_payload_is_refused()
    {
        var genuine = Mint();
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(genuine)).StatusCode);

        await Problems.AssertAsync(await MeAsync(FakeIdp.Tamper(genuine, Guid.NewGuid().ToString("D"))), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task A_signature_from_another_key_under_a_known_key_id_is_refused()
    {
        using var impostor = new IdpKey(Idp.Primary.Kid, System.Security.Cryptography.RSA.Create(2048), "sig");

        await Problems.AssertAsync(await MeAsync(Mint(key: impostor)), HttpStatusCode.Unauthorized);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-uuid")]
    [InlineData("12345")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    [InlineData("0194f2b6a1c37d4e8a0b123456789abc")] // a UUID, but not in canonical form: it would not round-trip as an owner id
    public async Task A_subject_that_is_missing_or_not_a_canonical_uuid_is_refused_and_creates_no_row(string? subject)
    {
        var before = (await UsersAsync(Factory, _ => true)).Count;

        await Problems.AssertAsync(await MeAsync(Mint(new TokenSpec { Subject = subject })), HttpStatusCode.Unauthorized);

        Assert.Equal(before, (await UsersAsync(Factory, _ => true)).Count);
    }

    [Fact]
    public async Task Garbage_in_the_authorization_header_is_a_401_never_a_500()
    {
        foreach (var token in new[] { "not.a.jwt", "a.b.c", new string('x', 4000), "eyJhbGciOiJSUzI1NiJ9.e30.", string.Empty })
        {
            using var client = Factory.CreateApiClient();
            client.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            await Problems.AssertAsync(await client.GetAsync("/auth/me"), HttpStatusCode.Unauthorized);
        }
    }

    [Fact]
    public async Task Keys_that_are_not_rs256_signing_keys_are_ignored()
    {
        using var idp = new FakeIdp();
        var encryption = idp.AddKey("enc-1", use: "enc");
        var weak = idp.AddKey("weak-1", bits: 1024);
        using var factory = idp.CreateFactory();

        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);
        await Problems.AssertAsync(await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow(), key: encryption)), HttpStatusCode.Unauthorized);
        await Problems.AssertAsync(await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow(), key: weak)), HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Keys_are_cached_across_requests()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory();

        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);
        }

        Assert.Equal(1, idp.JwksRequests);
    }

    [Fact]
    public async Task A_rotated_key_is_fetched_when_an_unknown_key_id_arrives_and_the_retired_one_stops_working()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory();
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);
        Assert.Equal(1, idp.JwksRequests);

        // The provider rotates: key-2 is published, key-1 retired. Once the refetch interval (30 s) has passed since
        // the last fetch, the first token under key-2 meets an unknown kid, which triggers a fetch BEFORE validation.
        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        var rotated = idp.AddKey("key-2");
        idp.Unpublish(idp.Primary);
        var response = await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow(), key: rotated));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(2, idp.JwksRequests);

        // Tokens under the retired key no longer verify (its kid is unknown now, and a refetch is not due again).
        await Problems.AssertAsync(await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow())), HttpStatusCode.Unauthorized);
        Assert.Equal(2, idp.JwksRequests);
    }

    [Fact]
    public async Task A_rotation_inside_the_refetch_interval_is_picked_up_when_the_interval_has_passed()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory();
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);

        var rotated = idp.AddKey("key-2");
        var token = idp.Mint(factory.Clock.GetUtcNow(), key: rotated);
        await Problems.AssertAsync(await MeWith(factory, token), HttpStatusCode.Unauthorized);
        Assert.Equal(1, idp.JwksRequests); // refused to refetch so soon after the last fetch

        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow(), key: rotated))).StatusCode);
        Assert.Equal(2, idp.JwksRequests);
    }

    [Fact]
    public async Task A_flood_of_unknown_key_ids_costs_one_refetch_per_interval()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory();
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);

        async Task Flood(string tag)
        {
            for (var i = 0; i < 30; i++)
            {
                var forged = new IdpKey($"{tag}-{i}", idp.Primary.Rsa, "sig"); // the Rsa is shared with the idp, which disposes it
                await Problems.AssertAsync(await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow(), key: forged)), HttpStatusCode.Unauthorized);
            }
        }

        await Flood("first");
        Assert.Equal(1, idp.JwksRequests); // 30 forged key ids, no extra fetch: the last fetch was moments ago

        factory.Clock.Advance(TimeSpan.FromSeconds(31));
        await Flood("second");
        Assert.Equal(2, idp.JwksRequests); // the interval passed: exactly one more fetch for 30 more forged key ids
    }

    [Fact]
    public async Task When_the_provider_is_down_the_answer_is_a_401_problem_and_nothing_leaks_then_it_recovers()
    {
        using var idp = new FakeIdp();
        idp.Failure = HttpStatusCode.InternalServerError;
        using var factory = idp.CreateFactory();

        var down = await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()));
        var problem = await Problems.AssertAsync(down, HttpStatusCode.Unauthorized);
        Assert.DoesNotContain("secret-looking", problem.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("JWKS", problem.GetRawText(), StringComparison.Ordinal);

        // Failing fast: a burst during the outage does not each pay a fetch.
        _ = await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()));
        _ = await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()));
        Assert.Equal(1, idp.JwksRequests);

        idp.Failure = null;
        factory.Clock.Advance(TimeSpan.FromSeconds(2));
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);
    }

    [Fact]
    public async Task Cached_keys_keep_working_through_a_provider_outage()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory();
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);

        idp.Failure = HttpStatusCode.ServiceUnavailable;
        factory.Clock.Advance(TimeSpan.FromHours(2)); // the cache is due for a routine refresh, which now fails

        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow()))).StatusCode);
        Assert.Equal(2, idp.JwksRequests); // the failed attempt was made once, then not repeated inside the interval
    }

    [Fact]
    public async Task A_provider_that_never_answers_is_cut_off_by_the_timeout()
    {
        using var idp = new FakeIdp { Hang = true };
        using var factory = idp.CreateFactory("Testing", ("Oidc:JwksTimeoutSeconds", "1"));
        var token = idp.Mint(factory.Clock.GetUtcNow());

        var response = await MeWith(factory, token).WaitAsync(TimeSpan.FromSeconds(30));

        await Problems.AssertAsync(response, HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Simultaneous_first_requests_for_one_subject_all_succeed_and_create_exactly_one_row()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory();
        var sub = Guid.NewGuid();
        var token = idp.Mint(factory.Clock.GetUtcNow(), new TokenSpec { Subject = sub.ToString("D"), Email = "race@example.test" });
        _ = await MeWith(factory, idp.Mint(factory.Clock.GetUtcNow())); // warm the key cache so the race is about the user row

        var responses = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => MeWith(factory, token)));

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        Assert.Single(await UsersAsync(factory, u => u.Id == sub));
        Assert.Single(await UsersAsync(factory, u => u.Email == "race@example.test"));
    }

    [Fact]
    public async Task An_email_owned_by_another_account_is_a_409_not_a_merge()
    {
        var owner = Guid.NewGuid();
        using (var scope = Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Users.Add(User.Create(owner, "taken@example.test", User.UnusablePasswordHash, Now));
            await db.SaveChangesAsync();
        }

        var newcomer = Guid.NewGuid();
        var response = await MeAsync(Mint(new TokenSpec { Subject = newcomer.ToString("D"), Email = "Taken@Example.Test" }));

        await Problems.AssertAsync(response, HttpStatusCode.Conflict, "identity_conflict");
        Assert.Empty(await UsersAsync(Factory, u => u.Id == newcomer));
        Assert.Single(await UsersAsync(Factory, u => u.Email == "taken@example.test"));
    }

    [Fact]
    public async Task The_owner_of_the_email_keeps_working_after_a_conflict_elsewhere()
    {
        var owner = Guid.NewGuid();
        var token = Mint(new TokenSpec { Subject = owner.ToString("D"), Email = "keeps@example.test" });
        Assert.Equal(HttpStatusCode.OK, (await MeAsync(token)).StatusCode);

        await Problems.AssertAsync(await MeAsync(Mint(new TokenSpec { Email = "keeps@example.test" })), HttpStatusCode.Conflict, "identity_conflict");

        Assert.Equal(HttpStatusCode.OK, (await MeAsync(token)).StatusCode);
    }

    [Theory]
    [InlineData("POST", "/auth/register", "{\"email\":\"a@example.test\",\"password\":\"correct horse battery staple\"}")]
    [InlineData("POST", "/auth/login", "{\"email\":\"a@example.test\",\"password\":\"correct horse battery staple\"}")]
    [InlineData("POST", "/auth/refresh", "{\"refresh_token\":\"x\"}")]
    [InlineData("POST", "/auth/logout", "{\"refresh_token\":\"x\"}")]
    [InlineData("POST", "/auth/login", "{not json")]
    [InlineData("POST", "/auth/register", "{}")]
    public async Task The_local_credential_endpoints_answer_404_in_oidc_mode_whatever_the_body(string method, string path, string body)
    {
        using var client = Factory.CreateApiClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

        var response = await client.SendAsync(request);

        var problem = await Problems.AssertAsync(response, HttpStatusCode.NotFound, "local_auth_disabled");
        Assert.Equal("Local authentication is disabled: AUTH_MODE=oidc", problem.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task The_openapi_document_is_the_same_in_oidc_mode()
    {
        using var client = Factory.CreateApiClient();
        var oidc = await client.GetStringAsync("/openapi/v1.json");

        using var local = new ApiFactory();
        using var localClient = local.CreateApiClient();
        Assert.Equal(await localClient.GetStringAsync("/openapi/v1.json"), oidc);
    }

    [Fact]
    public async Task The_dev_seed_user_is_not_created_in_oidc_mode()
    {
        using var idp = new FakeIdp();
        using var factory = idp.CreateFactory("Development", ("Seed:Enabled", "true"), ("Seed:DemoPassword", "a long demo password"));
        using var client = factory.CreateApiClient();
        _ = await client.GetAsync("/healthz");

        Assert.Empty(await UsersAsync(factory, _ => true));
    }

    private static async Task<HttpResponseMessage> MeWith(ApiFactory factory, string token)
    {
        using var client = Session.WithBearer(factory, token);
        return await client.GetAsync("/auth/me");
    }
}

/// <summary>An account provisioned from an identity-provider token has no password, and must say so safely in local mode too.</summary>
public sealed class OidcAccountInLocalModeTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task The_sentinel_hash_never_verifies_and_never_throws()
    {
        var hasher = new Argon2idPasswordHasher(Options.Create(new PasswordHashingOptions { MemoryKiB = 64, Iterations = 1 }));

        foreach (var password in new[] { string.Empty, "x", User.UnusablePasswordHash, "correct horse battery staple", new string('a', 500) })
        {
            Assert.Equal(PasswordVerification.Failed, await hasher.VerifyAsync(User.UnusablePasswordHash, password));
        }
    }

    [Fact]
    public async Task Local_login_for_an_oidc_provisioned_account_is_the_normal_401_identical_to_an_unknown_account()
    {
        var email = $"sso-{Guid.NewGuid():N}@example.test";
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Users.Add(User.CreateExternal(Guid.NewGuid(), email, factory.Clock.GetUtcNow()));
            await db.SaveChangesAsync();
        }

        using var client = factory.CreateApiClient();
        var sso = await client.PostAsJsonAsync("/auth/login", new { email, password = User.UnusablePasswordHash });
        var unknown = await client.PostAsJsonAsync("/auth/login", new { email = "nobody@example.test", password = User.UnusablePasswordHash });

        var ssoBody = await Problems.AssertAsync(sso, HttpStatusCode.Unauthorized, "invalid_credentials");
        var unknownBody = await Problems.AssertAsync(unknown, HttpStatusCode.Unauthorized, "invalid_credentials");
        Assert.Equal(unknownBody.GetProperty("detail").GetString(), ssoBody.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task Registering_an_address_an_oidc_account_already_uses_is_the_usual_conflict()
    {
        var email = $"sso-{Guid.NewGuid():N}@example.test";
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.Users.Add(User.CreateExternal(Guid.NewGuid(), email, factory.Clock.GetUtcNow()));
            await db.SaveChangesAsync();
        }

        using var client = factory.CreateApiClient();
        var response = await client.PostAsJsonAsync("/auth/register", new { email, password = Session.DefaultPassword });

        await Problems.AssertAsync(response, HttpStatusCode.Conflict, "email_taken");
    }

    [Fact]
    public async Task Local_mode_ignores_the_oidc_settings_and_refuses_a_token_from_the_provider()
    {
        using var idp = new FakeIdp();
        using var local = new ApiFactory("Testing", new Dictionary<string, string?> { ["Oidc:JwksUri"] = "not even a url", ["Oidc:Issuer"] = FakeIdp.Issuer });
        using var client = Session.WithBearer(local, idp.Mint(local.Clock.GetUtcNow()));

        await Problems.AssertAsync(await client.GetAsync("/auth/me"), HttpStatusCode.Unauthorized);
        var session = await Session.SignUpAsync(local); // local registration still works
        Assert.Equal(HttpStatusCode.OK, (await session.Client.GetAsync("/auth/me")).StatusCode);
    }
}

/// <summary>OIDC mode must refuse to start half-configured, with a message that names the variable to set.</summary>
public sealed class OidcConfigurationTests
{
    private static ApiFactory With(params (string Key, string? Value)[] settings) =>
        new("Testing", settings.ToDictionary(s => s.Key, s => s.Value, StringComparer.Ordinal));

    private static async Task<string> StartupFailureAsync(ApiFactory factory)
    {
        using (factory)
        {
            var failure = await Assert.ThrowsAnyAsync<Exception>(() =>
            {
                using var client = factory.CreateApiClient();
                return Task.CompletedTask;
            });
            return failure.ToString();
        }
    }

    [Theory]
    [InlineData("Oidc:Issuer", "OIDC_ISSUER")]
    [InlineData("Oidc:JwksUri", "OIDC_JWKS_URI")]
    [InlineData("Oidc:Audience", "OIDC_AUDIENCE")]
    public async Task A_missing_identity_setting_stops_startup_and_names_the_variable(string missing, string variable)
    {
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["Auth:Mode"] = "oidc",
            ["Oidc:Issuer"] = FakeIdp.Issuer,
            ["Oidc:JwksUri"] = FakeIdp.JwksUri,
            ["Oidc:Audience"] = FakeIdp.Audience,
        };
        settings[missing] = string.Empty;

        var text = await StartupFailureAsync(new ApiFactory("Testing", settings));

        Assert.Contains(variable, text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Oidc_mode_with_nothing_else_set_names_the_first_missing_variable()
    {
        var text = await StartupFailureAsync(With(("Auth:Mode", "oidc")));

        Assert.Contains("OIDC_ISSUER", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("not-a-url")]
    [InlineData("ftp://keycloak/certs")]
    [InlineData("/relative/certs")]
    public async Task The_key_url_must_be_an_absolute_http_url(string uri)
    {
        var text = await StartupFailureAsync(With(("Auth:Mode", "oidc"), ("Oidc:Issuer", FakeIdp.Issuer), ("Oidc:JwksUri", uri), ("Oidc:Audience", FakeIdp.Audience)));

        Assert.Contains("OIDC_JWKS_URI", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("banana")]
    [InlineData("oidc-please")]
    public async Task An_unknown_mode_stops_startup_instead_of_silently_falling_back_to_local(string mode)
    {
        var flat = await StartupFailureAsync(With(("AUTH_MODE", mode)));
        Assert.Contains("AUTH_MODE", flat, StringComparison.Ordinal);

        var sectioned = await StartupFailureAsync(With(("Auth:Mode", mode)));
        Assert.Contains("Mode", sectioned, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_flat_variable_names_configure_oidc_mode()
    {
        using var idp = new FakeIdp();
        using var factory = new ApiFactory("Testing", new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["AUTH_MODE"] = "OIDC",
            ["OIDC_ISSUER"] = FakeIdp.Issuer,
            ["OIDC_JWKS_URI"] = FakeIdp.JwksUri,
            ["OIDC_AUDIENCE"] = FakeIdp.Audience,
            ["Jwt:SigningKey"] = string.Empty,
        }, idp.Network);
        using var client = Session.WithBearer(factory, idp.Mint(factory.Clock.GetUtcNow()));

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/auth/me")).StatusCode);
        using var anonymous = factory.CreateApiClient();
        await Problems.AssertAsync(await anonymous.PostAsJsonAsync("/auth/login", new { email = "a@example.test", password = "x" }), HttpStatusCode.NotFound, "local_auth_disabled");
    }

    [Fact]
    public async Task Oidc_mode_needs_no_local_signing_key_but_local_mode_still_does()
    {
        using var idp = new FakeIdp();
        using var oidc = idp.CreateFactory();
        using var client = oidc.CreateApiClient();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/healthz")).StatusCode);

        var text = await StartupFailureAsync(With(("Jwt:SigningKey", string.Empty)));
        Assert.Contains("Jwt:SigningKey is required", text, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Oidc:JwksTimeoutSeconds", "0")]
    [InlineData("Oidc:JwksTimeoutSeconds", "61")]
    [InlineData("Oidc:JwksRefreshIntervalSeconds", "0")]
    public async Task Out_of_range_oidc_numbers_stop_startup(string key, string value)
    {
        using var idp = new FakeIdp();
        var text = await StartupFailureAsync(idp.CreateFactory("Testing", (key, value)));

        Assert.Contains(key.Split(':')[1], text, StringComparison.Ordinal);
    }

    [Fact]
    public void Only_acceptable_keys_pass_the_filter()
    {
        using var idp = new FakeIdp();
        var keys = new JsonWebKeySet(idp.Jwks()).Keys;

        Assert.Equal("key-1", keys[0].Kid);
        Assert.True(JwksConfigurationRetriever.IsAcceptable(keys[0]));
        Assert.False(JwksConfigurationRetriever.IsAcceptable(new JsonWebKey { Kty = "oct", K = "AAAA" }));
        Assert.False(JwksConfigurationRetriever.IsAcceptable(new JsonWebKey { Kty = "RSA", N = "AQAB", E = "AQAB" })); // far too short
    }

    [Fact]
    public async Task An_oversized_key_document_is_refused()
    {
        var huge = new string('x', JwksDocumentRetriever.MaxBytes + 10);
        using var handler = new StaticHandler(huge);
        var retriever = new JwksDocumentRetriever(new SingleClientFactory(handler), TimeSpan.FromSeconds(5));

        await Assert.ThrowsAsync<IOException>(() => retriever.GetDocumentAsync(FakeIdp.JwksUri, CancellationToken.None));
    }

    private sealed class StaticHandler(string body) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
    }

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
