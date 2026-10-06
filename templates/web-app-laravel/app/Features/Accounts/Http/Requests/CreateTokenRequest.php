<?php

declare(strict_types=1);

namespace App\Features\Accounts\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class CreateTokenRequest extends FormRequest
{
    /**
     * @return array<string, list<string>>
     */
    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'email', 'max:255'],
            'password' => ['required', 'string', 'max:128'],
            'device_name' => ['required', 'string', 'max:100'],
        ];
    }
}
