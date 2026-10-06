// Package auth is local accounts and opaque bearer sessions.
//
// Decisions that shape it (full reasoning in .aico/decisions.md):
//   - Passwords are hashed with Argon2id at explicit parameters at or above the
//     OWASP minimum, and rehashed on login when the configured cost has moved.
//   - Sessions are random 256-bit tokens. The database stores only their SHA-256,
//     so a leaked table cannot be replayed, and a session can be revoked by
//     deleting a row, which a self-contained JWT cannot do.
//   - Login does the same work whether or not the account exists (a dummy hash
//     is verified for an unknown email) and always answers the same error, so
//     response time and body do not reveal which emails are registered.
//   - Registration does reveal an existing email (409). That is the usual
//     trade-off for a self-service API; the registration route is rate limited,
//     and an email-verification flow is the growth step that removes it.
//
// Second mode, AUTH_MODE=oidc (resource-server mode): the service stops issuing
// credentials and verifies access tokens from an external identity provider
// (jwks.go), then maps the token subject to a local users row, creating it on
// first sight (provision.go). The Principal handed to the feature handlers is
// the same in both modes, so items and every future feature are unaware of it.
//
// What it deliberately does not do: act as an identity provider in oidc mode,
// per-account lockout, password reset, MFA. Each is listed in
// docs/ARCHITECTURE.md as a growth step; from a medium-sized deployment on,
// prefer delegating login to an IdP and verifying its tokens (oidc mode).
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/identity"
	"example.com/api-service/internal/platform/validate"
)

// Credential limits, mirrored in api/openapi.yaml.
const (
	MinPasswordLen = 12
	MaxPasswordLen = 128
	MaxEmailLen    = 254
	maxTokenLen    = 128
)

// Errors the HTTP edge maps to responses.
var (
	ErrInvalidCredentials = apperr.New(apperr.KindUnauthenticated, "invalid email or password")
	ErrInvalidToken       = apperr.New(apperr.KindUnauthenticated, "invalid or expired token")
	ErrEmailTaken         = apperr.New(apperr.KindConflict, "an account with this email already exists")

	// ErrIdentityConflict: the token is valid but its email belongs to a different
	// account. Accounts are never merged automatically (that would let whoever
	// controls an email claim take over the existing user), so the caller gets a
	// 409 an operator can act on.
	ErrIdentityConflict = apperr.NewCoded(apperr.KindConflict, "identity-conflict", "the email of this identity belongs to a different account")

	// ErrLocalAuthDisabled answers the credential endpoints in oidc mode.
	ErrLocalAuthDisabled = apperr.New(apperr.KindNotFound, "Local authentication is disabled: AUTH_MODE=oidc")

	// errUserNotFound is internal: Login converts it to ErrInvalidCredentials.
	errUserNotFound = errors.New("user not found")
)

// User is an account.
type User struct {
	ID           string
	Email        string
	PasswordHash string
	CreatedAt    time.Time
}

// Session is a stored login. TokenHash is the SHA-256 of the bearer token.
type Session struct {
	TokenHash []byte
	UserID    string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Token is what login returns. Value is shown to the client once and never stored.
type Token struct {
	Value     string
	ExpiresAt time.Time
}

// UserRepository is the account storage port.
type UserRepository interface {
	// Create stores u, or returns ErrEmailTaken.
	Create(ctx context.Context, u User) error
	// ByEmail returns the account, or an error for which IsUserNotFound is true.
	ByEmail(ctx context.Context, email string) (User, error)
	// ByID returns the account, or an error for which IsUserNotFound is true.
	ByID(ctx context.Context, id string) (User, error)
	UpdatePasswordHash(ctx context.Context, userID, hash string) error
	// CreateIfAbsent stores u unless a row with u.ID exists (created is then
	// false and nothing changes). It returns ErrEmailTaken when a different row
	// owns u.Email. Safe under concurrency: of N simultaneous calls for one id,
	// exactly one reports created.
	CreateIfAbsent(ctx context.Context, u User) (created bool, err error)
	// UpdateEmail changes an account's email, or returns ErrEmailTaken.
	UpdateEmail(ctx context.Context, userID, email string) error
}

// SessionRepository is the session storage port.
type SessionRepository interface {
	Create(ctx context.Context, s Session) error
	// Lookup returns the principal for a live session, or ErrInvalidToken.
	Lookup(ctx context.Context, tokenHash []byte, now time.Time) (identity.Principal, error)
	Delete(ctx context.Context, tokenHash []byte) error
	DeleteExpired(ctx context.Context, userID string, now time.Time) error
}

// IsUserNotFound reports whether err means "no such account".
func IsUserNotFound(err error) bool { return errors.Is(err, errUserNotFound) }

// IDGenerator creates ids.
type IDGenerator interface{ New() string }

// Deps are the Service's collaborators.
type Deps struct {
	Users    UserRepository
	Sessions SessionRepository
	Hasher   Hasher
	Clock    clock.Clock
	IDs      IDGenerator
	TTL      time.Duration
	Logger   *slog.Logger
	// Verifier switches the service to oidc mode: bearer tokens are then
	// identity-provider JWTs, no local credentials are issued, and Sessions and
	// Hasher are used only by the (disabled) local endpoints. Nil means local mode.
	Verifier TokenVerifier
}

// Service holds the authentication rules.
type Service struct {
	Deps
	dummyHash string
}

// NewService builds a Service. It hashes a throwaway password once so that
// logins for unknown emails can burn the same CPU as real ones.
func NewService(ctx context.Context, d Deps) (*Service, error) {
	if d.Logger == nil {
		d.Logger = slog.New(slog.DiscardHandler)
	}
	dummy, err := d.Hasher.Hash(ctx, "dummy-password-for-timing-equalisation")
	if err != nil {
		return nil, fmt.Errorf("auth: prepare timing hash: %w", err)
	}
	return &Service{Deps: d, dummyHash: dummy}, nil
}

// NormaliseEmail lower-cases and trims an address; accounts are keyed by it.
func NormaliseEmail(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// Register creates an account.
func (s *Service) Register(ctx context.Context, email, password string) (User, error) {
	email = NormaliseEmail(email)
	var verrs validate.Errors
	if !validEmail(email) {
		verrs.Add("email", "must be a valid email address")
	}
	switch n := utf8.RuneCountInString(password); {
	case n < MinPasswordLen:
		verrs.Add("password", fmt.Sprintf("must be at least %d characters", MinPasswordLen))
	case len(password) > MaxPasswordLen:
		verrs.Add("password", fmt.Sprintf("must be at most %d bytes", MaxPasswordLen))
	}
	if err := verrs.Err(); err != nil {
		return User{}, err
	}

	hash, err := s.Hasher.Hash(ctx, password)
	if err != nil {
		return User{}, fmt.Errorf("hash password: %w", err)
	}
	u := User{ID: s.IDs.New(), Email: email, PasswordHash: hash, CreatedAt: s.Clock.Now()}
	if err := s.Users.Create(ctx, u); err != nil {
		return User{}, err
	}
	return u, nil
}

// Login verifies credentials and issues a session token.
func (s *Service) Login(ctx context.Context, email, password string) (Token, error) {
	email = NormaliseEmail(email)
	if email == "" || len(email) > MaxEmailLen || password == "" || len(password) > MaxPasswordLen {
		var verrs validate.Errors
		if email == "" || len(email) > MaxEmailLen {
			verrs.Add("email", "is required")
		}
		if password == "" || len(password) > MaxPasswordLen {
			verrs.Add("password", "is required")
		}
		return Token{}, verrs.Err()
	}

	u, err := s.Users.ByEmail(ctx, email)
	if IsUserNotFound(err) {
		_, _, _ = s.Hasher.Verify(ctx, password, s.dummyHash) // equalise timing; the result is irrelevant
		return Token{}, ErrInvalidCredentials
	}
	if err != nil {
		return Token{}, fmt.Errorf("look up user: %w", err)
	}
	if u.PasswordHash == UnusablePasswordHash {
		// A provisioned identity-provider account has no local password. It must
		// look exactly like a wrong password, never like a malformed stored hash (500).
		_, _, _ = s.Hasher.Verify(ctx, password, s.dummyHash)
		return Token{}, ErrInvalidCredentials
	}
	ok, needsRehash, err := s.Hasher.Verify(ctx, password, u.PasswordHash)
	if err != nil {
		return Token{}, fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		return Token{}, ErrInvalidCredentials
	}
	if needsRehash {
		s.rehash(ctx, u.ID, password)
	}

	value, hash, err := newToken()
	if err != nil {
		return Token{}, err
	}
	now := s.Clock.Now()
	sess := Session{TokenHash: hash, UserID: u.ID, CreatedAt: now, ExpiresAt: now.Add(s.TTL)}
	if err := s.Sessions.Create(ctx, sess); err != nil {
		return Token{}, fmt.Errorf("create session: %w", err)
	}
	// Housekeeping: drop this user's expired sessions. Failure is harmless (they
	// are ignored on lookup anyway) so it is logged, not returned.
	if err := s.Sessions.DeleteExpired(ctx, u.ID, now); err != nil {
		s.Logger.WarnContext(ctx, "could not purge expired sessions", slog.String("error", err.Error()))
	}
	return Token{Value: value, ExpiresAt: sess.ExpiresAt}, nil
}

// rehash upgrades a stored hash to the current parameters after a successful
// login, the only moment the plaintext is available. Best effort: the login
// itself already succeeded.
func (s *Service) rehash(ctx context.Context, userID, password string) {
	hash, err := s.Hasher.Hash(ctx, password)
	if err == nil {
		err = s.Users.UpdatePasswordHash(ctx, userID, hash)
	}
	if err != nil {
		s.Logger.WarnContext(ctx, "could not upgrade password hash", slog.String("error", err.Error()))
	}
}

// Logout revokes the presented token. Revoking an unknown token is not an error.
func (s *Service) Logout(ctx context.Context, token string) error {
	return s.Sessions.Delete(ctx, HashToken(token))
}

// LocalAuthEnabled reports whether this service issues and verifies its own
// credentials (local mode). In oidc mode register, login and logout are off.
func (s *Service) LocalAuthEnabled() bool { return s.Verifier == nil }

// Authenticate resolves a bearer token to its principal, or ErrInvalidToken. In
// oidc mode the token is an identity-provider JWT (see authenticateOIDC).
func (s *Service) Authenticate(ctx context.Context, token string) (identity.Principal, error) {
	if s.Verifier != nil {
		return s.authenticateOIDC(ctx, token)
	}
	if token == "" || len(token) > maxTokenLen {
		return identity.Principal{}, ErrInvalidToken
	}
	return s.Sessions.Lookup(ctx, HashToken(token), s.Clock.Now())
}

// newToken returns a random token and its storage hash.
func newToken() (value string, hash []byte, err error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", nil, fmt.Errorf("generate token: %w", err)
	}
	value = base64.RawURLEncoding.EncodeToString(raw[:])
	return value, HashToken(value), nil
}

// HashToken is the SHA-256 stored in place of a token. A fast hash is correct
// here: the input is 256 random bits, so there is nothing to brute-force.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func validEmail(e string) bool {
	if len(e) > MaxEmailLen || len(e) < 3 {
		return false
	}
	addr, err := mail.ParseAddress(e)
	if err != nil || addr.Address != e {
		return false // rejects display names, comments and surrounding junk
	}
	at := strings.LastIndexByte(e, '@')
	return at > 0 && strings.Contains(e[at+1:], ".")
}
