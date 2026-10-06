package config_test

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"

	"example.com/api-service/internal/platform/config"
)

const dbURL = "postgres://app:s3cretpw@db:5432/app?sslmode=disable" // standards-allow: secret (fake test value)

func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestDefaults(t *testing.T) {
	t.Parallel()
	c, err := config.Load(env(map[string]string{"DATABASE_URL": dbURL}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Env != config.EnvDevelopment || c.Port != 8080 || c.Host != "0.0.0.0" || c.Addr() != "0.0.0.0:8080" {
		t.Errorf("unexpected defaults: %+v", c)
	}
	if c.Production() {
		t.Error("development must not be production")
	}
	if c.SessionTTL != 24*time.Hour || c.RequestTimeout != 10*time.Second || c.MaxBodyBytes != 1<<20 || !c.MigrateOnStart {
		t.Errorf("unexpected defaults: %+v", c)
	}
	if c.Argon2MemoryKiB != 65536 || c.Argon2Iterations != 3 || c.Argon2Parallelism != 1 {
		t.Errorf("argon2 defaults drifted: %d/%d/%d", c.Argon2MemoryKiB, c.Argon2Iterations, c.Argon2Parallelism)
	}
	if c.OTelEnabled {
		t.Error("telemetry must be off unless an endpoint is configured")
	}
}

func TestOverrides(t *testing.T) {
	t.Parallel()
	c, err := config.Load(env(map[string]string{
		"DATABASE_URL": dbURL, "APP_ENV": "production", "PORT": "9000", "HOST": "127.0.0.1",
		"LOG_LEVEL": "debug", "CORS_ALLOWED_ORIGINS": "https://app.example.com/, http://localhost:5173",
		"MAX_BODY_BYTES": "2048", "SESSION_TTL": "2h", "MIGRATE_ON_START": "false", "DB_MAX_CONNS": "3",
		"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Production() || c.Port != 9000 || c.Host != "127.0.0.1" || c.LogLevel != slog.LevelDebug ||
		c.MaxBodyBytes != 2048 || c.SessionTTL != 2*time.Hour || c.MigrateOnStart || c.DBMaxConns != 3 || !c.OTelEnabled {
		t.Errorf("overrides not applied: %+v", c)
	}
	want := []string{"https://app.example.com", "http://localhost:5173"}
	if strings.Join(c.CORSAllowedOrigins, ",") != strings.Join(want, ",") {
		t.Errorf("origins = %v, want %v", c.CORSAllowedOrigins, want)
	}
}

func TestRejectsBadValuesAndReportsAllAtOnce(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"database url missing", map[string]string{}, "DATABASE_URL: is required"},
		{"database url wrong scheme", map[string]string{"DATABASE_URL": "mysql://u:p@h/db"}, "DATABASE_URL: must be a postgres://"},
		{"database url unparseable", map[string]string{"DATABASE_URL": "postgres://%zz"}, "DATABASE_URL: must be a postgres://"},
		{"env unknown", map[string]string{"DATABASE_URL": dbURL, "APP_ENV": "staging"}, "APP_ENV: must be one of"},
		{"port not a number", map[string]string{"DATABASE_URL": dbURL, "PORT": "http"}, "PORT: must be an integer"},
		{"port out of range", map[string]string{"DATABASE_URL": dbURL, "PORT": "70000"}, "PORT: must be an integer"},
		{"duration bad", map[string]string{"DATABASE_URL": dbURL, "SESSION_TTL": "tomorrow"}, "SESSION_TTL: must be a duration"},
		{"duration too short", map[string]string{"DATABASE_URL": dbURL, "REQUEST_TIMEOUT": "1ms"}, "REQUEST_TIMEOUT: must be a duration"},
		{"bool bad", map[string]string{"DATABASE_URL": dbURL, "MIGRATE_ON_START": "maybe"}, "MIGRATE_ON_START: must be true or false"},
		{"float bad", map[string]string{"DATABASE_URL": dbURL, "RATE_LIMIT_RPS": "fast"}, "RATE_LIMIT_RPS: must be a number"},
		{"log level bad", map[string]string{"DATABASE_URL": dbURL, "LOG_LEVEL": "chatty"}, "LOG_LEVEL: must be debug"},
		{"cors wildcard", map[string]string{"DATABASE_URL": dbURL, "CORS_ALLOWED_ORIGINS": "*"}, "CORS_ALLOWED_ORIGINS: entries must be origins"},
		{"cors with path", map[string]string{"DATABASE_URL": dbURL, "CORS_ALLOWED_ORIGINS": "https://a.example.com/app"}, "CORS_ALLOWED_ORIGINS: entries must be origins"},
		{"argon2 below the OWASP floor", map[string]string{"DATABASE_URL": dbURL, "ARGON2_MEMORY_KIB": "1024"}, "ARGON2_MEMORY_KIB: must be an integer between 19456"},
		{"argon2 iterations below the floor", map[string]string{"DATABASE_URL": dbURL, "ARGON2_ITERATIONS": "1"}, "ARGON2_ITERATIONS: must be an integer between 2"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(env(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.want)
			}
			if strings.Contains(err.Error(), "s3cretpw") {
				t.Fatal("the error echoed a secret")
			}
		})
	}

	_, err := config.Load(env(map[string]string{"PORT": "x", "APP_ENV": "nope"}))
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"DATABASE_URL", "PORT", "APP_ENV"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("combined error is missing %s: %v", want, err)
		}
	}
}

func TestLogValueHidesThePassword(t *testing.T) {
	t.Parallel()
	c, err := config.Load(env(map[string]string{"DATABASE_URL": dbURL}))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("cfg", slog.Any("config", c))
	if strings.Contains(buf.String(), "s3cretpw") {
		t.Fatalf("the password was logged: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "db:5432") {
		t.Fatalf("the redacted URL should still name the host: %s", buf.String())
	}
}

func oidcEnv(extra map[string]string) map[string]string {
	m := map[string]string{
		"DATABASE_URL": dbURL, "AUTH_MODE": "oidc",
		"OIDC_ISSUER":     "http://localhost:8080/idp/realms/app",
		"OIDC_JWKS_URI":   "http://keycloak:8080/idp/realms/app/protocol/openid-connect/certs",
		"OIDC_AUDIENCE":   "app-api",
		"OIDC_CLOCK_SKEW": "",
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestAuthModeDefaultsToLocalAndIgnoresOIDCSettings(t *testing.T) {
	t.Parallel()
	c, err := config.Load(env(map[string]string{"DATABASE_URL": dbURL, "OIDC_ISSUER": "not even a url"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.AuthMode != config.AuthLocal || c.OIDC() || c.OIDCIssuer != "" || c.OIDCJWKSURI != "" || c.OIDCAudience != "" {
		t.Fatalf("a standalone service must be in local mode and ignore OIDC_*: %+v", c)
	}
}

func TestOIDCModeLoadsItsSettings(t *testing.T) {
	t.Parallel()
	c, err := config.Load(env(oidcEnv(nil)))
	if err != nil {
		t.Fatal(err)
	}
	if !c.OIDC() || c.OIDCIssuer != "http://localhost:8080/idp/realms/app" || c.OIDCAudience != "app-api" ||
		c.OIDCJWKSURI != "http://keycloak:8080/idp/realms/app/protocol/openid-connect/certs" || c.OIDCClockSkew != 30*time.Second {
		t.Fatalf("unexpected oidc configuration: %+v", c)
	}
	c, err = config.Load(env(oidcEnv(map[string]string{"OIDC_CLOCK_SKEW": "60s", "OIDC_ISSUER": " https://idp.example.com/realms/app/ "})))
	if err != nil {
		t.Fatal(err)
	}
	if c.OIDCClockSkew != time.Minute || c.OIDCIssuer != "https://idp.example.com/realms/app/" {
		t.Fatalf("the issuer must be kept exactly (trailing slash included): %q, skew %s", c.OIDCIssuer, c.OIDCClockSkew)
	}
}

func TestOIDCModeFailsFastNamingTheVariable(t *testing.T) {
	t.Parallel()
	const fakeSecret = "hunter2hunter2" // standards-allow: secret (fake test value)
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"mode unknown", map[string]string{"DATABASE_URL": dbURL, "AUTH_MODE": "saml"}, "AUTH_MODE: must be one of local, oidc"},
		{"issuer missing", oidcEnv(map[string]string{"OIDC_ISSUER": ""}), "OIDC_ISSUER: is required when AUTH_MODE=oidc"},
		{"jwks uri missing", oidcEnv(map[string]string{"OIDC_JWKS_URI": ""}), "OIDC_JWKS_URI: is required when AUTH_MODE=oidc"},
		{"audience missing", oidcEnv(map[string]string{"OIDC_AUDIENCE": ""}), "OIDC_AUDIENCE: is required when AUTH_MODE=oidc"},
		{"issuer not a url", oidcEnv(map[string]string{"OIDC_ISSUER": "keycloak"}), "OIDC_ISSUER: must be an absolute http(s) URL"},
		{"issuer wrong scheme", oidcEnv(map[string]string{"OIDC_ISSUER": "ftp://idp.example.com/realms/app"}), "OIDC_ISSUER: must be an absolute http(s) URL"},
		{"issuer with a query", oidcEnv(map[string]string{"OIDC_ISSUER": "https://idp.example.com/realms/app?x=1"}), "OIDC_ISSUER: must be an absolute http(s) URL"},
		{"jwks uri with credentials", oidcEnv(map[string]string{"OIDC_JWKS_URI": "https://admin:" + fakeSecret + "@idp.example.com/certs"}), "OIDC_JWKS_URI: must be an absolute http(s) URL"},
		{"jwks uri with a fragment", oidcEnv(map[string]string{"OIDC_JWKS_URI": "https://idp.example.com/certs#x"}), "OIDC_JWKS_URI: must be an absolute http(s) URL"},
		{"jwks uri unparseable", oidcEnv(map[string]string{"OIDC_JWKS_URI": "http://%zz"}), "OIDC_JWKS_URI: must be an absolute http(s) URL"},
		{"skew above 60 s", oidcEnv(map[string]string{"OIDC_CLOCK_SKEW": "61s"}), "OIDC_CLOCK_SKEW: must be a duration"},
		{"skew not a duration", oidcEnv(map[string]string{"OIDC_CLOCK_SKEW": "a bit"}), "OIDC_CLOCK_SKEW: must be a duration"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := config.Load(env(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.want)
			}
			if strings.Contains(err.Error(), fakeSecret) {
				t.Fatal("the error echoed credentials from a URL")
			}
		})
	}

	_, err := config.Load(env(map[string]string{"DATABASE_URL": dbURL, "AUTH_MODE": "oidc"}))
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"OIDC_ISSUER", "OIDC_JWKS_URI", "OIDC_AUDIENCE"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("all missing OIDC settings are reported together; %s is missing from: %v", want, err)
		}
	}
}

func TestLogValueShowsTheModeAndIssuerButNotTheJWKSURI(t *testing.T) {
	t.Parallel()
	c, err := config.Load(env(oidcEnv(nil)))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("cfg", slog.Any("config", c))
	if !strings.Contains(buf.String(), `"auth_mode":"oidc"`) || !strings.Contains(buf.String(), "localhost:8080/idp/realms/app") {
		t.Fatalf("the mode and issuer should be logged: %s", buf.String())
	}
	if strings.Contains(buf.String(), "keycloak:8080") {
		t.Fatalf("the internal JWKS address should stay out of the logs: %s", buf.String())
	}
}
