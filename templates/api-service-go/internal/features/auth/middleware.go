package auth

import (
	"context"
	"net/http"
	"strings"

	"example.com/api-service/internal/platform/identity"
)

type tokenKey struct{}

// TokenFromContext returns the bearer token the middleware authenticated, so
// logout can revoke exactly that session.
func TokenFromContext(ctx context.Context) (string, bool) {
	t, ok := ctx.Value(tokenKey{}).(string)
	return t, ok
}

// Middleware authenticates every request for which public returns false: it
// requires `Authorization: Bearer <token>`, resolves it to a Principal, and puts
// the Principal in the context. On failure it calls fail with an error that
// maps to a 401 (or a 500 if the session store is down) and stops.
//
// In oidc mode the bearer token is an identity-provider JWT and Authenticate
// verifies it and provisions the account (provision.go); nothing else changes.
//
// It is a deny-by-default gate: a route is protected unless public says
// otherwise, and a test compares the public set against the `security: []`
// operations in api/openapi.yaml, so forgetting to protect a new route is a
// failing test, not an incident.
func (s *Service) Middleware(public func(*http.Request) bool, fail func(http.ResponseWriter, *http.Request, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if public(r) {
				next.ServeHTTP(w, r)
				return
			}
			token, ok := bearerToken(r)
			if !ok {
				fail(w, r, ErrInvalidToken)
				return
			}
			p, err := s.Authenticate(r.Context(), token)
			if err != nil {
				fail(w, r, err)
				return
			}
			ctx := identity.WithPrincipal(context.WithValue(r.Context(), tokenKey{}, token), p)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// bearerToken extracts the token from an Authorization header. The scheme is
// case-insensitive (RFC 9110); anything else is rejected.
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	scheme, token, found := strings.Cut(h, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

// RejectLocalAuth answers 404 (ErrLocalAuthDisabled) for the requests isLocal
// selects, but only in oidc mode; in local mode it is a pass-through. It runs
// before the body is read and before authentication, so register, login and
// logout are uniformly "not found" in oidc mode whatever the caller sends, and a
// gateway cannot mistake a 401 on logout for "sign in first". The handlers check
// again (see Handler), so a route mounted without this middleware still fails closed.
func (s *Service) RejectLocalAuth(isLocal func(*http.Request) bool, fail func(http.ResponseWriter, *http.Request, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if s.LocalAuthEnabled() {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if isLocal(r) {
				fail(w, r, ErrLocalAuthDisabled)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
