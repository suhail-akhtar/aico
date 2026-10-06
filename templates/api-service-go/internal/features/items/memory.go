package items

import (
	"context"
	"sort"
	"sync"
	"time"
)

// MemoryRepository is an in-memory Repository. It is a test double and a
// development aid, NOT a runtime storage mode: nothing in cmd/ wires it. It is
// held to the same contract suite as PostgresRepository
// (repository_contract_test.go), which is what keeps it honest.
type MemoryRepository struct {
	mu    sync.Mutex
	items map[string]Item
}

// NewMemoryRepository returns an empty repository.
func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{items: map[string]Item{}}
}

// Create stores it.
func (r *MemoryRepository) Create(_ context.Context, it Item) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[it.ID] = it
	return nil
}

// Get returns the owner's item, or ErrNotFound.
func (r *MemoryRepository) Get(_ context.Context, ownerID, id string) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.items[id]
	if !ok || it.OwnerID != ownerID {
		return Item{}, ErrNotFound
	}
	return it, nil
}

// List returns up to limit of the owner's items with id < after, newest first.
func (r *MemoryRepository) List(_ context.Context, ownerID, after string, limit int) ([]Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Item, 0, len(r.items))
	for _, it := range r.items {
		if it.OwnerID == ownerID && it.ID < after {
			out = append(out, it)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Update replaces the item's fields, or returns ErrNotFound.
func (r *MemoryRepository) Update(_ context.Context, ownerID, id string, in Input, now time.Time) (Item, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.items[id]
	if !ok || it.OwnerID != ownerID {
		return Item{}, ErrNotFound
	}
	it.Name, it.Description, it.Quantity, it.UpdatedAt = in.Name, in.Description, in.Quantity, now
	r.items[id] = it
	return it, nil
}

// Delete removes the owner's item, or returns ErrNotFound.
func (r *MemoryRepository) Delete(_ context.Context, ownerID, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	it, ok := r.items[id]
	if !ok || it.OwnerID != ownerID {
		return ErrNotFound
	}
	delete(r.items, id)
	return nil
}
