<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Features\Accounts\Models\User;
use App\Features\Items\Models\Item;
use Database\Factories\ItemFactory;
use Database\Factories\UserFactory;
use Illuminate\Database\Seeder;
use RuntimeException;

/**
 * Development data: one demo account with a few items. Refuses to run in
 * production, where a well-known login would be a backdoor.
 * Sign in as demo@example.com with the password in UserFactory::PASSWORD
 * (a development-only constant).
 */
final class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        if (app()->isProduction()) {
            throw new RuntimeException('Refusing to seed demo data in production.');
        }

        $demo = User::query()->firstOrCreate(
            ['email' => 'demo@example.com'],
            ['name' => 'Demo User', 'password' => UserFactory::PASSWORD],
        );

        if (! Item::query()->whereBelongsTo($demo, 'owner')->exists()) {
            ItemFactory::new()->count(3)->ownedBy($demo)->create();
            ItemFactory::new()->done()->ownedBy($demo)->create();
        }
    }
}
