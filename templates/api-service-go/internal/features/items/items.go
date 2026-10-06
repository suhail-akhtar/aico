// Package items is the worked feature: a user's own list of items, end to end.
// Copy this package to add the next resource (docs/EXTENDING.md).
//
// Layout of a feature, and why:
//   - items.go     the domain: types, the Repository PORT, and the Service that
//     holds every business rule (validation, ids, timestamps, pagination);
//   - handler.go   the HTTP ADAPTER: maps the generated request/response types
//     to the Service, nothing else;
//   - postgres.go  the database ADAPTER (sqlc queries);
//   - memory.go    the in-memory ADAPTER, a faithful fake used by unit and API
//     tests and checked against the same contract suite as postgres.go.
//
// The Service never sees HTTP and the handler never sees SQL, so each can be
// replaced (a gRPC handler, a different store) without touching the rules.
//
// Ownership is enforced at the data layer: every Repository method takes the
// owner id and the query filters on it. Another user's item is therefore
// "not found", indistinguishable from a missing one, so ids cannot be probed.
package items

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/api-service/internal/platform/apperr"
	"example.com/api-service/internal/platform/clock"
	"example.com/api-service/internal/platform/ids"
	"example.com/api-service/internal/platform/pagination"
	"example.com/api-service/internal/platform/validate"
)

// Limits mirrored from api/openapi.yaml and the database CHECK constraints.
const (
	MaxNameLen        = 120
	MaxDescriptionLen = 1000
	MaxQuantity       = 1_000_000
)

// ErrNotFound is returned when an item does not exist or is not the caller's.
var ErrNotFound = apperr.New(apperr.KindNotFound, "item not found")

// Item is a stored item.
type Item struct {
	ID          string
	OwnerID     string
	Name        string
	Description string
	Quantity    int
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Input is what a client may set; nothing else is client-controlled.
type Input struct {
	Name        string
	Description string
	Quantity    int
}

// Page is one page of a listing.
type Page struct {
	Items      []Item
	NextCursor string // empty on the last page
}

// Repository is the storage port. Implementations must filter by ownerID.
type Repository interface {
	Create(ctx context.Context, it Item) error
	Get(ctx context.Context, ownerID, id string) (Item, error)
	// List returns up to limit items with id < after, newest first.
	List(ctx context.Context, ownerID, after string, limit int) ([]Item, error)
	Update(ctx context.Context, ownerID, id string, in Input, now time.Time) (Item, error)
	Delete(ctx context.Context, ownerID, id string) error
}

// IDGenerator creates ids.
type IDGenerator interface{ New() string }

// Service holds the business rules.
type Service struct {
	repo  Repository
	ids   IDGenerator
	clock clock.Clock
}

// NewService wires a Service.
func NewService(repo Repository, ids IDGenerator, c clock.Clock) *Service {
	return &Service{repo: repo, ids: ids, clock: c}
}

// Create validates in and stores a new item owned by ownerID.
func (s *Service) Create(ctx context.Context, ownerID string, in Input) (Item, error) {
	in, err := normalise(in)
	if err != nil {
		return Item{}, err
	}
	now := s.clock.Now()
	it := Item{
		ID: s.ids.New(), OwnerID: ownerID,
		Name: in.Name, Description: in.Description, Quantity: in.Quantity,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.repo.Create(ctx, it); err != nil {
		return Item{}, fmt.Errorf("create item: %w", err)
	}
	return it, nil
}

// Get returns one of the owner's items.
func (s *Service) Get(ctx context.Context, ownerID, id string) (Item, error) {
	if !ids.Valid(id) {
		return Item{}, ErrNotFound
	}
	return s.repo.Get(ctx, ownerID, id)
}

// List returns a page of the owner's items, newest first. limit 0 means the
// default page size; cursor "" means the first page.
func (s *Service) List(ctx context.Context, ownerID string, limit int, cursor string) (Page, error) {
	var verrs validate.Errors
	if limit == 0 {
		limit = pagination.DefaultLimit
	}
	if limit < 1 || limit > pagination.MaxLimit {
		verrs.Add("limit", fmt.Sprintf("must be between 1 and %d", pagination.MaxLimit))
	}
	after := ids.MaxID
	if cursor != "" {
		id, ok := pagination.DecodeCursor(cursor)
		if !ok {
			verrs.Add("cursor", "is not a valid cursor")
		}
		after = id
	}
	if err := verrs.Err(); err != nil {
		return Page{}, err
	}

	// One extra row tells us whether another page exists without a COUNT query.
	rows, err := s.repo.List(ctx, ownerID, after, limit+1)
	if err != nil {
		return Page{}, fmt.Errorf("list items: %w", err)
	}
	page := Page{Items: rows}
	if len(rows) > limit {
		page.Items = rows[:limit]
		page.NextCursor = pagination.EncodeCursor(rows[limit-1].ID)
	}
	return page, nil
}

// Update replaces the item's client-settable fields.
func (s *Service) Update(ctx context.Context, ownerID, id string, in Input) (Item, error) {
	in, err := normalise(in)
	if err != nil {
		return Item{}, err
	}
	if !ids.Valid(id) {
		return Item{}, ErrNotFound
	}
	return s.repo.Update(ctx, ownerID, id, in, s.clock.Now())
}

// Delete removes one of the owner's items.
func (s *Service) Delete(ctx context.Context, ownerID, id string) error {
	if !ids.Valid(id) {
		return ErrNotFound
	}
	return s.repo.Delete(ctx, ownerID, id)
}

// normalise trims and validates client input. Length is counted in characters
// (runes) to match PostgreSQL's char_length, so a name of 120 emoji is accepted
// by both layers and 121 is refused by both.
func normalise(in Input) (Input, error) {
	var verrs validate.Errors
	in.Name = strings.TrimSpace(in.Name)
	switch n := utf8.RuneCountInString(in.Name); {
	case n == 0:
		verrs.Add("name", "is required")
	case n > MaxNameLen:
		verrs.Add("name", fmt.Sprintf("must be at most %d characters", MaxNameLen))
	case !utf8.ValidString(in.Name) || strings.ContainsRune(in.Name, 0):
		verrs.Add("name", "contains invalid characters")
	}
	if utf8.RuneCountInString(in.Description) > MaxDescriptionLen {
		verrs.Add("description", fmt.Sprintf("must be at most %d characters", MaxDescriptionLen))
	} else if !utf8.ValidString(in.Description) || strings.ContainsRune(in.Description, 0) {
		verrs.Add("description", "contains invalid characters")
	}
	if in.Quantity < 0 || in.Quantity > MaxQuantity {
		verrs.Add("quantity", fmt.Sprintf("must be between 0 and %d", MaxQuantity))
	}
	return in, verrs.Err()
}
