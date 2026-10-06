// Package logging builds the process logger: JSON on stdout, one line per
// event, enriched with the request id and (when tracing is on) the trace and
// span ids found in the context.
//
// Why a wrapping handler: handlers log with `logger.InfoContext(ctx, ...)` and
// get correlation for free, instead of every call site remembering to add
// request_id. Why redaction here: a secret that reaches a log line is leaked
// forever, so attribute keys that name credentials are masked at the sink no
// matter who logged them. The access log never records headers, bodies or query
// strings, so redaction is the second line of defence, not the first.
package logging

import (
	"context"
	"io"
	"log/slog"
	"strings"

	"go.opentelemetry.io/otel/trace"
)

type ctxKey struct{}

// WithRequestID stores the request id for the log handler (and middleware) to find.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// RequestID returns the request id stored by WithRequestID, or "".
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

// New returns a JSON logger writing to w at the given level.
func New(w io.Writer, level slog.Level) *slog.Logger {
	base := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level, ReplaceAttr: redact})
	return slog.New(ctxHandler{base})
}

var sensitive = []string{"password", "passwd", "secret", "token", "authorization", "cookie", "api_key", "apikey"}

func redact(_ []string, a slog.Attr) slog.Attr {
	key := strings.ToLower(a.Key)
	for _, s := range sensitive {
		if strings.Contains(key, s) {
			return slog.String(a.Key, "[REDACTED]")
		}
	}
	return a
}

type ctxHandler struct{ slog.Handler }

func (h ctxHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("request_id", id))
	}
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h ctxHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return ctxHandler{h.Handler.WithAttrs(attrs)}
}

// WithGroup nests every later attribute, including request_id and trace_id, under
// the group (a slog property). The template never uses groups for that reason.
func (h ctxHandler) WithGroup(name string) slog.Handler {
	return ctxHandler{h.Handler.WithGroup(name)}
}
