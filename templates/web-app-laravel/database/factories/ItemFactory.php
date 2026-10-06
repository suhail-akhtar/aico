<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Features\Accounts\Models\User;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Models\Item;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Item>
 */
final class ItemFactory extends Factory
{
    protected $model = Item::class;

    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'title' => rtrim(fake()->sentence(4), '.'),
            'notes' => fake()->optional()->paragraph(),
            'status' => ItemStatus::Open,
        ];
    }

    public function done(): static
    {
        return $this->state(['status' => ItemStatus::Done]);
    }

    public function ownedBy(User $user): static
    {
        return $this->state(['user_id' => $user->id]);
    }
}
