<?php

declare(strict_types=1);

namespace App\Support\Config;

use Illuminate\Contracts\Config\Repository;

/**
 * Refuses to run on a configuration that is unsafe or unusable, instead of
 * discovering it on the first request. Laravel itself starts happily with no
 * APP_KEY (and fails later, mid-request) or with APP_DEBUG=true in production
 * (and shows stack traces to strangers).
 *
 * `errors()` is pure (config in, messages out) so tests exercise every rule
 * without booting a broken app. It runs from two places: the container
 * entrypoint (`php artisan app:check-config`, before the server starts) and
 * the provider's boot on web requests. What it deliberately does not do:
 * contact the database (that is /readyz's job) or read env() (config only).
 */
final class EnvironmentGuard
{
    /** OWASP Password Storage Cheat Sheet minimums. */
    public const ARGON2ID_MIN_MEMORY_KIB = 19456;

    public const ARGON2ID_MIN_TIME = 2;

    public const BCRYPT_MIN_ROUNDS = 10;

    public function __construct(private readonly Repository $config) {}

    /**
     * @return list<string>
     */
    public function errors(): array
    {
        $errors = [];

        $key = $this->string('app.key');
        if ($key === '') {
            $errors[] = 'APP_KEY is not set. Generate one with `php artisan key:generate --show` and provide it as an environment variable.';
        } else {
            $raw = str_starts_with($key, 'base64:') ? base64_decode(substr($key, 7), true) : $key;
            if ($raw === false || strlen($raw) !== 32) {
                $errors[] = 'APP_KEY must be 32 random bytes (base64: prefixed). Regenerate it with `php artisan key:generate --show`.';
            }
        }

        if ($this->string('app.env') === 'production') {
            if ($this->config->get('app.debug') === true) {
                $errors[] = 'APP_DEBUG must be false in production: debug pages leak source, paths and secrets.';
            }
            if ($this->string('database.default') === 'sqlite' && $this->string('database.connections.sqlite.database') === ':memory:') {
                $errors[] = 'Production cannot use an in-memory SQLite database.';
            }
        }

        $errors = [...$errors, ...$this->hashingErrors()];

        if ($this->string('database.default') === 'pgsql') {
            foreach (['host' => 'DB_HOST', 'database' => 'DB_DATABASE', 'username' => 'DB_USERNAME'] as $field => $variable) {
                if ($this->string("database.connections.pgsql.{$field}") === '') {
                    $errors[] = "{$variable} is not set (needed for PostgreSQL).";
                }
            }
        }

        return $errors;
    }

    /**
     * @return list<string>
     */
    private function hashingErrors(): array
    {
        $driver = $this->string('hashing.driver');

        if ($driver === 'argon2id') {
            $memory = $this->int('hashing.argon.memory');
            $time = $this->int('hashing.argon.time');

            return array_values(array_filter([
                $memory < self::ARGON2ID_MIN_MEMORY_KIB ? "ARGON_MEMORY={$memory} KiB is below the OWASP minimum of ".self::ARGON2ID_MIN_MEMORY_KIB.'.' : null,
                $time < self::ARGON2ID_MIN_TIME ? "ARGON_TIME={$time} is below the OWASP minimum of ".self::ARGON2ID_MIN_TIME.'.' : null,
            ]));
        }

        if ($driver === 'bcrypt') {
            $rounds = $this->int('hashing.bcrypt.rounds');

            return $rounds < self::BCRYPT_MIN_ROUNDS ? ["BCRYPT_ROUNDS={$rounds} is below the OWASP minimum of ".self::BCRYPT_MIN_ROUNDS.'.'] : [];
        }

        return ["HASH_DRIVER must be argon2id (default) or bcrypt; got '{$driver}'."];
    }

    private function string(string $key): string
    {
        $value = $this->config->get($key);

        return is_scalar($value) ? (string) $value : '';
    }

    private function int(string $key): int
    {
        $value = $this->config->get($key);

        return is_numeric($value) ? (int) $value : 0;
    }
}
