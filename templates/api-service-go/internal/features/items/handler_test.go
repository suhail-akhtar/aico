package items_test

import (
	"context"
	"errors"
	"testing"

	"example.com/api-service/internal/api"
	"example.com/api-service/internal/features/items"
	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/identity"
)

// The handler is exercised end to end through HTTP in internal/app. These tests
// cover the guards that HTTP cannot reach because the generated server or the
// middleware stands in front of them.

func newHandler(t *testing.T) *items.Handler {
	t.Helper()
	svc, _ := newService(t)
	return items.NewHandler(svc)
}

func TestHandlerFailsClosedWithoutAPrincipal(t *testing.T) {
	t.Parallel()
	h, ctx := newHandler(t), context.Background()
	check := func(name string, err error) {
		t.Helper()
		if apperr.KindOf(err) != apperr.KindUnauthenticated {
			t.Errorf("%s without a principal: %v, want an unauthenticated error", name, err)
		}
	}
	_, err := h.ListItems(ctx, api.ListItemsRequestObject{})
	check("ListItems", err)
	_, err = h.CreateItem(ctx, api.CreateItemRequestObject{Body: &api.CreateItem{Name: "x"}})
	check("CreateItem", err)
	_, err = h.GetItem(ctx, api.GetItemRequestObject{})
	check("GetItem", err)
	_, err = h.UpdateItem(ctx, api.UpdateItemRequestObject{Body: &api.CreateItem{Name: "x"}})
	check("UpdateItem", err)
	_, err = h.DeleteItem(ctx, api.DeleteItemRequestObject{})
	check("DeleteItem", err)
}

func TestHandlerRefusesAMissingBody(t *testing.T) {
	t.Parallel()
	h := newHandler(t)
	ctx := identity.WithPrincipal(context.Background(), identity.Principal{UserID: owner})
	_, err := h.CreateItem(ctx, api.CreateItemRequestObject{})
	if apperr.KindOf(err) != apperr.KindUnsupportedMediaType {
		t.Errorf("CreateItem without a body: %v", err)
	}
	_, err = h.UpdateItem(ctx, api.UpdateItemRequestObject{})
	if apperr.KindOf(err) != apperr.KindUnsupportedMediaType {
		t.Errorf("UpdateItem without a body: %v", err)
	}
}

func TestHandlerPropagatesServiceErrors(t *testing.T) {
	t.Parallel()
	h := newHandler(t)
	ctx := identity.WithPrincipal(context.Background(), identity.Principal{UserID: owner})
	if _, err := h.GetItem(ctx, api.GetItemRequestObject{Id: "0199a8c4-3f6e-7b21-8c3d-0123456789ab"}); !errors.Is(err, items.ErrNotFound) {
		t.Errorf("GetItem: %v", err)
	}
	if _, err := h.UpdateItem(ctx, api.UpdateItemRequestObject{Id: "0199a8c4-3f6e-7b21-8c3d-0123456789ab", Body: &api.CreateItem{Name: "x"}}); !errors.Is(err, items.ErrNotFound) {
		t.Errorf("UpdateItem: %v", err)
	}
	if _, err := h.DeleteItem(ctx, api.DeleteItemRequestObject{Id: "0199a8c4-3f6e-7b21-8c3d-0123456789ab"}); !errors.Is(err, items.ErrNotFound) {
		t.Errorf("DeleteItem: %v", err)
	}
	if _, err := h.CreateItem(ctx, api.CreateItemRequestObject{Body: &api.CreateItem{Name: ""}}); err == nil {
		t.Error("CreateItem accepted an empty name")
	}
	zero := 0
	if _, err := h.ListItems(ctx, api.ListItemsRequestObject{Params: api.ListItemsParams{Limit: &zero}}); err == nil {
		t.Error("an explicit limit=0 must be refused, not treated as the default")
	}
}
