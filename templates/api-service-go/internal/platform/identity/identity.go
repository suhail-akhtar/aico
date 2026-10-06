// Package identity carries "who is calling" from the authentication middleware
// to the feature handlers.
//
// Why it is its own package: auth proves identity and items consume it, but
// items must not import auth (features depend on the shared kernel, never on
// each other). Both depend on this tiny package instead, and a future feature
// can too. A Principal is the proven user id and nothing more, so a handler
// cannot accidentally trust a field the client supplied.
package identity

import "context"

// Principal is the authenticated caller.
type Principal struct {
	UserID string
	Email  string
}

type ctxKey struct{}

// WithPrincipal returns ctx carrying p.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the caller, and false when the request was not authenticated.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}
