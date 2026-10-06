<?php

declare(strict_types=1);

namespace App\Features\Items\Http\Livewire;

use App\Features\Accounts\Models\User;
use App\Features\Items\Actions\CreateItem;
use App\Features\Items\Actions\DeleteItem;
use App\Features\Items\Actions\ListItems;
use App\Features\Items\Actions\ToggleItem;
use App\Features\Items\Actions\UpdateItem;
use App\Features\Items\Enums\ItemStatus;
use App\Features\Items\Models\Item;
use Illuminate\Contracts\View\View;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Gate;
use Livewire\Attributes\Locked;
use Livewire\Attributes\Url;
use Livewire\Component;
use Livewire\WithPagination;

/**
 * The items screen: add, edit, tick, delete, search and filter without a page
 * reload. It is the web counterpart of ItemController and does the same four
 * things: validate (form), authorise (policy), delegate (action), render.
 *
 * Every public property can be rewritten by a malicious client. So: `editingId`
 * is #[Locked], and each method re-loads the item by id
 * and runs the policy on it, instead of trusting anything it was handed.
 */
final class ItemsPage extends Component
{
    use WithPagination;

    public ItemForm $form;

    #[Url(as: 'q', except: '')]
    public string $search = '';

    #[Url(as: 'status', except: '')]
    public string $statusFilter = '';

    #[Locked]
    public ?string $editingId = null;

    public function updatedSearch(): void
    {
        $this->resetPage();
    }

    public function updatedStatusFilter(): void
    {
        $this->resetPage();
    }

    public function save(CreateItem $create, UpdateItem $update): void
    {
        if ($this->editingId === null) {
            Gate::authorize('create', Item::class);
            $create->handle($this->user(), $this->form->toInput());
            $this->resetPage();
        } else {
            $item = $this->owned($this->editingId);
            $update->handle($item, $this->form->toInput($item));
        }

        $this->cancel();
    }

    public function edit(string $id): void
    {
        $item = $this->owned($id);
        $this->form->load($item);
        $this->editingId = $item->id;
        $this->resetValidation();
    }

    public function cancel(): void
    {
        $this->form->reset();
        $this->editingId = null;
        $this->resetValidation();
    }

    public function toggle(string $id, ToggleItem $toggle): void
    {
        $toggle->handle($this->owned($id));
    }

    public function delete(string $id, DeleteItem $delete): void
    {
        $delete->handle($this->owned($id));

        if ($this->editingId === $id) {
            $this->cancel();
        }
    }

    public function render(ListItems $list): View
    {
        Gate::authorize('viewAny', Item::class);

        $items = $list
            ->query($this->user(), $this->search, ItemStatus::tryFrom($this->statusFilter))
            ->paginate(10);

        $view = view('items.page', ['items' => $items]);

        return $view->layout('layouts.app', ['title' => 'Items']);
    }

    /** Load an item and run the policy: someone else's id answers 404, exactly as in the API. */
    private function owned(string $id): Item
    {
        $item = Item::query()->findOrFail($id);
        Gate::authorize('update', $item);

        return $item;
    }

    private function user(): User
    {
        $user = Auth::user();
        assert($user instanceof User);

        return $user;
    }
}
