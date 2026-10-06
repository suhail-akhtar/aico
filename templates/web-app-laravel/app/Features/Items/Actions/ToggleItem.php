<?php

declare(strict_types=1);

namespace App\Features\Items\Actions;

use App\Features\Items\Models\Item;

final class ToggleItem
{
    public function handle(Item $item): Item
    {
        $item->status = $item->status->toggled();
        $item->save();

        return $item;
    }
}
