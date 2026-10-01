CREATE TABLE orders (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  tenant_id  TEXT NOT NULL,
  customer   TEXT NOT NULL,
  items      TEXT NOT NULL,
  total      REAL NOT NULL,
  status     TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX orders_tenant ON orders (tenant_id, seq);
