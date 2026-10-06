<?php

declare(strict_types=1);

namespace App\Features\Items\Models;

use App\Features\Accounts\Models\User;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Policies\ItemPolicy;
use Database\Factories\ItemFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\UseFactory;
use Illuminate\Database\Eloquent\Attributes\UsePolicy;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * The worked example: copy this feature (model, actions, policy, requests,
 * resource, page, tests) to add the next one.
 *
 * The primary key is a ULID: sortable, unguessable in a URL, safe to expose.
 * `user_id` is deliberately NOT fillable: the owner comes from the signed-in
 * user in an action, never from request input.
 *
 * @property string $id
 * @property int $user_id
 * @property string $title
 * @property string|null $notes
 * @property ItemStatus $status
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
#[Fillable(['title', 'notes', 'status'])]
#[UseFactory(ItemFactory::class)]
#[UsePolicy(ItemPolicy::class)]
class Item extends Model
{
    /** @use HasFactory<ItemFactory> */
    use HasFactory, HasUlids;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'status' => ItemStatus::class,
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function owner(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
