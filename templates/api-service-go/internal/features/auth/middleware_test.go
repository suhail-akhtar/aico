package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/platform/identity"
)

func TestMiddleware(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	u, _ := e.svc.Register(ctx, "ada@example.com", goodPassword)
	tok, _ := e.svc.Login(ctx, "ada@example.com", goodPassword)

	var gotPrincipal identity.Principal
	var gotToken string
	var hadPrincipal bool
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPrincipal, hadPrincipal = identity.FromContext(r.Context())
		gotToken, _ = auth.TokenFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	var failed error
	fail := func(w http.ResponseWriter, _ *http.Request, err error) {
		failed = err
		w.WriteHeader(http.StatusUnauthorized)
	}
	public := func(r *http.Request) bool { return r.URL.Path == "/public" }
	h := e.svc.Middleware(public, fail)(next)

	call := func(path, authz string) int {
		failed, hadPrincipal = nil, false
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, http.NoBody)
		if authz != "" {
			req.Header.Set("Authorization", authz)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	t.Run("valid token reaches the handler with the principal", func(t *testing.T) {
		if code := call("/private", "Bearer "+tok.Value); code != 204 {
			t.Fatalf("status %d (%v)", code, failed)
		}
		if gotPrincipal.UserID != u.ID || gotToken != tok.Value {
			t.Fatalf("principal %+v, token %q", gotPrincipal, gotToken)
		}
	})
	t.Run("scheme is case-insensitive", func(t *testing.T) {
		if code := call("/private", "bearer "+tok.Value); code != 204 {
			t.Fatalf("status %d", code)
		}
	})
	t.Run("public routes need no token and carry no principal", func(t *testing.T) {
		if code := call("/public", ""); code != 204 || hadPrincipal {
			t.Fatalf("status %d, principal %v", code, hadPrincipal)
		}
	})
	t.Run("missing or malformed credentials are refused", func(t *testing.T) {
		for _, authz := range []string{"", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", tok.Value, "Token " + tok.Value} {
			if code := call("/private", authz); code != 401 || !errors.Is(failed, auth.ErrInvalidToken) || hadPrincipal {
				t.Errorf("Authorization %q: status %d, err %v, principal %v", authz, code, failed, hadPrincipal)
			}
		}
	})
	t.Run("unknown and expired tokens are refused", func(t *testing.T) {
		if code := call("/private", "Bearer not-a-real-token"); code != 401 {
			t.Fatalf("unknown token: %d", code)
		}
		e.clock.Advance(2 * time.Hour)
		if code := call("/private", "Bearer "+tok.Value); code != 401 || !errors.Is(failed, auth.ErrInvalidToken) {
			t.Fatalf("expired token: %d, %v", code, failed)
		}
	})
}
