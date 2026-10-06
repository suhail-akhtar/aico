package auth

import (
	"context"
	"sync"
	"time"

	"example.com/api-service/internal/platform/identity"
)

// MemoryUserRepository is an in-memory UserRepository: a test double, not a
// runtime mode. It is held to the same contract suite as the PostgreSQL one.
type MemoryUserRepository struct {
	mu      sync.Mutex
	byEmail map[string]User
	byID    map[string]User
}

// NewMemoryUserRepository returns an empty repository.
func NewMemoryUserRepository() *MemoryUserRepository {
	return &MemoryUserRepository{byEmail: map[string]User{}, byID: map[string]User{}}
}

// Create stores u, or returns ErrEmailTaken.
func (r *MemoryUserRepository) Create(_ context.Context, u User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, taken := r.byEmail[u.Email]; taken {
		return ErrEmailTaken
	}
	r.byEmail[u.Email], r.byID[u.ID] = u, u
	return nil
}

// ByEmail returns the account with that email.
func (r *MemoryUserRepository) ByEmail(_ context.Context, email string) (User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.byEmail[email]
	if !ok {
		return User{}, errUserNotFound
	}
	return u, nil
}

// ByID returns the account with that id.
func (r *MemoryUserRepository) ByID(_ context.Context, id string) (User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.byID[id]
	if !ok {
		return User{}, errUserNotFound
	}
	return u, nil
}

// CreateIfAbsent stores u unless its id exists; a different owner of the email is ErrEmailTaken.
func (r *MemoryUserRepository) CreateIfAbsent(_ context.Context, u User) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.byID[u.ID]; exists {
		return false, nil
	}
	if _, taken := r.byEmail[u.Email]; taken {
		return false, ErrEmailTaken
	}
	r.byEmail[u.Email], r.byID[u.ID] = u, u
	return true, nil
}

// UpdateEmail replaces an account's email, or returns ErrEmailTaken.
func (r *MemoryUserRepository) UpdateEmail(_ context.Context, userID, email string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.byID[userID]
	if !ok {
		return errUserNotFound
	}
	if owner, taken := r.byEmail[email]; taken && owner.ID != userID {
		return ErrEmailTaken
	}
	delete(r.byEmail, u.Email)
	u.Email = email
	r.byID[userID], r.byEmail[email] = u, u
	return nil
}

// UpdatePasswordHash replaces a stored hash.
func (r *MemoryUserRepository) UpdatePasswordHash(_ context.Context, userID, hash string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.byID[userID]
	if !ok {
		return errUserNotFound
	}
	u.PasswordHash = hash
	r.byID[userID], r.byEmail[u.Email] = u, u
	return nil
}

func (r *MemoryUserRepository) principal(userID string) (identity.Principal, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	u, ok := r.byID[userID]
	return identity.Principal{UserID: u.ID, Email: u.Email}, ok
}

// MemorySessionRepository is an in-memory SessionRepository.
type MemorySessionRepository struct {
	users    *MemoryUserRepository
	mu       sync.Mutex
	sessions map[string]Session // keyed by string(tokenHash)
}

// NewMemorySessionRepository returns an empty repository resolving users from users.
func NewMemorySessionRepository(users *MemoryUserRepository) *MemorySessionRepository {
	return &MemorySessionRepository{users: users, sessions: map[string]Session{}}
}

// Create stores s.
func (r *MemorySessionRepository) Create(_ context.Context, s Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[string(s.TokenHash)] = s
	return nil
}

// Lookup returns the principal for a live session, or ErrInvalidToken.
func (r *MemorySessionRepository) Lookup(_ context.Context, tokenHash []byte, now time.Time) (identity.Principal, error) {
	r.mu.Lock()
	s, ok := r.sessions[string(tokenHash)]
	r.mu.Unlock()
	if !ok || !s.ExpiresAt.After(now) {
		return identity.Principal{}, ErrInvalidToken
	}
	p, ok := r.users.principal(s.UserID)
	if !ok {
		return identity.Principal{}, ErrInvalidToken
	}
	return p, nil
}

// Delete revokes a session.
func (r *MemorySessionRepository) Delete(_ context.Context, tokenHash []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.sessions, string(tokenHash))
	return nil
}

// DeleteExpired removes a user's expired sessions.
func (r *MemorySessionRepository) DeleteExpired(_ context.Context, userID string, now time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for k, s := range r.sessions {
		if s.UserID == userID && !s.ExpiresAt.After(now) {
			delete(r.sessions, k)
		}
	}
	return nil
}
