package auth_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/validate"
)

type env struct {
	svc      *auth.Service
	users    *auth.MemoryUserRepository
	sessions *auth.MemorySessionRepository
	clock    *clock.Fake
	hasher   auth.Hasher
}

func newEnv(t *testing.T) *env {
	t.Helper()
	fake := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	users := auth.NewMemoryUserRepository()
	sessions := auth.NewMemorySessionRepository(users)
	hasher := auth.NewArgon2idHasher(cheapParams(), 0)
	svc, err := auth.NewService(context.Background(), auth.Deps{
		Users: users, Sessions: sessions, Hasher: hasher, Clock: fake,
		IDs: ids.NewGenerator(fake), TTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &env{svc: svc, users: users, sessions: sessions, clock: fake, hasher: hasher}
}

const goodPassword = "correct horse battery staple" // standards-allow: secret (fake test value)

func fields(t *testing.T, err error) map[string]string {
	t.Helper()
	var verrs validate.Errors
	if !errors.As(err, &verrs) {
		t.Fatalf("want validation errors, got %v", err)
	}
	m := map[string]string{}
	for _, f := range verrs {
		m[f.Field] = f.Message
	}
	return m
}

func TestRegister(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	u, err := e.svc.Register(context.Background(), "  Ada@Example.COM ", goodPassword)
	if err != nil {
		t.Fatal(err)
	}
	if u.Email != "ada@example.com" || !ids.Valid(u.ID) || !u.CreatedAt.Equal(e.clock.Now()) {
		t.Fatalf("unexpected user: %+v", u)
	}
	if u.PasswordHash == goodPassword || !strings.HasPrefix(u.PasswordHash, "$argon2id$") {
		t.Fatalf("password not hashed: %q", u.PasswordHash)
	}
	if _, err := e.svc.Register(context.Background(), "ADA@example.com", goodPassword); !errors.Is(err, auth.ErrEmailTaken) {
		t.Fatalf("duplicate (case-insensitive) email: %v", err)
	}
}

func TestRegisterValidation(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("a", 250) + "@example.com"
	tests := []struct {
		name, email, password, field string
	}{
		{"empty email", "", goodPassword, "email"},
		{"no at sign", "ada.example.com", goodPassword, "email"},
		{"no domain dot", "ada@localhost", goodPassword, "email"},
		{"display name", "Ada <ada@example.com>", goodPassword, "email"},
		{"spaces", "a da@example.com", goodPassword, "email"},
		{"too long", long, goodPassword, "email"},
		{"short password", "ada@example.com", "short", "password"},
		{"11 characters", "ada@example.com", strings.Repeat("x", 11), "password"},
		{"oversized password", "ada@example.com", strings.Repeat("x", auth.MaxPasswordLen+1), "password"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := newEnv(t).svc.Register(context.Background(), tt.email, tt.password)
			if _, ok := fields(t, err)[tt.field]; !ok {
				t.Fatalf("no error for %s: %v", tt.field, err)
			}
		})
	}
	// Exactly twelve characters is allowed, counted as characters.
	if _, err := newEnv(t).svc.Register(context.Background(), "ada@example.com", strings.Repeat("é", 12)); err != nil {
		t.Fatalf("12 characters must be accepted: %v", err)
	}
}

func TestLoginAndAuthenticate(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	u, _ := e.svc.Register(ctx, "ada@example.com", goodPassword)

	tok, err := e.svc.Login(ctx, "ADA@example.com", goodPassword)
	if err != nil {
		t.Fatal(err)
	}
	if len(tok.Value) != 43 || !tok.ExpiresAt.Equal(e.clock.Now().Add(time.Hour)) {
		t.Fatalf("unexpected token: %+v", tok)
	}
	p, err := e.svc.Authenticate(ctx, tok.Value)
	if err != nil || p.UserID != u.ID || p.Email != "ada@example.com" {
		t.Fatalf("Authenticate = %+v, %v", p, err)
	}

	tok2, _ := e.svc.Login(ctx, "ada@example.com", goodPassword)
	if tok2.Value == tok.Value {
		t.Fatal("every login must mint a distinct token")
	}
}

func TestLoginFailuresAreIndistinguishable(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	_, _ = e.svc.Register(ctx, "ada@example.com", goodPassword)

	_, wrongPassword := e.svc.Login(ctx, "ada@example.com", "not the right password")
	_, unknownUser := e.svc.Login(ctx, "nobody@example.com", goodPassword)
	if !errors.Is(wrongPassword, auth.ErrInvalidCredentials) || !errors.Is(unknownUser, auth.ErrInvalidCredentials) {
		t.Fatalf("wrong password: %v, unknown user: %v", wrongPassword, unknownUser)
	}
	if wrongPassword.Error() != unknownUser.Error() {
		t.Fatal("the two failures must read identically")
	}
}

func TestLoginValidatesInput(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	for _, tt := range []struct{ email, password, field string }{
		{"", goodPassword, "email"},
		{"ada@example.com", "", "password"},
		{"ada@example.com", strings.Repeat("x", auth.MaxPasswordLen+1), "password"},
		{strings.Repeat("a", auth.MaxEmailLen+1), goodPassword, "email"},
	} {
		_, err := e.svc.Login(context.Background(), tt.email, tt.password)
		if _, ok := fields(t, err)[tt.field]; !ok {
			t.Errorf("Login(%q, ...): want an error for %s, got %v", tt.email, tt.field, err)
		}
	}
}

func TestSessionsExpire(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	_, _ = e.svc.Register(ctx, "ada@example.com", goodPassword)
	tok, _ := e.svc.Login(ctx, "ada@example.com", goodPassword)

	e.clock.Advance(time.Hour - time.Second)
	if _, err := e.svc.Authenticate(ctx, tok.Value); err != nil {
		t.Fatalf("a live session was refused: %v", err)
	}
	e.clock.Advance(time.Second) // exactly at expiry
	if _, err := e.svc.Authenticate(ctx, tok.Value); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("an expired session was accepted: %v", err)
	}
}

func TestLogoutRevokes(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	_, _ = e.svc.Register(ctx, "ada@example.com", goodPassword)
	tok, _ := e.svc.Login(ctx, "ada@example.com", goodPassword)
	other, _ := e.svc.Login(ctx, "ada@example.com", goodPassword)

	if err := e.svc.Logout(ctx, tok.Value); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Authenticate(ctx, tok.Value); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("a revoked token still works: %v", err)
	}
	if _, err := e.svc.Authenticate(ctx, other.Value); err != nil {
		t.Fatalf("logging out one session must not end another: %v", err)
	}
	if err := e.svc.Logout(ctx, "never issued"); err != nil {
		t.Fatalf("revoking an unknown token must be harmless: %v", err)
	}
}

func TestAuthenticateRejectsJunk(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	for _, tok := range []string{"", "x", strings.Repeat("a", 500), "null", "' OR 1=1 --"} {
		if _, err := e.svc.Authenticate(context.Background(), tok); !errors.Is(err, auth.ErrInvalidToken) {
			t.Errorf("Authenticate(%q) = %v", tok, err)
		}
	}
}

func TestOnlyTheTokenHashIsStored(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	_, _ = e.svc.Register(ctx, "ada@example.com", goodPassword)
	tok, _ := e.svc.Login(ctx, "ada@example.com", goodPassword)

	p, err := e.sessions.Lookup(ctx, auth.HashToken(tok.Value), e.clock.Now())
	if err != nil || p.Email != "ada@example.com" {
		t.Fatalf("lookup by hash: %+v, %v", p, err)
	}
	if _, err := e.sessions.Lookup(ctx, []byte(tok.Value), e.clock.Now()); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatal("the raw token must not be a valid lookup key")
	}
}

func TestLoginUpgradesWeakHashes(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()

	weak := auth.NewArgon2idHasher(auth.Argon2Params{Memory: 8, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}, 0)
	oldHash, _ := weak.Hash(ctx, goodPassword)
	_ = e.users.Create(ctx, auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", Email: "old@example.com", PasswordHash: oldHash, CreatedAt: e.clock.Now()})

	// Rebuild the service with a stronger current hasher.
	stronger := auth.NewArgon2idHasher(auth.Argon2Params{Memory: 16, Iterations: 2, Parallelism: 1, SaltLen: 16, KeyLen: 32}, 0)
	svc, err := auth.NewService(ctx, auth.Deps{Users: e.users, Sessions: e.sessions, Hasher: stronger, Clock: e.clock, IDs: ids.NewGenerator(e.clock), TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Login(ctx, "old@example.com", goodPassword); err != nil {
		t.Fatal(err)
	}
	u, _ := e.users.ByEmail(ctx, "old@example.com")
	if u.PasswordHash == oldHash || !strings.Contains(u.PasswordHash, "m=16,t=2,p=1") {
		t.Fatalf("hash was not upgraded: %q", u.PasswordHash)
	}
	if _, err := svc.Login(ctx, "old@example.com", goodPassword); err != nil {
		t.Fatalf("login with the upgraded hash: %v", err)
	}
}

type brokenHasher struct{}

var errHash = errors.New("hash failure")

func (brokenHasher) Hash(context.Context, string) (string, error) { return "", errHash }
func (brokenHasher) Verify(context.Context, string, string) (bool, bool, error) {
	return false, false, errHash
}

func TestHasherFailuresSurface(t *testing.T) {
	t.Parallel()
	fake := clock.NewFake(time.Now())
	users := auth.NewMemoryUserRepository()
	if _, err := auth.NewService(context.Background(), auth.Deps{Users: users, Sessions: auth.NewMemorySessionRepository(users), Hasher: brokenHasher{}, Clock: fake, IDs: ids.NewGenerator(fake)}); !errors.Is(err, errHash) {
		t.Fatalf("NewService must fail when the hasher does: %v", err)
	}

	e := newEnv(t)
	svc, _ := auth.NewService(context.Background(), auth.Deps{Users: e.users, Sessions: e.sessions, Hasher: e.hasher, Clock: fake, IDs: ids.NewGenerator(fake), TTL: time.Hour})
	svc.Hasher = brokenHasher{}
	if _, err := svc.Register(context.Background(), "ada@example.com", goodPassword); !errors.Is(err, errHash) {
		t.Fatalf("Register: %v", err)
	}
	_ = e.users.Create(context.Background(), auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", Email: "ada@example.com", PasswordHash: "x", CreatedAt: fake.Now()})
	if _, err := svc.Login(context.Background(), "ada@example.com", goodPassword); !errors.Is(err, errHash) {
		t.Fatalf("Login: %v", err)
	}
}

func TestNormaliseEmail(t *testing.T) {
	t.Parallel()
	if got := auth.NormaliseEmail("  MiXed@Example.COM\n"); got != "mixed@example.com" {
		t.Fatalf("got %q", got)
	}
}
