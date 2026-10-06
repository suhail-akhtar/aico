// Package telemetry wires OpenTelemetry tracing, and does nothing unless asked.
//
// Why off by default: an exporter with no collector behind it retries, logs and
// burns CPU for nothing, and a starter should run with zero infrastructure. Set
// OTEL_EXPORTER_OTLP_ENDPOINT (or the _TRACES_ variant) and the service exports
// spans over OTLP/HTTP using the standard OTEL_* environment variables, which
// the SDK and exporter read themselves, so sampling, headers and TLS are
// configured exactly as the OpenTelemetry docs say, with no custom flags here.
//
// The HTTP handler is always wrapped with otelhttp (a no-op until a provider is
// installed), and log lines carry trace_id/span_id (internal/platform/logging),
// so enabling tracing needs no code change anywhere else. Metrics and database
// spans are growth steps, listed in docs/ARCHITECTURE.md.
package telemetry

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Shutdown flushes and stops the exporter.
type Shutdown func(context.Context) error

// Setup installs a global tracer provider when enabled and returns the function
// that flushes it. When disabled it installs nothing and returns a no-op.
func Setup(ctx context.Context, enabled bool, serviceName, serviceVersion string) (Shutdown, error) {
	if !enabled {
		return func(context.Context) error { return nil }, nil
	}
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("create OTLP trace exporter: %w", err)
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		attribute.String("service.name", serviceName),
		attribute.String("service.version", serviceVersion),
	))
	if err != nil {
		return nil, fmt.Errorf("build OpenTelemetry resource: %w", err)
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown, nil
}
