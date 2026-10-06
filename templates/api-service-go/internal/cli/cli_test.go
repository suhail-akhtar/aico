package cli_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/api-service/internal/cli"
	"example.com/api-service/internal/platform/database"
	"example.com/api-service/internal/platform/database/dbtest"
	"example.com/api-service/internal/platform/oidctest"
	"example.com/api-service/internal/platform/version"
)

const seedPassword = "seed-password-for-tests" // standards-allow: secret (fake test value)

func envOf(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

// syncBuffer lets the server goroutine write logs while the test reads them.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func run(args []string, env map[string]string) (code int, stdout, stderr string) {
	var out, errb syncBuffer
	code = cli.Run(context.Background(), args, envOf(env), &out, &errb)
	return code, out.String(), errb.String()
}

func TestVersionAndHelp(t *testing.T) {
	t.Parallel()
	for _, arg := range []string{"version", "--version"} {
		code, out, _ := run([]string{arg}, nil)
		if code != 0 || !strings.Contains(out, version.Version) {
			t.Errorf("%s: %d %q", arg, code, out)
		}
	}
	for _, arg := range []string{"help", "-h", "--help"} {
		code, out, _ := run([]string{arg}, nil)
		if code != 0 || !strings.Contains(out, "healthcheck") || !strings.Contains(out, "migrate") {
			t.Errorf("%s: %d %q", arg, code, out)
		}
	}
}

func TestUnknownCommandIsAUsageError(t *testing.T) {
	t.Parallel()
	code, _, errOut := run([]string{"frobnicate"}, nil)
	if code != 2 || !strings.Contains(errOut, `unknown command "frobnicate"`) {
		t.Fatalf("%d %q", code, errOut)
	}
}

func TestBadConfigurationExitsTwoAndNamesTheProblem(t *testing.T) {
	t.Parallel()
	for _, cmd := range []string{"serve", "migrate", "seed"} {
		code, _, errOut := run([]string{cmd}, map[string]string{"PORT": "banana"})
		if code != 2 || !strings.Contains(errOut, "DATABASE_URL") || !strings.Contains(errOut, "PORT") {
			t.Errorf("%s: %d %q", cmd, code, errOut)
		}
	}
	code, _, _ := run(nil, map[string]string{}) // no args means serve, and serve needs configuration
	if code != 2 {
		t.Errorf("default command with no configuration: %d", code)
	}
}

func TestSeedRefusesProductionAndWeakPasswords(t *testing.T) {
	t.Parallel()
	base := map[string]string{"DATABASE_URL": "postgres://u:p@127.0.0.1:1/db"}
	prod := map[string]string{"APP_ENV": "production", "SEED_PASSWORD": seedPassword}
	for k, v := range base {
		prod[k] = v
	}
	if code, out, _ := run([]string{"seed"}, prod); code != 1 || !strings.Contains(out, "refusing to seed in production") {
		t.Errorf("production: %d %s", code, out)
	}
	weak := map[string]string{"SEED_PASSWORD": "short"}
	for k, v := range base {
		weak[k] = v
	}
	if code, out, _ := run([]string{"seed"}, weak); code != 1 || !strings.Contains(out, "SEED_PASSWORD") {
		t.Errorf("weak password: %d %s", code, out)
	}
}

func TestHealthcheck(t *testing.T) {
	t.Parallel()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }))
	defer broken.Close()
	port := func(s *httptest.Server) string {
		_, p, _ := net.SplitHostPort(strings.TrimPrefix(s.URL, "http://"))
		return p
	}

	if code, _, errOut := run([]string{"healthcheck"}, map[string]string{"PORT": port(healthy)}); code != 0 {
		t.Errorf("healthy: %d %s", code, errOut)
	}
	if code, _, errOut := run([]string{"healthcheck"}, map[string]string{"PORT": port(broken)}); code != 1 || !strings.Contains(errOut, "503") {
		t.Errorf("unhealthy: %d %s", code, errOut)
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	p := port(closed)
	closed.Close()
	if code, _, _ := run([]string{"healthcheck"}, map[string]string{"PORT": p}); code != 1 {
		t.Errorf("nothing listening: %d", code)
	}
	for _, bad := range []string{"0", "70000", "abc", "-1"} {
		if code, _, errOut := run([]string{"healthcheck"}, map[string]string{"PORT": bad}); code != 1 || !strings.Contains(errOut, "invalid PORT") {
			t.Errorf("PORT=%s: %d %s", bad, code, errOut)
		}
	}
}

func TestHealthcheckDefaultsToPort8080(t *testing.T) {
	t.Parallel()
	err := cli.Healthcheck(context.Background(), envOf(nil), &http.Client{Timeout: time.Second})
	// Nothing is expected on :8080 here; whatever happens, the probe must have
	// targeted the documented default.
	if err != nil && !strings.Contains(err.Error(), "127.0.0.1:8080/healthz") && !strings.Contains(err.Error(), "answered") {
		t.Fatalf("the default probe did not target :8080: %v", err)
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	return strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
}

func TestMigrateAndSeed(t *testing.T) {
	t.Parallel()
	dsn, _ := dbtest.Schema(t)
	env := map[string]string{"DATABASE_URL": dsn, "APP_ENV": "development", "SEED_PASSWORD": seedPassword, "SEED_EMAIL": "demo@example.com", "ARGON2_MEMORY_KIB": "19456", "ARGON2_ITERATIONS": "2"}

	if code, out, errOut := run([]string{"migrate"}, env); code != 0 || !strings.Contains(out, "migrations applied") {
		t.Fatalf("migrate: %d %s %s", code, out, errOut)
	}
	if code, out, _ := run([]string{"seed"}, env); code != 0 || !strings.Contains(out, "seeded demo account") {
		t.Fatalf("seed: %d %s", code, out)
	}
	if code, out, _ := run([]string{"seed"}, env); code != 0 || !strings.Contains(out, "already exists") {
		t.Fatalf("seeding twice must be a harmless no-op: %d %s", code, out)
	}

	ctx := context.Background()
	pool, err := database.Open(ctx, dsn, database.Options{MaxConns: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var users, itemCount int
	if err := pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM items)").Scan(&users, &itemCount); err != nil {
		t.Fatal(err)
	}
	if users != 1 || itemCount != 3 {
		t.Fatalf("seeded %d users and %d items, want 1 and 3", users, itemCount)
	}
	var hash string
	if err := pool.QueryRow(ctx, "SELECT password_hash FROM users").Scan(&hash); err != nil || !strings.HasPrefix(hash, "$argon2id$") || strings.Contains(hash, seedPassword) {
		t.Fatalf("seeded password hash: %q %v", hash, err)
	}
}

// TestServeEndToEnd boots the real server exactly as `server serve` does: config
// from the environment, migrations, listen, serve the API, then shut down on
// context cancellation.
func TestServeEndToEnd(t *testing.T) {
	t.Parallel()
	dsn, _ := dbtest.Schema(t)
	port := freePort(t)
	env := map[string]string{
		"DATABASE_URL": dsn, "APP_ENV": "development", "HOST": "127.0.0.1", "PORT": port,
		"SHUTDOWN_TIMEOUT": "5s", "ARGON2_MEMORY_KIB": "19456", "ARGON2_ITERATIONS": "2", "LOG_LEVEL": "info",
	}

	ctx, stop := context.WithCancel(context.Background())
	var out, errb syncBuffer
	done := make(chan int, 1)
	go func() { done <- cli.Run(ctx, []string{"serve"}, envOf(env), &out, &errb) }()

	base := "http://127.0.0.1:" + port
	// No keep-alive: an idle or half-open client connection would make the server wait for it to close.
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	deadline := time.Now().Add(30 * time.Second)
	for cli.Healthcheck(context.Background(), envOf(env), client) != nil {
		if time.Now().After(deadline) {
			stop()
			t.Fatalf("the server never became healthy.\nstdout: %s\nstderr: %s", out.String(), errb.String())
		}
		time.Sleep(50 * time.Millisecond)
	}

	post := func(path, body string) (int, string) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, base+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return resp.StatusCode, buf.String()
	}
	creds := `{"email":"ada@example.com","password":"` + seedPassword + `"}`
	if code, body := post("/v1/auth/register", creds); code != 201 {
		t.Fatalf("register: %d %s", code, body)
	}
	code, body := post("/v1/auth/login", creds)
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal([]byte(body), &tok); err != nil || code != 200 || tok.AccessToken == "" {
		t.Fatalf("login: %d %s", code, body)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/readyz", http.NoBody)
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("readyz: %v %v", err, resp)
	}
	_ = resp.Body.Close()

	stop()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit code %d\nstdout: %s\nstderr: %s", code, out.String(), errb.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the server did not exit after its context was cancelled")
	}
	logs := out.String()
	for _, want := range []string{`"msg":"starting"`, `"msg":"server listening"`, `"msg":"shutting down"`, `"msg":"server stopped"`, `"request_id"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("startup log lacks %s", want)
		}
	}
	secrets := []string{seedPassword, tok.AccessToken}
	if u, err := url.Parse(dsn); err == nil && u.User != nil {
		if pw, ok := u.User.Password(); ok && pw != "" {
			secrets = append(secrets, pw)
		}
	}
	for _, secret := range secrets {
		if strings.Contains(logs, secret) {
			t.Errorf("a secret reached the logs: %q", secret)
		}
	}
}

func TestServeFailsWhenMigrationsArePendingAndAutoMigrateIsOff(t *testing.T) {
	t.Parallel()
	dsn, _ := dbtest.Schema(t) // empty schema: every migration is pending
	env := map[string]string{"DATABASE_URL": dsn, "HOST": "127.0.0.1", "PORT": freePort(t), "MIGRATE_ON_START": "false"}
	code, out, _ := run([]string{"serve"}, env)
	if code != 1 || !strings.Contains(out, "migrations are pending") {
		t.Fatalf("%d %s", code, out)
	}
}

func TestServeFailsFastWhenTheDatabaseIsUnreachable(t *testing.T) {
	t.Parallel()
	env := map[string]string{"DATABASE_URL": "postgres://u:p@127.0.0.1:1/db?connect_timeout=1&sslmode=disable", "PORT": freePort(t)}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var out, errb syncBuffer
	if code := cli.Run(ctx, []string{"serve"}, envOf(env), &out, &errb); code != 1 || !strings.Contains(out.String(), "command failed") {
		t.Fatalf("%d %s", code, out.String())
	}
}

func TestServeWarnsAboutInsecureDatabaseURLInProduction(t *testing.T) {
	t.Parallel()
	env := map[string]string{"APP_ENV": "production", "DATABASE_URL": "postgres://u:p@127.0.0.1:1/db?connect_timeout=1&sslmode=disable", "PORT": freePort(t)}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var out, errb syncBuffer
	cli.Run(ctx, []string{"serve"}, envOf(env), &out, &errb)
	if !strings.Contains(out.String(), "sslmode=disable in production") {
		t.Fatalf("no warning: %s", out.String())
	}
}

func TestListenFailureIsReported(t *testing.T) {
	t.Parallel()
	dsn, _ := dbtest.Schema(t)
	busy, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	port := strconv.Itoa(busy.Addr().(*net.TCPAddr).Port)
	env := map[string]string{"DATABASE_URL": dsn, "HOST": "127.0.0.1", "PORT": port, "ARGON2_MEMORY_KIB": "19456", "ARGON2_ITERATIONS": "2"}
	if code, out, _ := run([]string{"serve"}, env); code != 1 || !strings.Contains(out, "listen on") {
		t.Fatalf("%d %s", code, out)
	}
}

func TestOIDCModeWithoutItsSettingsExitsTwoNamingThem(t *testing.T) {
	t.Parallel()
	for _, cmd := range []string{"serve", "migrate", "seed"} {
		code, _, errOut := run([]string{cmd}, map[string]string{"DATABASE_URL": "postgres://u:p@h/db", "AUTH_MODE": "oidc"})
		if code != 2 {
			t.Errorf("%s: exit %d, want 2", cmd, code)
		}
		for _, want := range []string{"OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE"} {
			if !strings.Contains(errOut, want) {
				t.Errorf("%s: the error does not name %s: %q", cmd, want, errOut)
			}
		}
	}
}

func TestSeedDoesNothingInOIDCMode(t *testing.T) {
	t.Parallel()
	dsn, _ := dbtest.Schema(t)
	env := map[string]string{
		"DATABASE_URL": dsn, "SEED_PASSWORD": seedPassword, "AUTH_MODE": "oidc",
		"OIDC_ISSUER": oidctest.Issuer, "OIDC_JWKS_URI": "http://keycloak:8080/certs", "OIDC_AUDIENCE": oidctest.Audience,
	}
	code, out, errOut := run([]string{"seed"}, env)
	if code != 0 || !strings.Contains(out, "seed skipped: AUTH_MODE=oidc") {
		t.Fatalf("seed: %d %s %s", code, out, errOut)
	}
	// The command did not even connect: the schema is still empty.
	ctx := context.Background()
	pool, err := database.Open(ctx, dsn, database.Options{MaxConns: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var tables int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()").Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("seed in oidc mode touched the database: %d tables, %v", tables, err)
	}
}

// TestServeInOIDCMode boots the real server with AUTH_MODE=oidc against an
// in-process identity provider and drives it over a real socket.
func TestServeInOIDCMode(t *testing.T) {
	t.Parallel()
	dsn, _ := dbtest.Schema(t)
	provider := oidctest.NewProvider(t)
	port := freePort(t)
	env := map[string]string{
		"DATABASE_URL": dsn, "APP_ENV": "development", "HOST": "127.0.0.1", "PORT": port, "SHUTDOWN_TIMEOUT": "5s",
		"AUTH_MODE": "oidc", "OIDC_ISSUER": oidctest.Issuer, "OIDC_JWKS_URI": provider.JWKSURL(), "OIDC_AUDIENCE": oidctest.Audience,
	}
	ctx, stop := context.WithCancel(context.Background())
	var out, errb syncBuffer
	done := make(chan int, 1)
	go func() { done <- cli.Run(ctx, []string{"serve"}, envOf(env), &out, &errb) }()

	base := "http://127.0.0.1:" + port
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	deadline := time.Now().Add(30 * time.Second)
	for cli.Healthcheck(context.Background(), envOf(env), client) != nil {
		if time.Now().After(deadline) {
			stop()
			t.Fatalf("the server never became healthy.\nstdout: %s\nstderr: %s", out.String(), errb.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
	call := func(method, path, token string) (int, string) {
		req, _ := http.NewRequestWithContext(ctx, method, base+path, http.NoBody)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return resp.StatusCode, buf.String()
	}
	token := provider.Sign(provider.Claims(time.Now(), "7b0f5e1c-3a52-4d4e-9d0e-1f6a2b3c4d5e", "ada@example.com"))
	if code, body := call("GET", "/v1/auth/me", token); code != 200 || !strings.Contains(body, "ada@example.com") {
		t.Fatalf("me: %d %s", code, body)
	}
	if code, _ := call("GET", "/v1/auth/me", ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, body := call("POST", "/v1/auth/login", ""); code != 404 || !strings.Contains(body, "Local authentication is disabled") {
		t.Fatalf("login: %d %s", code, body)
	}

	stop()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit code %d\nstdout: %s\nstderr: %s", code, out.String(), errb.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the server did not exit after its context was cancelled")
	}
	logs := out.String()
	if !strings.Contains(logs, `"auth_mode":"oidc"`) || !strings.Contains(logs, `"oidc_issuer"`) || !strings.Contains(logs, "provisioned account from identity provider") {
		t.Errorf("the startup and provisioning lines are missing:\n%s", logs)
	}
	if strings.Contains(logs, token) {
		t.Error("a token reached the logs")
	}
}
