<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use App\Features\Items\Models\Item;
use Database\Seeders\DatabaseSeeder;

it('seeds one demo user with items, and is safe to run twice', function (): void {
    $this->seed(DatabaseSeeder::class);
    $this->seed(DatabaseSeeder::class);

    expect(User::query()->count())->toBe(1)->and(Item::query()->count())->toBe(4);
});

it('refuses to seed production', function (): void {
    $this->app['env'] = 'production';

    // Called directly: `db:seed` itself asks for confirmation in production before reaching the seeder.
    expect(fn () => app(DatabaseSeeder::class)->run())->toThrow(RuntimeException::class, 'production');
    expect(User::query()->count())->toBe(0);
});
