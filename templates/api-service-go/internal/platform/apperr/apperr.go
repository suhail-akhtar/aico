// Package apperr is the shared vocabulary for "what kind of failure is this".
//
// Why it exists: domain code must not know HTTP, yet the HTTP edge must map
// every failure to one RFC 9457 response in ONE place. A domain returns an
// *Error carrying a Kind; httpx turns the Kind into a status and a problem
// type. Anything that is not an *Error (or a validate.Errors) is a bug and
// becomes a 500 whose detail is never shown to the client.
//
// It deliberately has no status codes, no messages meant for logs, and no error
// codes per feature: a Kind is a category, the message is for the client.
package apperr

import "errors"

// Kind is the failure category.
type Kind uint8

// The categories the HTTP edge distinguishes.
const (
	KindInternal Kind = iota
	KindNotFound
	KindConflict
	KindUnauthenticated
	KindUnsupportedMediaType
	KindUnavailable
)

// Error is a categorised, client-safe failure.
type Error struct {
	Kind Kind
	// Msg is shown to the client; it must not contain secrets or internals.
	Msg string
	// Code optionally names the problem more precisely than the Kind does
	// (for example "identity-conflict" for a 409). The HTTP edge uses it as the
	// suffix of the problem type; empty means the Kind's default.
	Code string
}

// New returns a categorised error. Declare these once as package-level
// sentinels so callers can use errors.Is.
func New(kind Kind, msg string) *Error { return &Error{Kind: kind, Msg: msg} }

// NewCoded is New with a problem code: the status still comes from the Kind, but
// clients can tell this conflict (or not-found, ...) from the generic one.
func NewCoded(kind Kind, code, msg string) *Error { return &Error{Kind: kind, Msg: msg, Code: code} }

func (e *Error) Error() string { return e.Msg }

// KindOf reports the category of err, or KindInternal when err is not an *Error.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return KindInternal
}

// Message returns the client-safe message of an *Error, or "" otherwise.
func Message(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Msg
	}
	return ""
}
