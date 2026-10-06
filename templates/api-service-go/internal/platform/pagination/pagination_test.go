package pagination_test

import (
	"testing"

	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/pagination"
)

func TestCursorRoundTrip(t *testing.T) {
	t.Parallel()
	id := "0199a8c4-3f6e-7b21-8c3d-0123456789ab"
	got, ok := pagination.DecodeCursor(pagination.EncodeCursor(id))
	if !ok || got != id {
		t.Fatalf("round trip = %q, %v", got, ok)
	}
}

func TestDecodeCursorRejectsGarbage(t *testing.T) {
	t.Parallel()
	for _, bad := range []string{"", "!!!", "bm90LWEtdXVpZA", pagination.EncodeCursor("not-a-uuid"), pagination.EncodeCursor(ids.MaxID + "x")} {
		if id, ok := pagination.DecodeCursor(bad); ok {
			t.Errorf("DecodeCursor(%q) = %q, true; want rejection", bad, id)
		}
	}
}
