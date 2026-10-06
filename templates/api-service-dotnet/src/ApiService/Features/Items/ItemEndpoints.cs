using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using ApiService.SharedKernel;
using Microsoft.AspNetCore.Http.HttpResults;

namespace ApiService.Features.Items;

/// <summary>
/// /items: the worked resource, the pattern to copy for the next one (docs/EXTENDING.md).
/// The whole group requires a signed-in user; every handler passes the caller's id to the service,
/// which scopes every query by it. Declarative validation on the DTOs gives field-level 400s; errors
/// are problem documents; the OpenAPI document is generated from these declarations.
/// </summary>
internal static class ItemEndpoints
{
    public static IEndpointRouteBuilder MapItemEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        var group = app.MapGroup("/items").WithTags("Items").RequireAuthorization();

        group.MapGet("/", List)
            .WithName("ListItems")
            .WithSummary("The caller's items, newest first, one page at a time")
            .Produces<ItemPageResponse>()
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        group.MapPost("/", Create)
            .WithName("CreateItem")
            .WithSummary("Create an item")
            .Produces<ItemResponse>(StatusCodes.Status201Created)
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        group.MapGet("/{id:guid}", Get)
            .WithName("GetItem")
            .WithSummary("One item")
            .Produces<ItemResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapPut("/{id:guid}", Update)
            .WithName("UpdateItem")
            .WithSummary("Replace an item")
            .Produces<ItemResponse>()
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapDelete("/{id:guid}", Delete)
            .WithName("DeleteItem")
            .WithSummary("Delete an item")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

        return app;
    }

    private static async Task<Ok<ItemPageResponse>> List(
        ClaimsPrincipal user,
        ItemService items,
        CancellationToken cancellationToken,
        [Range(1, PagingDefaults.MaxLimit)] int limit = PagingDefaults.DefaultLimit,
        Guid? cursor = null) =>
        TypedResults.Ok(ItemPageResponse.From(await items.ListAsync(user.GetUserId(), limit, cursor, cancellationToken)));

    private static async Task<Created<ItemResponse>> Create(ItemRequest request, ClaimsPrincipal user, ItemService items, CancellationToken cancellationToken)
    {
        var item = await items.CreateAsync(user.GetUserId(), request, cancellationToken);
        return TypedResults.Created($"/items/{item.Id}", ItemResponse.From(item));
    }

    private static async Task<Ok<ItemResponse>> Get(Guid id, ClaimsPrincipal user, ItemService items, CancellationToken cancellationToken) =>
        TypedResults.Ok(ItemResponse.From(await items.GetAsync(user.GetUserId(), id, cancellationToken)));

    private static async Task<Ok<ItemResponse>> Update(Guid id, ItemRequest request, ClaimsPrincipal user, ItemService items, CancellationToken cancellationToken) =>
        TypedResults.Ok(ItemResponse.From(await items.UpdateAsync(user.GetUserId(), id, request, cancellationToken)));

    private static async Task<NoContent> Delete(Guid id, ClaimsPrincipal user, ItemService items, CancellationToken cancellationToken)
    {
        await items.DeleteAsync(user.GetUserId(), id, cancellationToken);
        return TypedResults.NoContent();
    }
}
