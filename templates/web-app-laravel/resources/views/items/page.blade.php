<div>
    <h1 class="text-2xl font-semibold">Items</h1>

    <form wire:submit="save" class="card mt-6" aria-label="{{ $editingId ? 'Edit item' : 'Add item' }}">
        <div class="mb-3">
            <label for="title" class="label">{{ $editingId ? 'Edit item' : 'New item' }}</label>
            <input id="title" type="text" wire:model="form.title" class="input" maxlength="120" autocomplete="off"
                   placeholder="What needs doing?">
            @error('form.title') <p class="field-error" role="alert">{{ $message }}</p> @enderror
        </div>
        <div class="mb-4">
            <label for="notes" class="label">Notes (optional)</label>
            <textarea id="notes" wire:model="form.notes" rows="2" class="input" maxlength="2000"></textarea>
            @error('form.notes') <p class="field-error" role="alert">{{ $message }}</p> @enderror
        </div>
        <div class="flex gap-2">
            <button type="submit" class="btn">{{ $editingId ? 'Save changes' : 'Add item' }}</button>
            @if ($editingId)
                <button type="button" wire:click="cancel" class="btn-quiet">Cancel</button>
            @endif
        </div>
    </form>

    <div class="mt-8 flex flex-wrap items-end gap-3">
        <div class="grow">
            <label for="search" class="label">Search</label>
            <input id="search" type="search" wire:model.live.debounce.300ms="search" class="input" placeholder="Search titles">
        </div>
        <div>
            <label for="status" class="label">Show</label>
            <select id="status" wire:model.live="statusFilter" class="input">
                <option value="">All</option>
                <option value="open">Open</option>
                <option value="done">Done</option>
            </select>
        </div>
    </div>

    <ul class="mt-4 space-y-2" aria-label="Your items">
        @forelse ($items as $item)
            <li wire:key="item-{{ $item->id }}" class="card flex flex-wrap items-start justify-between gap-4 p-4">
                <div class="min-w-0 break-words">
                    <p class="font-medium {{ $item->status->value === 'done' ? 'line-through muted' : '' }}">{{ $item->title }}</p>
                    @if ($item->notes)
                        <p class="muted mt-1 text-sm whitespace-pre-line">{{ $item->notes }}</p>
                    @endif
                    <span class="pill mt-2">{{ $item->status->label() }}</span>
                </div>
                <div class="flex shrink-0 flex-wrap gap-2">
                    <button type="button" wire:click="toggle('{{ $item->id }}')" class="btn-quiet">
                        {{ $item->status->value === 'done' ? 'Reopen' : 'Mark done' }}
                    </button>
                    <button type="button" wire:click="edit('{{ $item->id }}')" class="btn-quiet">Edit</button>
                    <button type="button" wire:click="delete('{{ $item->id }}')" wire:confirm="Delete this item?" class="btn-quiet">Delete</button>
                </div>
            </li>
        @empty
            <li class="card muted text-center">
                @if ($search !== '' || $statusFilter !== '')
                    Nothing matches. Clear the search or filter.
                @else
                    No items yet. Add your first one above.
                @endif
            </li>
        @endforelse
    </ul>

    @if ($items->hasPages())
        <nav class="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
            <span class="muted">Showing {{ $items->firstItem() }}-{{ $items->lastItem() }} of {{ $items->total() }}</span>
            <div class="flex gap-2">
                <button type="button" wire:click="previousPage" class="btn-quiet" @disabled($items->onFirstPage())>Previous</button>
                <button type="button" wire:click="nextPage" class="btn-quiet" @disabled(! $items->hasMorePages())>Next</button>
            </div>
        </nav>
    @endif
</div>
