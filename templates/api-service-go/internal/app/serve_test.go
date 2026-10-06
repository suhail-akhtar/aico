package app_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"example.com/api-service/internal/app"
	"example.com/api-service/internal/features/auth"
	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/database/dbtest"
	"example.com/api-service/internal/platform/logging"
)

func listen(t *testing.T) net.Listener {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

// No keep-alive: an idle or half-open client connection would make Shutdown wait for it.
var noKeepAlive = &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}

func fetch(t *testing.T, url string) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := noKeepAlive.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestServeAnswersThenShutsDownGracefully(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, map[string]string{"SHUTDOWN_TIMEOUT": "5s"})
	ln := listen(t)
	var logs bytes.Buffer
	logger := logging.New(&logs, slog.LevelInfo)

	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- app.Serve(ctx, ta.app, ln, testConfig(t, map[string]string{"SHUTDOWN_TIMEOUT": "5s"}), logger)
	}()

	base := "http://" + ln.Addr().String()
	if code, body := fetch(t, base+"/healthz"); code != 200 || !strings.Contains(body, `"ok"`) {
		t.Fatalf("healthz over a real socket: %d %s", code, body)
	}
	if code, _ := fetch(t, base+"/readyz"); code != 200 {
		t.Fatalf("readyz before shutdown: %d", code)
	}

	stop() // what SIGTERM does
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("graceful shutdown returned %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return after its context was cancelled")
	}
	if code := ta.get("/readyz", "").Code; code != 503 {
		t.Fatalf("readiness must report draining after shutdown began: %d", code)
	}
	if _, err := (&net.Dialer{Timeout: time.Second}).DialContext(context.Background(), "tcp", ln.Addr().String()); err == nil {
		t.Fatal("the listener still accepts connections after shutdown")
	}
	for _, want := range []string{"server listening", "shutting down", "server stopped"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("log is missing %q: %s", want, logs.String())
		}
	}
}

func TestServeReportsListenerFailure(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	ln := listen(t)
	_ = ln.Close() // Serve on a closed listener fails immediately
	err := app.Serve(context.Background(), ta.app, ln, testConfig(t, nil), slog.New(slog.DiscardHandler))
	if err == nil || errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("err = %v, want a serve failure", err)
	}
}

func TestNewFailsWhenTheHasherDoes(t *testing.T) {
	t.Parallel()
	users := auth.NewMemoryUserRepository()
	_, err := app.New(context.Background(), app.Options{
		Config: testConfig(t, nil), Logger: slog.New(slog.DiscardHandler),
		Users: users, Sessions: auth.NewMemorySessionRepository(users), Items: items.NewMemoryRepository(),
		Hasher: failingHasher{},
	})
	if err == nil {
		t.Fatal("want an error")
	}
}

type failingHasher struct{}

func (failingHasher) Hash(context.Context, string) (string, error) {
	return "", errors.New("no entropy")
}

func (failingHasher) Verify(context.Context, string, string) (bool, bool, error) {
	return false, false, errors.New("no entropy")
}

// The same API against real PostgreSQL: the assembled application, the sqlc
// adapters and the migrations, end to end through HTTP.
func TestAPIAgainstPostgres(t *testing.T) {
	t.Parallel()
	pool := dbtest.Pool(t)
	cfg := testConfig(t, map[string]string{"ARGON2_MEMORY_KIB": "19456", "ARGON2_ITERATIONS": "2"})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a, err := app.New(ctx, app.PostgresOptions(cfg, slog.New(slog.DiscardHandler), pool))
	if err != nil {
		t.Fatal(err)
	}
	ta := newTestApp(t, nil)
	ta.h = a.Handler() // drive the Postgres-backed app through the same client helpers

	alice, bob := ta.signUp("alice@example.com"), ta.signUp("bob@example.com")
	item := ta.createItem(alice, "from postgres")
	if r := ta.get("/v1/items/"+item.ID, alice); r.Code != 200 {
		t.Fatalf("owner read: %d %s", r.Code, r.Body)
	}
	if r := ta.get("/v1/items/"+item.ID, bob); r.Code != 404 {
		t.Fatalf("foreign read: %d", r.Code)
	}
	if r := ta.do(request{method: "POST", path: "/v1/auth/register", body: map[string]string{"email": "ALICE@example.com", "password": testPassword}}); r.Code != 409 {
		t.Fatalf("duplicate email through the unique index: %d %s", r.Code, r.Body)
	}
	if r := ta.get("/readyz", ""); r.Code != 200 {
		t.Fatalf("readyz with a live pool: %d %s", r.Code, r.Body)
	}
	pool.Close()
	r := ta.get("/readyz", "")
	if r.Code != 503 || strings.Contains(string(r.Body), "closed pool") {
		t.Fatalf("readyz with a dead pool: %d %s", r.Code, r.Body)
	}
}
