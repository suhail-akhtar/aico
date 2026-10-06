<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Livewire;

use App\Features\Items\Actions\ItemInput;
use App\Features\Items\Http\Requests\ItemRules;
use App\Features\Items\Models\Item;
use Livewire\Form;

/** The add/edit form's state and rules. The rules are the API's rules (ItemRules). */
final class ItemForm extends Form
{
    public string $title = '';

    public string $notes = '';

    /**
     * @return array<string, list<mixed>>
     */
    protected function rules(): array
    {
        $rules = ItemRules::rules();
        // The form never sends a status; the toggle action owns it.
        unset($rules['status']);

        return $rules;
    }

    public function load(Item $item): void
    {
        $this->title = $item->title;
        $this->notes = $item->notes ?? '';
    }

    public function toInput(?Item $keep = null): ItemInput
    {
        /** @var array<string, mixed> $validated */
        $validated = $this->validate();

        return $keep instanceof Item
            ? ItemInput::merge($keep, $validated)
            : ItemInput::fromValidated($validated);
    }
}
