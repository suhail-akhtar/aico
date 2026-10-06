using System.ComponentModel.DataAnnotations;
using ApiService.SharedKernel;

namespace ApiService.Features.Items;

/// <summary>Body for POST and PUT. PUT replaces the item, so both use the same shape.</summary>
public sealed record ItemRequest
{
    [Required]
    [StringLength(Item.NameMaxLength)]
    public string? Name { get; init; }

    [StringLength(Item.DescriptionMaxLength)]
    public string? Description { get; init; }

    [Range(0, Item.MaxQuantity)]
    public int Quantity { get; init; }
}

internal sealed record ItemResponse(Guid Id, string Name, string? Description, int Quantity, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)
{
    public static ItemResponse From(Item item)
    {
        ArgumentNullException.ThrowIfNull(item);
        return new ItemResponse(item.Id, item.Name, item.Description, item.Quantity, item.CreatedAt, item.UpdatedAt);
    }
}

internal sealed record ItemPageResponse(IReadOnlyList<ItemResponse> Items, Guid? NextCursor)
{
    public static ItemPageResponse From(Page<Item> page)
    {
        ArgumentNullException.ThrowIfNull(page);
        return new ItemPageResponse([.. page.Items.Select(ItemResponse.From)], page.NextCursor);
    }
}
