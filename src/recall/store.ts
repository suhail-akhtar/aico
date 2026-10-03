/**
 * The Recall index: one SQLite file that makes memories, knowledge, past
 * sessions and About-you facts searchable by words (FTS5) and, when an
 * embedding model is configured, by meaning (ADR 0018).
 *
 * AN INDEX, NOT A SOURCE OF TRUTH. Memories and knowledge stay files; past
 * sessions stay their append-only logs (ADR 0001). Everything here except
 * About-you facts can be rebuilt from those, so a missing or corrupt database
 * is not an error: it is renamed aside and rebuilt on open. About-you facts
 * belong to the profile learner, which re-supplies them through
 * {@link registerProfileSource} when a rebuild happens.
 *
 * INCREMENTAL. Each row remembers the file signature it was built from
 * (mtime and size); a sync re-reads only files whose signature moved and
 * drops rows whose file is gone. A row whose words change loses its
 * embedding, so a stale vector can never describe new text.
 *
 * WHY node:sqlite. FTS5 with BM25 ships in Node's SQLite (verified on 22.21);
 * no dependency, nothing to compile. Loaded lazily through `createRequire`
 * for the same bundler reason as miniapps/data, and only when Recall is used:
 * a turn with a small memory store never opens it.
 *
 * Deliberately not here: ranking (recall/search), embedding calls
 * (recall/embed), and any write to the files it mirrors — status changes for
 * memories go through memory/store, which owns those files.
 *
 * @module recall/store
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import type { DatabaseSync as SqliteDatabase, StatementSync } from 'node:sqlite';
import { aicoHome } from '../home.js';
import { memoryRoot, parseMemoryFile, type MemoryScope } from '../memory/store.js';
import { parseEntry as parseKnowledge } from '../knowledge/store.js';
import { episodeFromLog, listSessionLogs } from './episodes.js';

export type RecallKind = 'memory' | 'knowledge' | 'episode' | 'profile';
export type RecallStatus = 'active' | 'superseded' | 'archived';

export interface RecallItem {
  /** `memory:<file>`, `knowledge:<file>`, `episode:<session id>`, `profile:<id>`. */
  id: string;
  kind: RecallKind;
  /** memory: global|project|session; knowledge: global|project; episode/profile: global. */
  scope: string;
  /** Normalized project path; `session:<id>` for a session memory. */
  project: string | null;
  title: string;
  text: string;
  /** The file (memory, knowledge, session log) or the profile id it mirrors. */
  sourceRef: string;
  created: number;
  updated: number;
  lastUsed: number | null;
  uses: number;
  importance: number;
  pinned: boolean;
  status: RecallStatus;
  supersededBy: string | null;
  embedModel: string | null;
  /** Extra facts per kind, e.g. an episode's session id, files and tools. */
  meta: Record<string, unknown>;
}

const SCHEMA_VERSION = '1';

export function recallDir(): string { return path.join(aicoHome(), 'recall'); }
export function recallDbPath(): string { return path.join(recallDir(), 'recall.db'); }

/** Paths compare case-insensitively, exactly as memory/store keys project directories. */
export function normProject(p: string): string {
  return path.resolve(p).toLowerCase();
}

// ── opening ──────────────────────────────────────────────────────────

let sqlite: typeof import('node:sqlite') | undefined;
function loadSqlite(): typeof import('node:sqlite') {
  if (sqlite) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/SQLite is an experimental feature/i.test(text)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    return sqlite;
  } finally {
    process.emitWarning = original;
  }
}

interface Handle { db: SqliteDatabase; file: string; stmts: Map<string, StatementSync> }
let handle: Handle | undefined;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS items (
  n INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  project TEXT,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  last_used INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  embedding BLOB,
  embed_model TEXT,
  sig TEXT,
  hash TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS items_kind ON items(kind, status);
CREATE INDEX IF NOT EXISTS items_source ON items(source_ref);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, text, content='items', content_rowid='n', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, text) VALUES (new.n, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, text) VALUES ('delete', old.n, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, text ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, text) VALUES ('delete', old.n, old.title, old.text);
  INSERT INTO items_fts(rowid, title, text) VALUES (new.n, new.title, new.text);
END;
`;

function tryOpen(file: string): SqliteDatabase {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const check = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (check && Object.values(check)[0] !== 'ok') throw new Error('recall index failed its integrity check');
    db.exec(DDL);
    const v = db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value?: string } | undefined;
    if (!v) db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)`).run(SCHEMA_VERSION);
    else if (v.value !== SCHEMA_VERSION) throw new Error(`recall index schema ${v.value} is not ${SCHEMA_VERSION}`);
    return db;
  } catch (err) {
    try { db.close(); } catch { /* already unusable; the caller moves it aside */ }
    throw err;
  }
}

/**
 * The open database, rebuilt from scratch when the file is missing, corrupt
 * or from another schema. Moving it aside (not deleting) keeps one copy to
 * look at if a rebuild ever needs explaining.
 */
export function recallDb(): SqliteDatabase {
  const file = recallDbPath();
  if (handle && handle.file === file) return handle.db;
  if (handle) closeRecall();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db: SqliteDatabase;
  try {
    db = tryOpen(file);
  } catch {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.renameSync(file + suffix, `${file}.corrupt${suffix}`); } catch { /* absent: nothing to move */ }
    }
    db = tryOpen(file);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('rebuilt', ?)`).run(String(Date.now()));
  }
  handle = { db, file, stmts: new Map() };
  return db;
}

function stmt(sql: string): StatementSync {
  const db = recallDb();
  let s = handle!.stmts.get(sql);
  if (!s) { s = db.prepare(sql); handle!.stmts.set(sql, s); }
  return s;
}

/** Close the database (tests, shutdown). The next call reopens it. */
export function closeRecall(): void {
  if (!handle) return;
  try { handle.db.close(); } catch { /* best effort: the process may be exiting */ }
  handle = undefined;
}

export function getMeta(key: string): string | undefined {
  return (stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
}
export function setMeta(key: string, value: string): void {
  stmt('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, value);
}

// ── rows ─────────────────────────────────────────────────────────────

interface Row {
  n: number; id: string; kind: string; scope: string; project: string | null; title: string; text: string;
  source_ref: string; created: number; updated: number; last_used: number | null; uses: number;
  importance: number; pinned: number; status: string; superseded_by: string | null;
  embed_model: string | null; meta: string | null; embedding?: Uint8Array | null;
}

export function rowToItem(r: Row): RecallItem {
  let meta: Record<string, unknown> = {};
  try { meta = r.meta ? JSON.parse(r.meta) as Record<string, unknown> : {}; } catch { /* a torn meta is only extra facts */ }
  return {
    id: r.id, kind: r.kind as RecallKind, scope: r.scope, project: r.project, title: r.title, text: r.text,
    sourceRef: r.source_ref, created: r.created, updated: r.updated, lastUsed: r.last_used, uses: r.uses,
    importance: r.importance, pinned: r.pinned === 1, status: r.status as RecallStatus,
    supersededBy: r.superseded_by, embedModel: r.embed_model, meta,
  };
}

export const ITEM_COLUMNS = 'n, id, kind, scope, project, title, text, source_ref, created, updated, last_used, uses, importance, pinned, status, superseded_by, embed_model, meta';

export interface UpsertInput {
  id: string; kind: RecallKind; scope?: string; project?: string | null; title: string; text: string;
  sourceRef: string; created: number; updated: number; importance?: number; pinned?: boolean;
  status?: RecallStatus; supersededBy?: string | null; sig?: string; meta?: Record<string, unknown>;
}

const hashOf = (title: string, text: string): string =>
  crypto.createHash('sha1').update(title).update('\0').update(text).digest('hex').slice(0, 16);

/**
 * Insert or update one row. Keeps use counts and `last_used`; drops the
 * embedding when the words changed. Status from the source wins, except that
 * an `archived` row stays archived until its source changes.
 */
export function upsertItem(input: UpsertInput): void {
  const hash = hashOf(input.title, input.text);
  const prior = stmt('SELECT hash, status FROM items WHERE id = ?').get(input.id) as { hash?: string; status?: string } | undefined;
  const changed = !prior || prior.hash !== hash;
  // Upkeep's verdicts (archived, superseded) on index-only rows stand until the words change.
  const status = input.status ?? (prior && !changed && prior.status !== 'active' ? prior.status as RecallStatus : 'active');
  stmt(`INSERT INTO items (id, kind, scope, project, title, text, source_ref, created, updated, importance, pinned, status, superseded_by, sig, hash, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, scope = excluded.scope, project = excluded.project,
          title = excluded.title, text = excluded.text, source_ref = excluded.source_ref, created = excluded.created,
          updated = excluded.updated, importance = excluded.importance, pinned = excluded.pinned, status = excluded.status,
          superseded_by = excluded.superseded_by, sig = excluded.sig, hash = excluded.hash, meta = excluded.meta`)
    .run(
      input.id, input.kind, input.scope ?? 'global', input.project ?? null, input.title, input.text, input.sourceRef,
      input.created, input.updated, input.importance ?? 1, input.pinned ? 1 : 0, status, input.supersededBy ?? null,
      input.sig ?? null, hash, JSON.stringify(input.meta ?? {}),
    );
  if (changed) stmt('UPDATE items SET embedding = NULL, embed_model = NULL WHERE id = ?').run(input.id);
}

export function deleteItem(id: string): void {
  stmt('DELETE FROM items WHERE id = ?').run(id);
}

export function getItem(id: string): RecallItem | undefined {
  const r = stmt(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowToItem(r) : undefined;
}

export function listItems(filter: { kind?: RecallKind; status?: RecallStatus } = {}): RecallItem[] {
  const where: string[] = []; const args: string[] = [];
  if (filter.kind) { where.push('kind = ?'); args.push(filter.kind); }
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const sql = `SELECT ${ITEM_COLUMNS} FROM items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY n`;
  return (recallDb().prepare(sql).all(...args) as unknown as Row[]).map(rowToItem);
}

export function countItems(): Record<RecallKind, number> {
  const out: Record<RecallKind, number> = { memory: 0, knowledge: 0, episode: 0, profile: 0 };
  for (const r of stmt('SELECT kind, COUNT(*) AS c FROM items GROUP BY kind').all() as Array<{ kind: RecallKind; c: number }>) out[r.kind] = r.c;
  return out;
}

/** Index-only status (episodes, profile). Memory status lives in the memory's file. */
export function setItemStatus(id: string, status: RecallStatus, supersededBy?: string): void {
  stmt('UPDATE items SET status = ?, superseded_by = ? WHERE id = ?').run(status, supersededBy ?? null, id);
}

/** Recall used these: more uses, newer `last_used` (the ranking's use bonus and upkeep's staleness). */
export function recordUse(ids: readonly string[], now = Date.now()): void {
  if (!ids.length) return;
  const s = stmt('UPDATE items SET uses = uses + 1, last_used = ? WHERE id = ?');
  for (const id of ids) s.run(now, id);
}

// ── embeddings ───────────────────────────────────────────────────────

export function setEmbedding(id: string, model: string, vector: Float32Array): void {
  stmt('UPDATE items SET embedding = ?, embed_model = ? WHERE id = ?')
    .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
}

/** Active rows with no vector from this model, oldest first. */
export function itemsNeedingEmbedding(model: string, limit: number): RecallItem[] {
  return (stmt(`SELECT ${ITEM_COLUMNS} FROM items WHERE status = 'active' AND (embedding IS NULL OR embed_model IS NOT ?) ORDER BY n LIMIT ?`)
    .all(model, limit) as unknown as Row[]).map(rowToItem);
}

/** Every vector from this model, decoded. */
export function embeddingsFor(model: string): Array<{ id: string; vector: Float32Array }> {
  const rows = stmt('SELECT id, embedding FROM items WHERE embed_model = ? AND embedding IS NOT NULL').all(model) as Array<{ id: string; embedding: Uint8Array }>;
  return rows.map(r => {
    const copy = new Uint8Array(r.embedding);   // aligned copy: Float32Array needs a 4-byte offset
    return { id: r.id, vector: new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)) };
  });
}

// ── syncing from the sources ─────────────────────────────────────────

function sigOf(file: string): string | undefined {
  try { const s = fs.statSync(file); return `${Math.round(s.mtimeMs)}:${s.size}`; } catch { return undefined; }
}

function storedSigs(kind: RecallKind): Map<string, { id: string; sig: string | null }> {
  const out = new Map<string, { id: string; sig: string | null }>();
  for (const r of stmt('SELECT id, source_ref, sig FROM items WHERE kind = ?').all(kind) as Array<{ id: string; source_ref: string; sig: string | null }>) {
    out.set(r.source_ref, { id: r.id, sig: r.sig });
  }
  return out;
}

function mdFiles(dir: string): string[] {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => path.join(dir, f)); } catch { return []; }
}

/** Mirror every memory file. Returns how many rows were (re)written. */
export function syncMemories(): number {
  const root = memoryRoot();
  const files: Array<{ file: string; scope: MemoryScope }> = mdFiles(path.join(root, 'global')).map(file => ({ file, scope: 'global' as const }));
  for (const [sub, scope] of [['projects', 'project'], ['sessions', 'session']] as const) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(path.join(root, sub)); } catch { /* none yet */ }
    for (const d of dirs) for (const file of mdFiles(path.join(root, sub, d))) files.push({ file, scope });
  }
  const known = storedSigs('memory');
  let written = 0;
  const seen = new Set<string>();
  recallDb().exec('BEGIN');
  try {
    for (const { file, scope } of files) {
      seen.add(file);
      const sig = sigOf(file);
      if (!sig || known.get(file)?.sig === sig) continue;
      const m = parseMemoryFile(file, scope);
      if (!m) continue;
      const project = scope === 'project' ? (m.belongsTo ? normProject(m.belongsTo) : null)
        : scope === 'session' ? `session:${m.belongsTo ?? path.basename(path.dirname(file))}` : null;
      upsertItem({
        id: `memory:${file}`, kind: 'memory', scope, project, title: m.id, text: m.text, sourceRef: file,
        created: m.createdAt || m.updatedAt, updated: m.updatedAt || m.createdAt,
        importance: m.pinned ? 1.3 : 1, pinned: m.pinned === true,
        status: m.status === 'superseded' ? 'superseded' : 'active', supersededBy: m.supersededBy ?? null,
        sig, meta: { memoryId: m.id, tags: m.tags },
      });
      written++;
    }
    for (const [ref, row] of known) if (!seen.has(ref)) { deleteItem(row.id); written++; }
    recallDb().exec('COMMIT');
  } catch (err) {
    recallDb().exec('ROLLBACK');
    throw err;
  }
  return written;
}

/** Mirror knowledge: the global directory plus each named project's `.aico/knowledge`. */
export function syncKnowledge(projectRoots: readonly string[] = []): number {
  const dirs = [path.join(aicoHome(), 'knowledge'), ...projectRoots.map(r => path.join(r, '.aico', 'knowledge'))];
  const known = storedSigs('knowledge');
  let written = 0;
  recallDb().exec('BEGIN');
  try {
    for (const dir of dirs) {
      const files = mdFiles(dir);
      const here = new Set(files);
      for (const file of files) {
        const sig = sigOf(file);
        if (!sig || known.get(file)?.sig === sig) continue;
        let raw = '';
        try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
        if (raw.length > 8_000) continue;
        const entry = parseKnowledge(path.basename(file, '.md'), file, raw);
        if (!entry) continue;
        const mtime = Number(sig.split(':')[0]);
        upsertItem({
          id: `knowledge:${file}`, kind: 'knowledge', scope: entry.scope ? 'project' : 'global',
          project: entry.scope ? normProject(entry.scope) : null, title: entry.id,
          text: `${entry.trigger}\n${entry.content}`, sourceRef: file, created: mtime, updated: mtime, sig,
          meta: { trigger: entry.trigger },
        });
        written++;
      }
      // Only rows from a directory that was scanned can be judged gone.
      for (const [ref, row] of known) {
        if (path.dirname(ref) === dir && !here.has(ref)) { deleteItem(row.id); written++; }
      }
    }
    recallDb().exec('COMMIT');
  } catch (err) {
    recallDb().exec('ROLLBACK');
    throw err;
  }
  return written;
}

/**
 * Build an episode for every session log that changed since it was indexed
 * and is not mid-turn. Stops when `budgetMs` runs out; the rest are picked up
 * on the next sync, so a first sync over a thousand logs never stalls a turn.
 */
export function syncEpisodes(opts: { budgetMs?: number; now?: number } = {}): { written: number; pending: number } {
  const started = Date.now();
  const budget = opts.budgetMs ?? 4_000;
  const logs = listSessionLogs();
  const known = storedSigs('episode');
  const present = new Set(logs.map(l => l.file));
  let written = 0; let pending = 0;
  for (const [ref, row] of known) if (!present.has(ref)) { deleteItem(row.id); written++; }
  // Newest first: if the budget runs out, the sessions people ask about are in.
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const log of logs) {
    const sig = `${Math.round(log.mtimeMs)}:${log.size}`;
    if (known.get(log.file)?.sig === sig) continue;
    if (Date.now() - started > budget) { pending++; continue; }
    let text = '';
    try { text = fs.readFileSync(log.file, 'utf8'); } catch { continue; }
    const ep = episodeFromLog(text, { sessionId: log.id, now: opts.now });
    if (!ep) continue;   // empty, or mid-turn: indexed once it settles
    upsertItem({
      id: `episode:${log.id}`, kind: 'episode', scope: 'global', project: ep.cwd ? normProject(ep.cwd) : null,
      title: ep.title, text: ep.text, sourceRef: log.file, created: ep.startedAt, updated: ep.endedAt, sig,
      meta: { sessionId: log.id, cwd: ep.cwd, files: ep.files, tools: ep.tools, turns: ep.turns, request: ep.request, outcome: ep.outcome },
    });
    written++;
  }
  return { written, pending };
}

// ── About-you facts (written by src/profile) ─────────────────────────

export interface ProfileItemInput {
  id: string;
  text: string;
  title?: string;
  /** 0–1 confidence or weight; default 1. */
  importance?: number;
  /** `hidden` and forgotten facts are not searchable: pass `archived` (or remove them). */
  status?: RecallStatus;
  updated?: number;
  meta?: Record<string, unknown>;
}

/** Index About-you facts as `profile` rows. Idempotent by id. */
export function upsertProfileItems(items: readonly ProfileItemInput[]): number {
  const now = Date.now();
  recallDb().exec('BEGIN');
  try {
    for (const it of items) {
      if (!it.id || !it.text?.trim()) continue;
      upsertItem({
        id: `profile:${it.id}`, kind: 'profile', scope: 'global', project: null, title: it.title ?? it.id,
        text: it.text.trim(), sourceRef: it.id, created: it.updated ?? now, updated: it.updated ?? now,
        importance: it.importance ?? 1, status: it.status ?? 'active', meta: it.meta ?? {},
      });
    }
    recallDb().exec('COMMIT');
  } catch (err) {
    recallDb().exec('ROLLBACK');
    throw err;
  }
  return items.length;
}

export function removeProfileItem(id: string): boolean {
  const had = getItem(`profile:${id}`);
  deleteItem(`profile:${id}`);
  return Boolean(had);
}

let profileSource: (() => ProfileItemInput[]) | undefined;

/** The profile learner says where its facts come from, so a rebuild can re-index them. */
export function registerProfileSource(source: (() => ProfileItemInput[]) | undefined): void {
  profileSource = source;
}

// ── whole-store operations ───────────────────────────────────────────

export interface SyncReport { memories: number; knowledge: number; episodes: number; pendingEpisodes: number; ms: number }

/** Bring the index up to date with the files and logs. */
export function syncAll(opts: { projectRoots?: string[]; budgetMs?: number; now?: number } = {}): SyncReport {
  const started = Date.now();
  if (getMeta('rebuilt') && profileSource) {
    try {
      upsertProfileItems(profileSource());
      stmt(`DELETE FROM meta WHERE key = 'rebuilt'`).run();
    } catch { /* the learner re-supplies on its next run */ }
  }
  const memories = syncMemories();
  const knowledge = syncKnowledge(opts.projectRoots ?? []);
  const ep = syncEpisodes({ budgetMs: opts.budgetMs, now: opts.now });
  return { memories, knowledge, episodes: ep.written, pendingEpisodes: ep.pending, ms: Date.now() - started };
}

/**
 * Throw the index away and build it again from the sources. About-you rows
 * are kept (they have no file to rebuild from) and re-supplied by the
 * learner when it has registered.
 */
export function rebuildRecall(opts: { projectRoots?: string[]; budgetMs?: number } = {}): SyncReport & { counts: Record<RecallKind, number> } {
  recallDb().exec(`DELETE FROM items WHERE kind != 'profile'`);
  recallDb().exec(`INSERT INTO items_fts(items_fts) VALUES ('rebuild')`);
  const report = syncAll({ ...opts, budgetMs: opts.budgetMs ?? 60_000 });
  if (profileSource) {
    try { upsertProfileItems(profileSource()); } catch { /* kept rows stand until the learner runs */ }
  }
  return { ...report, counts: countItems() };
}
