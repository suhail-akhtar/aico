package apperr_test

import (
	"errors"
	"fmt"
	"testing"

	"example.com/api-service/internal/platform/apperr"
)

func TestKindAndMessage(t *testing.T) {
	t.Parallel()
	base := apperr.New(apperr.KindConflict, "already there")
	tests := []struct {
		name     string
		err      error
		wantKind apperr.Kind
		wantMsg  string
	}{
		{"categorised", base, apperr.KindConflict, "already there"},
		{"wrapped keeps the category", fmt.Errorf("context: %w", base), apperr.KindConflict, "already there"},
		{"plain error is internal", errors.New("boom"), apperr.KindInternal, ""},
		{"nil is internal", nil, apperr.KindInternal, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := apperr.KindOf(tt.err); got != tt.wantKind {
				t.Errorf("KindOf = %v, want %v", got, tt.wantKind)
			}
			if got := apperr.Message(tt.err); got != tt.wantMsg {
				t.Errorf("Message = %q, want %q", got, tt.wantMsg)
			}
		})
	}
}

func TestNewCodedCarriesTheCode(t *testing.T) {
	t.Parallel()
	e := apperr.NewCoded(apperr.KindConflict, "identity-conflict", "taken")
	if e.Code != "identity-conflict" || e.Kind != apperr.KindConflict || e.Msg != "taken" || apperr.New(apperr.KindConflict, "x").Code != "" {
		t.Fatalf("unexpected error: %+v", e)
	}
}

func TestSentinelsWorkWithErrorsIs(t *testing.T) {
	t.Parallel()
	sentinel := apperr.New(apperr.KindNotFound, "nope")
	if !errors.Is(fmt.Errorf("lookup: %w", sentinel), sentinel) {
		t.Fatal("errors.Is must see through wrapping")
	}
	if sentinel.Error() != "nope" {
		t.Fatalf("Error() = %q", sentinel.Error())
	}
}
