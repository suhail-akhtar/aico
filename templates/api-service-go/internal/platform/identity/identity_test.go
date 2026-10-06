package identity_test

import (
	"context"
	"testing"

	"example.com/api-service/internal/platform/identity"
)

func TestRoundTrip(t *testing.T) {
	t.Parallel()
	if _, ok := identity.FromContext(context.Background()); ok {
		t.Fatal("a bare context must have no principal")
	}
	want := identity.Principal{UserID: "u1", Email: "a@example.com"}
	got, ok := identity.FromContext(identity.WithPrincipal(context.Background(), want))
	if !ok || got != want {
		t.Fatalf("got %+v, %v", got, ok)
	}
}
