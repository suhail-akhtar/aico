using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace ApiService.Features.Items;

/// <summary>
/// The worked resource. Domain rules (the length limits) are constants here and the request DTOs
/// reference them, so the limit is written once. The entity owns its invariants through <see cref="Create"/>
/// and <see cref="Update"/>; its setters are private so no code path can put it in an invalid state.
/// It knows nothing about HTTP; the only framework reference in this file is the EF mapping at the bottom.
/// </summary>
internal sealed class Item
{
    public const int NameMaxLength = 120;
    public const int DescriptionMaxLength = 2000;
    public const int MaxQuantity = 1_000_000;

    private Item()
    {
    }

    public Guid Id { get; private set; }

    /// <summary>The user who owns the item. Every query is scoped by it; another user's item does not exist.</summary>
    public Guid OwnerId { get; private set; }

    public string Name { get; private set; } = string.Empty;

    public string? Description { get; private set; }

    public int Quantity { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public static Item Create(Guid id, Guid ownerId, string name, string? description, int quantity, DateTimeOffset now)
    {
        var item = new Item { Id = id, OwnerId = ownerId, CreatedAt = now };
        item.Update(name, description, quantity, now);
        return item;
    }

    public void Update(string name, string? description, int quantity, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(name.Trim().Length, NameMaxLength);
        ArgumentOutOfRangeException.ThrowIfNegative(quantity);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(quantity, MaxQuantity);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(description?.Length ?? 0, DescriptionMaxLength);

        Name = name.Trim();
        Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        Quantity = quantity;
        UpdatedAt = now;
    }
}

internal sealed class ItemConfiguration : IEntityTypeConfiguration<Item>
{
    public void Configure(EntityTypeBuilder<Item> builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.ToTable("items");
        builder.HasKey(i => i.Id);
        builder.Property(i => i.Id).ValueGeneratedNever();
        builder.Property(i => i.Name).HasMaxLength(Item.NameMaxLength).IsRequired();
        builder.Property(i => i.Description).HasMaxLength(Item.DescriptionMaxLength);
        // The listing query is "this owner's items, newest first": one index serves it.
        builder.HasIndex(i => new { i.OwnerId, i.Id });
    }
}
