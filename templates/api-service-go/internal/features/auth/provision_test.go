package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/api-service/internal/api"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/identity"
	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/oidctest"
)

// countingUsers counts how many CreateIfAbsent calls actually inserted a row.
type countingUsers struct {
	*auth.MemoryUserRepository
	inserted atomic.Int64
}

func (c *countingUsers) CreateIfAbsent(ctx context.Context, u auth.User) (bool, error) {
	created, err := c.MemoryUserRepository.CreateIfAbsent(ctx, u)
	if created {
		c.inserted.Add(1)
	}
	return created, err
}

type oidcEnv struct {
	svc   *auth.Service
	users *countingUsers
	p     *oidctest.Provider
	clock *clock.Fake
}

func newOIDCEnv(t *testing.T) *oidcEnv {
	t.Helper()
	ve := newVerifier(t, nil)
	users := &countingUsers{MemoryUserRepository: auth.NewMemoryUserRepository()}
	svc, err := auth.NewService(t.Context(), auth.Deps{
		Users: users, Sessions: auth.NewMemorySessionRepository(users.MemoryUserRepository),
		Hasher: auth.NewArgon2idHasher(cheapParams(), 0), Clock: ve.clock, IDs: ids.NewGenerator(ve.clock),
		TTL: time.Hour, Verifier: ve.v,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &oidcEnv{svc: svc, users: users, p: ve.p, clock: ve.clock}
}

func (e *oidcEnv) token(sub, email string) string {
	return e.p.Sign(e.p.Claims(e.clock.Now(), sub, email))
}

func TestFirstSightProvisionsTheAccount(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	ctx := t.Context()

	p, err := e.svc.Authenticate(ctx, e.token(subAda, "Ada@Example.com"))
	if err != nil {
		t.Fatal(err)
	}
	if p.UserID != subAda || p.Email != "ada@example.com" {
		t.Fatalf("principal = %+v: the user id is the subject", p)
	}
	u, err := e.users.ByID(ctx, subAda)
	if err != nil {
		t.Fatal(err)
	}
	if u.Email != "ada@example.com" || u.PasswordHash != auth.UnusablePasswordHash || !u.CreatedAt.Equal(e.clock.Now()) {
		t.Fatalf("stored user = %+v", u)
	}

	if again, err := e.svc.Authenticate(ctx, e.token(subAda, "ada@example.com")); err != nil || again != p {
		t.Fatalf("second sight: %+v, %v", again, err)
	}
	if n := e.users.inserted.Load(); n != 1 {
		t.Fatalf("%d inserts for one subject", n)
	}
}

func TestProvisioningFallsBackToAnInvalidDomainEmail(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	ctx := t.Context()
	want := subAda + "@oidc.invalid"

	p, err := e.svc.Authenticate(ctx, e.token(subAda, ""))
	if err != nil || p.Email != want {
		t.Fatalf("no email claim: %+v, %v", p, err)
	}
	// A claim that is not an address is treated as absent too.
	p, err = e.svc.Authenticate(ctx, e.token(subGrace, "not an email"))
	if err != nil || p.Email != subGrace+"@oidc.invalid" {
		t.Fatalf("garbage email claim: %+v, %v", p, err)
	}
	// A later token without the claim must not erase a real address...
	if _, err := e.svc.Authenticate(ctx, e.token(subAda, "ada@example.com")); err != nil {
		t.Fatal(err)
	}
	p, err = e.svc.Authenticate(ctx, e.token(subAda, ""))
	if err != nil || p.Email != "ada@example.com" {
		t.Fatalf("a token without an email overwrote it: %+v, %v", p, err)
	}
}

func TestAChangedEmailClaimUpdatesTheAccount(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	ctx := t.Context()
	if _, err := e.svc.Authenticate(ctx, e.token(subAda, "ada@example.com")); err != nil {
		t.Fatal(err)
	}
	p, err := e.svc.Authenticate(ctx, e.token(subAda, "ada.lovelace@example.com"))
	if err != nil || p.Email != "ada.lovelace@example.com" || p.UserID != subAda {
		t.Fatalf("after the change: %+v, %v", p, err)
	}
	if _, err := e.users.ByEmail(ctx, "ada@example.com"); !auth.IsUserNotFound(err) {
		t.Fatalf("the old address must be free again: %v", err)
	}
}

func TestEmailCollisionIsAConflictNeverAMerge(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	ctx := t.Context()
	local, err := e.svc.Register(ctx, "ada@example.com", goodPassword)
	if err != nil {
		t.Fatal(err)
	}

	_, err = e.svc.Authenticate(ctx, e.token(subAda, "ADA@example.com"))
	if !errors.Is(err, auth.ErrIdentityConflict) || apperr.KindOf(err) != apperr.KindConflict {
		t.Fatalf("new subject, existing email: %v", err)
	}
	if _, err := e.users.ByID(ctx, subAda); !auth.IsUserNotFound(err) {
		t.Fatalf("no row may be created for the colliding subject: %v", err)
	}
	if stored, _ := e.users.ByEmail(ctx, "ada@example.com"); stored.ID != local.ID || stored.PasswordHash != local.PasswordHash {
		t.Fatalf("the existing account was modified: %+v", stored)
	}

	// An already-provisioned subject whose claim moves onto someone else's address.
	if _, err := e.svc.Authenticate(ctx, e.token(subGrace, "grace@example.com")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Authenticate(ctx, e.token(subGrace, "ada@example.com")); !errors.Is(err, auth.ErrIdentityConflict) {
		t.Fatalf("existing subject, email owned by another: %v", err)
	}
	if u, _ := e.users.ByID(ctx, subGrace); u.Email != "grace@example.com" {
		t.Fatalf("the conflicting update must not apply: %+v", u)
	}
}

func TestSimultaneousFirstRequestsCreateExactlyOneAccount(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	token := e.token(subAda, "ada@example.com")
	const callers = 48
	var wg sync.WaitGroup
	results := make([]identity.Principal, callers)
	errs := make([]error, callers)
	start := make(chan struct{})
	for i := range callers {
		wg.Go(func() {
			<-start
			results[i], errs[i] = e.svc.Authenticate(context.Background(), token)
		})
	}
	close(start)
	wg.Wait()
	for i := range callers {
		if errs[i] != nil || results[i].UserID != subAda || results[i].Email != "ada@example.com" {
			t.Fatalf("caller %d: %+v, %v", i, results[i], errs[i])
		}
	}
	if n := e.users.inserted.Load(); n != 1 {
		t.Fatalf("%d rows inserted for one subject, want exactly 1", n)
	}
}

func TestRefusedTokensProvisionNothing(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	ctx := t.Context()
	claims := e.p.Claims(e.clock.Now(), subAda, "ada@example.com")
	claims["aud"] = "someone-else"
	for name, token := range map[string]string{
		"wrong audience": e.p.Sign(claims),
		"unsigned":       e.p.SignNone(e.p.Claims(e.clock.Now(), subAda, "ada@example.com")),
		"garbage":        "garbage",
		"empty":          "",
		"oversized":      strings.Repeat("x", 9000),
	} {
		if _, err := e.svc.Authenticate(ctx, token); !errors.Is(err, auth.ErrInvalidToken) {
			t.Errorf("%s: %v, want ErrInvalidToken", name, err)
		}
	}
	if _, err := e.users.ByID(ctx, subAda); !auth.IsUserNotFound(err) {
		t.Fatalf("a refused token created an account: %v", err)
	}
}

// brokenUsers fails like a database outage.
type brokenUsers struct {
	*auth.MemoryUserRepository
	byID, create bool
}

var errDown = errors.New("connection refused")

func (b brokenUsers) ByID(ctx context.Context, id string) (auth.User, error) {
	if b.byID {
		return auth.User{}, errDown
	}
	return b.MemoryUserRepository.ByID(ctx, id)
}

func (b brokenUsers) CreateIfAbsent(ctx context.Context, u auth.User) (bool, error) {
	if b.create {
		return false, errDown
	}
	return b.MemoryUserRepository.CreateIfAbsent(ctx, u)
}

func TestStorageOutagesAreNotInvalidTokens(t *testing.T) {
	t.Parallel()
	for name, users := range map[string]brokenUsers{
		"lookup fails":    {MemoryUserRepository: auth.NewMemoryUserRepository(), byID: true},
		"provision fails": {MemoryUserRepository: auth.NewMemoryUserRepository(), create: true},
	} {
		ve := newVerifier(t, nil)
		svc, err := auth.NewService(t.Context(), auth.Deps{
			Users: users, Sessions: auth.NewMemorySessionRepository(users.MemoryUserRepository),
			Hasher: auth.NewArgon2idHasher(cheapParams(), 0), Clock: ve.clock, IDs: ids.NewGenerator(ve.clock),
			TTL: time.Hour, Verifier: ve.v,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = svc.Authenticate(t.Context(), ve.p.Sign(ve.claims("ada@example.com")))
		if !errors.Is(err, errDown) || errors.Is(err, auth.ErrInvalidToken) {
			t.Errorf("%s: %v, want the storage error", name, err)
		}
	}
}

func TestRereadAfterInsertFailureSurfaces(t *testing.T) {
	t.Parallel()
	ve := newVerifier(t, nil)
	users := &flakyReread{MemoryUserRepository: auth.NewMemoryUserRepository()}
	svc, err := auth.NewService(t.Context(), auth.Deps{
		Users: users, Sessions: auth.NewMemorySessionRepository(users.MemoryUserRepository),
		Hasher: auth.NewArgon2idHasher(cheapParams(), 0), Clock: ve.clock, IDs: ids.NewGenerator(ve.clock),
		TTL: time.Hour, Verifier: ve.v,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(t.Context(), ve.p.Sign(ve.claims("ada@example.com"))); !errors.Is(err, errDown) {
		t.Fatalf("a failing re-read: %v", err)
	}
}

// flakyReread answers the first ByID as "not found" and every later one with an outage.
type flakyReread struct {
	*auth.MemoryUserRepository
	calls atomic.Int64
}

func (f *flakyReread) ByID(ctx context.Context, id string) (auth.User, error) {
	if f.calls.Add(1) > 1 {
		return auth.User{}, errDown
	}
	return f.MemoryUserRepository.ByID(ctx, id)
}

func TestEmailUpdateFailuresSurface(t *testing.T) {
	t.Parallel()
	ve := newVerifier(t, nil)
	users := &failingUpdate{MemoryUserRepository: auth.NewMemoryUserRepository()}
	svc, err := auth.NewService(t.Context(), auth.Deps{
		Users: users, Sessions: auth.NewMemorySessionRepository(users.MemoryUserRepository),
		Hasher: auth.NewArgon2idHasher(cheapParams(), 0), Clock: ve.clock, IDs: ids.NewGenerator(ve.clock),
		TTL: time.Hour, Verifier: ve.v,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(t.Context(), ve.p.Sign(ve.claims("ada@example.com"))); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(t.Context(), ve.p.Sign(ve.claims("new@example.com"))); !errors.Is(err, errDown) {
		t.Fatalf("a failing email update: %v", err)
	}
}

type failingUpdate struct{ *auth.MemoryUserRepository }

func (failingUpdate) UpdateEmail(context.Context, string, string) error { return errDown }

func TestAProvisionedAccountCannotLogInLocally(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	ctx := t.Context()
	if _, err := e.svc.Authenticate(ctx, e.token(subAda, "ada@example.com")); err != nil {
		t.Fatal(err)
	}
	// The same user table behind a service in local mode (a deployment that switched modes).
	local, err := auth.NewService(ctx, auth.Deps{
		Users: e.users, Sessions: auth.NewMemorySessionRepository(e.users.MemoryUserRepository),
		Hasher: auth.NewArgon2idHasher(cheapParams(), 0), Clock: e.clock, IDs: ids.NewGenerator(e.clock), TTL: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, pw := range []string{goodPassword, auth.UnusablePasswordHash, "!", "x"} {
		_, err := local.Login(ctx, "ada@example.com", pw)
		if !errors.Is(err, auth.ErrInvalidCredentials) {
			t.Errorf("password %q: %v, want the normal invalid-credentials error (never a 500)", pw, err)
		}
	}
}

func TestLocalAuthIsOffInOIDCMode(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	if e.svc.LocalAuthEnabled() {
		t.Fatal("oidc mode must report local auth as disabled")
	}
	h := auth.NewHandler(e.svc)
	ctx := t.Context()
	if _, err := h.Register(ctx, api.RegisterRequestObject{Body: &api.Credentials{Email: "a@example.com"}}); !errors.Is(err, auth.ErrLocalAuthDisabled) {
		t.Errorf("Register: %v", err)
	}
	if _, err := h.Login(ctx, api.LoginRequestObject{Body: &api.Credentials{Email: "a@example.com"}}); !errors.Is(err, auth.ErrLocalAuthDisabled) {
		t.Errorf("Login: %v", err)
	}
	if _, err := h.Logout(ctx, api.LogoutRequestObject{}); !errors.Is(err, auth.ErrLocalAuthDisabled) {
		t.Errorf("Logout: %v", err)
	}
	if apperr.KindOf(auth.ErrLocalAuthDisabled) != apperr.KindNotFound || !strings.Contains(auth.ErrLocalAuthDisabled.Error(), "AUTH_MODE=oidc") {
		t.Errorf("unexpected error: %v", auth.ErrLocalAuthDisabled)
	}
	// GetMe still works: it only reads the principal the middleware proved.
	me, err := h.GetMe(identity.WithPrincipal(ctx, identity.Principal{UserID: subAda, Email: "a@example.com"}), api.GetMeRequestObject{})
	if err != nil || me.(api.GetMe200JSONResponse).Id != subAda {
		t.Errorf("GetMe: %v, %v", me, err)
	}
}

func TestMiddlewareInOIDCMode(t *testing.T) {
	t.Parallel()
	e := newOIDCEnv(t)
	var gotPrincipal identity.Principal
	var gotToken string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPrincipal, _ = identity.FromContext(r.Context())
		gotToken, _ = auth.TokenFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	var failed error
	fail := func(w http.ResponseWriter, _ *http.Request, err error) {
		failed = err
		w.WriteHeader(http.StatusUnauthorized)
	}
	gate := e.svc.RejectLocalAuth(func(r *http.Request) bool { return r.URL.Path == "/local" }, fail)
	h := gate(e.svc.Middleware(func(*http.Request) bool { return false }, fail)(next))
	call := func(path, authz string) int {
		failed = nil
		req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, http.NoBody)
		if authz != "" {
			req.Header.Set("Authorization", authz)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	token := e.token(subAda, "ada@example.com")
	if code := call("/private", "Bearer "+token); code != 204 || gotPrincipal.UserID != subAda || gotToken != token {
		t.Fatalf("valid JWT: %d, %+v", code, gotPrincipal)
	}
	if code := call("/private", ""); code != 401 || !errors.Is(failed, auth.ErrInvalidToken) {
		t.Fatalf("no token: %d, %v", code, failed)
	}
	if code := call("/private", "Bearer "+e.p.SignNone(e.p.Claims(e.clock.Now(), subAda, ""))); code != 401 || !errors.Is(failed, auth.ErrInvalidToken) {
		t.Fatalf("alg none: %d, %v", code, failed)
	}
	// The local routes are 404 before authentication looks at the request: with a
	// valid token, with a bad one and with none.
	for _, authz := range []string{"Bearer " + token, "Bearer junk", ""} {
		if code := call("/local", authz); code != 401 || !errors.Is(failed, auth.ErrLocalAuthDisabled) {
			t.Errorf("/local with %q: %d, %v", authz, code, failed)
		}
	}
}

func TestRejectLocalAuthIsAPassThroughInLocalMode(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	var reached bool
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true })
	h := e.svc.RejectLocalAuth(func(*http.Request) bool { return true }, func(http.ResponseWriter, *http.Request, error) {
		t.Error("local mode must never reject")
	})(next)
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/x", http.NoBody))
	if !reached || !e.svc.LocalAuthEnabled() {
		t.Fatal("the request did not reach the handler")
	}
}
