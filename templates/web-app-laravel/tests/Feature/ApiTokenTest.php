<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use Database\Factories\UserFactory;

it('issues a bearer token for valid credentials and the token works', function (): void {
    $user = User::factory()->create(['email' => 'ada@example.test']);

    $response = $this->postJson('/api/v1/auth/tokens', [
        'email' => 'ADA@example.test',
        'password' => UserFactory::PASSWORD,
        'device_name' => 'laptop',
    ])->assertCreated()->assertJsonPath('data.type', 'Bearer');

    expect($response->json('data.expires_at'))->not->toBeNull();

    $token = (string) $response->json('data.token');
    $this->getJson('/api/v1/items', ['Authorization' => "Bearer {$token}"])->assertOk();

    // Stored hashed: the plain token is not in the database.
    expect($user->tokens()->first()?->token)->not->toBe(explode('|', $token)[1]);
});

it('gives the same answer for a wrong password and an unknown email', function (): void {
    User::factory()->create(['email' => 'ada@example.test']);

    $wrongPassword = $this->postJson('/api/v1/auth/tokens', ['email' => 'ada@example.test', 'password' => 'nope-nope-nope', 'device_name' => 'x']);
    $unknownEmail = $this->postJson('/api/v1/auth/tokens', ['email' => 'nobody@example.test', 'password' => 'nope-nope-nope', 'device_name' => 'x']);

    $wrongPassword->assertStatus(422);
    $unknownEmail->assertStatus(422);
    expect($wrongPassword->json('errors'))->toBe($unknownEmail->json('errors'));
});

it('throttles credential guessing per email and IP', function (): void {
    User::factory()->create(['email' => 'ada@example.test']);
    $attempt = fn () => $this->postJson('/api/v1/auth/tokens', ['email' => 'ada@example.test', 'password' => 'wrong-wrong-wrong', 'device_name' => 'x']);

    foreach (range(1, 5) as $_) {
        $attempt()->assertStatus(422);
    }

    $attempt()->assertStatus(429)->assertHeader('Retry-After');
});

it('revokes only the token that made the request', function (): void {
    [$user, $headers] = userWithToken();
    $user->createToken('other');

    $this->deleteJson('/api/v1/auth/tokens/current', [], $headers)->assertNoContent();

    expect($user->tokens()->count())->toBe(1);
    app('auth')->forgetGuards(); // the test app keeps the authenticated user between requests
    $this->getJson('/api/v1/items', $headers)->assertUnauthorized();
});

it('requires a device name and a password', function (): void {
    $this->postJson('/api/v1/auth/tokens', ['email' => 'a@example.test'])->assertStatus(422);
});
