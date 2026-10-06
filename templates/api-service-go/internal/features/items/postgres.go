package items

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"example.com/api-service/internal/platform/database/dbgen"
)

// PostgresRepository stores items in PostgreSQL through the sqlc queries.
type PostgresRepository struct {
	q *dbgen.Queries
}

// NewPostgresRepository returns a repository over a pool or transaction.
func NewPostgresRepository(db dbgen.DBTX) *PostgresRepository {
	return &PostgresRepository{q: dbgen.New(db)}
}

// Create inserts it.
func (r *PostgresRepository) Create(ctx context.Context, it Item) error {
	err := r.q.CreateItem(ctx, dbgen.CreateItemParams{
		ID: it.ID, OwnerID: it.OwnerID, Name: it.Name, Description: it.Description,
		Quantity:  int32(it.Quantity), //nolint:gosec // validated 0..1,000,000 by the service
		CreatedAt: it.CreatedAt, UpdatedAt: it.UpdatedAt,
	})
	if err != nil {
		return fmt.Errorf("insert item: %w", err)
	}
	return nil
}

// Get returns the owner's item, or ErrNotFound.
func (r *PostgresRepository) Get(ctx context.Context, ownerID, id string) (Item, error) {
	row, err := r.q.GetItem(ctx, dbgen.GetItemParams{ID: id, OwnerID: ownerID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, fmt.Errorf("select item: %w", err)
	}
	return fromRow(row), nil
}

// List returns up to limit items older than after, newest first.
func (r *PostgresRepository) List(ctx context.Context, ownerID, after string, limit int) ([]Item, error) {
	rows, err := r.q.ListItems(ctx, dbgen.ListItemsParams{
		OwnerID: ownerID, ID: after,
		Limit: int32(limit), //nolint:gosec // the service caps the page size at 101
	})
	if err != nil {
		return nil, fmt.Errorf("select items: %w", err)
	}
	out := make([]Item, len(rows))
	for i, row := range rows {
		out[i] = fromRow(row)
	}
	return out, nil
}

// Update replaces the item's fields and returns the stored result, or ErrNotFound.
func (r *PostgresRepository) Update(ctx context.Context, ownerID, id string, in Input, now time.Time) (Item, error) {
	row, err := r.q.UpdateItem(ctx, dbgen.UpdateItemParams{
		ID: id, OwnerID: ownerID, Name: in.Name, Description: in.Description,
		Quantity:  int32(in.Quantity), //nolint:gosec // validated 0..1,000,000 by the service
		UpdatedAt: now,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, fmt.Errorf("update item: %w", err)
	}
	return fromRow(row), nil
}

// Delete removes the owner's item, or returns ErrNotFound.
func (r *PostgresRepository) Delete(ctx context.Context, ownerID, id string) error {
	n, err := r.q.DeleteItem(ctx, dbgen.DeleteItemParams{ID: id, OwnerID: ownerID})
	if err != nil {
		return fmt.Errorf("delete item: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func fromRow(row dbgen.Item) Item {
	return Item{
		ID: row.ID, OwnerID: row.OwnerID, Name: row.Name, Description: row.Description,
		Quantity: int(row.Quantity), CreatedAt: row.CreatedAt.UTC(), UpdatedAt: row.UpdatedAt.UTC(),
	}
}
