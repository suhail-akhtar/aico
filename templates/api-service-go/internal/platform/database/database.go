// Package database owns the PostgreSQL connection pool and the migrations.
//
// Why pgx's native pool (pgxpool) with sqlc-generated queries: the queries are
// plain SQL checked against the schema at generation time, so a typo is a
// `make gen` failure rather than a 500 in production, and there is no ORM
// between the code and the database. database/sql is used for exactly one
// thing, running goose, which speaks it; the pool hands out a *sql.DB view of
// itself for that.
//
// Why migrations take a session advisory lock: with several replicas starting
// together, goose's PostgreSQL locker makes one run the migrations while the
// others wait, instead of racing on the same DDL.
//
// It does not retry connecting forever: a service that cannot reach its
// database at startup exits non-zero and lets the orchestrator back off, which
// is visible, whereas an in-process retry loop looks healthy while serving
// nothing.
package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"example.com/api-service/db"
)

// Options tunes the pool.
type Options struct {
	MaxConns int
}

// Open connects, verifies the connection, and returns the pool.
func Open(ctx context.Context, url string, opts Options) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		// pgx's message can include the URL; do not pass it on.
		return nil, errors.New("database: DATABASE_URL could not be parsed")
	}
	if opts.MaxConns > 0 {
		cfg.MaxConns = int32(opts.MaxConns) //nolint:gosec // bounded by config validation (1..500)
	}
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("database: create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("database: ping: %w", err)
	}
	return pool, nil
}

// Migrate applies every pending migration. lockID 0 uses goose's default
// advisory-lock key; tests pass distinct keys so parallel schemas do not queue.
func Migrate(ctx context.Context, pool *pgxpool.Pool, lockID int64) error {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }() // closes the database/sql view only; the pool stays open
	return migrate(ctx, sqlDB, lockID)
}

func migrate(ctx context.Context, sqlDB *sql.DB, lockID int64) error {
	var lockOpts []lock.SessionLockerOption
	if lockID != 0 {
		lockOpts = append(lockOpts, lock.WithLockID(lockID))
	}
	locker, err := lock.NewPostgresSessionLocker(lockOpts...)
	if err != nil {
		return fmt.Errorf("database: create migration lock: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, db.Migrations(), goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("database: create migration provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("database: migrate: %w", err)
	}
	return nil
}

// Pending reports how many migrations have not been applied yet.
func Pending(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer func() { _ = sqlDB.Close() }()
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, db.Migrations())
	if err != nil {
		return 0, fmt.Errorf("database: create migration provider: %w", err)
	}
	statuses, err := provider.Status(ctx)
	if err != nil {
		return 0, fmt.Errorf("database: migration status: %w", err)
	}
	n := 0
	for _, s := range statuses {
		if s.State == goose.StatePending {
			n++
		}
	}
	return n, nil
}

// Postgres error codes the adapters translate into domain errors.
const (
	codeUniqueViolation     = "23505"
	codeForeignKeyViolation = "23503"
)

// IsUniqueViolation reports whether err is a PostgreSQL unique-constraint failure.
func IsUniqueViolation(err error) bool { return hasCode(err, codeUniqueViolation) }

// IsForeignKeyViolation reports whether err is a PostgreSQL foreign-key failure.
func IsForeignKeyViolation(err error) bool { return hasCode(err, codeForeignKeyViolation) }

func hasCode(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}
