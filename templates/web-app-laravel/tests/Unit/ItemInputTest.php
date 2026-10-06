<?php

declare(strict_types=1);

use App\Features\Items\Actions\ItemInput;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Models\Item;

it('builds from validated data, defaulting status to open and blank notes to null', function (): void {
    $input = ItemInput::fromValidated(['title' => 'Write tests', 'notes' => '']);

    expect($input->title)->toBe('Write tests')
        ->and($input->notes)->toBeNull()
        ->and($input->status)->toBe(ItemStatus::Open);
});

it('reads a status when one is given', function (): void {
    expect(ItemInput::fromValidated(['title' => 'x', 'status' => 'done'])->status)->toBe(ItemStatus::Done);
});

it('keeps stored values for fields a partial update did not send', function (): void {
    $item = new Item(['title' => 'Old', 'notes' => 'keep me', 'status' => ItemStatus::Done]);

    $input = ItemInput::merge($item, ['title' => 'New']);

    expect($input->title)->toBe('New')
        ->and($input->notes)->toBe('keep me')
        ->and($input->status)->toBe(ItemStatus::Done);
});

it('lets a partial update clear the notes', function (): void {
    $item = new Item(['title' => 'Old', 'notes' => 'gone soon', 'status' => ItemStatus::Open]);

    expect(ItemInput::merge($item, ['notes' => null])->notes)->toBeNull()
        ->and(ItemInput::merge($item, ['status' => 'done'])->status)->toBe(ItemStatus::Done);
});

it('toggles between open and done', function (): void {
    expect(ItemStatus::Open->toggled())->toBe(ItemStatus::Done)
        ->and(ItemStatus::Done->toggled())->toBe(ItemStatus::Open)
        ->and(ItemStatus::Done->label())->toBe('Done');
});
