<?php

declare(strict_types=1);

namespace App\Features\Items\Actions;

use App\Features\Items\Models\Item;

final class UpdateItem
{
    public function handle(Item $item, ItemInput $input): Item
    {
        $item->fill([
            'title' => $input->title,
            'notes' => $input->notes,
            'status' => $input->status,
        ])->save();

        return $item;
    }
}
