package auth_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"

	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/platform/database/dbtest"
)

type repos struct {
	users    auth.UserRepository
	sessions auth.SessionRepository
}

func TestMemoryRepositories(t *testing.T) {
	t.Parallel()
	runContract(t, func(*testing.T) repos {
		u := auth.NewMemoryUserRepository()
		return repos{users: u, sessions: auth.NewMemorySessionRepository(u)}
	})
}

func TestPostgresRepositories(t *testing.T) {
	t.Parallel()
	runContract(t, func(t *testing.T) repos {
		pool := dbtest.Pool(t)
		return repos{users: auth.NewPostgresUserRepository(pool), sessions: auth.NewPostgresSessionRepository(pool)}
	})
}

// runContract is the behaviour every UserRepository and SessionRepository must
// have; it runs against the in-memory fakes and PostgreSQL.
func runContract(t *testing.T, newRepos func(*testing.T) repos) {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)
	ada := auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-00000000000a", Email: "ada@example.com", PasswordHash: "h1", CreatedAt: now}

	t.Run("users: create, find, duplicate, update", func(t *testing.T) {
		r := newRepos(t).users
		if err := r.Create(ctx, ada); err != nil {
			t.Fatal(err)
		}
		got, err := r.ByEmail(ctx, "ada@example.com")
		if err != nil {
			t.Fatal(err)
		}
		if diff := cmp.Diff(ada, got); diff != "" {
			t.Fatalf("(-want +got):\n%s", diff)
		}
		dup := ada
		dup.ID = "0199a8c4-3f6e-7b21-8c3d-00000000000b"
		if err := r.Create(ctx, dup); !errors.Is(err, auth.ErrEmailTaken) {
			t.Fatalf("duplicate email: %v", err)
		}
		if _, err := r.ByEmail(ctx, "nobody@example.com"); !auth.IsUserNotFound(err) {
			t.Fatalf("unknown email: %v", err)
		}
		if err := r.UpdatePasswordHash(ctx, ada.ID, "h2"); err != nil {
			t.Fatal(err)
		}
		if got, _ := r.ByEmail(ctx, "ada@example.com"); got.PasswordHash != "h2" {
			t.Fatalf("hash not updated: %q", got.PasswordHash)
		}
	})

	t.Run("users: ByID, CreateIfAbsent, UpdateEmail", func(t *testing.T) {
		r := newRepos(t).users
		grace := auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-00000000000c", Email: "grace@example.com", PasswordHash: auth.UnusablePasswordHash, CreatedAt: now}

		if _, err := r.ByID(ctx, grace.ID); !auth.IsUserNotFound(err) {
			t.Fatalf("unknown id: %v", err)
		}
		created, err := r.CreateIfAbsent(ctx, grace)
		if err != nil || !created {
			t.Fatalf("first insert: %v, %v", created, err)
		}
		if got, err := r.ByID(ctx, grace.ID); err != nil || cmp.Diff(grace, got) != "" {
			t.Fatalf("ByID: %+v, %v", got, err)
		}
		// Same id again: nothing happens, nothing fails, whatever the other fields say.
		again := grace
		again.Email, again.PasswordHash = "other@example.com", "different"
		if created, err := r.CreateIfAbsent(ctx, again); err != nil || created {
			t.Fatalf("repeat insert: %v, %v", created, err)
		}
		if got, _ := r.ByID(ctx, grace.ID); got.Email != grace.Email || got.PasswordHash != grace.PasswordHash {
			t.Fatalf("a repeated insert changed the row: %+v", got)
		}
		// A different id on the same email is the collision.
		clash := auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-00000000000d", Email: grace.Email, PasswordHash: "h", CreatedAt: now}
		if created, err := r.CreateIfAbsent(ctx, clash); !errors.Is(err, auth.ErrEmailTaken) || created {
			t.Fatalf("email collision: %v, %v", created, err)
		}
		if _, err := r.ByID(ctx, clash.ID); !auth.IsUserNotFound(err) {
			t.Fatalf("the colliding row exists: %v", err)
		}

		if err := r.Create(ctx, ada); err != nil {
			t.Fatal(err)
		}
		if err := r.UpdateEmail(ctx, grace.ID, "grace.hopper@example.com"); err != nil {
			t.Fatal(err)
		}
		if got, _ := r.ByEmail(ctx, "grace.hopper@example.com"); got.ID != grace.ID {
			t.Fatalf("email not updated: %+v", got)
		}
		if _, err := r.ByEmail(ctx, grace.Email); !auth.IsUserNotFound(err) {
			t.Fatalf("the old email still resolves: %v", err)
		}
		if err := r.UpdateEmail(ctx, grace.ID, ada.Email); !errors.Is(err, auth.ErrEmailTaken) {
			t.Fatalf("moving onto another user's email: %v", err)
		}
		if err := r.UpdateEmail(ctx, grace.ID, "grace.hopper@example.com"); err != nil {
			t.Fatalf("setting your own email again is harmless: %v", err)
		}
	})

	t.Run("users: simultaneous CreateIfAbsent for one id inserts exactly once", func(t *testing.T) {
		r := newRepos(t).users
		u := auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-00000000000e", Email: "race@example.com", PasswordHash: auth.UnusablePasswordHash, CreatedAt: now}
		const callers = 24
		var wg sync.WaitGroup
		var inserted atomic.Int64
		errs := make(chan error, callers)
		start := make(chan struct{})
		for range callers {
			wg.Go(func() {
				<-start
				created, err := r.CreateIfAbsent(ctx, u)
				if err != nil {
					errs <- err
				}
				if created {
					inserted.Add(1)
				}
			})
		}
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Errorf("a concurrent first insert failed: %v", err)
		}
		if n := inserted.Load(); n != 1 {
			t.Fatalf("%d callers reported created, want exactly 1", n)
		}
		if got, err := r.ByID(ctx, u.ID); err != nil || got.Email != u.Email {
			t.Fatalf("the row: %+v, %v", got, err)
		}
	})

	t.Run("sessions: lookup, expiry, delete, purge", func(t *testing.T) {
		rs := newRepos(t)
		if err := rs.users.Create(ctx, ada); err != nil {
			t.Fatal(err)
		}
		live := auth.Session{TokenHash: auth.HashToken("live"), UserID: ada.ID, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
		old := auth.Session{TokenHash: auth.HashToken("old"), UserID: ada.ID, CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)}
		for _, s := range []auth.Session{live, old} {
			if err := rs.sessions.Create(ctx, s); err != nil {
				t.Fatal(err)
			}
		}

		p, err := rs.sessions.Lookup(ctx, live.TokenHash, now)
		if err != nil || p.UserID != ada.ID || p.Email != ada.Email {
			t.Fatalf("live lookup: %+v, %v", p, err)
		}
		if _, err := rs.sessions.Lookup(ctx, old.TokenHash, now); !errors.Is(err, auth.ErrInvalidToken) {
			t.Fatalf("expired lookup: %v", err)
		}
		if _, err := rs.sessions.Lookup(ctx, live.TokenHash, live.ExpiresAt); !errors.Is(err, auth.ErrInvalidToken) {
			t.Fatalf("a session is dead at its exact expiry instant: %v", err)
		}
		if _, err := rs.sessions.Lookup(ctx, auth.HashToken("unknown"), now); !errors.Is(err, auth.ErrInvalidToken) {
			t.Fatalf("unknown lookup: %v", err)
		}

		if err := rs.sessions.DeleteExpired(ctx, ada.ID, now); err != nil {
			t.Fatal(err)
		}
		if _, err := rs.sessions.Lookup(ctx, live.TokenHash, now); err != nil {
			t.Fatalf("purging expired sessions removed a live one: %v", err)
		}
		if err := rs.sessions.Delete(ctx, live.TokenHash); err != nil {
			t.Fatal(err)
		}
		if _, err := rs.sessions.Lookup(ctx, live.TokenHash, now); !errors.Is(err, auth.ErrInvalidToken) {
			t.Fatalf("deleted session still resolves: %v", err)
		}
		if err := rs.sessions.Delete(ctx, live.TokenHash); err != nil {
			t.Fatalf("deleting twice must be harmless: %v", err)
		}
	})
}

// A storage failure must surface as itself, never be mistaken for "no such
// user" or "invalid token" (an outage must not look like a failed login).
func TestPostgresFailuresAreNotDomainErrors(t *testing.T) {
	t.Parallel()
	pool := dbtest.Pool(t)
	users, sessions := auth.NewPostgresUserRepository(pool), auth.NewPostgresSessionRepository(pool)
	pool.Close()
	ctx, now := context.Background(), time.Now()
	check := func(name string, err error) {
		t.Helper()
		if err == nil || errors.Is(err, auth.ErrEmailTaken) || errors.Is(err, auth.ErrInvalidToken) || auth.IsUserNotFound(err) {
			t.Errorf("%s on a closed pool: %v, want a storage error", name, err)
		}
	}
	check("users.Create", users.Create(ctx, auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", Email: "a@example.com"}))
	_, err := users.ByEmail(ctx, "a@example.com")
	check("users.ByEmail", err)
	_, err = users.ByID(ctx, "0199a8c4-3f6e-7b21-8c3d-0123456789ab")
	check("users.ByID", err)
	_, err = users.CreateIfAbsent(ctx, auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", Email: "a@example.com"})
	check("users.CreateIfAbsent", err)
	check("users.UpdateEmail", users.UpdateEmail(ctx, "0199a8c4-3f6e-7b21-8c3d-0123456789ab", "b@example.com"))
	check("users.UpdatePasswordHash", users.UpdatePasswordHash(ctx, "0199a8c4-3f6e-7b21-8c3d-0123456789ab", "h"))
	check("sessions.Create", sessions.Create(ctx, auth.Session{TokenHash: []byte("h"), UserID: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", CreatedAt: now, ExpiresAt: now}))
	_, err = sessions.Lookup(ctx, []byte("h"), now)
	check("sessions.Lookup", err)
	check("sessions.Delete", sessions.Delete(ctx, []byte("h")))
	check("sessions.DeleteExpired", sessions.DeleteExpired(ctx, "0199a8c4-3f6e-7b21-8c3d-0123456789ab", now))
}
