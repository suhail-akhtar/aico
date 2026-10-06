// Package pagination holds keyset-cursor helpers.
//
// Why keyset and not OFFSET: OFFSET n makes the database walk and discard n
// rows, so page 5,000 is 5,000 times slower than page 1, and rows inserted
// between requests make pages skip or repeat. A keyset cursor ("everything
// older than this id") is an index range scan at any depth and stable under
// inserts. The cursor is opaque base64 of the last id so clients treat it as a
// token and the server can change its shape without breaking anyone.
package pagination

import (
	"encoding/base64"

	"example.com/api-service/internal/platform/ids"
)

// Default and maximum page sizes.
const (
	DefaultLimit = 50
	MaxLimit     = 100
)

// EncodeCursor turns the last id of a page into an opaque cursor.
func EncodeCursor(lastID string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(lastID))
}

// DecodeCursor returns the id a cursor stands for; ok is false for anything
// that did not come from EncodeCursor.
func DecodeCursor(cursor string) (id string, ok bool) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", false
	}
	id = string(raw)
	if !ids.Valid(id) {
		return "", false
	}
	return id, true
}
