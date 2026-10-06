package items

import (
	"context"

	"example.com/api-service/internal/api"
	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/identity"
)

var errUnsupportedMedia = apperr.New(apperr.KindUnsupportedMediaType, "the request body must be application/json")

// Handler is the HTTP adapter. It implements the item operations of the
// generated api.StrictServerInterface; errors are returned, never written, and
// httpx maps them to problem responses.
type Handler struct {
	svc *Service
}

// NewHandler returns the item operations backed by svc.
func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

func caller(ctx context.Context) (string, error) {
	p, ok := identity.FromContext(ctx)
	if !ok {
		// The middleware guarantees a principal on secured routes; reaching this
		// means a route was mounted without it, which must fail closed.
		return "", apperr.New(apperr.KindUnauthenticated, "authentication required")
	}
	return p.UserID, nil
}

// ListItems implements GET /v1/items.
func (h *Handler) ListItems(ctx context.Context, req api.ListItemsRequestObject) (api.ListItemsResponseObject, error) {
	owner, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	limit, cursor := 0, ""
	if req.Params.Limit != nil {
		limit = *req.Params.Limit
		if limit == 0 {
			limit = -1 // an explicit limit=0 is invalid, not "use the default"
		}
	}
	if req.Params.Cursor != nil {
		cursor = *req.Params.Cursor
	}
	page, err := h.svc.List(ctx, owner, limit, cursor)
	if err != nil {
		return nil, err
	}
	// A non-nil slice so an empty page is `[]`, never `null`.
	body := api.ItemPage{Items: make([]api.Item, len(page.Items))}
	for i, it := range page.Items {
		body.Items[i] = toAPI(it)
	}
	if page.NextCursor != "" {
		body.NextCursor = &page.NextCursor
	}
	return api.ListItems200JSONResponse(body), nil
}

// CreateItem implements POST /v1/items.
func (h *Handler) CreateItem(ctx context.Context, req api.CreateItemRequestObject) (api.CreateItemResponseObject, error) {
	owner, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errUnsupportedMedia
	}
	it, err := h.svc.Create(ctx, owner, fromAPI(*req.Body))
	if err != nil {
		return nil, err
	}
	location := "/v1/items/" + it.ID
	return api.CreateItem201JSONResponse{Body: toAPI(it), Headers: api.CreateItem201ResponseHeaders{Location: &location}}, nil
}

// GetItem implements GET /v1/items/{id}.
func (h *Handler) GetItem(ctx context.Context, req api.GetItemRequestObject) (api.GetItemResponseObject, error) {
	owner, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	it, err := h.svc.Get(ctx, owner, req.Id)
	if err != nil {
		return nil, err
	}
	return api.GetItem200JSONResponse(toAPI(it)), nil
}

// UpdateItem implements PUT /v1/items/{id}.
func (h *Handler) UpdateItem(ctx context.Context, req api.UpdateItemRequestObject) (api.UpdateItemResponseObject, error) {
	owner, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, errUnsupportedMedia
	}
	it, err := h.svc.Update(ctx, owner, req.Id, fromAPI(*req.Body))
	if err != nil {
		return nil, err
	}
	return api.UpdateItem200JSONResponse(toAPI(it)), nil
}

// DeleteItem implements DELETE /v1/items/{id}.
func (h *Handler) DeleteItem(ctx context.Context, req api.DeleteItemRequestObject) (api.DeleteItemResponseObject, error) {
	owner, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if err := h.svc.Delete(ctx, owner, req.Id); err != nil {
		return nil, err
	}
	return api.DeleteItem204Response{}, nil
}

func toAPI(it Item) api.Item {
	return api.Item{
		Id: it.ID, Name: it.Name, Description: it.Description, Quantity: it.Quantity,
		CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
	}
}

// fromAPI copies only the client-settable fields. The request type has no id,
// owner or timestamps, so mass assignment is impossible by construction.
func fromAPI(b api.CreateItem) Input {
	in := Input{Name: b.Name}
	if b.Description != nil {
		in.Description = *b.Description
	}
	if b.Quantity != nil {
		in.Quantity = *b.Quantity
	}
	return in
}
