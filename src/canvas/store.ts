/**
 * Canvas documents — a document or a code file the agent writes and the person
 * edits directly, side by side with the chat.
 *
 * ## Where they live
 *
 * In the session's own data directory, next to its attachments:
 * `<workspace>/sessions/<session>/canvas/<id>.json`, one file per canvas. A
 * canvas belongs to the conversation that made it, so it is found by the same
 * lookup the attachment store uses and goes wherever the session goes.
 *
 * ## Why the document is the single source of truth
 *
 * The transcript carries only a reference card (```canvas {"id",…}). The
 * content lives here, versioned, and every writer — the agent's `Canvas` tool
 * and the person's editor — goes through {@link writeCanvas} with the version
 * it was based on. A write based on a stale version is refused and handed the
 * latest document, so neither side can silently overwrite what the other just
 * did. That one rule is what makes two editors on one text safe without locks
 * that outlive a request.
 *
 * ## Concurrency
 *
 * The server and the tool run in one process, so a per-file promise chain is
 * enough to make read-check-write atomic. Files are written to a temporary
 * name and renamed into place, so a crash mid-write leaves the old version
 * rather than half a document.
 *
 * @module canvas/store
 */

import crypto from 'crypto';
import path from 'path';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import type { AicoSettings } from '../settings.js';
import { getWorkspaceInfo } from '../workspace.js';

export type CanvasKind = 'document' | 'code';
export type CanvasAuthor = 'agent' | 'user';

export interface CanvasVersion {
  version: number;
  content: string;
  author: CanvasAuthor;
  /** Epoch milliseconds. */
  at: number;
  note?: string;
}

export interface CanvasDoc {
  id: string;
  title: string;
  kind: CanvasKind;
  /** For `code`: the language ("typescript", "python"…). */
  language?: string;
  content: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Oldest first, capped at {@link CANVAS_VERSION_CAP}. The last entry is the current content. */
  versions: CanvasVersion[];
}

/** What a list shows — no content, no history. */
export interface CanvasSummary {
  id: string;
  title: string;
  kind: CanvasKind;
  language?: string;
  version: number;
  updatedAt: number;
  author: CanvasAuthor;
  chars: number;
}

export interface CanvasContext {
  settings?: AicoSettings;
  cwd: string;
  sessionId: string;
}

/** A change, for the live stream: open editors and cards refresh from it. */
export interface CanvasChange {
  sessionId: string;
  id: string;
  title: string;
  kind: CanvasKind;
  version: number;
  author: CanvasAuthor;
  action: 'create' | 'update' | 'restore';
  at: number;
}

export type WriteResult =
  | { ok: true; canvas: CanvasDoc; changed: boolean }
  | { ok: false; conflict: true; canvas: CanvasDoc };

/** How many versions a canvas keeps. Older ones fall off the front. */
export const CANVAS_VERSION_CAP = 50;
/** Largest content a canvas accepts, in characters. A book chapter, not a book. */
export const CANVAS_MAX_CHARS = 400_000;
const MAX_TITLE = 120;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/i;

export function isCanvasId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function newId(): string {
  return `cv-${crypto.randomBytes(5).toString('hex')}`;
}

function directory(ctx: CanvasContext): string {
  const info = getWorkspaceInfo({ settings: ctx.settings, cwd: ctx.cwd, sessionId: ctx.sessionId });
  if (!info.sessionDir) throw new Error('a canvas needs a session');
  return path.join(info.sessionDir, 'canvas');
}

function fileFor(ctx: CanvasContext, id: string): string {
  if (!isCanvasId(id)) throw new Error(`"${String(id)}" is not a canvas id`);
  return path.join(directory(ctx), `${id}.json`);
}

// ── Events ───────────────────────────────────────────────────────────

const listeners = new Set<(change: CanvasChange) => void>();

/** Hear about every canvas write in this process. Returns the unsubscribe. */
export function onCanvasChange(listener: (change: CanvasChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function announce(ctx: CanvasContext, doc: CanvasDoc, action: CanvasChange['action']): void {
  const last = doc.versions[doc.versions.length - 1];
  const change: CanvasChange = {
    sessionId: ctx.sessionId, id: doc.id, title: doc.title, kind: doc.kind,
    version: doc.version, author: last?.author ?? 'agent', action, at: doc.updatedAt,
  };
  for (const listener of listeners) {
    // One broken subscriber must not fail a write that has already happened.
    try { listener(change); } catch { /* ignored */ }
  }
}

// ── Locking and IO ───────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function readDoc(file: string): Promise<CanvasDoc | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return undefined; }
  try {
    const doc = JSON.parse(text) as CanvasDoc;
    if (!doc || typeof doc.content !== 'string' || !Array.isArray(doc.versions)) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}

async function writeDoc(file: string, doc: CanvasDoc): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(doc), 'utf8');
  // Windows refuses a rename over a file something is reading for a moment
  // (a virus scanner, an indexer). A short retry is the documented remedy.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, file);
      return;
    } catch (err) {
      if (attempt >= 4) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw err;
      }
      await new Promise(r => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

function checkContent(content: unknown): string {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (content.length > CANVAS_MAX_CHARS) {
    throw new Error(`content is ${content.length.toLocaleString()} characters; a canvas holds at most ${CANVAS_MAX_CHARS.toLocaleString()}`);
  }
  return content;
}

function cleanTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  return (t || 'Untitled').slice(0, MAX_TITLE);
}

function cleanLanguage(language: unknown): string | undefined {
  if (typeof language !== 'string') return undefined;
  const l = language.trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 32);
  return l || undefined;
}

function withVersion(doc: CanvasDoc, content: string, author: CanvasAuthor, note?: string): CanvasDoc {
  const at = Math.max(Date.now(), doc.updatedAt + 1);
  const version = doc.version + 1;
  const entry: CanvasVersion = { version, content, author, at, ...(note ? { note: note.slice(0, 200) } : {}) };
  return {
    ...doc,
    content,
    version,
    updatedAt: at,
    versions: [...doc.versions, entry].slice(-CANVAS_VERSION_CAP),
  };
}

// ── The API ──────────────────────────────────────────────────────────

export function summarize(doc: CanvasDoc): CanvasSummary {
  const last = doc.versions[doc.versions.length - 1];
  return {
    id: doc.id, title: doc.title, kind: doc.kind,
    ...(doc.language ? { language: doc.language } : {}),
    version: doc.version, updatedAt: doc.updatedAt, author: last?.author ?? 'agent', chars: doc.content.length,
  };
}

export async function listCanvases(ctx: CanvasContext): Promise<CanvasSummary[]> {
  let names: string[];
  try { names = await readdir(directory(ctx)); } catch { return []; }
  const docs = await Promise.all(names
    .filter(n => n.endsWith('.json') && isCanvasId(n.slice(0, -5)))
    .map(n => readDoc(path.join(directory(ctx), n))));
  return docs
    .filter((d): d is CanvasDoc => Boolean(d))
    .map(summarize)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCanvas(ctx: CanvasContext, id: string): Promise<CanvasDoc | undefined> {
  if (!isCanvasId(id)) return undefined;
  return readDoc(fileFor(ctx, id));
}

export async function createCanvas(ctx: CanvasContext, input: {
  title?: string; kind?: string; language?: string; content: string; author?: CanvasAuthor; note?: string;
}): Promise<CanvasDoc> {
  const content = checkContent(input.content);
  if (input.kind !== undefined && input.kind !== 'document' && input.kind !== 'code') {
    throw new Error('kind must be "document" or "code"');
  }
  const kind: CanvasKind = input.kind === 'code' ? 'code' : 'document';
  const language = kind === 'code' ? cleanLanguage(input.language) : undefined;
  const author = input.author ?? 'agent';
  const now = Date.now();
  let id = newId();
  // Ten hex characters make a collision in one session vanishingly rare; the
  // check makes it impossible.
  while (await getCanvas(ctx, id)) id = newId();
  const doc: CanvasDoc = {
    id, title: cleanTitle(input.title), kind, ...(language ? { language } : {}),
    content, version: 1, createdAt: now, updatedAt: now,
    versions: [{ version: 1, content, author, at: now, ...(input.note ? { note: input.note.slice(0, 200) } : {}) }],
  };
  const file = fileFor(ctx, id);
  await withLock(file, () => writeDoc(file, doc));
  announce(ctx, doc, 'create');
  return doc;
}

/**
 * Replace a canvas's content, if nobody has changed it since `baseVersion`.
 *
 * A stale base is a conflict, answered with the current document so the caller
 * can merge or choose — never a silent overwrite. Writing the content it
 * already has is a no-op that reports success without minting a version, so
 * an autosave that fires twice does not fill the history with duplicates.
 */
export async function writeCanvas(ctx: CanvasContext, id: string, input: {
  content: string; baseVersion: number; author: CanvasAuthor; note?: string; title?: string;
}): Promise<WriteResult> {
  const content = checkContent(input.content);
  const file = fileFor(ctx, id);
  const result = await withLock(file, async (): Promise<WriteResult> => {
    const doc = await readDoc(file);
    if (!doc) throw new CanvasNotFound(id);
    if (!Number.isInteger(input.baseVersion) || input.baseVersion !== doc.version) {
      return { ok: false, conflict: true, canvas: doc };
    }
    const title = input.title !== undefined ? cleanTitle(input.title) : doc.title;
    if (content === doc.content && title === doc.title) return { ok: true, canvas: doc, changed: false };
    const next = { ...withVersion(doc, content, input.author, input.note), title };
    await writeDoc(file, next);
    return { ok: true, canvas: next, changed: true };
  });
  if (result.ok && result.changed) announce(ctx, result.canvas, 'update');
  return result;
}

/**
 * Bring back an earlier version — as a new version on top, so the history
 * keeps what was replaced and a restore can itself be undone.
 */
export async function restoreCanvas(ctx: CanvasContext, id: string, version: number, input: {
  author: CanvasAuthor; baseVersion?: number;
}): Promise<WriteResult> {
  const file = fileFor(ctx, id);
  const result = await withLock(file, async (): Promise<WriteResult> => {
    const doc = await readDoc(file);
    if (!doc) throw new CanvasNotFound(id);
    if (input.baseVersion !== undefined && input.baseVersion !== doc.version) {
      return { ok: false, conflict: true, canvas: doc };
    }
    const old = doc.versions.find(v => v.version === version);
    if (!old) {
      const kept = doc.versions.length ? `${doc.versions[0]!.version}–${doc.version}` : 'none';
      throw new Error(`version ${version} of canvas ${id} is not kept (versions ${kept} are)`);
    }
    if (version === doc.version) return { ok: true, canvas: doc, changed: false };
    const next = withVersion(doc, old.content, input.author, `Restored version ${version}`);
    await writeDoc(file, next);
    return { ok: true, canvas: next, changed: true };
  });
  if (result.ok && result.changed) announce(ctx, result.canvas, 'restore');
  return result;
}

export class CanvasNotFound extends Error {
  constructor(id: string) {
    super(`no canvas "${id}" in this chat`);
    this.name = 'CanvasNotFound';
  }
}

/**
 * Replace one exact passage, the way the Edit tool does.
 *
 * `find` must occur exactly once — or at least once with `all` — because a
 * passage that occurs twice is an instruction with two possible meanings, and
 * guessing which one was meant is how the wrong paragraph gets rewritten.
 */
export function applyFindReplace(content: string, find: string, replace: string, all = false):
  { ok: true; content: string; count: number } | { ok: false; error: string } {
  if (typeof find !== 'string' || find.length === 0) return { ok: false, error: '`find` must be a non-empty string' };
  if (typeof replace !== 'string') return { ok: false, error: '`replace` must be a string' };
  if (find === replace) return { ok: false, error: '`find` and `replace` are the same — nothing would change' };
  let count = 0;
  for (let at = content.indexOf(find); at >= 0; at = content.indexOf(find, at + find.length)) count++;
  if (count === 0) {
    return { ok: false, error: '`find` does not occur in the canvas. Read it again and copy the passage exactly, including line breaks and punctuation.' };
  }
  if (count > 1 && !all) {
    return { ok: false, error: `\`find\` occurs ${count} times. Include more surrounding text so it matches exactly once, or pass all: true to replace every occurrence.` };
  }
  return { ok: true, content: content.split(find).join(replace), count };
}
