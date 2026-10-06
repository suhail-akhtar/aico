<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

// Feature tests boot the application and get a fresh in-memory SQLite database per test.
pest()->extend(TestCase::class)->use(RefreshDatabase::class)->in('Feature');
// Unit tests that need the container (config, hashing) still extend TestCase, but touch no database.
pest()->extend(TestCase::class)->in('Unit');

/**
 * A user plus a real Sanctum bearer token (hashed in the database, like production).
 *
 * @return array{0: User, 1: array<string, string>}
 */
function userWithToken(?User $user = null): array
{
    $user ??= User::factory()->create();
    $token = $user->createToken('tests')->plainTextToken;

    return [$user, ['Authorization' => 'Bearer '.$token, 'Accept' => 'application/json']];
}
