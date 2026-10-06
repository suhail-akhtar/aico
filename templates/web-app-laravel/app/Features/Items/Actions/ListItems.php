<?php

declare(strict_types=1);

namespace App\Features\Items\Actions;

use App\Features\Accounts\Models\User;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Models\Item;
use Illuminate\Database\Eloquent\Builder;

/**
 * The one query for "my items". Always scoped to the owner, so no caller can
 * forget to. Returns a builder: the page paginates by offset (it shows page
 * numbers), the API by cursor (stable under inserts, cheap on big tables).
 */
final class ListItems
{
    /**
     * @return Builder<Item>
     */
    public function query(User $owner, ?string $search = null, ?ItemStatus $status = null): Builder
    {
        return Item::query()
            ->whereBelongsTo($owner, 'owner')
            ->when($status, fn (Builder $q, ItemStatus $s) => $q->where('status', $s))
            ->when($search !== null && trim($search) !== '', fn (Builder $q) => $q->whereRaw("lower(title) like ? escape '!'", ['%'.self::escapeLike(mb_strtolower(trim((string) $search))).'%']))
            // The id is the tie-breaker: ULIDs sort by creation time, and a
            // cursor needs a total order.
            ->orderByDesc('created_at')
            ->orderByDesc('id');
    }

    /**
     * Escape LIKE wildcards so a search for "100%" finds "100%", not everything.
     * `!` is the escape character: unlike a backslash it means the same in
     * PostgreSQL and SQLite (whose LIKE has no default escape at all).
     */
    private static function escapeLike(string $value): string
    {
        return str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $value);
    }
}
