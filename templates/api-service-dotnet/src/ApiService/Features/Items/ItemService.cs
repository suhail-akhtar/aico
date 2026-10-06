using ApiService.Persistence;
using ApiService.SharedKernel;
using Microsoft.EntityFrameworkCore;

namespace ApiService.Features.Items;

/// <summary>
/// The items use cases. The ownership rule lives in exactly one place, <see cref="Owned"/>: every query
/// starts from the caller's own items, so "someone else's item" and "no such item" are the same answer
/// (404), which also stops id probing. Listing is keyset-paginated, newest first.
/// </summary>
internal sealed class ItemService(AppDbContext db, TimeProvider clock)
{
    public async Task<Page<Item>> ListAsync(Guid ownerId, int limit, Guid? cursor, CancellationToken cancellationToken)
    {
        var query = Owned(ownerId).AsNoTracking();
        if (cursor is { } after)
        {
            query = query.Where(i => i.Id < after);
        }

        // One extra row tells us whether another page exists without a COUNT.
        var rows = await query.OrderByDescending(i => i.Id).Take(limit + 1).ToListAsync(cancellationToken);
        var hasMore = rows.Count > limit;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }

        return new Page<Item>(rows, hasMore ? rows[^1].Id : null);
    }

    public async Task<Item> GetAsync(Guid ownerId, Guid id, CancellationToken cancellationToken) =>
        await Owned(ownerId).AsNoTracking().SingleOrDefaultAsync(i => i.Id == id, cancellationToken)
        ?? throw NotFound();

    public async Task<Item> CreateAsync(Guid ownerId, ItemRequest request, CancellationToken cancellationToken)
    {
        var item = Item.Create(Ids.New(clock), ownerId, request.Name!, request.Description, request.Quantity, clock.GetUtcNow());
        db.Items.Add(item);
        await db.SaveChangesAsync(cancellationToken);
        return item;
    }

    public async Task<Item> UpdateAsync(Guid ownerId, Guid id, ItemRequest request, CancellationToken cancellationToken)
    {
        var item = await Owned(ownerId).SingleOrDefaultAsync(i => i.Id == id, cancellationToken) ?? throw NotFound();
        item.Update(request.Name!, request.Description, request.Quantity, clock.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
        return item;
    }

    public async Task DeleteAsync(Guid ownerId, Guid id, CancellationToken cancellationToken)
    {
        var removed = await Owned(ownerId).Where(i => i.Id == id).ExecuteDeleteAsync(cancellationToken);
        if (removed == 0)
        {
            throw NotFound();
        }
    }

    private IQueryable<Item> Owned(Guid ownerId) => db.Items.Where(i => i.OwnerId == ownerId);

    private static NotFoundException NotFound() => new("item_not_found", "No such item.");
}
