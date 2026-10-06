// Package httpx is the HTTP edge toolkit: RFC 9457 problem responses, the
// middleware chain, and the single place that maps failures to responses.
//
// Why one error mapper: handlers return errors and never write error bodies, so
// every failure the API can produce has the same shape (`application/problem+json`
// with a stable `type`, the request id, and field errors for validation), no
// status is chosen ad hoc, and an unexpected error can never leak its text: it
// is logged with the request id and the client gets a generic 500.
//
// It does not know any feature. Features express failures as apperr kinds or
// validate.Errors and this package turns them into HTTP.
package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/logging"
	"example.com/api-service/internal/platform/validate"
)

// ProblemContentType is the RFC 9457 media type.
const ProblemContentType = "application/problem+json"

const typePrefix = "urn:problem:"

// FieldProblem is one entry of the `errors` extension member.
type FieldProblem struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// Problem is an RFC 9457 problem details object plus `request_id` and `errors`.
type Problem struct {
	Type      string         `json:"type"`
	Title     string         `json:"title"`
	Status    int            `json:"status"`
	Detail    string         `json:"detail,omitempty"`
	Instance  string         `json:"instance,omitempty"`
	RequestID string         `json:"request_id,omitempty"`
	Errors    []FieldProblem `json:"errors,omitempty"`
}

// NewProblem builds a problem whose type is urn:problem:<code>.
func NewProblem(status int, code, title, detail string) Problem {
	return Problem{Type: typePrefix + code, Title: title, Status: status, Detail: detail}
}

// WriteProblem renders p. Instance and request id are filled from the request;
// the instance is the path only, never the query string.
func WriteProblem(w http.ResponseWriter, r *http.Request, p Problem) {
	p.Instance = r.URL.Path
	p.RequestID = logging.RequestID(r.Context())
	if p.Status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="api"`)
	}
	w.Header().Set("Content-Type", ProblemContentType)
	w.WriteHeader(p.Status)
	_ = json.NewEncoder(w).Encode(p) // the client may have gone; nothing useful to do on failure
}

// ErrorHandler returns the function that turns any error into a response. It
// is installed as the strict server's response-error handler, so it sees every
// error a handler returns.
func ErrorHandler(logger *slog.Logger) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		WriteProblem(w, r, ProblemFor(r, logger, err))
	}
}

// ProblemFor maps err to a problem. Unknown errors are logged and masked.
func ProblemFor(r *http.Request, logger *slog.Logger, err error) Problem {
	var verrs validate.Errors
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &verrs):
		p := NewProblem(http.StatusUnprocessableEntity, "validation-failed", "Validation failed", "One or more fields are invalid.")
		for _, f := range verrs {
			p.Errors = append(p.Errors, FieldProblem{Field: f.Field, Message: f.Message})
		}
		return p
	case errors.As(err, &tooLarge):
		return NewProblem(http.StatusRequestEntityTooLarge, "payload-too-large", "Payload too large", "The request body exceeds the allowed size.")
	}

	var ae *apperr.Error
	if errors.As(err, &ae) {
		var p Problem
		switch ae.Kind {
		case apperr.KindNotFound:
			p = NewProblem(http.StatusNotFound, "not-found", "Not found", ae.Msg)
		case apperr.KindConflict:
			p = NewProblem(http.StatusConflict, "conflict", "Conflict", ae.Msg)
		case apperr.KindUnauthenticated:
			p = NewProblem(http.StatusUnauthorized, "unauthenticated", "Authentication required", ae.Msg)
		case apperr.KindUnsupportedMediaType:
			p = NewProblem(http.StatusUnsupportedMediaType, "unsupported-media-type", "Unsupported media type", ae.Msg)
		case apperr.KindUnavailable:
			p = NewProblem(http.StatusServiceUnavailable, "unavailable", "Service unavailable", ae.Msg)
		case apperr.KindInternal:
			// An explicitly internal error is still masked below.
		}
		if p.Status != 0 {
			if ae.Code != "" {
				p.Type = typePrefix + ae.Code // a more specific type, same status and title
			}
			return p
		}
	}

	logger.ErrorContext(r.Context(), "unhandled error", slog.String("error", err.Error()), slog.String("path", r.URL.Path))
	return NewProblem(http.StatusInternalServerError, "internal", "Internal server error", "Something went wrong. Quote the request id when reporting it.")
}

// RequestErrorHandler handles failures decoding the request (malformed JSON,
// oversized body) before any handler runs.
func RequestErrorHandler(logger *slog.Logger) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			WriteProblem(w, r, ProblemFor(r, logger, err))
			return
		}
		WriteProblem(w, r, NewProblem(http.StatusBadRequest, "malformed-request", "Malformed request", "The request body is not valid JSON for this operation."))
	}
}

// ParamErrorHandler handles path/query parameters that fail to bind (for
// example `limit=abc`).
func ParamErrorHandler(w http.ResponseWriter, r *http.Request, _ error) {
	WriteProblem(w, r, NewProblem(http.StatusBadRequest, "malformed-request", "Malformed request", "A path or query parameter is malformed."))
}

// NotFoundOrMethodNotAllowed is the catch-all route. ServeMux would answer a
// wrong path or method with plain text; this keeps the problem+json contract
// and distinguishes 404 from 405 (with an Allow header) by probing the mux.
func NotFoundOrMethodNotAllowed(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var allow []string
		for _, m := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
			probe := r.Clone(r.Context())
			probe.Method = m
			if _, pattern := mux.Handler(probe); pattern != "" && pattern != "/" {
				allow = append(allow, m)
			}
		}
		if len(allow) > 0 {
			for _, m := range allow {
				w.Header().Add("Allow", m)
			}
			WriteProblem(w, r, NewProblem(http.StatusMethodNotAllowed, "method-not-allowed", "Method not allowed", "This resource does not support "+r.Method+"."))
			return
		}
		WriteProblem(w, r, NewProblem(http.StatusNotFound, "not-found", "Not found", "No such route."))
	})
}
