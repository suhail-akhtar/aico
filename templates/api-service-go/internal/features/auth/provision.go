package auth

// Identity mapping and just-in-time provisioning for AUTH_MODE=oidc.
//
// The user id IS the token `sub`, so an item's owner_id is the identity
// provider's own stable identifier and nothing here needs a lookup table. The
// users row exists because items.owner_id references it (and so a future feature
// can join on it); it is created the first time a subject is seen and carries an
// unusable password hash, so the account can never sign in locally.
//
// Alternatives rejected, recorded in .aico/decisions.md: matching accounts by
// email (an email claim is not an identifier; accepting it as one lets whoever
// controls the claim take over a pre-existing local account), and merging on a
// collision (same problem, silently). A collision is a 409 that tells an
// operator to resolve it.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"example.com/api-service/internal/platform/identity"
)

// UnusablePasswordHash is stored for accounts that have no local password. It is
// not a valid Argon2id encoding, so no password can ever verify against it, and
// Login recognises it before the hasher would reject it as malformed (which is a
// 500). It starts with "!" in the tradition of /etc/shadow's locked accounts.
const UnusablePasswordHash = "!oidc-no-local-password" //nolint:gosec // G101 false positive: a sentinel no password can match, not a credential

// invalidEmailDomain is reserved (RFC 2606): an address under it can never
// receive mail or collide with a real one.
const invalidEmailDomain = "@oidc.invalid"

// authenticateOIDC verifies an identity-provider token and maps it to a local
// account. Every verification failure is the same 401; a storage failure is
// returned as itself so an outage never looks like a bad token.
func (s *Service) authenticateOIDC(ctx context.Context, token string) (identity.Principal, error) {
	claims, err := s.Verifier.Verify(ctx, token)
	if err != nil {
		// Debug, not warn: anyone can send garbage, and the log must not become the target.
		s.Logger.DebugContext(ctx, "bearer token refused", slog.String("reason", err.Error()))
		return identity.Principal{}, ErrInvalidToken
	}
	u, err := s.provision(ctx, claims)
	if err != nil {
		return identity.Principal{}, err
	}
	return identity.Principal{UserID: u.ID, Email: u.Email}, nil
}

// provision returns the account for claims.Subject, creating it on first sight.
//
// Concurrency: two simultaneous first requests both reach CreateIfAbsent; the
// repository guarantees exactly one insert, and the other re-reads the winner's
// row, so both succeed and there is one row.
//
// Email: the claim is authoritative for display, so a changed claim updates the
// stored address (and may conflict, see ErrIdentityConflict). A token without an
// email claim never overwrites a real address with the placeholder.
func (s *Service) provision(ctx context.Context, c Claims) (User, error) {
	u, err := s.Users.ByID(ctx, c.Subject)
	switch {
	case err == nil:
		return s.syncEmail(ctx, u, c.Email)
	case !IsUserNotFound(err):
		return User{}, fmt.Errorf("look up user: %w", err)
	}

	email := c.Email
	if email == "" || !validEmail(email) {
		email = c.Subject + invalidEmailDomain
	}
	created, err := s.Users.CreateIfAbsent(ctx, User{
		ID: c.Subject, Email: email, PasswordHash: UnusablePasswordHash, CreatedAt: s.Clock.Now(),
	})
	if errors.Is(err, ErrEmailTaken) {
		return User{}, ErrIdentityConflict
	}
	if err != nil {
		return User{}, fmt.Errorf("provision user: %w", err)
	}
	if created {
		s.Logger.InfoContext(ctx, "provisioned account from identity provider", slog.String("user_id", c.Subject))
	}
	// Created or lost the race: either way the row now exists. Re-read it so the
	// caller sees what is stored, not what this request attempted to store.
	u, err = s.Users.ByID(ctx, c.Subject)
	if err != nil {
		return User{}, fmt.Errorf("re-read provisioned user: %w", err)
	}
	return u, nil
}

// syncEmail aligns the stored email with a valid, different claim.
func (s *Service) syncEmail(ctx context.Context, u User, claim string) (User, error) {
	if claim == "" || claim == u.Email || !validEmail(claim) {
		return u, nil
	}
	if err := s.Users.UpdateEmail(ctx, u.ID, claim); err != nil {
		if errors.Is(err, ErrEmailTaken) {
			return User{}, ErrIdentityConflict
		}
		return User{}, fmt.Errorf("update email: %w", err)
	}
	u.Email = claim
	return u, nil
}
