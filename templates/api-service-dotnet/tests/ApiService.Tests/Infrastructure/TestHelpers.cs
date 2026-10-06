using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ApiService.Tests.Infrastructure;

// The contract as a client sees it. These records are deliberately NOT the server's types: a test that
// reuses the server's DTOs cannot notice the server changing its own wire format.

// Every name is spelled out in snake_case on purpose: this is the wire contract the shared front end depends on,
// and it must fail here if the server's naming policy ever changes.

internal sealed record TokensDto(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("token_type")] string TokenType,
    [property: JsonPropertyName("expires_in")] int ExpiresIn,
    [property: JsonPropertyName("refresh_token")] string RefreshToken);

internal sealed record ItemDto(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("description")] string? Description,
    [property: JsonPropertyName("quantity")] int Quantity,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt,
    [property: JsonPropertyName("updated_at")] DateTimeOffset UpdatedAt);

internal sealed record ItemPageDto(
    [property: JsonPropertyName("items")] List<ItemDto> Items,
    [property: JsonPropertyName("next_cursor")] Guid? NextCursor);

internal static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static async Task<T> ReadAsync<T>(this HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        var value = await response.Content.ReadFromJsonAsync<T>(Options);
        return value ?? throw new InvalidOperationException("Empty body");
    }

    public static async Task<JsonElement> ReadJsonAsync(this HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);
        return await response.Content.ReadFromJsonAsync<JsonElement>(Options);
    }
}

/// <summary>A signed-up user with a client that already carries its bearer token.</summary>
internal sealed class Session(HttpClient client, TokensDto tokens, string email, string password)
{
    public HttpClient Client { get; } = client;

    public TokensDto Tokens { get; } = tokens;

    public string Email { get; } = email;

    public string Password { get; } = password;

    public const string DefaultPassword = "correct horse battery staple"; // standards-allow: secret

    public static async Task<Session> SignUpAsync(ApiFactory factory, string? email = null, string password = DefaultPassword)
    {
        ArgumentNullException.ThrowIfNull(factory);
        email ??= $"user-{Guid.NewGuid():N}@example.test";
        using var anonymous = factory.CreateApiClient();
        var response = await anonymous.PostAsJsonAsync("/auth/register", new { email, password });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var tokens = await response.ReadAsync<TokensDto>();
        return new Session(WithBearer(factory, tokens.AccessToken), tokens, email, password);
    }

    public static HttpClient WithBearer(ApiFactory factory, string accessToken)
    {
        ArgumentNullException.ThrowIfNull(factory);
        var client = factory.CreateApiClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return client;
    }

    public async Task<ItemDto> CreateItemAsync(string name = "Notebook", int quantity = 1, string? description = null)
    {
        var response = await Client.PostAsJsonAsync("/items", new { name, quantity, description });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await response.ReadAsync<ItemDto>();
    }
}

internal static class Problems
{
    /// <summary>Asserts the response is an RFC 9457 problem document and returns it.</summary>
    public static async Task<JsonElement> AssertAsync(HttpResponseMessage response, HttpStatusCode status, string? code = null)
    {
        ArgumentNullException.ThrowIfNull(response);
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var body = await response.ReadJsonAsync();
        Assert.Equal((int)status, body.GetProperty("status").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("title").GetString()));
        Assert.True(body.TryGetProperty("request_id", out _), "problem documents carry the request id");
        if (code is not null)
        {
            Assert.Equal(code, body.GetProperty("code").GetString());
        }

        return body;
    }
}
