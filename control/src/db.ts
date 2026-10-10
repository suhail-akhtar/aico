/**
 * The control server's database: one SQLite file, forward-only migrations.
 *
 * Rules the schema holds to (ADR 0040), each checked by a test:
 *  - every table except `meta` and `tenants` has a `tenant_id` column, and the
 *    repository (store.ts) puts it in every query — tenant isolation is not a
 *    convention a new endpoint can forget;
 *  - `audit` is append-only at the storage layer: triggers abort UPDATE and
 *    DELETE, so tampering needs a deliberate schema change that the hash chain
 *    still exposes;
 *  - tokens, session ids and device codes are stored as hashes only.
 *
 * `node:sqlite` is the engine's own baseline (Node >= 22.5), so a single-node
 * deployment needs nothing installed. Postgres is a later backend behind the
 * same repository functions.
 *
 * @module db
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded through require: esbuild (tsup) rewrites a static `node:sqlite` import to `sqlite`, which does not exist.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

const MIGRATIONS: string[] = [
  // 1 — the whole phase-1 schema.
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE tenants (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  );

  CREATE TABLE teams (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE (tenant_id, name)
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
    team_id TEXT, status TEXT NOT NULL DEFAULT 'active',
    external_id TEXT, source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL, last_login_at INTEGER,
    UNIQUE (tenant_id, email)
  );
  CREATE INDEX users_external ON users (tenant_id, external_id);

  CREATE TABLE policies (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    scope TEXT NOT NULL, scope_id TEXT NOT NULL, name TEXT NOT NULL,
    doc TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT,
    UNIQUE (tenant_id, scope, scope_id)
  );

  CREATE TABLE budgets (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    scope TEXT NOT NULL, scope_id TEXT NOT NULL, period TEXT NOT NULL,
    limit_usd REAL NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE (tenant_id, scope, scope_id, period)
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL, csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    approvals_failed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE oidc_flows (
    state_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    verifier TEXT NOT NULL, nonce TEXT NOT NULL, next TEXT NOT NULL, created_at INTEGER NOT NULL
  );

  CREATE TABLE device_grants (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_code_hash TEXT NOT NULL UNIQUE, user_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', user_id TEXT,
    interval_s INTEGER NOT NULL, last_poll_at INTEGER, expires_at INTEGER NOT NULL,
    device_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', aico_version TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (tenant_id, user_code)
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
    aico_version TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_seen_at INTEGER,
    revoked_at INTEGER, revoked_reason TEXT
  );

  CREATE TABLE refresh_tokens (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
    device_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
  );

  CREATE TABLE audit (
    tenant_id TEXT NOT NULL REFERENCES tenants(id), seq INTEGER NOT NULL,
    record_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, source TEXT NOT NULL,
    user_id TEXT, user_email TEXT, device_id TEXT,
    kind TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
    body TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
    PRIMARY KEY (tenant_id, seq),
    UNIQUE (tenant_id, record_id)
  );
  CREATE INDEX audit_time ON audit (tenant_id, ts_ms);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

  CREATE TABLE usage_events (
    tenant_id TEXT NOT NULL REFERENCES tenants(id), event_id TEXT NOT NULL,
    user_id TEXT NOT NULL, team_id TEXT, device_id TEXT,
    at_ms INTEGER NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id, event_id)
  );
  CREATE INDEX usage_user ON usage_events (tenant_id, user_id, at_ms);
  `,
];

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

function migrate(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) throw new Error(`The database is from a newer AICO Control (schema ${current}); this one knows ${MIGRATIONS.length}.`);
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
