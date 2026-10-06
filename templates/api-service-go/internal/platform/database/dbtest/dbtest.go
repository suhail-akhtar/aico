// Package dbtest gives a test its own PostgreSQL schema.
//
// Why a schema per test and not a container per test (Testcontainers): the
// tests run inside a tools container with no Docker socket, and in CI beside a
// postgres service; both just provide TEST_DATABASE_URL. One shared server plus
// one throwaway schema per test is fast (milliseconds), isolated (no test sees
// another's rows) and parallel-safe.
//
// When TEST_DATABASE_URL is unset the test is skipped, so `go test ./...` works
// on a laptop with no database. Set REQUIRE_DB=1 (CI and `make cov` do) and a
// missing database fails the test instead, so the coverage gate can never be
// satisfied by silently skipping the adapters.
package dbtest

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"example.com/api-service/internal/platform/database"
)

// URL returns the test database URL, skipping (or failing under REQUIRE_DB=1)
// when none is configured.
func URL(tb testing.TB) string {
	tb.Helper()
	u := os.Getenv("TEST_DATABASE_URL")
	if u == "" {
		if os.Getenv("REQUIRE_DB") == "1" {
			tb.Fatal("REQUIRE_DB=1 but TEST_DATABASE_URL is not set")
		}
		tb.Skip("TEST_DATABASE_URL not set; skipping PostgreSQL integration test")
	}
	return u
}

// Schema creates an empty schema that is dropped when the test ends and returns
// a database URL whose search_path is that schema, plus the schema name.
func Schema(tb testing.TB) (dsn, schema string) {
	tb.Helper()
	base := URL(tb)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var raw [8]byte
	_, _ = rand.Read(raw[:])
	schema = "t_" + hex.EncodeToString(raw[:]) // hex only, so it is safe to splice into DDL

	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		tb.Fatalf("connect to test database: %v", err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = admin.Close(ctx)
		tb.Fatalf("create schema: %v", err)
	}
	tb.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer ccancel()
		_, _ = admin.Exec(cctx, "DROP SCHEMA "+schema+" CASCADE")
		_ = admin.Close(cctx)
	})

	u, err := url.Parse(base)
	if err != nil {
		tb.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String(), schema
}

// Pool returns a pool on a fresh, migrated schema that is dropped when the test ends.
func Pool(tb testing.TB) *pgxpool.Pool {
	tb.Helper()
	dsn, schema := Schema(tb)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := database.Open(ctx, dsn, database.Options{MaxConns: 4})
	if err != nil {
		tb.Fatalf("open pool: %v", err)
	}
	tb.Cleanup(pool.Close)
	// A distinct advisory-lock key per schema so parallel tests never queue on each other.
	h := binary.BigEndian.Uint32([]byte(schema[2:6]))
	if err := database.Migrate(ctx, pool, int64(h)+1); err != nil {
		tb.Fatalf("migrate: %v", err)
	}
	return pool
}
