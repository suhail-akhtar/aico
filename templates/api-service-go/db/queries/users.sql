-- name: CreateUser :one
INSERT INTO users (id, email, password_hash, created_at)
VALUES ($1, $2, $3, $4)
RETURNING id, email, password_hash, created_at;

-- name: GetUserByEmail :one
SELECT id, email, password_hash, created_at FROM users WHERE email = $1;

-- name: UpdatePasswordHash :exec
UPDATE users SET password_hash = $2 WHERE id = $1;

-- name: GetUserByID :one
SELECT id, email, password_hash, created_at FROM users WHERE id = $1;

-- Just-in-time provisioning of an identity-provider account (AUTH_MODE=oidc).
-- ON CONFLICT (id) DO NOTHING is what makes two simultaneous first requests for
-- the same subject both succeed: the loser inserts nothing and re-reads. An email
-- already owned by a different row still raises the unique violation on
-- users_email_key, which the adapter reports as ErrEmailTaken.
-- name: CreateUserIfAbsent :execrows
INSERT INTO users (id, email, password_hash, created_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (id) DO NOTHING;

-- name: UpdateUserEmail :exec
UPDATE users SET email = $2 WHERE id = $1;
