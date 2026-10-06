package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/api-service/internal/app"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/config"
	"example.com/api-service/internal/platform/httpx"
	"example.com/api-service/internal/platform/logging"
)

// The API tests build the real application (real middleware, real generated
// router, real services) over in-memory repositories, and call it through
// httptest with no port. PostgreSQL behaviour is covered by the repository
// contract suites and the serve/cli tests.

// testPassword is an obviously fake credential.
const testPassword = "correct horse battery staple" // standards-allow: secret (fake test value)

type testApp struct {
	t         *testing.T
	app       *app.App
	h         http.Handler
	logs      *bytes.Buffer
	clock     *clock.Fake
	users     *auth.MemoryUserRepository // the account store behind app, for tests that seed or inspect it
	pinged    func() error
	mu        sync.Mutex
	exchanges []exchange // every call made through do, for the contract tests
}

// exchange is one recorded request/response pair.
type exchange struct {
	method, uri string
	token       string
	body        []byte
	response    response
}

func testConfig(t *testing.T, env map[string]string) config.Config {
	t.Helper()
	base := map[string]string{
		"DATABASE_URL": "postgres://u:p@localhost:5432/db", "APP_ENV": "test",
		"RATE_LIMIT_RPS": "10000", "RATE_LIMIT_BURST": "10000",
		"AUTH_RATE_LIMIT_PER_MINUTE": "100000", "AUTH_RATE_LIMIT_BURST": "100000",
		"MAX_BODY_BYTES": "4096", "SESSION_TTL": "1h",
	}
	for k, v := range env {
		base[k] = v
	}
	cfg, err := config.Load(func(k string) string { return base[k] })
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func newTestApp(t *testing.T, env map[string]string) *testApp {
	t.Helper()
	logs := &bytes.Buffer{}
	logger := logging.New(logs, slog.LevelDebug)
	fake := clock.NewFake(time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC))
	users := auth.NewMemoryUserRepository()
	ta := &testApp{t: t, logs: logs, clock: fake, users: users}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a, err := app.New(ctx, app.Options{
		Config:   testConfig(t, env),
		Logger:   logger,
		Users:    users,
		Sessions: auth.NewMemorySessionRepository(users),
		Items:    items.NewMemoryRepository(),
		Hasher:   auth.NewArgon2idHasher(auth.Argon2Params{Memory: 8, Iterations: 1, Parallelism: 1, SaltLen: 16, KeyLen: 32}, 0),
		Clock:    fake,
		Ping: func(context.Context) error {
			if ta.pinged != nil {
				return ta.pinged()
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ta.app, ta.h = a, a.Handler()
	return ta
}

// response is a captured reply.
type response struct {
	Code   int
	Header http.Header
	Body   []byte
}

func (r response) json(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		t.Fatalf("body is not JSON: %v: %s", err, r.Body)
	}
}

func (r response) problem(t *testing.T) httpx.Problem {
	t.Helper()
	if ct := r.Header.Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Fatalf("Content-Type = %q, want %q (body: %s)", ct, httpx.ProblemContentType, r.Body)
	}
	var p httpx.Problem
	r.json(t, &p)
	if p.Status != r.Code || p.Type == "" || p.Title == "" {
		t.Fatalf("incomplete problem document: %+v (HTTP %d)", p, r.Code)
	}
	return p
}

// request describes one call.
type request struct {
	method, path string
	body         any // string/[]byte are sent verbatim; anything else is JSON-encoded
	token        string
	header       map[string]string
	remote       string
}

func (ta *testApp) do(r request) response {
	ta.t.Helper()
	var rdr io.Reader = http.NoBody
	switch b := r.body.(type) {
	case nil:
	case string:
		rdr = strings.NewReader(b)
	case []byte:
		rdr = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			ta.t.Fatal(err)
		}
		rdr = bytes.NewReader(raw)
	}
	req := httptest.NewRequestWithContext(ta.t.Context(), r.method, r.path, rdr)
	if r.body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.token != "" {
		req.Header.Set("Authorization", "Bearer "+r.token)
	}
	for k, v := range r.header {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	if r.remote != "" {
		req.RemoteAddr = r.remote
	}
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	res := rec.Result()
	defer func() { _ = res.Body.Close() }()
	body, _ := io.ReadAll(res.Body)
	out := response{Code: res.StatusCode, Header: res.Header, Body: body}
	var sent []byte
	switch b := r.body.(type) {
	case string:
		sent = []byte(b)
	case []byte:
		sent = b
	case nil:
	default:
		sent, _ = json.Marshal(b)
	}
	ta.mu.Lock()
	ta.exchanges = append(ta.exchanges, exchange{method: r.method, uri: r.path, token: r.token, body: sent, response: out})
	ta.mu.Unlock()
	return out
}

func (ta *testApp) get(path, token string) response {
	ta.t.Helper()
	return ta.do(request{method: http.MethodGet, path: path, token: token})
}

// signUp registers and logs in, returning the bearer token.
func (ta *testApp) signUp(email string) string {
	ta.t.Helper()
	creds := map[string]string{"email": email, "password": testPassword}
	if r := ta.do(request{method: http.MethodPost, path: "/v1/auth/register", body: creds}); r.Code != http.StatusCreated {
		ta.t.Fatalf("register %s: %d %s", email, r.Code, r.Body)
	}
	r := ta.do(request{method: http.MethodPost, path: "/v1/auth/login", body: creds})
	if r.Code != http.StatusOK {
		ta.t.Fatalf("login %s: %d %s", email, r.Code, r.Body)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	r.json(ta.t, &tok)
	return tok.AccessToken
}

type itemJSON struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Quantity    int       `json:"quantity"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (ta *testApp) createItem(token, name string) itemJSON {
	ta.t.Helper()
	r := ta.do(request{method: http.MethodPost, path: "/v1/items", token: token, body: map[string]any{"name": name, "quantity": 1}})
	if r.Code != http.StatusCreated {
		ta.t.Fatalf("create %q: %d %s", name, r.Code, r.Body)
	}
	var it itemJSON
	r.json(ta.t, &it)
	return it
}
