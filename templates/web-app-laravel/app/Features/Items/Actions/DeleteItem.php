<?php

declare(strict_types=1);

namespace App\Features\Items\Actions;

use App\Features\Items\Models\Item;

final class DeleteItem
{
    public function handle(Item $item): void
    {
        $item->delete();
    }
}
