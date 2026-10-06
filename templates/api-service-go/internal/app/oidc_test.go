package app_test

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/api-service/internal/app"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/database/dbtest"
	"example.com/api-service/internal/platform/oidctest"
)

// These tests run the assembled application in AUTH_MODE=oidc against an
// in-process identity provider (oidctest): real JWKS fetching, real middleware,
// real generated routes. No network and no Keycloak.

const (
	subAda   = "7b0f5e1c-3a52-4d4e-9d0e-1f6a2b3c4d5e"
	subGrace = "0f2d8c64-91aa-4b7e-8c35-5d2e7a1b9f40"
	subLin   = "3c9a1e55-2b47-4f8d-a6c1-9e0d7b5f2a13"
)

func oidcEnv(p *oidctest.Provider) map[string]string {
	return map[string]string{
		"AUTH_MODE": "oidc", "OIDC_ISSUER": oidctest.Issuer,
		"OIDC_JWKS_URI": p.JWKSURL(), "OIDC_AUDIENCE": oidctest.Audience,
	}
}

type oidcApp struct {
	*testApp
	p *oidctest.Provider
}

func newOIDCApp(t *testing.T) *oidcApp {
	t.Helper()
	p := oidctest.NewProvider(t)
	return &oidcApp{testApp: newTestApp(t, oidcEnv(p)), p: p}
}

func (a *oidcApp) token(sub, email string) string {
	return a.p.Sign(a.p.Claims(a.clock.Now(), sub, email))
}

func TestOIDCModeServesTheSameAPIForIdentityProviderTokens(t *testing.T) {
	t.Parallel()
	a := newOIDCApp(t)
	ada, grace := a.token(subAda, "Ada@Example.com"), a.token(subGrace, "grace@example.com")

	me := a.get("/v1/auth/me", ada)
	var who struct{ ID, Email string }
	me.json(t, &who)
	if me.Code != 200 || who.ID != subAda || who.Email != "ada@example.com" {
		t.Fatalf("me: %d %s", me.Code, me.Body)
	}

	item := a.createItem(ada, "from the idp")
	if r := a.get("/v1/items/"+item.ID, ada); r.Code != 200 {
		t.Fatalf("owner read: %d %s", r.Code, r.Body)
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if r := a.do(request{method: method, path: "/v1/items/" + item.ID, token: grace, body: map[string]any{"name": "x"}}); r.Code != 404 {
			t.Errorf("%s another subject's item: %d, want 404", method, r.Code)
		}
	}
	if r := a.get("/v1/items", grace); !strings.Contains(string(r.Body), `"items":[]`) {
		t.Fatalf("grace sees ada's items: %s", r.Body)
	}
	if r := a.do(request{method: "PUT", path: "/v1/items/" + item.ID, token: ada, body: map[string]any{"name": "renamed", "quantity": 4}}); r.Code != 200 {
		t.Fatalf("update: %d %s", r.Code, r.Body)
	}
	if r := a.do(request{method: "DELETE", path: "/v1/items/" + item.ID, token: ada}); r.Code != 204 {
		t.Fatalf("delete: %d %s", r.Code, r.Body)
	}
}

func TestOIDCModeRefusesBadTokensWithTheNormal401(t *testing.T) {
	t.Parallel()
	a := newOIDCApp(t)
	now := a.clock.Now()
	claims := func(f func(map[string]any)) string {
		c := a.p.Claims(now, subAda, "ada@example.com")
		f(c)
		return a.p.Sign(c)
	}
	valid := a.token(subAda, "ada@example.com")
	tests := map[string]string{
		"expired":               claims(func(c map[string]any) { c["exp"] = now.Add(-time.Hour).Unix() }),
		"not yet valid":         claims(func(c map[string]any) { c["nbf"] = now.Add(time.Hour).Unix() }),
		"wrong issuer":          claims(func(c map[string]any) { c["iss"] = "https://evil.example.test" }),
		"wrong audience":        claims(func(c map[string]any) { c["aud"] = "account" }),
		"subject not a UUID":    claims(func(c map[string]any) { c["sub"] = "admin" }),
		"subject missing":       claims(func(c map[string]any) { delete(c, "sub") }),
		"alg none":              a.p.SignNone(a.p.Claims(now, subAda, "")),
		"HS256 with public key": a.p.SignHS256WithPublicKey(a.p.Claims(now, subAda, "")),
		"forged signature":      a.p.SignForged(a.p.Claims(now, subAda, "")),
		"unknown key id":        a.p.SignWithKID("nope", a.p.Claims(now, subAda, "")),
		"tampered payload":      oidctest.Tamper(t, valid, subGrace),
		"garbage":               "not-a-jwt",
		"an opaque local token": "dGhpcy1pcy1ub3QtYS1qd3QtYnV0LWxvb2tzLWxpa2UtYS1sb2NhbC1zZXNzaW9u",
		"oversized":             strings.Repeat("a", 20000),
	}
	for name, token := range tests {
		r := a.get("/v1/auth/me", token)
		p := r.problem(t)
		if r.Code != 401 || p.Type != "urn:problem:unauthenticated" || !strings.HasPrefix(r.Header.Get("WWW-Authenticate"), "Bearer") {
			t.Errorf("%s: %d %+v", name, r.Code, p)
		}
		body := string(r.Body)
		if strings.Contains(body, token[:min(len(token), 40)]) || strings.Contains(strings.ToLower(body), "signature") || strings.Contains(body, "goroutine") {
			t.Errorf("%s: the response explains or echoes too much: %s", name, body)
		}
	}
	if r := a.do(request{method: "GET", path: "/v1/auth/me"}); r.Code != 401 {
		t.Errorf("no token: %d", r.Code)
	}
	// None of that created an account.
	if _, err := a.users.ByID(t.Context(), subAda); !auth.IsUserNotFound(err) {
		t.Fatalf("a refused token provisioned an account: %v", err)
	}
	if strings.Contains(a.logs.String(), valid) {
		t.Fatal("a token reached the logs")
	}
}

func TestOIDCModeDisablesTheLocalCredentialEndpoints(t *testing.T) {
	t.Parallel()
	a := newOIDCApp(t)
	tok := a.token(subAda, "ada@example.com")
	creds := map[string]string{"email": "ada@example.com", "password": testPassword}
	for _, tt := range []struct {
		name string
		req  request
	}{
		{"register", request{method: "POST", path: "/v1/auth/register", body: creds}},
		{"register with a malformed body", request{method: "POST", path: "/v1/auth/register", body: `{"email":`}},
		{"login", request{method: "POST", path: "/v1/auth/login", body: creds}},
		{"logout with a valid token", request{method: "POST", path: "/v1/auth/logout", token: tok}},
		{"logout without a token", request{method: "POST", path: "/v1/auth/logout"}},
		{"logout with a bad token", request{method: "POST", path: "/v1/auth/logout", token: "junk"}},
	} {
		r := a.do(tt.req)
		p := r.problem(t)
		if r.Code != 404 || p.Type != "urn:problem:not-found" || p.Detail != "Local authentication is disabled: AUTH_MODE=oidc" {
			t.Errorf("%s: %d %+v", tt.name, r.Code, p)
		}
	}
	if _, err := a.users.ByEmail(t.Context(), "ada@example.com"); !auth.IsUserNotFound(err) {
		t.Fatalf("register must not have created an account: %v", err)
	}
	// The probes and the spec stay open, and /auth/me still works.
	for _, path := range []string{"/healthz", "/readyz", "/openapi.yaml"} {
		if r := a.get(path, ""); r.Code != 200 {
			t.Errorf("GET %s: %d", path, r.Code)
		}
	}
	if r := a.get("/v1/auth/me", tok); r.Code != 200 {
		t.Errorf("/v1/auth/me: %d", r.Code)
	}
}

func TestOIDCEmailCollisionIsA409IdentityConflict(t *testing.T) {
	t.Parallel()
	a := newOIDCApp(t)
	local := auth.User{ID: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", Email: "ada@example.com", PasswordHash: "!", CreatedAt: a.clock.Now()}
	if err := a.users.Create(t.Context(), local); err != nil {
		t.Fatal(err)
	}
	r := a.get("/v1/auth/me", a.token(subAda, "ada@example.com"))
	p := r.problem(t)
	if r.Code != 409 || p.Type != "urn:problem:identity-conflict" || p.Title != "Conflict" {
		t.Fatalf("%d %+v", r.Code, p)
	}
	if strings.Contains(string(r.Body), local.ID) {
		t.Fatalf("the conflict leaks the other account's id: %s", r.Body)
	}
	if got, _ := a.users.ByEmail(t.Context(), "ada@example.com"); got.ID != local.ID {
		t.Fatalf("the existing account was taken over: %+v", got)
	}
	// The same subject with a free address is fine.
	if r := a.get("/v1/auth/me", a.token(subAda, "ada.new@example.com")); r.Code != 200 {
		t.Fatalf("%d %s", r.Code, r.Body)
	}
}

func TestOIDCModePicksUpARotatedSigningKey(t *testing.T) {
	t.Parallel()
	a := newOIDCApp(t)
	if r := a.get("/v1/auth/me", a.token(subAda, "")); r.Code != 200 {
		t.Fatalf("before rotation: %d %s", r.Code, r.Body)
	}
	a.p.Rotate()
	if r := a.get("/v1/auth/me", a.token(subAda, "")); r.Code != 200 {
		t.Fatalf("after rotation: %d %s", r.Code, r.Body)
	}
}

func TestOIDCModeWithoutAnIdentityProviderStillStartsAndRefuses(t *testing.T) {
	t.Parallel()
	p := oidctest.NewProvider(t)
	p.Fail(http.StatusServiceUnavailable)
	a := &oidcApp{testApp: newTestApp(t, oidcEnv(p)), p: p}
	if r := a.get("/healthz", ""); r.Code != 200 {
		t.Fatalf("liveness must not depend on the identity provider: %d", r.Code)
	}
	r := a.get("/v1/auth/me", a.token(subAda, ""))
	if r.Code != 401 {
		t.Fatalf("with no keys known the token is refused: %d %s", r.Code, r.Body)
	}
	r.problem(t) // a problem document, never a stack trace or a 500
}

func TestOIDCModeNeedsAWorkingVerifierConfiguration(t *testing.T) {
	t.Parallel()
	p := oidctest.NewProvider(t)
	cfg := testConfig(t, oidcEnv(p))
	cfg.OIDCClockSkew = 5 * time.Minute // Load would refuse this; New must not trust its caller either
	users := auth.NewMemoryUserRepository()
	_, err := app.New(t.Context(), app.Options{
		Config: cfg, Logger: slog.New(slog.DiscardHandler), Users: users,
		Sessions: auth.NewMemorySessionRepository(users), Items: items.NewMemoryRepository(),
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{Memory: 8, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}, 0),
	})
	if err == nil || !strings.Contains(err.Error(), "clock skew") {
		t.Fatalf("err = %v", err)
	}
}

func TestOIDCModeAcceptsAnInjectedVerifier(t *testing.T) {
	t.Parallel()
	p := oidctest.NewProvider(t)
	users := auth.NewMemoryUserRepository()
	a, err := app.New(t.Context(), app.Options{
		Config: testConfig(t, oidcEnv(p)), Logger: slog.New(slog.DiscardHandler), Users: users,
		Sessions: auth.NewMemorySessionRepository(users), Items: items.NewMemoryRepository(),
		Hasher:   auth.NewArgon2idHasher(auth.Argon2Params{Memory: 8, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}, 0),
		Verifier: stubVerifier{},
	})
	if err != nil {
		t.Fatal(err)
	}
	ta := newTestApp(t, nil)
	ta.h = a.Handler()
	if r := ta.get("/v1/auth/me", "anything"); r.Code != 200 || !strings.Contains(string(r.Body), subAda) {
		t.Fatalf("%d %s", r.Code, r.Body)
	}
}

type stubVerifier struct{}

func (stubVerifier) Verify(context.Context, string) (auth.Claims, error) {
	return auth.Claims{Subject: subAda, Email: "stub@example.com"}, nil
}

func TestLocalModeIgnoresOIDCSettingsAndKeepsLocalAuth(t *testing.T) {
	t.Parallel()
	p := oidctest.NewProvider(t)
	ta := newTestApp(t, map[string]string{"OIDC_ISSUER": oidctest.Issuer, "OIDC_JWKS_URI": p.JWKSURL(), "OIDC_AUDIENCE": oidctest.Audience})
	tok := ta.signUp("ada@example.com")
	if r := ta.get("/v1/auth/me", tok); r.Code != 200 {
		t.Fatalf("local mode must keep working: %d %s", r.Code, r.Body)
	}
	// An identity-provider token is just an unknown opaque token here.
	jwt := p.Sign(p.Claims(ta.clock.Now(), subAda, "ada@example.com"))
	if r := ta.get("/v1/auth/me", jwt); r.Code != 401 {
		t.Fatalf("a JWT must not authenticate in local mode: %d", r.Code)
	}
	if p.Hits() != 0 {
		t.Fatalf("local mode contacted the identity provider %d times", p.Hits())
	}
}

// The same flow against PostgreSQL: provisioning under real concurrency, the
// unique indexes, and the stored sentinel.
func TestOIDCAgainstPostgres(t *testing.T) {
	t.Parallel()
	pool := dbtest.Pool(t)
	p := oidctest.NewProvider(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	logger := slog.New(slog.DiscardHandler)
	env := oidcEnv(p)
	env["ARGON2_MEMORY_KIB"], env["ARGON2_ITERATIONS"] = "19456", "2"
	oidcCfg := testConfig(t, env)
	a, err := app.New(ctx, app.PostgresOptions(oidcCfg, logger, pool))
	if err != nil {
		t.Fatal(err)
	}
	ta := newTestApp(t, nil)
	ta.h = a.Handler()
	now := func() time.Time { return time.Now().UTC() }
	token := func(sub, email string) string { return p.Sign(p.Claims(now(), sub, email)) }

	// 24 simultaneous first requests for one new subject all succeed and make one row.
	tok := token(subAda, "ada@example.com")
	var wg sync.WaitGroup
	codes := make([]int, 24)
	for i := range codes {
		wg.Go(func() { codes[i] = ta.get("/v1/auth/me", tok).Code })
	}
	wg.Wait()
	for i, c := range codes {
		if c != 200 {
			t.Fatalf("concurrent first request %d answered %d", i, c)
		}
	}
	var rows int
	var hash string
	if err := pool.QueryRow(ctx, "SELECT count(*), min(password_hash) FROM users WHERE id = $1", subAda).Scan(&rows, &hash); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || hash != auth.UnusablePasswordHash {
		t.Fatalf("%d rows, hash %q", rows, hash)
	}

	// Items work and are private to the subject.
	item := ta.createItem(tok, "pg")
	if r := ta.get("/v1/items/"+item.ID, token(subGrace, "grace@example.com")); r.Code != 404 {
		t.Fatalf("foreign read: %d", r.Code)
	}

	// An email already owned by a local account is a conflict, and no row is created.
	localCfg := testConfig(t, map[string]string{"ARGON2_MEMORY_KIB": "19456", "ARGON2_ITERATIONS": "2"})
	localApp, err := app.New(ctx, app.PostgresOptions(localCfg, logger, pool))
	if err != nil {
		t.Fatal(err)
	}
	local := newTestApp(t, nil)
	local.h = localApp.Handler()
	local.signUp("taken@example.com")
	if r := ta.get("/v1/auth/me", token(subLin, "Taken@example.com")); r.Code != 409 || r.problem(t).Type != "urn:problem:identity-conflict" {
		t.Fatalf("collision through the unique index: %d %s", r.Code, r.Body)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM users WHERE id = $1", subLin).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("a conflicting subject got a row: %d, %v", rows, err)
	}

	// The provisioned account cannot sign in locally: the normal 401, never a 500.
	for _, pw := range []string{testPassword, auth.UnusablePasswordHash} {
		r := local.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "ada@example.com", "password": pw}})
		if r.Code != 401 || r.problem(t).Type != "urn:problem:unauthenticated" {
			t.Fatalf("local login for a provisioned account: %d %s", r.Code, r.Body)
		}
	}

	// A changed email claim updates the row.
	if r := ta.get("/v1/auth/me", token(subAda, "ada.lovelace@example.com")); r.Code != 200 || !strings.Contains(string(r.Body), "ada.lovelace@example.com") {
		t.Fatalf("email change: %d %s", r.Code, r.Body)
	}
	if r := ta.get("/v1/auth/me", token(subAda, "taken@example.com")); r.Code != 409 {
		t.Fatalf("moving onto a taken address: %d %s", r.Code, r.Body)
	}
}
