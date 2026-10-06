// Package config reads the process configuration from environment variables,
// validates all of it at once, and refuses to start on any problem.
//
// Why env only and hand-written: the same image must run unchanged on every
// host (12-factor), so there is no config file, no flag layer and no library
// with its own search path. Why validate everything up front: a bad value
// discovered at the first request is an outage; discovered at startup it is a
// failed deploy that never took traffic. Every problem is reported together so
// one deploy attempt fixes all of them, and the messages name the variable but
// never echo a value, because DATABASE_URL carries a password.
//
// It does not load .env files (compose and your shell do that) and it does not
// read secrets from anywhere but the environment; mount them as env vars from
// your secret manager.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Authentication modes (AUTH_MODE). local is the standalone default: accounts and
// opaque sessions live in this service. oidc makes the service an OAuth 2.0
// resource server for an external identity provider (Keycloak, Entra ID, ...).
const (
	AuthLocal = "local"
	AuthOIDC  = "oidc"
)

// Environments the service distinguishes.
const (
	EnvDevelopment = "development"
	EnvProduction  = "production"
	EnvTest        = "test"
)

// OWASP Password Storage Cheat Sheet floor for Argon2id: m=19 MiB, t=2, p=1.
const (
	minArgonMemoryKiB  = 19456
	minArgonIterations = 2
)

// Config is the validated configuration.
type Config struct {
	Env         string
	Host        string
	Port        int
	DatabaseURL string
	LogLevel    slog.Level

	CORSAllowedOrigins []string
	MaxBodyBytes       int64
	RateLimitRPS       float64
	RateLimitBurst     int
	AuthRateLimitRPM   float64
	AuthRateLimitBurst int

	AuthMode string

	// Only meaningful, and only validated, when AuthMode is oidc.
	OIDCIssuer    string        // exact expected `iss`
	OIDCJWKSURI   string        // where the signing keys are fetched (may be an internal URL)
	OIDCAudience  string        // required `aud` value
	OIDCClockSkew time.Duration // leeway for exp/nbf/iat, at most 60 s

	SessionTTL      time.Duration
	RequestTimeout  time.Duration
	ShutdownTimeout time.Duration

	DBMaxConns     int
	MigrateOnStart bool

	Argon2MemoryKiB   uint32
	Argon2Iterations  uint32
	Argon2Parallelism uint8

	OTelEnabled     bool
	OTelServiceName string

	// SeedEmail is the demo account `server seed` creates; its password is read
	// from SEED_PASSWORD by the seed command only and is never part of Config.
	SeedEmail string
}

// OIDC reports whether the service verifies identity-provider tokens instead of
// issuing its own sessions.
func (c Config) OIDC() bool { return c.AuthMode == AuthOIDC }

// Production reports whether the service runs in production mode.
func (c Config) Production() bool { return c.Env == EnvProduction }

// Addr is the listen address.
func (c Config) Addr() string { return fmt.Sprintf("%s:%d", c.Host, c.Port) }

// LogValue lets slog print the configuration without the database password.
func (c Config) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("env", c.Env),
		slog.String("addr", c.Addr()),
		slog.String("database", redactURL(c.DatabaseURL)),
		slog.String("log_level", c.LogLevel.String()),
		slog.Int("cors_origins", len(c.CORSAllowedOrigins)),
		slog.Int64("max_body_bytes", c.MaxBodyBytes),
		slog.String("auth_mode", c.AuthMode),
		slog.String("oidc_issuer", c.OIDCIssuer), // public by definition; the JWKS URI and audience stay out of the logs
		slog.String("session_ttl", c.SessionTTL.String()),
		slog.Bool("migrate_on_start", c.MigrateOnStart),
		slog.Bool("otel", c.OTelEnabled),
	)
}

func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "[unparseable]"
	}
	return u.Redacted()
}

// Load reads and validates the configuration. getenv is os.Getenv in
// production and a map lookup in tests.
func Load(getenv func(string) string) (Config, error) {
	l := &loader{getenv: getenv}
	c := Config{
		Env:                l.oneOf("APP_ENV", EnvDevelopment, EnvDevelopment, EnvProduction, EnvTest),
		Host:               l.str("HOST", "0.0.0.0"),
		Port:               l.integer("PORT", 8080, 1, 65535),
		LogLevel:           l.level("LOG_LEVEL", slog.LevelInfo),
		CORSAllowedOrigins: l.origins("CORS_ALLOWED_ORIGINS"),
		MaxBodyBytes:       int64(l.integer("MAX_BODY_BYTES", 1<<20, 1, 64<<20)),
		RateLimitRPS:       l.float("RATE_LIMIT_RPS", 20, 0.1, 100000),
		RateLimitBurst:     l.integer("RATE_LIMIT_BURST", 40, 1, 1000000),
		AuthRateLimitRPM:   l.float("AUTH_RATE_LIMIT_PER_MINUTE", 10, 0.1, 100000),
		AuthRateLimitBurst: l.integer("AUTH_RATE_LIMIT_BURST", 5, 1, 100000),
		AuthMode:           l.oneOf("AUTH_MODE", AuthLocal, AuthLocal, AuthOIDC),
		SessionTTL:         l.duration("SESSION_TTL", 24*time.Hour, time.Minute, 90*24*time.Hour),
		RequestTimeout:     l.duration("REQUEST_TIMEOUT", 10*time.Second, 100*time.Millisecond, 5*time.Minute),
		ShutdownTimeout:    l.duration("SHUTDOWN_TIMEOUT", 20*time.Second, time.Second, 10*time.Minute),
		DBMaxConns:         l.integer("DB_MAX_CONNS", 10, 1, 500),
		MigrateOnStart:     l.boolean("MIGRATE_ON_START", true),
		Argon2MemoryKiB:    uint32(l.integer("ARGON2_MEMORY_KIB", 65536, minArgonMemoryKiB, 4<<20)), //nolint:gosec // bounded above
		Argon2Iterations:   uint32(l.integer("ARGON2_ITERATIONS", 3, minArgonIterations, 20)),       //nolint:gosec // bounded above
		Argon2Parallelism:  uint8(l.integer("ARGON2_PARALLELISM", 1, 1, 16)),                        //nolint:gosec // bounded above
		OTelServiceName:    l.str("OTEL_SERVICE_NAME", "api-service"),
		SeedEmail:          l.str("SEED_EMAIL", "demo@example.com"),
	}
	if c.OIDC() {
		c.OIDCIssuer = l.oidcURL("OIDC_ISSUER", true)
		c.OIDCJWKSURI = l.oidcURL("OIDC_JWKS_URI", false)
		c.OIDCAudience = l.required("OIDC_AUDIENCE")
		c.OIDCClockSkew = l.duration("OIDC_CLOCK_SKEW", 30*time.Second, 0, time.Minute)
	}
	c.OTelEnabled = getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != ""
	c.DatabaseURL = l.databaseURL("DATABASE_URL")
	if err := errors.Join(l.errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration:\n%w", err)
	}
	return c, nil
}

type loader struct {
	getenv func(string) string
	errs   []error
}

func (l *loader) fail(key, format string, args ...any) {
	l.errs = append(l.errs, fmt.Errorf("  %s: %s", key, fmt.Sprintf(format, args...)))
}

func (l *loader) str(key, def string) string {
	if v := strings.TrimSpace(l.getenv(key)); v != "" {
		return v
	}
	return def
}

func (l *loader) oneOf(key, def string, allowed ...string) string {
	v := l.str(key, def)
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	l.fail(key, "must be one of %s", strings.Join(allowed, ", "))
	return def
}

func (l *loader) integer(key string, def, minV, maxV int) int {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < minV || n > maxV {
		l.fail(key, "must be an integer between %d and %d", minV, maxV)
		return def
	}
	return n
}

func (l *loader) float(key string, def, minV, maxV float64) float64 {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || f < minV || f > maxV {
		l.fail(key, "must be a number between %g and %g", minV, maxV)
		return def
	}
	return f
}

func (l *loader) duration(key string, def, minV, maxV time.Duration) time.Duration {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < minV || d > maxV {
		l.fail(key, "must be a duration (for example 30s) between %s and %s", minV, maxV)
		return def
	}
	return d
}

func (l *loader) boolean(key string, def bool) bool {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	b, err := strconv.ParseBool(raw)
	if err != nil {
		l.fail(key, "must be true or false")
		return def
	}
	return b
}

func (l *loader) level(key string, def slog.Level) slog.Level {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(raw)); err != nil {
		l.fail(key, "must be debug, info, warn or error")
		return def
	}
	return lv
}

// origins parses a comma-separated allow-list. "*" is refused: the API uses
// bearer tokens, so a wildcard would let any web page script it for a user who
// pastes a token, and an explicit list costs nothing.
func (l *loader) origins(key string) []string {
	raw := l.str(key, "")
	if raw == "" {
		return nil
	}
	var out []string
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimRight(strings.TrimSpace(o), "/")
		u, err := url.Parse(o)
		if o == "" || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Path != "" {
			l.fail(key, "entries must be origins like https://app.example.com (no wildcard, no path)")
			return nil
		}
		out = append(out, o)
	}
	return out
}

func (l *loader) databaseURL(key string) string {
	raw := l.str(key, "")
	if raw == "" {
		l.fail(key, "is required (postgres://user:password@host:5432/dbname)")
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host == "" {
		// The value is deliberately not echoed: it carries a password.
		l.fail(key, "must be a postgres:// or postgresql:// URL")
		return ""
	}
	return raw
}

// required returns a non-empty value or records that it is missing. It is used
// for settings that have no safe default, so the failure names the variable.
func (l *loader) required(key string) string {
	v := l.str(key, "")
	if v == "" {
		l.fail(key, "is required when AUTH_MODE=oidc")
	}
	return v
}

// oidcURL validates an identity-provider URL. The issuer is compared with the
// token's `iss` byte for byte, so it is returned exactly as configured (only
// surrounding whitespace is trimmed); the JWKS URI is where keys are fetched and
// is usually an internal address (http://keycloak:8080/...), so plain http is
// allowed for it. Neither may carry credentials, a query or a fragment: a
// userinfo part would put a password in the process arguments and logs.
func (l *loader) oidcURL(key string, issuer bool) string {
	raw := l.required(key)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" || (issuer && u.RawQuery != "") {
		// The value is not echoed: a misconfigured URL may embed credentials.
		l.fail(key, "must be an absolute http(s) URL without credentials or fragment")
		return ""
	}
	return raw
}
