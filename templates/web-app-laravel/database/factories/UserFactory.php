<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Features\Accounts\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * @extends Factory<User>
 */
final class UserFactory extends Factory
{
    protected $model = User::class;

    /** Hashed once per process: Argon2id is deliberately slow. */
    protected static ?string $password = null;

    /** The plain password every factory user has (tests sign in with it). */
    public const PASSWORD = 'correct horse battery staple';

    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'name' => fake()->name(),
            'email' => fake()->unique()->safeEmail(),
            'email_verified_at' => now(),
            'password' => self::$password ??= Hash::make(self::PASSWORD),
            'remember_token' => Str::random(10),
        ];
    }

    public function unverified(): static
    {
        return $this->state(['email_verified_at' => null]);
    }
}
