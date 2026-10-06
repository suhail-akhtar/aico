package validate_test

import (
	"errors"
	"strings"
	"testing"

	"example.com/api-service/internal/platform/validate"
)

func TestErrors(t *testing.T) {
	t.Parallel()
	var e validate.Errors
	if e.Err() != nil {
		t.Fatal("empty Errors must be a nil error")
	}
	e.Add("name", "is required")
	e.Add("quantity", "must be positive")
	err := e.Err()
	if err == nil {
		t.Fatal("non-empty Errors must be an error")
	}
	var got validate.Errors
	if !errors.As(err, &got) || len(got) != 2 {
		t.Fatalf("errors.As lost the fields: %v", got)
	}
	msg := err.Error()
	for _, want := range []string{"name: is required", "quantity: must be positive"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q missing %q", msg, want)
		}
	}
}
