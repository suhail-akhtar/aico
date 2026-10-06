package telemetry_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace/noop"

	"example.com/api-service/internal/platform/telemetry"
)

func TestDisabledDoesNothing(t *testing.T) {
	t.Parallel()
	shutdown, err := telemetry.Setup(context.Background(), false, "svc", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown failed: %v", err)
	}
}

// Not parallel: it sets process environment and the global tracer provider.
func TestEnabledExportsSpansOverOTLP(t *testing.T) {
	var hits atomic.Int32
	var path atomic.Value
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		path.Store(r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", collector.URL)
	t.Setenv("OTEL_EXPORTER_OTLP_INSECURE", "true")
	defer otel.SetTracerProvider(noop.NewTracerProvider())

	shutdown, err := telemetry.Setup(context.Background(), true, "svc", "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	_, span := otel.Tracer("test").Start(context.Background(), "unit-of-work")
	span.End()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil { // flushes the batch
		t.Fatalf("shutdown: %v", err)
	}
	if hits.Load() == 0 {
		t.Fatal("no export request reached the collector")
	}
	if got, _ := path.Load().(string); got != "/v1/traces" {
		t.Fatalf("exported to %q, want /v1/traces", got)
	}
}
