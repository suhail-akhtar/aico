package database_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"example.com/api-service/internal/platform/database"
	"example.com/api-service/internal/platform/database/dbtest"
)

func TestOpenRejectsUnparseableURLWithoutEchoingIt(t *testing.T) {
	t.Parallel()
	_, err := database.Open(context.Background(), "postgres://user:hunter2@host:notaport/db", database.Options{})
	if err == nil {
		t.Fatal("want an error")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("the error leaked the password: %v", err)
	}
}

func TestOpenFailsFastWhenUnreachable(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := database.Open(ctx, "postgres://u:p@127.0.0.1:1/db?connect_timeout=1&sslmode=disable", database.Options{})
	if err == nil {
		t.Fatal("want an error for an unreachable database")
	}
}

func TestMigrateIsIdempotentAndCreatesTheSchema(t *testing.T) {
	t.Parallel()
	pool := dbtest.Pool(t) // already migrated once
	ctx := context.Background()

	if n, err := database.Pending(ctx, pool); err != nil || n != 0 {
		t.Fatalf("pending = %d, %v; want 0", n, err)
	}
	if err := database.Migrate(ctx, pool, 0); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	for _, table := range []string{"users", "sessions", "items"} {
		var exists bool
		err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists)
		if err != nil || !exists {
			t.Errorf("table %s missing (%v)", table, err)
		}
	}
}

func TestConstraintsAreEnforcedByTheDatabase(t *testing.T) {
	t.Parallel()
	pool := dbtest.Pool(t)
	ctx := context.Background()
	const uid = "0199a8c4-3f6e-7b21-8c3d-0123456789ab"
	insertUser := "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, 'h', now())"

	if _, err := pool.Exec(ctx, insertUser, uid, "a@example.com"); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, insertUser, "0199a8c4-3f6e-7b21-8c3d-0123456789ac", "a@example.com")
	if !database.IsUniqueViolation(err) || database.IsForeignKeyViolation(err) {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, err := pool.Exec(ctx, insertUser, "0199a8c4-3f6e-7b21-8c3d-0123456789ad", "Upper@Example.com"); err == nil {
		t.Fatal("a non-lowercase email must violate the CHECK constraint")
	}
	_, err = pool.Exec(ctx, "INSERT INTO items (id, owner_id, name, created_at, updated_at) VALUES ($1, $2, 'x', now(), now())",
		"0199a8c4-3f6e-7b21-8c3d-0123456789ae", "0199a8c4-3f6e-7b21-8c3d-ffffffffffff")
	if !database.IsForeignKeyViolation(err) {
		t.Fatalf("orphan item: %v", err)
	}
	if database.IsUniqueViolation(errors.New("plain")) {
		t.Fatal("a plain error is not a unique violation")
	}
}
