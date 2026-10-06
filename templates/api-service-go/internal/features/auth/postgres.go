package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"example.com/api-service/internal/platform/database"
	"example.com/api-service/internal/platform/database/dbgen"
	"example.com/api-service/internal/platform/identity"
)

// PostgresUserRepository implements UserRepository.
type PostgresUserRepository struct {
	q *dbgen.Queries
}

// NewPostgresUserRepository returns a repository over a pool or transaction.
func NewPostgresUserRepository(db dbgen.DBTX) *PostgresUserRepository {
	return &PostgresUserRepository{q: dbgen.New(db)}
}

// Create inserts u, mapping the unique-email violation to ErrEmailTaken.
func (r *PostgresUserRepository) Create(ctx context.Context, u User) error {
	_, err := r.q.CreateUser(ctx, dbgen.CreateUserParams{ID: u.ID, Email: u.Email, PasswordHash: u.PasswordHash, CreatedAt: u.CreatedAt})
	if database.IsUniqueViolation(err) {
		return ErrEmailTaken
	}
	if err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	return nil
}

// ByEmail returns the account with that (normalised) email.
func (r *PostgresUserRepository) ByEmail(ctx context.Context, email string) (User, error) {
	row, err := r.q.GetUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, errUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("select user: %w", err)
	}
	return User{ID: row.ID, Email: row.Email, PasswordHash: row.PasswordHash, CreatedAt: row.CreatedAt.UTC()}, nil
}

// ByID returns the account with that id.
func (r *PostgresUserRepository) ByID(ctx context.Context, id string) (User, error) {
	row, err := r.q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, errUserNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("select user by id: %w", err)
	}
	return User{ID: row.ID, Email: row.Email, PasswordHash: row.PasswordHash, CreatedAt: row.CreatedAt.UTC()}, nil
}

// CreateIfAbsent inserts u unless its id exists (ON CONFLICT (id) DO NOTHING, so
// concurrent first requests for one subject cannot fail each other). A different
// row owning the email is the unique violation on users_email_key.
func (r *PostgresUserRepository) CreateIfAbsent(ctx context.Context, u User) (bool, error) {
	n, err := r.q.CreateUserIfAbsent(ctx, dbgen.CreateUserIfAbsentParams{ID: u.ID, Email: u.Email, PasswordHash: u.PasswordHash, CreatedAt: u.CreatedAt})
	if database.IsUniqueViolation(err) {
		return false, ErrEmailTaken
	}
	if err != nil {
		return false, fmt.Errorf("insert user if absent: %w", err)
	}
	return n == 1, nil
}

// UpdateEmail replaces an account's email, mapping the unique violation to ErrEmailTaken.
func (r *PostgresUserRepository) UpdateEmail(ctx context.Context, userID, email string) error {
	err := r.q.UpdateUserEmail(ctx, dbgen.UpdateUserEmailParams{ID: userID, Email: email})
	if database.IsUniqueViolation(err) {
		return ErrEmailTaken
	}
	if err != nil {
		return fmt.Errorf("update email: %w", err)
	}
	return nil
}

// UpdatePasswordHash replaces a stored hash.
func (r *PostgresUserRepository) UpdatePasswordHash(ctx context.Context, userID, hash string) error {
	if err := r.q.UpdatePasswordHash(ctx, dbgen.UpdatePasswordHashParams{ID: userID, PasswordHash: hash}); err != nil {
		return fmt.Errorf("update password hash: %w", err)
	}
	return nil
}

// PostgresSessionRepository implements SessionRepository.
type PostgresSessionRepository struct {
	q *dbgen.Queries
}

// NewPostgresSessionRepository returns a repository over a pool or transaction.
func NewPostgresSessionRepository(db dbgen.DBTX) *PostgresSessionRepository {
	return &PostgresSessionRepository{q: dbgen.New(db)}
}

// Create stores a session.
func (r *PostgresSessionRepository) Create(ctx context.Context, s Session) error {
	err := r.q.CreateSession(ctx, dbgen.CreateSessionParams{
		TokenHash: s.TokenHash, UserID: s.UserID, CreatedAt: s.CreatedAt, ExpiresAt: s.ExpiresAt,
	})
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	return nil
}

// Lookup returns the principal for a live session, or ErrInvalidToken.
func (r *PostgresSessionRepository) Lookup(ctx context.Context, tokenHash []byte, now time.Time) (identity.Principal, error) {
	row, err := r.q.GetSessionUser(ctx, dbgen.GetSessionUserParams{TokenHash: tokenHash, ExpiresAt: now})
	if errors.Is(err, pgx.ErrNoRows) {
		return identity.Principal{}, ErrInvalidToken
	}
	if err != nil {
		return identity.Principal{}, fmt.Errorf("select session: %w", err)
	}
	return identity.Principal{UserID: row.ID, Email: row.Email}, nil
}

// Delete revokes a session.
func (r *PostgresSessionRepository) Delete(ctx context.Context, tokenHash []byte) error {
	if err := r.q.DeleteSession(ctx, tokenHash); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteExpired removes a user's expired sessions.
func (r *PostgresSessionRepository) DeleteExpired(ctx context.Context, userID string, now time.Time) error {
	if err := r.q.DeleteExpiredSessions(ctx, dbgen.DeleteExpiredSessionsParams{UserID: userID, ExpiresAt: now}); err != nil {
		return fmt.Errorf("purge sessions: %w", err)
	}
	return nil
}
