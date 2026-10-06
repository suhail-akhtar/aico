-- Every query is scoped by owner_id: ownership is part of the WHERE clause, so
-- another user's row is indistinguishable from a missing one.

-- name: CreateItem :exec
INSERT INTO items (id, owner_id, name, description, quantity, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetItem :one
SELECT id, owner_id, name, description, quantity, created_at, updated_at
FROM items
WHERE id = $1 AND owner_id = $2;

-- name: ListItems :many
SELECT id, owner_id, name, description, quantity, created_at, updated_at
FROM items
WHERE owner_id = $1 AND id < $2
ORDER BY id DESC
LIMIT $3;

-- name: UpdateItem :one
UPDATE items
SET name = $3, description = $4, quantity = $5, updated_at = $6
WHERE id = $1 AND owner_id = $2
RETURNING id, owner_id, name, description, quantity, created_at, updated_at;

-- name: DeleteItem :execrows
DELETE FROM items WHERE id = $1 AND owner_id = $2;
