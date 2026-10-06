<?php

declare(strict_types=1);

namespace App\Features\Items\Actions;

use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Models\Item;

/**
 * The validated shape of an item's editable fields: what the actions accept.
 * It keeps HTTP requests, Livewire forms and queued jobs out of the business
 * logic: any of them can build one.
 */
final readonly class ItemInput
{
    public function __construct(
        public string $title,
        public ?string $notes = null,
        public ItemStatus $status = ItemStatus::Open,
    ) {}

    /**
     * @param  array<string, mixed>  $validated
     */
    public static function fromValidated(array $validated): self
    {
        return new self(
            title: self::string($validated['title'] ?? ''),
            notes: self::nullableString($validated['notes'] ?? null),
            status: ItemStatus::from(self::string($validated['status'] ?? ItemStatus::Open->value)),
        );
    }

    /**
     * A partial update (PATCH): fields that were not sent keep their stored value.
     *
     * @param  array<string, mixed>  $validated
     */
    public static function merge(Item $item, array $validated): self
    {
        return new self(
            title: array_key_exists('title', $validated) ? self::string($validated['title']) : $item->title,
            notes: array_key_exists('notes', $validated) ? self::nullableString($validated['notes']) : $item->notes,
            status: array_key_exists('status', $validated) ? ItemStatus::from(self::string($validated['status'])) : $item->status,
        );
    }

    private static function string(mixed $value): string
    {
        return is_scalar($value) ? (string) $value : '';
    }

    private static function nullableString(mixed $value): ?string
    {
        return is_scalar($value) && (string) $value !== '' ? (string) $value : null;
    }
}
