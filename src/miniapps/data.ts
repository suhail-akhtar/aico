/**
 * A Mini App's database, and the only way its page can reach one.
 *
 * ## Why the app does not send SQL
 *
 * The obvious design is an endpoint that runs whatever SQL the page sends. It
 * is one function, it supports everything, and it is wrong here: the page is
 * written by a model, and every form field on it becomes a place where a bug
 * or an injected string turns into a statement. A generated app that
 * concatenates a search box into a `WHERE` clause is not a hypothetical — it is
 * the most likely thing for one to do.
 *
 * So the page names a table and passes values, and this module builds the
 * statement. Identifiers are checked against the schema that was actually
 * applied, values only ever arrive as bound parameters, and there is no path
 * from a string in the browser to a token in a query.
 *
 * ## Why the schema is a file and not an API
 *
 * `schema.sql` is applied once, at open. Tables are the app's shape, and a
 * shape the running page can change is not a shape — it is a suggestion. It
 * also means the schema is reviewable: a file you can read, diff, and keep,
 * rather than a sequence of calls you would have to replay to understand.
 *
 * ## node:sqlite
 *
 * Node ships SQLite from 22.5. That is worth a required-version bump on its
 * own: the alternatives are a native module, which would make every
 * `npx github:…` install compile C++ on the user's machine, or WebAssembly,
 * which trades a megabyte and manual persistence for nothing we need. It is
 * marked experimental, which is a real risk and a contained one — it is behind
 * this module and nothing else imports it.
 *
 * @module miniapps/data
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';

/**
 * `node:sqlite`, fetched at runtime rather than imported.
 *
 * esbuild rewrites `node:x` to bare `x` for any builtin missing from its own
 * list, and `node:sqlite` is too new to be on it — so a static import compiles
 * to `import { DatabaseSync } from "sqlite"`, which resolves to nothing and
 * fails when the bundle is loaded rather than when it is built. `external` in
 * the tsup config does not prevent the rewrite.
 *
 * `createRequire` is opaque to the bundler, so the specifier survives intact.
 * The type still comes from a real `import type`, which is erased before
 * esbuild ever sees it, so none of this costs us type checking.
 */
const { DatabaseSync } = withoutSqliteWarning(
  () => createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'),
);
type DatabaseSync = SqliteDatabase;

/**
 * Load the module without Node announcing that SQLite is experimental.
 *
 * We know. The user opening an invoice list does not, and a warning printed
 * into the terminal the first time a Mini App is touched teaches people to
 * ignore the terminal. Node emits it once, when the module is first required —
 * not on each open — so this wraps the require and nothing else. Anything else
 * Node has to say still gets through, and `emitWarning` is restored either way.
 */
function withoutSqliteWarning<T>(load: () => T): T {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/SQLite is an experimental feature/i.test(text)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return load();
  } finally {
    process.emitWarning = original;
  }
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

/**
 * One open database per app, kept for the life of the process.
 *
 * Opening per request would reapply the schema and lose SQLite's page cache on
 * every keystroke of a type-ahead. Apps are small and few; holding them open is
 * cheaper than the alternative and simpler than a pool.
 */
const open = new Map<string, DatabaseSync>();

export function closeAll(): void {
  for (const db of open.values()) {
    try { db.close(); } catch { /* already gone; nothing to salvage */ }
  }
  open.clear();
}

/**
 * The app's database, opening and initialising it if this is the first call.
 *
 * `schema.sql` is applied every time rather than once-and-recorded, so it must
 * be written to tolerate that — `CREATE TABLE IF NOT EXISTS`. Trading a
 * migrations table for a constraint on the schema is the right way round at
 * this size: there is no upgrade path to get wrong, and the constraint is one
 * the author would follow anyway.
 */
export async function database(dir: string): Promise<DatabaseSync> {
  const existing = open.get(dir);
  if (existing) return existing;

  const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
  // Write-ahead logging, so a read during a write does not block. These apps
  // are single-user, but a page that polls while you type is two connections
  // as far as SQLite is concerned.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const schemaPath = path.join(dir, 'schema.sql');
  if (existsSync(schemaPath)) {
    const schema = await readFile(schemaPath, 'utf8');
    if (schema.trim()) db.exec(schema);
  }

  open.set(dir, db);
  return db;
}

/**
 * The tables the app actually has.
 *
 * Read from the database rather than parsed from `schema.sql`, because what
 * matters is what exists — and this is the list every identifier in a request
 * is checked against. Deriving it from the file would mean trusting a file to
 * describe a database.
 */
export async function describe(dir: string): Promise<TableInfo[]> {
  const db = await database(dir);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];

  return tables.map(({ name }) => ({
    name,
    // `pragma_table_info` as a table-valued function, so the table name is a
    // bound parameter rather than spliced into `PRAGMA table_info(...)`, which
    // takes no parameters and would have to be concatenated.
    columns: (db.prepare(
      'SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(?)',
    ).all(name) as { name: string; type: string; nn: number; pk: number }[])
      .map(c => ({ name: c.name, type: c.type, notNull: c.nn === 1, primaryKey: c.pk > 0 })),
  }));
}

/** Resolve a caller's table name against the schema, or refuse it. */
async function tableOf(dir: string, name: string): Promise<TableInfo> {
  const found = (await describe(dir)).find(t => t.name === name);
  if (!found) throw new Error(`no table "${name}" in this app`);
  return found;
}

/**
 * Quote an identifier that has already been matched against the schema.
 *
 * The check is the security boundary; this only stops a legitimate column
 * called `order` or `group` from colliding with a keyword. Doubling any
 * embedded quote keeps that true even for a name SQLite allowed and nobody
 * expected.
 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ListOptions {
  /** Equality filters. Unknown columns are refused, not ignored. */
  where?: Record<string, unknown>;
  orderBy?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export async function list(
  dir: string, table: string, options: ListOptions = {},
): Promise<Record<string, unknown>[]> {
  const info = await tableOf(dir, table);
  const known = new Set(info.columns.map(c => c.name));
  const db = await database(dir);

  const filters = Object.entries(options.where ?? {});
  for (const [column] of filters) {
    if (!known.has(column)) throw new Error(`no column "${column}" on ${table}`);
  }

  const where = filters.length
    ? ` WHERE ${filters.map(([c]) => `${ident(c)} = ?`).join(' AND ')}`
    : '';

  let order = '';
  if (options.orderBy) {
    if (!known.has(options.orderBy)) throw new Error(`no column "${options.orderBy}" on ${table}`);
    // Direction is a closed set rather than a string, so it cannot carry a
    // clause of its own.
    order = ` ORDER BY ${ident(options.orderBy)} ${options.direction === 'desc' ? 'DESC' : 'ASC'}`;
  }

  // Clamped rather than trusted: a page asking for everything is usually a bug,
  // and a page asking for two million rows is always one.
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 1000);
  const offset = Math.max(Number(options.offset) || 0, 0);

  return db.prepare(
    `SELECT * FROM ${ident(table)}${where}${order} LIMIT ${limit} OFFSET ${offset}`,
  ).all(...filters.map(([, v]) => v as never)) as Record<string, unknown>[];
}

export async function insert(
  dir: string, table: string, row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const info = await tableOf(dir, table);
  const known = new Set(info.columns.map(c => c.name));
  const entries = Object.entries(row).filter(([c]) => known.has(c));
  if (entries.length === 0) throw new Error(`nothing to insert into ${table}`);

  const db = await database(dir);
  const result = db.prepare(
    `INSERT INTO ${ident(table)} (${entries.map(([c]) => ident(c)).join(', ')})`
    + ` VALUES (${entries.map(() => '?').join(', ')})`,
  ).run(...entries.map(([, v]) => v as never));

  // The row as stored, not as sent — defaults, triggers and type affinity all
  // mean those can differ, and the page should show what is in the database.
  return db.prepare(`SELECT * FROM ${ident(table)} WHERE rowid = ?`)
    .get(result.lastInsertRowid as never) as Record<string, unknown>;
}

export async function update(
  dir: string, table: string, id: unknown, row: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const info = await tableOf(dir, table);
  const key = info.columns.find(c => c.primaryKey);
  if (!key) throw new Error(`${table} has no primary key, so a row cannot be addressed`);

  const known = new Set(info.columns.map(c => c.name));
  const entries = Object.entries(row).filter(([c]) => known.has(c) && c !== key.name);
  if (entries.length === 0) throw new Error(`nothing to update on ${table}`);

  const db = await database(dir);
  db.prepare(
    `UPDATE ${ident(table)} SET ${entries.map(([c]) => `${ident(c)} = ?`).join(', ')}`
    + ` WHERE ${ident(key.name)} = ?`,
  ).run(...entries.map(([, v]) => v as never), id as never);

  return db.prepare(`SELECT * FROM ${ident(table)} WHERE ${ident(key.name)} = ?`)
    .get(id as never) as Record<string, unknown> ?? null;
}

export async function remove(dir: string, table: string, id: unknown): Promise<boolean> {
  const info = await tableOf(dir, table);
  const key = info.columns.find(c => c.primaryKey);
  if (!key) throw new Error(`${table} has no primary key, so a row cannot be addressed`);

  const db = await database(dir);
  const result = db.prepare(
    `DELETE FROM ${ident(table)} WHERE ${ident(key.name)} = ?`,
  ).run(id as never);
  return Number(result.changes) > 0;
}
