-- +goose Up
-- Identity and the worked resource. Every constraint the API relies on lives
-- here as well as in code: the database is the last line of defence, and a
-- second writer (a script, another service) gets the same guarantees.

CREATE TABLE users (
    id            uuid        PRIMARY KEY,
    email         text        NOT NULL,
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL,
    CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 254)
);
CREATE UNIQUE INDEX users_email_key ON users (email);

-- Sessions store the SHA-256 of the bearer token, never the token: a database
-- leak must not hand out live credentials.
CREATE TABLE sessions (
    token_hash bytea       PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE items (
    id          uuid        PRIMARY KEY,
    owner_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description text        NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
    quantity    integer     NOT NULL DEFAULT 0 CHECK (quantity BETWEEN 0 AND 1000000),
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);
-- Keyset pagination: ids are UUIDv7, so id order is creation order.
CREATE INDEX items_owner_id_id_idx ON items (owner_id, id DESC);

-- +goose Down
DROP TABLE items;
DROP TABLE sessions;
DROP TABLE users;
