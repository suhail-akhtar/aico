-- Applied on every open: every statement must be idempotent.
-- To change a table that already has data, append an ALTER TABLE line below
-- (and update the CREATE TABLE so a fresh database matches). Never rewrite
-- history above; the file is the migration log.

CREATE TABLE IF NOT EXISTS records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  amount      REAL    NOT NULL DEFAULT 0 CHECK (amount >= 0),
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS records_created_at ON records (created_at);
CREATE INDEX IF NOT EXISTS records_status ON records (status);

-- Migrations (append below, oldest first):
