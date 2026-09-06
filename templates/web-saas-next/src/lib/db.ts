/**
 * One SQLite database for the whole server process, migrated on first use.
 *
 * node:sqlite is synchronous and in-process: no pool, no driver. The handle is
 * cached on `globalThis` so Next's dev server, which re-evaluates modules on
 * change, does not open a new connection per edit. `DATABASE_PATH` says where
 * the file lives; `:memory:` in tests.
 *
 * Migrations are the numbered entries below. Append, never edit: a deployed
 * database has already run the earlier ones.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT    NOT NULL,
     created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS items (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
     done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
     created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS items_user ON items (user_id, created_at DESC)`,
  // 4: the next migration goes here.
];

export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT n FROM _migrations').all() as Array<{ n: number }>).map(r => r.n));
  MIGRATIONS.forEach((sql, i) => {
    const n = i + 1;
    if (done.has(n)) return;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?, ?)').run(n, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
  return db;
}

const globalForDb = globalThis as unknown as { __appDb?: DatabaseSync };

/** The process-wide database. Pages, actions and route handlers call this. */
export function db(): DatabaseSync {
  if (!globalForDb.__appDb) {
    globalForDb.__appDb = openDatabase(process.env.DATABASE_PATH ?? './data/app.sqlite');
  }
  return globalForDb.__appDb;
}
