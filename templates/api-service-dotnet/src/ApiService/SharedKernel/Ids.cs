namespace ApiService.SharedKernel;

/// <summary>Identifier creation in one place, driven by the injected clock so tests control it.</summary>
internal static class Ids
{
    /// <summary>A UUIDv7: sortable by creation time, so keyset pagination and index inserts stay cheap.</summary>
    public static Guid New(TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(clock);
        return Guid.CreateVersion7(clock.GetUtcNow());
    }
}
