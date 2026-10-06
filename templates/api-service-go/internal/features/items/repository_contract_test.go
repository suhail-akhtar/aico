package items_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/database/dbtest"
	"example.com/api-service/internal/platform/ids"
)

// repoFactory returns a repository and a function that creates a user row the
// repository may reference (PostgreSQL enforces the owner foreign key; the
// in-memory fake has no users and ignores it).
type repoFactory func(t *testing.T) (repo items.Repository, addOwner func(id string))

func TestMemoryRepository(t *testing.T) {
	t.Parallel()
	runRepositoryContract(t, func(*testing.T) (items.Repository, func(string)) {
		return items.NewMemoryRepository(), func(string) {}
	})
}

func TestPostgresRepository(t *testing.T) {
	t.Parallel()
	runRepositoryContract(t, func(t *testing.T) (items.Repository, func(string)) {
		pool := dbtest.Pool(t)
		return items.NewPostgresRepository(pool), func(id string) {
			_, err := pool.Exec(context.Background(),
				"INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, 'h', now())", id, id+"@example.com")
			if err != nil {
				t.Fatalf("insert owner: %v", err)
			}
		}
	})
}

// runRepositoryContract is the behaviour every Repository must have. It runs
// against the in-memory fake and PostgreSQL, so the fake cannot drift from the
// real thing, and a new adapter proves itself by passing this suite.
func runRepositoryContract(t *testing.T, newRepo repoFactory) {
	t.Helper()
	fake := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	gen := ids.NewGenerator(fake)
	const alice, bob = "0199a8c4-3f6e-7b21-8c3d-00000000000a", "0199a8c4-3f6e-7b21-8c3d-00000000000b"

	newItem := func(owner, name string) items.Item {
		fake.Advance(time.Millisecond)
		now := fake.Now()
		return items.Item{ID: gen.New(), OwnerID: owner, Name: name, Description: "d", Quantity: 3, CreatedAt: now, UpdatedAt: now}
	}
	setup := func(t *testing.T) items.Repository {
		repo, addOwner := newRepo(t)
		addOwner(alice)
		addOwner(bob)
		return repo
	}
	ctx := context.Background()

	t.Run("create then get round-trips every field", func(t *testing.T) {
		repo := setup(t)
		it := newItem(alice, "pen")
		if err := repo.Create(ctx, it); err != nil {
			t.Fatal(err)
		}
		got, err := repo.Get(ctx, alice, it.ID)
		if err != nil {
			t.Fatal(err)
		}
		if diff := cmp.Diff(it, got); diff != "" {
			t.Fatalf("stored item differs (-want +got):\n%s", diff)
		}
	})

	t.Run("another owner sees not found", func(t *testing.T) {
		repo := setup(t)
		it := newItem(alice, "pen")
		_ = repo.Create(ctx, it)
		if _, err := repo.Get(ctx, bob, it.ID); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("Get as another owner: %v", err)
		}
		if _, err := repo.Update(ctx, bob, it.ID, items.Input{Name: "stolen"}, fake.Now()); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("Update as another owner: %v", err)
		}
		if err := repo.Delete(ctx, bob, it.ID); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("Delete as another owner: %v", err)
		}
		if got, err := repo.Get(ctx, alice, it.ID); err != nil || got.Name != "pen" {
			t.Fatalf("the owner's item was affected: %+v, %v", got, err)
		}
	})

	t.Run("missing id is not found", func(t *testing.T) {
		repo := setup(t)
		missing := gen.New()
		if _, err := repo.Get(ctx, alice, missing); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("Get: %v", err)
		}
		if _, err := repo.Update(ctx, alice, missing, items.Input{Name: "x"}, fake.Now()); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("Update: %v", err)
		}
		if err := repo.Delete(ctx, alice, missing); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("Delete: %v", err)
		}
	})

	t.Run("update replaces fields and returns the stored row", func(t *testing.T) {
		repo := setup(t)
		it := newItem(alice, "pen")
		_ = repo.Create(ctx, it)
		fake.Advance(time.Minute)
		got, err := repo.Update(ctx, alice, it.ID, items.Input{Name: "marker", Description: "blue", Quantity: 9}, fake.Now())
		if err != nil {
			t.Fatal(err)
		}
		want := it
		want.Name, want.Description, want.Quantity, want.UpdatedAt = "marker", "blue", 9, fake.Now()
		if diff := cmp.Diff(want, got); diff != "" {
			t.Fatalf("updated item differs (-want +got):\n%s", diff)
		}
		again, _ := repo.Get(ctx, alice, it.ID)
		if diff := cmp.Diff(want, again); diff != "" {
			t.Fatalf("stored item differs (-want +got):\n%s", diff)
		}
	})

	t.Run("delete removes it", func(t *testing.T) {
		repo := setup(t)
		it := newItem(alice, "pen")
		_ = repo.Create(ctx, it)
		if err := repo.Delete(ctx, alice, it.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.Get(ctx, alice, it.ID); !errors.Is(err, items.ErrNotFound) {
			t.Fatalf("after delete: %v", err)
		}
	})

	t.Run("list is newest first, scoped to the owner, and keyset paged", func(t *testing.T) {
		repo := setup(t)
		var mine []items.Item
		for _, name := range []string{"a", "b", "c", "d", "e"} {
			it := newItem(alice, name)
			mine = append(mine, it)
			_ = repo.Create(ctx, it)
			_ = repo.Create(ctx, newItem(bob, "bob-"+name))
		}

		all, err := repo.List(ctx, alice, ids.MaxID, 100)
		if err != nil {
			t.Fatal(err)
		}
		if len(all) != 5 {
			t.Fatalf("listed %d items, want 5 (and none of bob's)", len(all))
		}
		for i, it := range all {
			if want := mine[len(mine)-1-i]; it.ID != want.ID {
				t.Fatalf("position %d is %s, want %s (newest first)", i, it.Name, want.Name)
			}
		}

		page1, _ := repo.List(ctx, alice, ids.MaxID, 2)
		page2, _ := repo.List(ctx, alice, page1[len(page1)-1].ID, 2)
		page3, _ := repo.List(ctx, alice, page2[len(page2)-1].ID, 2)
		var names []string
		for _, p := range [][]items.Item{page1, page2, page3} {
			for _, it := range p {
				names = append(names, it.Name)
			}
		}
		if diff := cmp.Diff([]string{"e", "d", "c", "b", "a"}, names); diff != "" {
			t.Fatalf("paging order (-want +got):\n%s", diff)
		}
		if len(page3) != 1 {
			t.Fatalf("last page has %d items, want 1", len(page3))
		}
	})

	t.Run("list of nothing is empty, not an error", func(t *testing.T) {
		repo := setup(t)
		got, err := repo.List(ctx, alice, ids.MaxID, 10)
		if err != nil || len(got) != 0 {
			t.Fatalf("got %v, %v", got, err)
		}
	})
}

// A storage failure must surface as itself, never be mistaken for "not found"
// (which would turn an outage into silent 404s).
func TestPostgresFailuresAreNotNotFound(t *testing.T) {
	t.Parallel()
	pool := dbtest.Pool(t)
	repo := items.NewPostgresRepository(pool)
	pool.Close()
	ctx := context.Background()
	id := "0199a8c4-3f6e-7b21-8c3d-0123456789ab"
	check := func(name string, err error) {
		t.Helper()
		if err == nil || errors.Is(err, items.ErrNotFound) {
			t.Errorf("%s on a closed pool: %v, want a storage error", name, err)
		}
	}
	check("Create", repo.Create(ctx, items.Item{ID: id, OwnerID: id, Name: "x"}))
	_, err := repo.Get(ctx, id, id)
	check("Get", err)
	_, err = repo.List(ctx, id, ids.MaxID, 10)
	check("List", err)
	_, err = repo.Update(ctx, id, id, items.Input{Name: "x"}, time.Now())
	check("Update", err)
	check("Delete", repo.Delete(ctx, id, id))
}
