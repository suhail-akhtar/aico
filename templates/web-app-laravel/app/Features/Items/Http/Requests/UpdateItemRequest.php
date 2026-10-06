<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** PATCH: send only the fields to change. The policy check happens in the controller, on the bound item. */
final class UpdateItemRequest extends FormRequest
{
    /**
     * @return array<string, list<mixed>>
     */
    public function rules(): array
    {
        return ItemRules::partial();
    }
}
