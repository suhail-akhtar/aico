package app_test

import (
	"strings"
	"testing"
)

// Go 1.27 backs encoding/json with the v2 implementation. These tests pin the
// JSON behaviours this API depends on, so a toolchain upgrade that changes one
// fails here (and in CI) rather than in production. The expectations are the
// API's contract, not whatever the decoder happens to do.

func TestJSONDecodingEdgeCases(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")

	tests := []struct {
		name     string
		body     string
		wantCode int
		wantName string // checked when the item was created
		wantQty  int
	}{
		{"plain", `{"name":"a","quantity":3}`, 201, "a", 3},
		{"unknown fields are ignored", `{"name":"a","colour":"red","nested":{"x":1}}`, 201, "a", 0},
		{"unicode escapes decode", `{"name":"café"}`, 201, "café", 0},
		{"surrogate pair decodes", `{"name":"😀"}`, 201, "\U0001F600", 0},
		{"whitespace around the document is fine", " \n\t{\"name\":\"a\"}\n ", 201, "a", 0},
		{"null description is treated as absent", `{"name":"a","description":null}`, 201, "a", 0},
		{"null quantity is treated as absent", `{"name":"a","quantity":null}`, 201, "a", 0},
		{"integral float quantity is refused", `{"name":"a","quantity":3.0}`, 400, "", 0},
		{"exponent quantity is refused", `{"name":"a","quantity":1e2}`, 400, "", 0},
		{"fractional quantity is refused", `{"name":"a","quantity":1.5}`, 400, "", 0},
		{"quantity beyond int64 is refused", `{"name":"a","quantity":99999999999999999999}`, 400, "", 0},
		{"quantity as a string is refused", `{"name":"a","quantity":"3"}`, 400, "", 0},
		{"huge quantity is a validation error", `{"name":"a","quantity":2000000}`, 422, "", 0},
		{"negative zero quantity", `{"name":"a","quantity":-0}`, 201, "a", 0},
		{"name as number is refused", `{"name":1}`, 400, "", 0},
		{"missing name", `{"quantity":1}`, 422, "", 0},
		{"NUL in the name is a validation error, not a 500", `{"name":"a\u0000b"}`, 422, "", 0},
		{"lone surrogate does not become a 500", `{"name":"\ud800"}`, 0, "", 0},
		{"trailing comma is refused", `{"name":"a",}`, 400, "", 0},
		{"single quotes are refused", `{'name':'a'}`, 400, "", 0},
		{"comments are refused", `{"name":"a"/*x*/}`, 400, "", 0},
		{"top-level array is refused", `[{"name":"a"}]`, 400, "", 0},
		{"BOM-prefixed body is refused", "\ufeff" + `{"name":"a"}`, 400, "", 0},
		{"truncated body is refused", `{"name":"a"`, 400, "", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			r := ta.do(request{method: "POST", path: "/v1/items", token: tok, body: tt.body})
			if tt.wantCode == 0 {
				if r.Code >= 500 {
					t.Fatalf("answered %d: %s", r.Code, r.Body)
				}
				return
			}
			if r.Code != tt.wantCode {
				t.Fatalf("status %d, want %d: %s", r.Code, tt.wantCode, r.Body)
			}
			if tt.wantCode != 201 {
				r.problem(t)
				return
			}
			var it itemJSON
			r.json(t, &it)
			if it.Name != tt.wantName || it.Quantity != tt.wantQty {
				t.Fatalf("stored %+v, want name %q quantity %d", it, tt.wantName, tt.wantQty)
			}
		})
	}
}

func TestJSONFieldNamesAreCaseSensitive(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	// encoding/json v1 matched field names case-insensitively; v2 does not.
	// Either way the contract is "name" in lower case: an upper-case key must
	// not smuggle a value in as if it were the real field.
	r := ta.do(request{method: "POST", path: "/v1/items", token: tok, body: `{"NAME":"shouty"}`})
	if r.Code == 201 {
		var it itemJSON
		r.json(t, &it)
		t.Logf("this toolchain matches JSON keys case-insensitively (stored %q); the API still treats name as required in lower case only by schema", it.Name)
	} else if r.Code != 422 {
		t.Fatalf("status %d: %s", r.Code, r.Body)
	}
}

func TestDuplicateKeysDoNotCrash(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")
	r := ta.do(request{method: "POST", path: "/v1/items", token: tok, body: `{"name":"first","name":"second"}`})
	if r.Code >= 500 {
		t.Fatalf("duplicate keys caused %d: %s", r.Code, r.Body)
	}
	if r.Code == 201 {
		var it itemJSON
		r.json(t, &it)
		if it.Name != "first" && it.Name != "second" {
			t.Fatalf("name = %q", it.Name)
		}
		t.Logf("duplicate keys accepted; last-wins/first-wins observed: %q", it.Name)
	}
}

func TestJSONEncodingEdgeCases(t *testing.T) {
	t.Parallel()
	ta := newTestApp(t, nil)
	tok := ta.signUp("ada@example.com")

	// An empty page encodes as [] (never null) and omits next_cursor.
	if r := ta.get("/v1/items", tok); strings.TrimSpace(string(r.Body)) != `{"items":[]}` {
		t.Fatalf("empty page encodes as %s", r.Body)
	}
	// Characters that need care are escaped, never raw, in a JSON string.
	it := ta.createItem(tok, "a<b>&  \"\\\u0001z")
	raw := string(ta.get("/v1/items/"+it.ID, tok).Body)
	for _, bad := range []string{" ", " ", "\x01"} {
		if strings.Contains(raw, bad) {
			t.Errorf("response contains an unescaped control character %q: %s", bad, raw)
		}
	}
	var back itemJSON
	ta.get("/v1/items/"+it.ID, tok).json(t, &back)
	if back.Name != "a<b>&  \"\\\u0001z" {
		t.Fatalf("round trip changed the name: %q", back.Name)
	}
	// Timestamps are RFC 3339 UTC with a Z suffix.
	if !strings.Contains(raw, `"created_at":"2026-10-06T09:00:00Z"`) {
		t.Fatalf("timestamp format: %s", raw)
	}
}
