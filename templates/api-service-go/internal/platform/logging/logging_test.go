package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/trace"

	"example.com/api-service/internal/platform/logging"
)

func decode(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatalf("log line is not JSON: %v: %s", err, buf)
	}
	return m
}

func TestAddsRequestID(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	l := logging.New(&buf, slog.LevelInfo)
	ctx := logging.WithRequestID(context.Background(), "req-1")
	l.InfoContext(ctx, "hello", slog.String("k", "v"))
	m := decode(t, &buf)
	if m["request_id"] != "req-1" || m["msg"] != "hello" || m["k"] != "v" {
		t.Fatalf("unexpected line: %v", m)
	}
	if got := logging.RequestID(ctx); got != "req-1" {
		t.Fatalf("RequestID = %q", got)
	}
	if got := logging.RequestID(context.Background()); got != "" {
		t.Fatalf("RequestID on a bare context = %q", got)
	}
}

func TestAddsTraceIDs(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	l := logging.New(&buf, slog.LevelInfo)
	tid, _ := trace.TraceIDFromHex("0102030405060708090a0b0c0d0e0f10")
	sid, _ := trace.SpanIDFromHex("0102030405060708")
	ctx := trace.ContextWithSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid}))
	l.With(slog.String("component", "x")).InfoContext(ctx, "traced")
	m := decode(t, &buf)
	if m["trace_id"] != tid.String() || m["span_id"] != sid.String() {
		t.Fatalf("missing trace ids: %v", m)
	}
}

func TestRedactsCredentialAttributes(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	l := logging.New(&buf, slog.LevelInfo)
	// standards-allow: secret (obviously fake test values)
	l.Info("login", slog.String("password", "fake-password-value"), slog.String("Authorization", "Bearer fake-token"), slog.String("api_key", "k"), slog.String("user", "ada"))
	for _, secret := range []string{"fake-password-value", "Bearer fake-token"} {
		if bytes.Contains(buf.Bytes(), []byte(secret)) {
			t.Errorf("secret %q reached the log: %s", secret, buf.String())
		}
	}
	m := decode(t, &buf)
	if m["password"] != "[REDACTED]" || m["Authorization"] != "[REDACTED]" || m["api_key"] != "[REDACTED]" || m["user"] != "ada" {
		t.Fatalf("redaction wrong: %v", m)
	}
}

func TestLevelFilters(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logging.New(&buf, slog.LevelWarn).Info("quiet")
	if buf.Len() != 0 {
		t.Fatalf("info line written at warn level: %s", buf.String())
	}
}

func TestWithGroupStillLogs(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logging.New(&buf, slog.LevelInfo).WithGroup("g").Info("grouped", slog.String("k", "v"))
	m := decode(t, &buf)
	if g, ok := m["g"].(map[string]any); !ok || g["k"] != "v" {
		t.Fatalf("grouped attribute lost: %v", m)
	}
}
