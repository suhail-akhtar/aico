<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Resources;

use App\Features\Items\Models\Item;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * The public shape of an item. The API contract lives here: add a model column
 * and it stays private until it is listed below.
 *
 * @mixin Item
 */
final class ItemResource extends JsonResource
{
    /**
     * @return array{id: string, title: string, notes: string|null, status: string, created_at: string, updated_at: string}
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'notes' => $this->notes,
            'status' => $this->status->value,
            'created_at' => $this->created_at->toIso8601String(),
            'updated_at' => $this->updated_at->toIso8601String(),
        ];
    }
}
