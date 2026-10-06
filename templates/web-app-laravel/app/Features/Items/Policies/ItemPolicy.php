<?php

declare(strict_types=1);

namespace App\Features\Items\Policies;

use App\Features\Accounts\Models\User;
use App\Features\Items\Models\Item;
use Illuminate\Auth\Access\Response;

/**
 * Ownership rules. Someone else's item answers "not found", not "forbidden":
 * a 403 would confirm that the id exists. The web page, the API and the tests
 * all go through these methods; nothing checks `user_id` by hand elsewhere.
 */
final class ItemPolicy
{
    public function viewAny(User $user): bool
    {
        return true;
    }

    public function create(User $user): bool
    {
        return true;
    }

    public function view(User $user, Item $item): Response
    {
        return $this->owns($user, $item);
    }

    public function update(User $user, Item $item): Response
    {
        return $this->owns($user, $item);
    }

    public function delete(User $user, Item $item): Response
    {
        return $this->owns($user, $item);
    }

    private function owns(User $user, Item $item): Response
    {
        return $item->user_id === $user->id ? Response::allow() : Response::denyAsNotFound();
    }
}
