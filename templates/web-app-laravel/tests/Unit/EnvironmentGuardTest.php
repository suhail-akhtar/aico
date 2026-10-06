<?php

declare(strict_types=1);

use App\Support\Config\EnvironmentGuard;
use Illuminate\Config\Repository;

/**
 * @param  array<string, mixed>  $overrides
 */
function guardFor(array $overrides = []): EnvironmentGuard
{
    $config = new Repository(array_replace_recursive([
        'app' => ['key' => 'base64:'.base64_encode(random_bytes(32)), 'env' => 'production', 'debug' => false],
        'database' => ['default' => 'pgsql', 'connections' => ['pgsql' => ['host' => 'db', 'database' => 'app', 'username' => 'app']]],
        'hashing' => ['driver' => 'argon2id', 'argon' => ['memory' => 65536, 'time' => 3], 'bcrypt' => ['rounds' => 12]],
    ], $overrides));

    return new EnvironmentGuard($config);
}

it('accepts a sound production configuration', function (): void {
    expect(guardFor()->errors())->toBe([]);
});

it('rejects a missing APP_KEY', function (): void {
    expect(guardFor(['app' => ['key' => '']])->errors())->toHaveCount(1)
        ->and(guardFor(['app' => ['key' => '']])->errors()[0])->toContain('APP_KEY is not set');
});

it('rejects an APP_KEY of the wrong length', function (): void {
    expect(guardFor(['app' => ['key' => 'base64:'.base64_encode('short')]])->errors()[0])->toContain('32 random bytes')
        ->and(guardFor(['app' => ['key' => '%%%not base64%%%']])->errors()[0])->toContain('32 random bytes');
});

it('accepts a raw 32 byte key', function (): void {
    expect(guardFor(['app' => ['key' => str_repeat('k', 32)]])->errors())->toBe([]);
});

it('rejects APP_DEBUG=true in production only', function (): void {
    expect(guardFor(['app' => ['debug' => true]])->errors()[0])->toContain('APP_DEBUG');
    expect(guardFor(['app' => ['env' => 'local', 'debug' => true]])->errors())->toBe([]);
});

it('rejects an in-memory sqlite database in production', function (): void {
    $guard = guardFor(['database' => ['default' => 'sqlite', 'connections' => ['sqlite' => ['database' => ':memory:']]]]);

    expect($guard->errors()[0])->toContain('in-memory');
});

it('names every missing PostgreSQL setting', function (): void {
    $guard = guardFor(['database' => ['connections' => ['pgsql' => ['host' => '', 'database' => '', 'username' => '']]]]);

    expect($guard->errors())->toHaveCount(3)->and($guard->errors()[0])->toContain('DB_HOST');
});

it('rejects Argon2id weaker than the OWASP minimum', function (): void {
    $errors = guardFor(['hashing' => ['argon' => ['memory' => 1024, 'time' => 1]]])->errors();

    expect($errors)->toHaveCount(2)->and($errors[0])->toContain('ARGON_MEMORY');
});

it('checks bcrypt cost when bcrypt is the driver, and rejects unknown drivers', function (): void {
    expect(guardFor(['hashing' => ['driver' => 'bcrypt', 'bcrypt' => ['rounds' => 12]]])->errors())->toBe([])
        ->and(guardFor(['hashing' => ['driver' => 'bcrypt', 'bcrypt' => ['rounds' => 4]]])->errors()[0])->toContain('BCRYPT_ROUNDS')
        ->and(guardFor(['hashing' => ['driver' => 'md5']])->errors()[0])->toContain('HASH_DRIVER');
});

it('is what `php artisan app:check-config` reports', function (): void {
    config(['app.key' => '']);

    $this->artisan('app:check-config')->assertFailed();
});

it('passes `app:check-config` with the test configuration', function (): void {
    $this->artisan('app:check-config')->assertSuccessful();
});
