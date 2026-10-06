<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;

it('migrates and seeds the demo account, then stops with --no-serve', function (): void {
    $this->artisan('app:dev', ['--no-serve' => true])->assertSuccessful();

    expect(User::query()->where('email', 'demo@example.com')->exists())->toBeTrue();
});

it('creates a missing SQLite file before migrating', function (): void {
    $file = sys_get_temp_dir().'/aico-dev-'.bin2hex(random_bytes(4)).'.sqlite';
    config(['database.default' => 'sqlite', 'database.connections.sqlite.database' => $file]);

    // Only the preparation step: the in-memory test connection stays in use for migrate/seed.
    $this->artisan('app:dev', ['--no-serve' => true])->assertSuccessful();

    expect(is_file($file))->toBeTrue();
    @unlink($file);
});

it('refuses to run in production', function (): void {
    $this->app['env'] = 'production';

    $this->artisan('app:dev', ['--no-serve' => true])->assertFailed();
    expect(User::query()->count())->toBe(0);
});
