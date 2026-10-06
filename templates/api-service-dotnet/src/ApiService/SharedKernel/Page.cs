namespace ApiService.SharedKernel;

/// <summary>
/// One page of a keyset-paginated list. <see cref="NextCursor"/> is the id to pass as
/// <c>cursor</c> for the next page, or null on the last page (serialised as <c>next_cursor</c>). Clients treat it as opaque. Keyset beats offset here: ids are
/// time-ordered (UUIDv7), so a page is stable while rows are added and costs the same on page 1,000.
/// </summary>
internal sealed record Page<T>(IReadOnlyList<T> Items, Guid? NextCursor);

internal static class PagingDefaults
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 100;
}
