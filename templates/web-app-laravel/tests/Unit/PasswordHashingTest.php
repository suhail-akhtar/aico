<?php

declare(strict_types=1);

use App\Support\Config\EnvironmentGuard;
use Illuminate\Support\Facades\Hash;

// The framework's own Argon2 defaults (1 MiB of memory) are far below the OWASP
// minimum. These tests pin OUR parameters so a config edit cannot weaken them quietly.

it('hashes passwords with Argon2id by default', function (): void {
    expect(config('hashing.driver'))->toBe('argon2id');
});

it('sets Argon2id parameters at or above the OWASP minimum', function (): void {
    expect(config('hashing.argon.memory'))->toBeGreaterThanOrEqual(EnvironmentGuard::ARGON2ID_MIN_MEMORY_KIB)
        ->and(config('hashing.argon.time'))->toBeGreaterThanOrEqual(EnvironmentGuard::ARGON2ID_MIN_TIME)
        ->and(config('hashing.argon.threads'))->toBeGreaterThanOrEqual(1);
});

it('produces hashes that really carry those parameters', function (): void {
    $hash = Hash::make('correct horse battery staple');
    $info = password_get_info($hash);

    expect($hash)->toStartWith('$argon2id$')
        ->and($info['algoName'])->toBe('argon2id')
        ->and($info['options']['memory_cost'])->toBeGreaterThanOrEqual(19456)
        ->and($info['options']['time_cost'])->toBeGreaterThanOrEqual(2);
});

it('verifies a password and rejects a wrong one', function (): void {
    $hash = Hash::make('correct horse battery staple');

    expect(Hash::check('correct horse battery staple', $hash))->toBeTrue()
        ->and(Hash::check('wrong', $hash))->toBeFalse();
});

it('marks a hash made with weaker parameters for rehash on login', function (): void {
    $weak = password_hash('correct horse battery staple', PASSWORD_ARGON2ID, ['memory_cost' => 1024, 'time_cost' => 2, 'threads' => 1]);

    expect(Hash::needsRehash($weak))->toBeTrue()
        ->and(Hash::needsRehash(Hash::make('x')))->toBeFalse();
});
