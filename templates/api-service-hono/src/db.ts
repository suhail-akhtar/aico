/**
 * One SQLite database, opened once, migrated on open.
 *
 * node:sqlite is synchronous and in-process: no pool, no connection string, no
 * driver to install. `DATABASE_PATH` says where the file lives (default
 * `./data/app.sqlite`; `:memory:` in tests). Migrations are the numbered
 * entries below — append, never edit, because a deployed database has already
 * run the earlier ones.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS items (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
     quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
     created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  // 2: next migration goes here, e.g. `ALTER TABLE items ADD COLUMN sku TEXT`
];

export function openDatabase(file = process.env.DATABASE_PATH ?? './data/app.sqlite'): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(
    (db.prepare('SELECT n FROM _migrations').all() as Array<{ n: number }>).map(r => r.n),
  );
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
