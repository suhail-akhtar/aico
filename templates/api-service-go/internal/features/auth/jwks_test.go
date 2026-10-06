package auth_test

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/logging"
	"example.com/api-service/internal/platform/oidctest"
)

// Keycloak's `sub` is a UUID; these are obviously fake.
const (
	subAda   = "7b0f5e1c-3a52-4d4e-9d0e-1f6a2b3c4d5e"
	subGrace = "0f2d8c64-91aa-4b7e-8c35-5d2e7a1b9f40"
)

type verifierEnv struct {
	v     *auth.JWKSVerifier
	p     *oidctest.Provider
	clock *clock.Fake
	logs  *bytes.Buffer
}

func newVerifier(t *testing.T, tweak func(*oidctest.Provider, *auth.JWKSConfig)) *verifierEnv {
	t.Helper()
	fake := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	p := oidctest.NewProvider(t)
	logs := &bytes.Buffer{}
	cfg := auth.JWKSConfig{
		Issuer: oidctest.Issuer, JWKSURI: p.JWKSURL(), Audience: oidctest.Audience,
		Leeway: 30 * time.Second, Now: fake.Now, Logger: logging.New(logs, slog.LevelDebug),
	}
	if tweak != nil {
		tweak(p, &cfg)
	}
	v, err := auth.NewJWKSVerifier(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	return &verifierEnv{v: v, p: p, clock: fake, logs: logs}
}

func (e *verifierEnv) claims(email string) map[string]any {
	return e.p.Claims(e.clock.Now(), subAda, email)
}

func TestVerifyAcceptsAValidToken(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil)
	got, err := e.v.Verify(t.Context(), e.p.Sign(e.claims("Ada@Example.COM")))
	if err != nil {
		t.Fatal(err)
	}
	if got.Subject != subAda || got.Email != "ada@example.com" {
		t.Fatalf("claims = %+v: the subject is the id and the email is lower-cased", got)
	}
}

func TestVerifyNormalisesSubjectAndToleratesNoEmail(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil)
	c := e.claims("")
	c["sub"] = strings.ToUpper(subAda)
	got, err := e.v.Verify(t.Context(), e.p.Sign(c))
	if err != nil || got.Subject != subAda || got.Email != "" {
		t.Fatalf("got %+v, %v: an upper-case UUID is canonicalised and the email claim is optional", got, err)
	}
}

func TestVerifyAcceptsAnAudienceList(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil)
	c := e.claims("")
	c["aud"] = []string{"account", oidctest.Audience}
	if _, err := e.v.Verify(t.Context(), e.p.Sign(c)); err != nil {
		t.Fatalf("aud may be an array that contains the audience: %v", err)
	}
}

func TestVerifyRefusesInvalidTokens(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil)
	now := e.clock.Now()
	mutate := func(f func(map[string]any)) string {
		c := e.claims("ada@example.com")
		f(c)
		return e.p.Sign(c)
	}
	tests := []struct {
		name  string
		token string
	}{
		{"expired", mutate(func(c map[string]any) { c["exp"] = now.Add(-2 * time.Minute).Unix() })},
		{"expiry missing", mutate(func(c map[string]any) { delete(c, "exp") })},
		{"not yet valid", mutate(func(c map[string]any) { c["nbf"] = now.Add(2 * time.Minute).Unix() })},
		{"issued in the future", mutate(func(c map[string]any) { c["iat"] = now.Add(10 * time.Minute).Unix() })},
		{"wrong issuer", mutate(func(c map[string]any) { c["iss"] = "https://evil.example.test/realms/app" })},
		{"issuer with a trailing slash", mutate(func(c map[string]any) { c["iss"] = oidctest.Issuer + "/" })},
		{"issuer missing", mutate(func(c map[string]any) { delete(c, "iss") })},
		{"wrong audience", mutate(func(c map[string]any) { c["aud"] = "account" })},
		{"audience missing", mutate(func(c map[string]any) { delete(c, "aud") })},
		{"subject missing", mutate(func(c map[string]any) { delete(c, "sub") })},
		{"subject empty", mutate(func(c map[string]any) { c["sub"] = "" })},
		{"subject not a UUID", mutate(func(c map[string]any) { c["sub"] = "admin" })},
		{"subject in braces", mutate(func(c map[string]any) { c["sub"] = "{" + subAda + "}" })},
		{"subject is a number", mutate(func(c map[string]any) { c["sub"] = 42 })},
		{"email is not a string", mutate(func(c map[string]any) { c["email"] = 42 })},
		{"alg none", e.p.SignNone(e.claims("ada@example.com"))},
		{"HS256 signed with the public key", e.p.SignHS256WithPublicKey(e.claims("ada@example.com"))},
		{"RS512 instead of RS256", e.p.SignRS512(e.claims("ada@example.com"))},
		{"signed by an unpublished key", e.p.SignForged(e.claims("ada@example.com"))},
		{"unknown kid", e.p.SignWithKID("not-a-key", e.claims("ada@example.com"))},
		{"no kid", e.p.SignWithoutKID(e.claims("ada@example.com"))},
		{"payload tampered after signing", oidctest.Tamper(t, e.p.Sign(e.claims("ada@example.com")), subGrace)},
		{"empty", ""},
		{"not a JWT", "not-a-token"},
		{"three empty segments", ".."},
		{"garbage segments", "a.b.c"},
		{"bearer prefix left on", "Bearer " + e.p.Sign(e.claims(""))},
		{"far too long", strings.Repeat("a", 9000)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got, err := e.v.Verify(t.Context(), tt.token); err == nil {
				t.Fatalf("accepted: %+v", got)
			} else if tt.token != "" && strings.Contains(err.Error(), tt.token) {
				t.Fatalf("the error repeats the token: %v", err)
			}
		})
	}
}

func TestVerifyHonoursClockSkewLeewayButNotMore(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil) // leeway 30 s
	now := e.clock.Now()
	for name, mutate := range map[string]func(map[string]any){
		"expired 10 s ago": func(c map[string]any) { c["exp"] = now.Add(-10 * time.Second).Unix() },
		"valid in 10 s":    func(c map[string]any) { c["nbf"] = now.Add(10 * time.Second).Unix() },
		"issued in 10 s":   func(c map[string]any) { c["iat"] = now.Add(10 * time.Second).Unix() },
	} {
		c := e.claims("")
		mutate(c)
		if _, err := e.v.Verify(t.Context(), e.p.Sign(c)); err != nil {
			t.Errorf("%s: within the leeway, got %v", name, err)
		}
	}
	c := e.claims("")
	c["exp"] = now.Add(-45 * time.Second).Unix()
	if _, err := e.v.Verify(t.Context(), e.p.Sign(c)); err == nil {
		t.Error("expired 45 s ago must fail with a 30 s leeway")
	}
	e.clock.Advance(10 * time.Minute)
	if _, err := e.v.Verify(t.Context(), e.p.Sign(c)); err == nil {
		t.Error("a token must expire when the clock moves on")
	}
}

func TestVerifyFetchesARotatedKeyOnAnUnknownKid(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil)
	if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err != nil {
		t.Fatal(err)
	}
	before := e.p.Hits()
	if before != 1 {
		t.Fatalf("the key set is fetched once at start-up, got %d requests", before)
	}

	e.p.Rotate()
	got, err := e.v.Verify(t.Context(), e.p.Sign(e.claims("")))
	if err != nil || got.Subject != subAda {
		t.Fatalf("a token signed by the rotated key must verify after one refetch: %+v, %v", got, err)
	}
	if e.p.Hits() != before+1 {
		t.Fatalf("expected exactly one refetch, got %d requests in total", e.p.Hits())
	}
	// The old key is still published (as Keycloak keeps a passive key), and is cached.
	if _, err := e.v.Verify(t.Context(), e.p.SignWithKID("key-0", e.claims(""))); err == nil {
		t.Fatal("key-0's id with the new key's signature must not verify")
	}
}

func TestUnknownKidFloodDoesNotHammerTheIdentityProvider(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, nil)
	for i := range 60 {
		kid := "forged-" + strings.Repeat("x", i%7) + string(rune('a'+i%26))
		if _, err := e.v.Verify(t.Context(), e.p.SignWithKID(kid, e.claims(""))); err == nil {
			t.Fatal("a forged kid verified")
		}
	}
	// One request at start-up and at most one rate-limited refetch for all 60 tokens.
	if hits := e.p.Hits(); hits > 2 {
		t.Fatalf("60 forged kids caused %d requests to the identity provider, want at most 2", hits)
	}
	// And a legitimate token still verifies afterwards.
	if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err != nil {
		t.Fatalf("a valid token after the flood: %v", err)
	}
}

func TestRefetchIsAllowedAgainAfterTheInterval(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, func(_ *oidctest.Provider, c *auth.JWKSConfig) { c.UnknownKIDInterval = 50 * time.Millisecond })
	_, _ = e.v.Verify(t.Context(), e.p.SignWithKID("nope", e.claims(""))) // consumes the burst
	e.p.Rotate()
	// Within the interval a refetch may be refused; once it has passed, the rotated key is found.
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the rotated key was never fetched although the interval elapsed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestVerifierSurvivesAnUnreachableIdentityProvider(t *testing.T) {
	t.Parallel()
	e := newVerifier(t, func(p *oidctest.Provider, c *auth.JWKSConfig) {
		p.Fail(503)
		c.UnknownKIDInterval = 200 * time.Millisecond
	})
	// Construction succeeded (newVerifier would have failed the test); the outage is logged.
	if !strings.Contains(e.logs.String(), "could not refresh the signing keys") {
		t.Fatalf("the failed first fetch must be logged, got: %s", e.logs)
	}
	token := e.p.Sign(e.claims(""))
	if _, err := e.v.Verify(t.Context(), token); err == nil {
		t.Fatal("no keys are known: the token must be refused")
	}
	if strings.Contains(e.logs.String(), token) {
		t.Fatal("a token reached the logs")
	}
	// The identity provider recovers: the next token with a kid triggers a fetch, if the limiter allows it.
	e.p.Fail(0)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := e.v.Verify(t.Context(), token); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("verification never recovered after the identity provider came back")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestVerifyRefusesUntrustedKeys(t *testing.T) {
	t.Parallel()
	t.Run("an RSA key below 2048 bits", func(t *testing.T) {
		t.Parallel()
		e := newVerifier(t, func(p *oidctest.Provider, _ *auth.JWKSConfig) { p.UseWeakKey() })
		if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err == nil {
			t.Fatal("a 1024-bit key must not be trusted")
		}
	})
	t.Run("an encryption key, even labelled RS256", func(t *testing.T) {
		t.Parallel()
		e := newVerifier(t, func(p *oidctest.Provider, _ *auth.JWKSConfig) { p.PublishAs("enc", "RS256") })
		if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err == nil {
			t.Fatal("a key published with use=enc must never verify a signature")
		}
	})
	t.Run("RS512 is refused even when the key set does not say which algorithm the key is for", func(t *testing.T) {
		t.Parallel()
		e := newVerifier(t, func(p *oidctest.Provider, _ *auth.JWKSConfig) { p.PublishAs("sig", "") })
		if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err != nil {
			t.Fatalf("RS256 with an alg-less key: %v", err)
		}
		if _, err := e.v.Verify(t.Context(), e.p.SignRS512(e.claims(""))); err == nil {
			t.Fatal("the algorithm must be pinned by the verifier, not inferred from the key set")
		}
	})
	t.Run("a key with no use is accepted (RFC 7517: use is optional)", func(t *testing.T) {
		t.Parallel()
		e := newVerifier(t, func(p *oidctest.Provider, _ *auth.JWKSConfig) { p.PublishAs("", "RS256") })
		if _, err := e.v.Verify(t.Context(), e.p.Sign(e.claims(""))); err != nil {
			t.Fatal(err)
		}
	})
}

func TestNewJWKSVerifierRejectsBadConfiguration(t *testing.T) {
	t.Parallel()
	good := auth.JWKSConfig{Issuer: oidctest.Issuer, JWKSURI: "http://127.0.0.1:1/certs", Audience: oidctest.Audience}
	for name, mutate := range map[string]func(*auth.JWKSConfig){
		"no issuer":         func(c *auth.JWKSConfig) { c.Issuer = "" },
		"no jwks uri":       func(c *auth.JWKSConfig) { c.JWKSURI = "" },
		"no audience":       func(c *auth.JWKSConfig) { c.Audience = "" },
		"negative leeway":   func(c *auth.JWKSConfig) { c.Leeway = -time.Second },
		"leeway over 60 s":  func(c *auth.JWKSConfig) { c.Leeway = 61 * time.Second },
		"unparseable jwks":  func(c *auth.JWKSConfig) { c.JWKSURI = "://nope" },
		"jwks not absolute": func(c *auth.JWKSConfig) { c.JWKSURI = "certs" },
	} {
		cfg := good
		mutate(&cfg)
		ctx, cancel := context.WithCancel(t.Context())
		if v, err := auth.NewJWKSVerifier(ctx, cfg); err == nil {
			t.Errorf("%s: accepted (%v)", name, v)
		}
		cancel()
	}
}
