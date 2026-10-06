package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"example.com/api-service/internal/platform/logging"
	"example.com/api-service/internal/platform/ratelimit"
)

// Middleware wraps a handler.
type Middleware func(http.Handler) http.Handler

// Chain applies mw so that the first element is the outermost wrapper.
func Chain(h http.Handler, mw ...Middleware) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}

// statusRecorder remembers what was written so the access log and the panic
// recovery know the outcome. Unwrap keeps http.ResponseController working.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int64
	wrote  bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wrote {
		s.status, s.wrote = code, true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if !s.wrote {
		s.status, s.wrote = http.StatusOK, true
	}
	n, err := s.ResponseWriter.Write(p)
	s.bytes += int64(n)
	return n, err
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func recorderOf(w http.ResponseWriter) *statusRecorder {
	if sr, ok := w.(*statusRecorder); ok {
		return sr
	}
	return &statusRecorder{ResponseWriter: w, status: http.StatusOK}
}

// RequestID accepts a sane inbound X-Request-Id (so ids flow across services)
// or mints one, puts it in the context for logs and problems, and echoes it.
// An inbound value is only trusted if it is short and plain: it ends up in log
// lines, so anything else is replaced rather than sanitised.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(logging.WithRequestID(r.Context(), id)))
	})
}

func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.'
		if !ok {
			return false
		}
	}
	return true
}

func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// AccessLog writes one structured line per request: method, path (no query
// string), status, bytes, duration and the client address. Probe routes log at
// debug so they do not drown real traffic.
func AccessLog(logger *slog.Logger, now func() time.Time) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := now()
			rec := recorderOf(w)
			next.ServeHTTP(rec, r)

			level := slog.LevelInfo
			switch {
			case rec.status >= 500:
				level = slog.LevelError
			case r.URL.Path == "/healthz" || r.URL.Path == "/readyz":
				level = slog.LevelDebug
			}
			logger.LogAttrs(r.Context(), level, "request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Int64("bytes", rec.bytes),
				slog.Int64("duration_ms", now().Sub(start).Milliseconds()),
				slog.String("remote_ip", ClientIP(r)),
			)
		})
	}
}

// Recover turns a panic in a handler into a logged 500 with a request id. It
// re-panics http.ErrAbortHandler, which net/http uses deliberately.
func Recover(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler { //nolint:errorlint // sentinel compared by identity, as net/http documents
					panic(v)
				}
				logger.ErrorContext(r.Context(), "panic in handler", slog.Any("panic", v), slog.String("stack", string(debug.Stack())))
				if !recorderOf(w).wrote {
					WriteProblem(w, r, NewProblem(http.StatusInternalServerError, "internal", "Internal server error", "Something went wrong. Quote the request id when reporting it."))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// SecurityHeaders sets the response headers an API wants on every reply (OWASP
// HTTP Headers and REST Security cheat sheets). HSTS is added only in
// production: over plain HTTP it is ignored, and a development host that
// received it would be stuck on HTTPS. `Cache-Control: no-store` keeps tokens
// and per-user data out of shared caches.
func SecurityHeaders(production bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
			h.Set("Cross-Origin-Opener-Policy", "same-origin")
			h.Set("Cross-Origin-Resource-Policy", "same-origin")
			h.Set("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()")
			h.Set("Cache-Control", "no-store")
			if production {
				h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CORS answers cross-origin requests for an explicit allow-list only. A request
// from any other origin passes through untouched and therefore without CORS
// headers, so the browser blocks it. Preflights from allowed origins are
// answered here and never reach rate limiting or authentication.
func CORS(allowed []string) Middleware {
	set := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		set[o] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin == "" {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Add("Vary", "Origin")
			if _, ok := set[origin]; !ok {
				next.ServeHTTP(w, r)
				return
			}
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Expose-Headers", "X-Request-Id, Retry-After, Location")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Add("Vary", "Access-Control-Request-Method")
				h.Add("Vary", "Access-Control-Request-Headers")
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Id")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ClientIP is the peer address. X-Forwarded-For is deliberately NOT trusted:
// any client can set it, which would let one machine dodge rate limits by
// rotating the header. Behind a proxy, enforce limits at the proxy or add a
// trusted-proxy list here (docs/ARCHITECTURE.md, "Growing up").
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// RateLimit rejects requests over the limiter's budget with a 429 problem and a
// Retry-After header. match selects the requests the limiter applies to.
func RateLimit(l *ratelimit.Limiter, match func(*http.Request) bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if match != nil && !match(r) {
				next.ServeHTTP(w, r)
				return
			}
			if ok, wait := l.Allow(ClientIP(r)); !ok {
				secs := int(wait.Seconds()) + 1
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				WriteProblem(w, r, NewProblem(http.StatusTooManyRequests, "rate-limited", "Too many requests", "Slow down and retry after the delay in Retry-After."))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// NotProbe is a RateLimit matcher that exempts the liveness and readiness
// routes: an orchestrator probing every second must never be throttled.
func NotProbe(r *http.Request) bool {
	return r.URL.Path != "/healthz" && r.URL.Path != "/readyz"
}

// PathPrefix returns a RateLimit matcher for requests under any of prefixes.
func PathPrefix(prefixes ...string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		for _, p := range prefixes {
			if strings.HasPrefix(r.URL.Path, p) {
				return true
			}
		}
		return false
	}
}

// MaxBody caps request bodies. A declared Content-Length over the limit is
// refused before reading anything; an undeclared (chunked) body is cut off by
// http.MaxBytesReader and surfaces as *http.MaxBytesError while decoding.
func MaxBody(limit int64) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > limit {
				WriteProblem(w, r, ProblemFor(r, nil, &http.MaxBytesError{Limit: limit}))
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			next.ServeHTTP(w, r)
		})
	}
}

// Timeout gives every request a context deadline. Database calls and outbound
// requests take that context, so a stuck dependency fails the request instead
// of holding a goroutine and a connection until the client gives up.
func Timeout(d time.Duration) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireJSON answers 415 to a write request that carries a body in any media
// type other than application/json. The generated decoder would happily parse
// a JSON document sent as text/plain, and a text/plain or form-encoded POST is
// exactly what a cross-site HTML form can send without a CORS preflight, so
// refusing it is a CSRF defence in depth as well as a contract check. A request
// with no body (logout, delete) is unaffected.
func RequireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch
		if write && r.ContentLength != 0 {
			mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || mt != "application/json" {
				WriteProblem(w, r, NewProblem(http.StatusUnsupportedMediaType, "unsupported-media-type", "Unsupported media type", "The request body must be application/json."))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
