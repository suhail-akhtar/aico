// Package oidctest is a stand-in identity provider for tests: it generates RSA
// keys, serves them as a JWKS from an in-process httptest server, and signs
// tokens, including the malformed and malicious ones the verifier must refuse.
//
// Why it exists as a package: the verifier tests (features/auth) and the
// application tests (app) need the same provider, and a real Keycloak would make
// the suite slow, flaky and network-dependent. Nothing here is imported by the
// service binary.
//
// Keys are generated once per test process and shared (RSA generation is the
// slow part); a Provider only decides which of them it publishes. It is not a
// model of OIDC discovery or the token endpoint: the service never calls them.
package oidctest

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// The issuer and audience a default Provider expects the service to be configured with.
const (
	Issuer   = "https://idp.example.test/realms/app"
	Audience = "app-api"
)

var (
	keyOnce sync.Once
	keyPool [3]*rsa.PrivateKey // two sound keys and one too small to be trusted
)

// poolKey returns shared key i: 0 and 1 are 2048-bit, 2 is 1024-bit.
func poolKey(tb testing.TB, i int) *rsa.PrivateKey {
	tb.Helper()
	keyOnce.Do(func() {
		for n, bits := range []int{2048, 2048, 1024} {
			k, err := rsa.GenerateKey(rand.Reader, bits)
			if err != nil {
				panic(fmt.Sprintf("oidctest: generate RSA key: %v", err))
			}
			keyPool[n] = k
		}
	})
	return keyPool[i]
}

type published struct {
	kid, use, alg string
	key           *rsa.PrivateKey
}

// Provider serves a JWKS and signs tokens.
type Provider struct {
	tb   testing.TB
	srv  *httptest.Server
	hits atomic.Int64

	mu      sync.Mutex
	keys    []published // what the JWKS endpoint publishes
	current published   // what Sign signs with
	status  int         // non-zero: the JWKS endpoint answers this status
	next    int         // next pool key to hand out on Rotate
}

// NewProvider starts a provider publishing one 2048-bit signing key. The server
// stops when the test ends.
func NewProvider(tb testing.TB) *Provider {
	tb.Helper()
	p := &Provider{tb: tb, next: 1}
	p.current = published{kid: "key-0", use: "sig", alg: "RS256", key: poolKey(tb, 0)}
	p.keys = []published{p.current}
	p.srv = httptest.NewServer(http.HandlerFunc(p.serveJWKS))
	tb.Cleanup(p.srv.Close)
	return p
}

// JWKSURL is the address to configure as OIDC_JWKS_URI.
func (p *Provider) JWKSURL() string { return p.srv.URL + "/certs" }

// Hits is how many times the JWKS endpoint has been requested.
func (p *Provider) Hits() int { return int(p.hits.Load()) }

// KID is the key id Sign currently uses.
func (p *Provider) KID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.current.kid
}

// Rotate publishes a second 2048-bit key (the old one stays published, as
// Keycloak does for a passive key) and signs with it from now on.
func (p *Provider) Rotate() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current = published{kid: fmt.Sprintf("key-%d", p.next), use: "sig", alg: "RS256", key: poolKey(p.tb, 1)}
	p.next++
	p.keys = append(p.keys, p.current)
}

// UseWeakKey publishes a 1024-bit key and signs with it from now on.
func (p *Provider) UseWeakKey() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current = published{kid: "weak", use: "sig", alg: "RS256", key: poolKey(p.tb, 2)}
	p.keys = []published{p.current}
}

// PublishAs changes the `use` and `alg` the current key is published with (for
// example "enc"/"RSA-OAEP", which Keycloak publishes beside its signing key).
func (p *Provider) PublishAs(use, alg string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current.use, p.current.alg = use, alg
	p.keys[len(p.keys)-1] = p.current
}

// Fail makes the JWKS endpoint answer status (an outage); 0 restores it.
func (p *Provider) Fail(status int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = status
}

func (p *Provider) serveJWKS(w http.ResponseWriter, _ *http.Request) {
	p.hits.Add(1)
	p.mu.Lock()
	status, keys := p.status, append([]published(nil), p.keys...)
	p.mu.Unlock()
	if status != 0 {
		http.Error(w, "identity provider unavailable", status)
		return
	}
	type jwk struct {
		Kty string `json:"kty"`
		Kid string `json:"kid"`
		Use string `json:"use,omitempty"`
		Alg string `json:"alg,omitempty"`
		N   string `json:"n"`
		E   string `json:"e"`
	}
	set := struct {
		Keys []jwk `json:"keys"`
	}{}
	for _, k := range keys {
		set.Keys = append(set.Keys, jwk{
			Kty: "RSA", Kid: k.kid, Use: k.use, Alg: k.alg,
			N: base64.RawURLEncoding.EncodeToString(k.key.N.Bytes()),
			E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.key.E)).Bytes()),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(set)
}

// Claims returns a valid access-token payload for sub at time now: the default
// issuer and audience, issued now, valid for five minutes. An empty email omits
// the claim. Tests change the map to build each invalid variant.
func (p *Provider) Claims(now time.Time, sub, email string) map[string]any {
	c := map[string]any{
		"iss": Issuer, "aud": Audience, "sub": sub,
		"iat": now.Unix(), "nbf": now.Unix(), "exp": now.Add(5 * time.Minute).Unix(),
	}
	if email != "" {
		c["email"] = email
	}
	return c
}

// Sign signs claims with RS256 and the current key, as the identity provider would.
func (p *Provider) Sign(claims map[string]any) string {
	p.mu.Lock()
	cur := p.current
	p.mu.Unlock()
	return p.sign(jwt.SigningMethodRS256, cur.key, cur.kid, claims)
}

// SignForged signs with a key the provider never published, under the current
// key's kid: the kid resolves but the signature cannot verify.
func (p *Provider) SignForged(claims map[string]any) string {
	return p.sign(jwt.SigningMethodRS256, poolKey(p.tb, 1), p.KID(), claims)
}

// SignWithKID signs with the current key under a different kid.
func (p *Provider) SignWithKID(kid string, claims map[string]any) string {
	p.mu.Lock()
	cur := p.current
	p.mu.Unlock()
	return p.sign(jwt.SigningMethodRS256, cur.key, kid, claims)
}

// SignWithoutKID signs with the current key and leaves the kid header out.
func (p *Provider) SignWithoutKID(claims map[string]any) string {
	p.mu.Lock()
	cur := p.current
	p.mu.Unlock()
	return p.sign(jwt.SigningMethodRS256, cur.key, "", claims)
}

// SignRS512 signs with the current key but a different RSA algorithm: the
// verifier pins RS256, so a stronger-looking algorithm is still refused.
func (p *Provider) SignRS512(claims map[string]any) string {
	p.mu.Lock()
	cur := p.current
	p.mu.Unlock()
	return p.sign(jwt.SigningMethodRS512, cur.key, cur.kid, claims)
}

// SignHS256WithPublicKey is the algorithm-confusion attack: an HS256 token whose
// MAC key is the provider's public key, which an RS256-agnostic verifier would
// accept because the "secret" is public.
func (p *Provider) SignHS256WithPublicKey(claims map[string]any) string {
	p.mu.Lock()
	cur := p.current
	p.mu.Unlock()
	pub := base64.RawURLEncoding.EncodeToString(cur.key.N.Bytes()) // any public bytes serve: none are secret
	return p.sign(jwt.SigningMethodHS256, []byte(pub), cur.kid, claims)
}

// SignNone builds an unsigned token (`alg: none`).
func (p *Provider) SignNone(claims map[string]any) string {
	return p.sign(jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, p.KID(), claims)
}

func (p *Provider) sign(method jwt.SigningMethod, key any, kid string, claims map[string]any) string {
	p.tb.Helper()
	tok := jwt.NewWithClaims(method, jwt.MapClaims(claims))
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(key)
	if err != nil {
		p.tb.Fatalf("oidctest: sign token: %v", err)
	}
	return s
}

// Tamper replaces the payload of a signed token with a different, still-valid
// JSON payload (the subject changed to victim) and keeps the original signature.
func Tamper(tb testing.TB, token, victim string) string {
	tb.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		tb.Fatalf("oidctest: not a compact JWT: %q", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		tb.Fatalf("oidctest: decode payload: %v", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		tb.Fatalf("oidctest: parse payload: %v", err)
	}
	claims["sub"] = victim
	forged, err := json.Marshal(claims)
	if err != nil {
		tb.Fatalf("oidctest: encode payload: %v", err)
	}
	parts[1] = base64.RawURLEncoding.EncodeToString(forged)
	return strings.Join(parts, ".")
}
