package httpx_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"example.com/api-service/internal/platform/httpx"
	"example.com/api-service/internal/platform/logging"
	"example.com/api-service/internal/platform/ratelimit"
)

var ok200 = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok")
})

func serve(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestChainOrderIsOutermostFirst(t *testing.T) {
	t.Parallel()
	var order []string
	mk := func(name string) httpx.Middleware {
		return func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				order = append(order, name)
				next.ServeHTTP(w, r)
			})
		}
	}
	serve(httpx.Chain(ok200, mk("a"), mk("b"), mk("c")), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if strings.Join(order, "") != "abc" {
		t.Fatalf("order = %v", order)
	}
}

func TestRequestID(t *testing.T) {
	t.Parallel()
	var seen string
	h := httpx.RequestID(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { seen = logging.RequestID(r.Context()) }))

	t.Run("mints one", func(t *testing.T) {
		rec := serve(h, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
		id := rec.Header().Get("X-Request-Id")
		if len(id) != 32 || id != seen {
			t.Fatalf("header %q, context %q", id, seen)
		}
	})
	t.Run("keeps a sane inbound id", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
		req.Header.Set("X-Request-Id", "trace-123.abc_DEF")
		if got := serve(h, req).Header().Get("X-Request-Id"); got != "trace-123.abc_DEF" {
			t.Fatalf("id = %q", got)
		}
	})
	t.Run("replaces hostile ids", func(t *testing.T) {
		for _, bad := range []string{"has space", "new\nline", strings.Repeat("a", 65), "semi;colon", "é"} {
			req := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
			req.Header.Set("X-Request-Id", bad)
			got := serve(h, req).Header().Get("X-Request-Id")
			if got == bad || len(got) != 32 {
				t.Errorf("hostile id %q was accepted as %q", bad, got)
			}
		}
	})
}

func TestAccessLog(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logger := logging.New(&buf, slog.LevelDebug)
	clockTicks := []time.Time{time.Unix(100, 0), time.Unix(100, int64(42*time.Millisecond))}
	i := 0
	now := func() time.Time { t := clockTicks[min(i, 1)]; i++; return t }
	h := httpx.AccessLog(logger, now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, "tea")
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/items?token=do-not-log", http.NoBody)
	req.RemoteAddr = "203.0.113.9:5555"
	serve(h, req)

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["method"] != "GET" || line["path"] != "/v1/items" || line["status"] != float64(418) ||
		line["bytes"] != float64(3) || line["duration_ms"] != float64(42) || line["remote_ip"] != "203.0.113.9" {
		t.Fatalf("access log line: %v", line)
	}
	if strings.Contains(buf.String(), "do-not-log") {
		t.Fatal("the query string must never be logged")
	}
}

func TestAccessLogLevels(t *testing.T) {
	t.Parallel()
	tests := []struct {
		path   string
		status int
		want   string
	}{
		{"/v1/items", 200, "INFO"},
		{"/v1/items", 500, "ERROR"},
		{"/healthz", 200, "DEBUG"},
		{"/readyz", 200, "DEBUG"},
	}
	for _, tt := range tests {
		var buf bytes.Buffer
		h := httpx.AccessLog(logging.New(&buf, slog.LevelDebug), time.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tt.status)
		}))
		serve(h, httptest.NewRequest(http.MethodGet, tt.path, http.NoBody))
		if !strings.Contains(buf.String(), `"level":"`+tt.want+`"`) {
			t.Errorf("%s %d: want level %s, got %s", tt.path, tt.status, tt.want, buf.String())
		}
	}
}

func TestRecover(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logger := logging.New(&buf, slog.LevelInfo)

	t.Run("panic becomes a 500 problem and is logged", func(t *testing.T) {
		h := httpx.Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("kaboom") }),
			httpx.RequestID, httpx.Recover(logger))
		rec := serve(h, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
		p := decodeProblem(t, rec)
		if rec.Code != 500 || p.RequestID == "" {
			t.Fatalf("%d %+v", rec.Code, p)
		}
		if strings.Contains(rec.Body.String(), "kaboom") {
			t.Fatal("the panic value leaked to the client")
		}
		if !strings.Contains(buf.String(), "kaboom") || !strings.Contains(buf.String(), "stack") {
			t.Fatalf("panic not logged with a stack: %s", buf.String())
		}
	})
	t.Run("does not write twice when the response has started", func(t *testing.T) {
		h := httpx.AccessLog(logger, time.Now)(httpx.Recover(logger)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusAccepted)
			panic("late")
		})))
		rec := serve(h, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
		if rec.Code != http.StatusAccepted || rec.Body.Len() != 0 {
			t.Fatalf("a started response was overwritten: %d %q", rec.Code, rec.Body)
		}
	})
	t.Run("ErrAbortHandler is passed through", func(t *testing.T) {
		defer func() {
			if v := recover(); v != http.ErrAbortHandler { //nolint:errorlint // sentinel compared by identity
				t.Fatalf("recovered %v, want http.ErrAbortHandler", v)
			}
		}()
		serve(httpx.Recover(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) })),
			httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	})
}

func TestSecurityHeaders(t *testing.T) {
	t.Parallel()
	want := map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"Referrer-Policy":              "no-referrer",
		"Content-Security-Policy":      "default-src 'none'; frame-ancestors 'none'",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cache-Control":                "no-store",
	}
	dev := serve(httpx.SecurityHeaders(false)(ok200), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	for k, v := range want {
		if got := dev.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if dev.Header().Get("Permissions-Policy") == "" {
		t.Error("Permissions-Policy missing")
	}
	if dev.Header().Get("Strict-Transport-Security") != "" {
		t.Error("HSTS must not be sent outside production")
	}
	prod := serve(httpx.SecurityHeaders(true)(ok200), httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if got := prod.Header().Get("Strict-Transport-Security"); !strings.Contains(got, "max-age=63072000") {
		t.Errorf("HSTS = %q", got)
	}
}

func TestCORS(t *testing.T) {
	t.Parallel()
	h := httpx.CORS([]string{"https://app.example.com"})(ok200)

	t.Run("no origin is not CORS", func(t *testing.T) {
		rec := serve(h, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
		if rec.Header().Get("Access-Control-Allow-Origin") != "" || rec.Header().Get("Vary") != "" {
			t.Fatalf("headers added to a same-origin request: %v", rec.Header())
		}
	})
	t.Run("allowed origin is echoed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
		req.Header.Set("Origin", "https://app.example.com")
		rec := serve(h, req)
		if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" || rec.Header().Get("Vary") != "Origin" {
			t.Fatalf("headers: %v", rec.Header())
		}
		if rec.Code != 200 {
			t.Fatalf("status %d", rec.Code)
		}
	})
	t.Run("other origin gets no CORS headers", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
		req.Header.Set("Origin", "https://evil.example.net")
		rec := serve(h, req)
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("a disallowed origin was allowed: %v", rec.Header())
		}
	})
	t.Run("preflight from an allowed origin is answered here", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/v1/items", http.NoBody)
		req.Header.Set("Origin", "https://app.example.com")
		req.Header.Set("Access-Control-Request-Method", "POST")
		rec := serve(h, req)
		if rec.Code != http.StatusNoContent || !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") ||
			!strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") || rec.Header().Get("Access-Control-Max-Age") == "" {
			t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
		}
	})
	t.Run("preflight from another origin is not answered", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/v1/items", http.NoBody)
		req.Header.Set("Origin", "https://evil.example.net")
		req.Header.Set("Access-Control-Request-Method", "POST")
		rec := serve(h, req)
		if rec.Header().Get("Access-Control-Allow-Methods") != "" {
			t.Fatalf("preflight granted: %v", rec.Header())
		}
	})
}

func TestClientIP(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest(http.MethodGet, "/", http.NoBody)
	req.RemoteAddr = "198.51.100.4:1234"
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	if got := httpx.ClientIP(req); got != "198.51.100.4" {
		t.Fatalf("ClientIP = %q: X-Forwarded-For must not be trusted", got)
	}
	req.RemoteAddr = "no-port"
	if got := httpx.ClientIP(req); got != "no-port" {
		t.Fatalf("ClientIP = %q", got)
	}
}

func TestRateLimit(t *testing.T) {
	t.Parallel()
	now := time.Unix(1_700_000_000, 0)
	l := ratelimit.New(1, 2, time.Minute, func() time.Time { return now })
	h := httpx.RateLimit(l, httpx.NotProbe)(ok200)
	call := func(path, ip string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, http.NoBody)
		req.RemoteAddr = ip + ":1"
		return serve(h, req)
	}

	call("/v1/items", "1.1.1.1")
	call("/v1/items", "1.1.1.1")
	rec := call("/v1/items", "1.1.1.1")
	p := decodeProblem(t, rec)
	if rec.Code != 429 || p.Type != "urn:problem:rate-limited" {
		t.Fatalf("third request: %d %s", rec.Code, p.Type)
	}
	if secs, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || secs < 1 {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
	if call("/v1/items", "2.2.2.2").Code != 200 {
		t.Fatal("another client must not be affected")
	}
	for range 10 {
		if call("/healthz", "1.1.1.1").Code != 200 || call("/readyz", "1.1.1.1").Code != 200 {
			t.Fatal("probes must never be rate limited")
		}
	}
}

func TestPathPrefixMatcher(t *testing.T) {
	t.Parallel()
	m := httpx.PathPrefix("/v1/auth/login", "/v1/auth/register")
	for path, want := range map[string]bool{"/v1/auth/login": true, "/v1/auth/register": true, "/v1/auth/me": false, "/v1/items": false} {
		if got := m(httptest.NewRequest(http.MethodPost, path, http.NoBody)); got != want {
			t.Errorf("match(%s) = %v, want %v", path, got, want)
		}
	}
	l := ratelimit.New(1, 1, time.Minute, nil)
	h := httpx.RateLimit(l, m)(ok200)
	for range 5 {
		if serve(h, httptest.NewRequest(http.MethodGet, "/v1/items", http.NoBody)).Code != 200 {
			t.Fatal("an unmatched path must bypass the limiter")
		}
	}
}

func TestMaxBody(t *testing.T) {
	t.Parallel()
	read := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			httpx.RequestErrorHandler(slog.New(slog.DiscardHandler))(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	h := httpx.MaxBody(10)(read)

	if rec := serve(h, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("0123456789"))); rec.Code != 204 {
		t.Fatalf("body at the limit: %d", rec.Code)
	}
	rec := serve(h, httptest.NewRequest(http.MethodPost, "/", strings.NewReader("0123456789x")))
	if decodeProblem(t, rec); rec.Code != 413 {
		t.Fatalf("declared oversize: %d", rec.Code)
	}
	chunked := httptest.NewRequest(http.MethodPost, "/", io.NopCloser(strings.NewReader(strings.Repeat("x", 100))))
	chunked.ContentLength = -1 // unknown length: only the streaming cap can stop it
	if rec := serve(h, chunked); rec.Code != 413 {
		t.Fatalf("streamed oversize: %d", rec.Code)
	}
}

func TestTimeoutSetsDeadline(t *testing.T) {
	t.Parallel()
	var deadline time.Time
	var has bool
	h := httpx.Timeout(time.Minute)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { deadline, has = r.Context().Deadline() }))
	serve(h, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if !has || time.Until(deadline) > time.Minute || time.Until(deadline) < 50*time.Second {
		t.Fatalf("deadline = %v (set: %v)", deadline, has)
	}
}

func TestRequireJSON(t *testing.T) {
	t.Parallel()
	h := httpx.RequireJSON(ok200)
	call := func(method, contentType, body string) int {
		req := httptest.NewRequest(method, "/", strings.NewReader(body))
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		return serve(h, req).Code
	}
	for _, ok := range []string{"application/json", "application/json; charset=utf-8", "Application/JSON"} {
		if code := call("POST", ok, "{}"); code != 200 {
			t.Errorf("%q refused: %d", ok, code)
		}
	}
	for _, bad := range []string{"", "text/plain", "application/xml", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "application/jsonx", "json", ";;;"} {
		if code := call("POST", bad, "{}"); code != 415 {
			t.Errorf("%q accepted for a POST body: %d", bad, code)
		}
		if code := call("PUT", bad, "{}"); code != 415 {
			t.Errorf("%q accepted for a PUT body: %d", bad, code)
		}
	}
	if code := call("POST", "", ""); code != 200 {
		t.Errorf("a body-less POST (logout) must pass: %d", code)
	}
	if code := call("GET", "text/plain", ""); code != 200 {
		t.Errorf("GET is not a write: %d", code)
	}
	if code := call("DELETE", "", ""); code != 200 {
		t.Errorf("DELETE without a body: %d", code)
	}
}

// The recorder must not hide optional interfaces of the real writer: handlers
// reach Flush (and Hijack, SetWriteDeadline) through http.ResponseController.
func TestRecorderUnwrapsForResponseController(t *testing.T) {
	t.Parallel()
	flushed := false
	h := httpx.AccessLog(slog.New(slog.DiscardHandler), time.Now)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("Flush through the wrapper: %v", err)
		}
		flushed = true
	}))
	rec := serve(h, httptest.NewRequest(http.MethodGet, "/", http.NoBody))
	if !flushed || !rec.Flushed {
		t.Fatalf("the flush did not reach the underlying writer (handler ran: %v, flushed: %v)", flushed, rec.Flushed)
	}
}
