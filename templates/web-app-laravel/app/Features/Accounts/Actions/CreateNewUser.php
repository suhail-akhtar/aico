<?php

declare(strict_types=1);

namespace App\Features\Accounts\Actions;

use App\Features\Accounts\Models\User;
use App\Features\Accounts\Rules\PasswordRules;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Laravel\Fortify\Contracts\CreatesNewUsers;

/** Sign-up. Fortify calls this; the web form and the tests share one rule set. */
final class CreateNewUser implements CreatesNewUsers
{
    /**
     * @param  array<string, mixed>  $input
     */
    public function create(array $input): User
    {
        /** @var array{name: string, email: string, password: string} $data */
        $data = Validator::make($input, [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'string', 'email:rfc', 'max:255', Rule::unique(User::class)],
            'password' => PasswordRules::rules(),
        ])->validate();

        return User::create([
            'name' => $data['name'],
            'email' => mb_strtolower($data['email']),
            'password' => $data['password'],
        ]);
    }
}
