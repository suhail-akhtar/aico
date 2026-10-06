<?php

declare(strict_types=1);

namespace App\Features\Accounts\Actions;

use App\Features\Accounts\Models\User;
use App\Features\Accounts\Rules\PasswordRules;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\Validator;
use Laravel\Fortify\Contracts\ResetsUserPasswords;

/** Completes the emailed reset link. */
final class ResetUserPassword implements ResetsUserPasswords
{
    /**
     * @param  Authenticatable&User  $user
     * @param  array<string, mixed>  $input
     */
    public function reset($user, array $input): void
    {
        /** @var array{password: string} $data */
        $data = Validator::make($input, [
            'password' => PasswordRules::rules(),
        ])->validate();

        // The model's 'hashed' cast does the hashing.
        $user->forceFill(['password' => $data['password']])->save();
    }
}
