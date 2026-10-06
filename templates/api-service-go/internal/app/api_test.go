package app_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
)

func TestProbes(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)

	if r := ta.get("/healthz", ""); r.Code != 200 || strings.TrimSpace(string(r.Body)) != `{"status":"ok"}` {
		t.Fatalf("healthz: %d %s", r.Code, r.Body)
	}
	if r := ta.get("/readyz", ""); r.Code != 200 {
		t.Fatalf("readyz: %d %s", r.Code, r.Body)
	}

	ta.pinged = func() error { return fmt.Errorf("connection refused to postgres://u:secretpw@db/x") }
	r := ta.get("/readyz", "")
	if p := r.problem(t); r.Code != 503 || p.Type != "urn:problem:unavailable" {
		t.Fatalf("readyz with the database down: %d %+v", r.Code, p)
	}
	if strings.Contains(string(r.Body), "secretpw") {
		t.Fatal("readiness leaked the database error to the client")
	}
	if r := ta.get("/healthz", ""); r.Code != 200 {
		t.Fatalf("liveness must not depend on the database: %d", r.Code)
	}
}

func TestReadinessFlipsWhenDraining(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	if r := ta.get("/readyz", ""); r.Code != 200 {
		t.Fatalf("before drain: %d", r.Code)
	}
	ta.app.Drain()
	if r := ta.get("/readyz", ""); r.Code != 503 {
		t.Fatalf("while draining: %d", r.Code)
	}
	if r := ta.get("/healthz", ""); r.Code != 200 {
		t.Fatalf("liveness while draining: %d", r.Code)
	}
}

func TestOpenAPIIsServed(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	r := ta.get("/openapi.yaml", "")
	if r.Code != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/yaml") || !strings.Contains(string(r.Body), "openapi: 3.0.3") {
		t.Fatalf("openapi.yaml: %d %q", r.Code, r.Header.Get("Content-Type"))
	}
}

func TestAccountLifecycle(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	creds := map[string]string{"email": "Ada@Example.com", "password": testPassword}

	r := ta.do(request{method: "POST", path: "/v1/auth/register", body: creds})
	var user struct{ ID, Email string }
	r.json(t, &user)
	if r.Code != 201 || user.Email != "ada@example.com" || user.ID == "" {
		t.Fatalf("register: %d %s", r.Code, r.Body)
	}
	if strings.Contains(string(r.Body), "password") || strings.Contains(string(r.Body), "argon2") {
		t.Fatalf("register response exposes credentials: %s", r.Body)
	}

	if r := ta.do(request{method: "POST", path: "/v1/auth/register", body: creds}); r.Code != 409 || r.problem(t).Type != "urn:problem:conflict" {
		t.Fatalf("duplicate register: %d %s", r.Code, r.Body)
	}

	r = ta.do(request{method: "POST", path: "/v1/auth/login", body: creds})
	var tok struct {
		AccessToken string    `json:"access_token"`
		TokenType   string    `json:"token_type"`
		ExpiresAt   time.Time `json:"expires_at"`
	}
	r.json(t, &tok)
	if r.Code != 200 || tok.TokenType != "Bearer" || tok.AccessToken == "" || !tok.ExpiresAt.Equal(ta.clock.Now().Add(time.Hour)) {
		t.Fatalf("login: %d %s", r.Code, r.Body)
	}

	me := ta.get("/v1/auth/me", tok.AccessToken)
	var who struct{ ID, Email string }
	me.json(t, &who)
	if me.Code != 200 || who.ID != user.ID || who.Email != "ada@example.com" {
		t.Fatalf("me: %d %s", me.Code, me.Body)
	}

	if r := ta.do(request{method: "POST", path: "/v1/auth/logout", token: tok.AccessToken}); r.Code != 204 || len(r.Body) != 0 {
		t.Fatalf("logout: %d %s", r.Code, r.Body)
	}
	if r := ta.get("/v1/auth/me", tok.AccessToken); r.Code != 401 {
		t.Fatalf("a revoked token still works: %d", r.Code)
	}
}

func TestLoginFailures(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	ta.signUp("ada@example.com")

	wrong := ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "ada@example.com", "password": "definitely not it"}})
	unknown := ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "nobody@example.com", "password": testPassword}})
	if wrong.Code != 401 || unknown.Code != 401 {
		t.Fatalf("wrong: %d, unknown: %d", wrong.Code, unknown.Code)
	}
	a, b := wrong.problem(t), unknown.problem(t)
	a.RequestID, b.RequestID = "", ""
	if diff := cmp.Diff(a, b); diff != "" {
		t.Fatalf("the two failures must be identical so emails cannot be enumerated (-wrong +unknown):\n%s", diff)
	}
	if r := ta.do(request{method: "POST", path: "/v1/auth/login", body: map[string]string{"email": "ada@example.com"}}); r.Code != 422 {
		t.Fatalf("login without a password: %d %s", r.Code, r.Body)
	}
}

func TestRegisterValidationIsReportedPerField(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	r := ta.do(request{method: "POST", path: "/v1/auth/register", body: map[string]string{"email": "not-an-email", "password": "short"}})
	p := r.problem(t)
	if r.Code != 422 || len(p.Errors) != 2 {
		t.Fatalf("%d %+v", r.Code, p)
	}
	got := map[string]bool{}
	for _, f := range p.Errors {
		got[f.Field] = f.Message != ""
	}
	if !got["email"] || !got["password"] {
		t.Fatalf("errors = %+v", p.Errors)
	}
}

func TestItemsCRUD(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")

	r := ta.do(request{method: "POST", path: "/v1/items", token: tok, body: map[string]any{"name": "  Pen ", "description": "blue", "quantity": 7}})
	var it itemJSON
	r.json(t, &it)
	if r.Code != 201 || it.Name != "Pen" || it.Description != "blue" || it.Quantity != 7 || it.ID == "" {
		t.Fatalf("create: %d %s", r.Code, r.Body)
	}
	if loc := r.Header.Get("Location"); loc != "/v1/items/"+it.ID {
		t.Fatalf("Location = %q", loc)
	}
	if !it.CreatedAt.Equal(ta.clock.Now()) || !it.UpdatedAt.Equal(it.CreatedAt) {
		t.Fatalf("timestamps: %+v", it)
	}

	got := ta.get("/v1/items/"+it.ID, tok)
	var again itemJSON
	got.json(t, &again)
	if diff := cmp.Diff(it, again); got.Code != 200 || diff != "" {
		t.Fatalf("get: %d (-created +fetched):\n%s", got.Code, diff)
	}

	ta.clock.Advance(time.Minute)
	r = ta.do(request{method: "PUT", path: "/v1/items/" + it.ID, token: tok, body: map[string]any{"name": "Marker", "quantity": 2}})
	var up itemJSON
	r.json(t, &up)
	if r.Code != 200 || up.Name != "Marker" || up.Description != "" || up.Quantity != 2 ||
		!up.CreatedAt.Equal(it.CreatedAt) || !up.UpdatedAt.Equal(ta.clock.Now()) {
		t.Fatalf("update: %d %s", r.Code, r.Body)
	}

	if r := ta.do(request{method: "DELETE", path: "/v1/items/" + it.ID, token: tok}); r.Code != 204 || len(r.Body) != 0 {
		t.Fatalf("delete: %d %s", r.Code, r.Body)
	}
	if r := ta.get("/v1/items/"+it.ID, tok); r.Code != 404 || r.problem(t).Type != "urn:problem:not-found" {
		t.Fatalf("get after delete: %d %s", r.Code, r.Body)
	}
	if r := ta.do(request{method: "DELETE", path: "/v1/items/" + it.ID, token: tok}); r.Code != 404 {
		t.Fatalf("second delete: %d", r.Code)
	}
}

func TestItemValidationAnswers422PerField(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	r := ta.do(request{method: "POST", path: "/v1/items", token: tok, body: map[string]any{"name": " ", "quantity": -5, "description": strings.Repeat("x", 1001)}})
	p := r.problem(t)
	if r.Code != 422 || p.Type != "urn:problem:validation-failed" || len(p.Errors) != 3 {
		t.Fatalf("%d %+v", r.Code, p)
	}
	if p.RequestID == "" || p.Instance != "/v1/items" {
		t.Fatalf("problem lacks request id or instance: %+v", p)
	}
}

func TestListPaginationOverHTTP(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")

	empty := ta.get("/v1/items", tok)
	if empty.Code != 200 || strings.TrimSpace(string(empty.Body)) != `{"items":[]}` {
		t.Fatalf("an empty list must be [] and have no cursor: %d %s", empty.Code, empty.Body)
	}

	for i := range 5 {
		ta.clock.Advance(time.Millisecond)
		ta.createItem(tok, fmt.Sprintf("item-%d", i))
	}
	var names []string
	path, pages := "/v1/items?limit=2", 0
	for {
		r := ta.get(path, tok)
		var page struct {
			Items      []itemJSON `json:"items"`
			NextCursor string     `json:"next_cursor"`
		}
		r.json(t, &page)
		if r.Code != 200 {
			t.Fatalf("page %d: %d %s", pages, r.Code, r.Body)
		}
		pages++
		for _, it := range page.Items {
			names = append(names, it.Name)
		}
		if page.NextCursor == "" {
			break
		}
		path = "/v1/items?limit=2&cursor=" + page.NextCursor
	}
	want := []string{"item-4", "item-3", "item-2", "item-1", "item-0"}
	if diff := cmp.Diff(want, names); diff != "" || pages != 3 {
		t.Fatalf("pages=%d (-want +got):\n%s", pages, diff)
	}
}

func TestListParameterValidation(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	tests := []struct {
		query    string
		wantCode int
	}{
		{"limit=0", 422},
		{"limit=101", 422},
		{"limit=-3", 422},
		{"cursor=garbage", 422},
		{"limit=abc", 400},
		{"limit=1.5", 400},
		{"limit=", 400},
		{"limit=100", 200},
		{"limit=1", 200},
	}
	for _, tt := range tests {
		if r := ta.get("/v1/items?"+tt.query, tok); r.Code != tt.wantCode {
			t.Errorf("?%s -> %d, want %d (%s)", tt.query, r.Code, tt.wantCode, r.Body)
		}
	}
}

func TestUnknownRoutesAndMethodsKeepTheProblemContract(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	r := ta.get("/nope", "")
	if p := r.problem(t); r.Code != 404 || p.Type != "urn:problem:not-found" {
		t.Fatalf("unknown route: %d %+v", r.Code, p)
	}
	r = ta.do(request{method: "DELETE", path: "/healthz"})
	if p := r.problem(t); r.Code != 405 || p.Type != "urn:problem:method-not-allowed" || r.Header.Get("Allow") != "GET" {
		t.Fatalf("wrong method: %d %+v Allow=%q", r.Code, p, r.Header.Get("Allow"))
	}
	r = ta.do(request{method: http.MethodPatch, path: "/v1/items/x", token: "irrelevant"})
	if r.Code != 405 {
		t.Fatalf("PATCH on an item: %d", r.Code)
	}
}
