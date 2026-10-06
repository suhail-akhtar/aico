<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Requests;

use App\Features\Items\Models\Item;
use Illuminate\Foundation\Http\FormRequest;

final class StoreItemRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()?->can('create', Item::class) ?? false;
    }

    /**
     * @return array<string, list<mixed>>
     */
    public function rules(): array
    {
        return ItemRules::rules();
    }
}
