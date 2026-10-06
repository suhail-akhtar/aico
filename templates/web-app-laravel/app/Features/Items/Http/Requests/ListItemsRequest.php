<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Requests;

use App\Features\Items\Enums\ItemStatus;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

final class ListItemsRequest extends FormRequest
{
    public const MAX_LIMIT = 100;

    public const DEFAULT_LIMIT = 25;

    /**
     * @return array<string, list<mixed>>
     */
    public function rules(): array
    {
        return [
            'q' => ['sometimes', 'nullable', 'string', 'max:100'],
            'status' => ['sometimes', Rule::enum(ItemStatus::class)],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
            'cursor' => ['sometimes', 'string', 'max:512'],
        ];
    }
}
