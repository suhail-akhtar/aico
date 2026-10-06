package httpx_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/httpx"
	"example.com/api-service/internal/platform/logging"
	"example.com/api-service/internal/platform/validate"
)

func discard() *slog.Logger { return slog.New(slog.DiscardHandler) }

func decodeProblem(t *testing.T, rec *httptest.ResponseRecorder) httpx.Problem {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != httpx.ProblemContentType {
		t.Fatalf("Content-Type = %q, want %q", ct, httpx.ProblemContentType)
	}
	var p httpx.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("body is not a problem document: %v: %s", err, rec.Body)
	}
	if p.Status != rec.Code {
		t.Fatalf("body status %d != HTTP status %d", p.Status, rec.Code)
	}
	return p
}

func TestProblemForMapsEveryKind(t *testing.T) {
	t.Parallel()
	var verrs validate.Errors
	verrs.Add("name", "is required")
	tests := []struct {
		name     string
		err      error
		wantCode int
		wantType string
	}{
		{"validation", verrs.Err(), 422, "urn:problem:validation-failed"},
		{"wrapped validation", fmt.Errorf("x: %w", verrs.Err()), 422, "urn:problem:validation-failed"},
		{"too large", &http.MaxBytesError{Limit: 10}, 413, "urn:problem:payload-too-large"},
		{"not found", apperr.New(apperr.KindNotFound, "gone"), 404, "urn:problem:not-found"},
		{"conflict", apperr.New(apperr.KindConflict, "dup"), 409, "urn:problem:conflict"},
		{"coded conflict keeps status and title, refines the type", apperr.NewCoded(apperr.KindConflict, "identity-conflict", "dup"), 409, "urn:problem:identity-conflict"},
		{"coded explicit internal is still masked", apperr.NewCoded(apperr.KindInternal, "custom", "secret detail"), 500, "urn:problem:internal"},
		{"unauthenticated", apperr.New(apperr.KindUnauthenticated, "who"), 401, "urn:problem:unauthenticated"},
		{"media type", apperr.New(apperr.KindUnsupportedMediaType, "json"), 415, "urn:problem:unsupported-media-type"},
		{"unavailable", apperr.New(apperr.KindUnavailable, "db"), 503, "urn:problem:unavailable"},
		{"explicit internal", apperr.New(apperr.KindInternal, "secret detail"), 500, "urn:problem:internal"},
		{"unknown", errors.New("pq: password authentication failed for user admin"), 500, "urn:problem:internal"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/x?token=abc", http.NoBody)
			httpx.ErrorHandler(discard())(rec, req, tt.err)
			p := decodeProblem(t, rec)
			if rec.Code != tt.wantCode || p.Type != tt.wantType {
				t.Fatalf("got %d %s, want %d %s", rec.Code, p.Type, tt.wantCode, tt.wantType)
			}
			if p.Instance != "/x" {
				t.Errorf("instance = %q: it must be the path without the query string", p.Instance)
			}
			if strings.Contains(rec.Body.String(), "password authentication") || strings.Contains(rec.Body.String(), "secret detail") {
				t.Errorf("an internal error leaked into the response: %s", rec.Body)
			}
		})
	}
}

func TestValidationProblemListsFields(t *testing.T) {
	t.Parallel()
	var verrs validate.Errors
	verrs.Add("name", "is required")
	verrs.Add("quantity", "out of range")
	rec := httptest.NewRecorder()
	httpx.ErrorHandler(discard())(rec, httptest.NewRequest(http.MethodPost, "/v1/items", http.NoBody), verrs.Err())
	p := decodeProblem(t, rec)
	if len(p.Errors) != 2 || p.Errors[0].Field != "name" || p.Errors[1].Message != "out of range" {
		t.Fatalf("errors = %+v", p.Errors)
	}
}

func TestUnauthorizedAdvertisesBearer(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	httpx.ErrorHandler(discard())(rec, httptest.NewRequest(http.MethodGet, "/", http.NoBody), apperr.New(apperr.KindUnauthenticated, "no"))
	if got := rec.Header().Get("WWW-Authenticate"); !strings.HasPrefix(got, "Bearer") {
		t.Fatalf("WWW-Authenticate = %q", got)
	}
}

func TestUnknownErrorsAreLoggedWithRequestID(t *testing.T) {
	t.Parallel()
	var buf bytes.Buffer
	logger := logging.New(&buf, slog.LevelInfo)
	req := httptest.NewRequest(http.MethodGet, "/boom", http.NoBody)
	req = req.WithContext(logging.WithRequestID(req.Context(), "rid-7"))
	rec := httptest.NewRecorder()
	httpx.ErrorHandler(logger)(rec, req, errors.New("disk on fire"))
	p := decodeProblem(t, rec)
	if p.RequestID != "rid-7" {
		t.Errorf("problem request_id = %q", p.RequestID)
	}
	if !strings.Contains(buf.String(), "disk on fire") || !strings.Contains(buf.String(), "rid-7") {
		t.Errorf("the real error and the request id must be in the log: %s", buf.String())
	}
}

func TestRequestErrorHandler(t *testing.T) {
	t.Parallel()
	h := httpx.RequestErrorHandler(discard())

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/", http.NoBody), fmt.Errorf("can not decode: %w", io.ErrUnexpectedEOF))
	if p := decodeProblem(t, rec); rec.Code != 400 || p.Type != "urn:problem:malformed-request" {
		t.Fatalf("malformed body: %d %s", rec.Code, p.Type)
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/", http.NoBody), fmt.Errorf("can not decode: %w", &http.MaxBytesError{Limit: 1}))
	if decodeProblem(t, rec); rec.Code != 413 {
		t.Fatalf("oversized body: %d", rec.Code)
	}
}

func TestParamErrorHandler(t *testing.T) {
	t.Parallel()
	rec := httptest.NewRecorder()
	httpx.ParamErrorHandler(rec, httptest.NewRequest(http.MethodGet, "/v1/items?limit=abc", http.NoBody), errors.New("bad"))
	if decodeProblem(t, rec); rec.Code != 400 {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestNotFoundOrMethodNotAllowed(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /things", func(http.ResponseWriter, *http.Request) {})
	mux.HandleFunc("POST /things", func(http.ResponseWriter, *http.Request) {})
	mux.Handle("/", httpx.NotFoundOrMethodNotAllowed(mux))

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nowhere", http.NoBody))
	if p := decodeProblem(t, rec); rec.Code != 404 || p.Type != "urn:problem:not-found" {
		t.Fatalf("unknown path: %d %s", rec.Code, p.Type)
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/things", http.NoBody))
	if p := decodeProblem(t, rec); rec.Code != 405 || p.Type != "urn:problem:method-not-allowed" {
		t.Fatalf("wrong method: %d %s", rec.Code, p.Type)
	}
	if allow := strings.Join(rec.Header().Values("Allow"), ","); allow != "GET,POST" {
		t.Fatalf("Allow = %q, want GET,POST", allow)
	}
}
