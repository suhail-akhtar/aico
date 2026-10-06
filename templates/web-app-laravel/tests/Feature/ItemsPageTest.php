<?php

declare(strict_types=1);

use App\Features\Accounts\Models\User;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Http\Livewire\ItemsPage;
use App\Features\Items\Models\Item;
use Livewire\Livewire;

beforeEach(function (): void {
    $this->user = User::factory()->create();
    $this->actingAs($this->user);
});

it('renders for a signed-in user', function (): void {
    $this->get('/items')->assertOk()->assertSeeLivewire(ItemsPage::class);
});

it('shows the empty state until there is something to show', function (): void {
    Livewire::test(ItemsPage::class)->assertSee('No items yet');
});

it('adds an item and clears the form', function (): void {
    Livewire::test(ItemsPage::class)
        ->set('form.title', 'Buy milk')
        ->set('form.notes', '2 litres')
        ->call('save')
        ->assertHasNoErrors()
        ->assertSet('form.title', '')
        ->assertSee('Buy milk');

    $item = Item::query()->firstOrFail();
    expect($item->user_id)->toBe($this->user->id)->and($item->notes)->toBe('2 litres');
});

it('shows a field error beside the field and creates nothing', function (): void {
    Livewire::test(ItemsPage::class)
        ->set('form.title', '')
        ->call('save')
        ->assertHasErrors(['form.title' => 'required']);

    expect(Item::query()->count())->toBe(0);
});

it('enforces the same length limits as the API', function (): void {
    Livewire::test(ItemsPage::class)
        ->set('form.title', str_repeat('a', 121))
        ->call('save')
        ->assertHasErrors(['form.title' => 'max']);
});

it('edits an item in place', function (): void {
    $item = Item::factory()->ownedBy($this->user)->create(['title' => 'Old', 'notes' => 'n']);

    Livewire::test(ItemsPage::class)
        ->call('edit', $item->id)
        ->assertSet('form.title', 'Old')
        ->assertSet('editingId', $item->id)
        ->set('form.title', 'New')
        ->call('save')
        ->assertHasNoErrors()
        ->assertSet('editingId', null);

    expect($item->fresh()?->title)->toBe('New');
});

it('cancels an edit without saving', function (): void {
    $item = Item::factory()->ownedBy($this->user)->create(['title' => 'Old']);

    Livewire::test(ItemsPage::class)
        ->call('edit', $item->id)
        ->set('form.title', 'Changed')
        ->call('cancel')
        ->assertSet('editingId', null)
        ->assertSet('form.title', '');

    expect($item->fresh()?->title)->toBe('Old');
});

it('ticks an item done and back', function (): void {
    $item = Item::factory()->ownedBy($this->user)->create();

    $page = Livewire::test(ItemsPage::class)->call('toggle', $item->id);
    expect($item->fresh()?->status)->toBe(ItemStatus::Done);

    $page->call('toggle', $item->id);
    expect($item->fresh()?->status)->toBe(ItemStatus::Open);
});

it('deletes an item, and leaves edit mode if it was the one being edited', function (): void {
    $item = Item::factory()->ownedBy($this->user)->create();

    Livewire::test(ItemsPage::class)
        ->call('edit', $item->id)
        ->call('delete', $item->id)
        ->assertSet('editingId', null);

    $this->assertModelMissing($item);
});

it('searches and filters', function (): void {
    Item::factory()->ownedBy($this->user)->create(['title' => 'Pay rent']);
    Item::factory()->ownedBy($this->user)->done()->create(['title' => 'Walk dog']);

    Livewire::test(ItemsPage::class)
        ->set('search', 'rent')->assertSee('Pay rent')->assertDontSee('Walk dog')
        ->set('search', '')->set('statusFilter', 'done')->assertSee('Walk dog')->assertDontSee('Pay rent')
        ->set('search', 'zzz')->assertSee('Nothing matches');
});

it('paginates ten to a page', function (): void {
    Item::factory()->ownedBy($this->user)->count(12)->create();

    Livewire::test(ItemsPage::class)
        ->assertSee('Showing 1-10 of 12')
        ->call('nextPage')
        ->assertSee('Showing 11-12 of 12');
});

it('never shows, edits, toggles or deletes another user\'s item, even with a forged id', function (string $method): void {
    $theirs = Item::factory()->create(['title' => 'Secret plans']);

    Livewire::test(ItemsPage::class)->assertDontSee('Secret plans');

    // The component call goes through the HTTP kernel: a foreign id is a plain 404.
    Livewire::test(ItemsPage::class)->call($method, $theirs->id)->assertStatus(404);
    expect($theirs->fresh()?->title)->toBe('Secret plans');
})->with(['edit', 'toggle', 'delete']);

it('does not let the browser rewrite the locked editing id', function (): void {
    $theirs = Item::factory()->create();

    expect(fn () => Livewire::test(ItemsPage::class)->set('editingId', $theirs->id))->toThrow(Exception::class);
});

it('escapes HTML in titles and notes', function (): void {
    Item::factory()->ownedBy($this->user)->create(['title' => '<script>alert(1)</script>', 'notes' => '<img src=x onerror=alert(1)>']);

    $this->get('/items')->assertOk()
        ->assertDontSee('<script>alert(1)</script>', false)
        ->assertDontSee('<img src=x', false)
        ->assertSee('&lt;script&gt;alert(1)&lt;/script&gt;', false);
});

it('keeps two users\' lists separate', function (): void {
    $other = User::factory()->create();
    Item::factory()->ownedBy($other)->create(['title' => 'Other person task']);
    Item::factory()->ownedBy($this->user)->create(['title' => 'My task']);

    Livewire::test(ItemsPage::class)->assertSee('My task')->assertDontSee('Other person task');
});
