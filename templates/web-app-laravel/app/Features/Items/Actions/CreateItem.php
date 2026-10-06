<?php

declare(strict_types=1);

namespace App\Features\Items\Actions;

use App\Features\Accounts\Models\User;
use App\Features\Items\Models\Item;

/** One business operation, one class: the web page and the API both call this. */
final class CreateItem
{
    public function handle(User $owner, ItemInput $input): Item
    {
        $item = new Item([
            'title' => $input->title,
            'notes' => $input->notes,
            'status' => $input->status,
        ]);
        $item->owner()->associate($owner);
        $item->save();

        return $item;
    }
}
