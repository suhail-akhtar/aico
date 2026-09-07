/**
 * One SQLite database per server process, migrated on first use, seeded with
 * sample data when empty so the dashboard has something to draw on day one.
 * `DATABASE_PATH` says where the file lives; `:memory:` in tests.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS metrics (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     name    TEXT    NOT NULL,
     value   REAL    NOT NULL,
     at      TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS metrics_name_at ON metrics (name, at)`,
];

export function openDatabase(file: string, { seed = true } = {}): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT n FROM _migrations').all() as Array<{ n: number }>).map(r => r.n));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (n, applied_at) VALUES (?, ?)').run(i + 1, new Date().toISOString());
  });
  if (seed && (db.prepare('SELECT count(*) AS n FROM metrics').get() as { n: number }).n === 0) seedSample(db);
  return db;
}

/** Fourteen days of two series, so the page is never blank on first open. Delete once real data flows. */
export function seedSample(db: DatabaseSync): void {
  const insert = db.prepare('INSERT INTO metrics (name, value, at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (let d = 13; d >= 0; d--) {
    const day = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    insert.run('signups', 20 + Math.round(15 * Math.sin(d / 2)) + d, `${day} 12:00:00`);
    insert.run('revenue', 400 + d * 30 + Math.round(60 * Math.cos(d / 3)), `${day} 12:00:00`);
  }
}

const globalForDb = globalThis as unknown as { __appDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!globalForDb.__appDb) globalForDb.__appDb = openDatabase(process.env.DATABASE_PATH ?? './data/app.sqlite');
  return globalForDb.__appDb;
}
