// Package validate collects field-level validation failures.
//
// Why hand-written instead of go-playground/validator: the rules here are a few
// length and range checks that also live in api/openapi.yaml, and a struct-tag
// DSL would be a third place to keep them in step. Services build an Errors
// value, return it when non-empty, and the HTTP edge renders it as a 422
// problem with one entry per field. It is not an *apperr.Error on purpose: it
// carries structure, not just a message.
package validate

import (
	"fmt"
	"strings"
)

// FieldError names one invalid input and says what is wrong with it.
type FieldError struct {
	Field   string
	Message string
}

// Errors is a list of field failures; it is an error when non-empty.
type Errors []FieldError

// Add records a failure.
func (e *Errors) Add(field, message string) {
	*e = append(*e, FieldError{Field: field, Message: message})
}

// Err returns e as an error, or nil when nothing failed.
func (e Errors) Err() error {
	if len(e) == 0 {
		return nil
	}
	return e
}

func (e Errors) Error() string {
	parts := make([]string, len(e))
	for i, f := range e {
		parts[i] = fmt.Sprintf("%s: %s", f.Field, f.Message)
	}
	return "validation failed: " + strings.Join(parts, "; ")
}
