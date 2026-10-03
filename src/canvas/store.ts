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
 * ## Tabs (AICO Docs)
 *
 * A document has one or more tabs, each its own Markdown with its own version.
 * Versions are per tab so the agent filling tab 2 never makes the person's
 * save on tab 1 a conflict. `content` and `version` on the document are read
 * aliases of the first tab — what a client written before tabs existed reads
 * and writes, unchanged. `revision` counts every change of any kind. A file
 * written before tabs is migrated on read into one tab `t1` (nothing is
 * rewritten on disk until the next write). Contract:
 * `docs/engineering/canvas-docs-contract.md`.
 *
 * ## Comments
 *
 * Kept with the canvas, never in the Markdown (a marker in the text would
 * break find/replace and leak into every export). Anchored by quote and
 * context, re-anchored after every content write of their tab
 * (`canvas/comments`).
 *
 * ## Sheets (AICO Sheets)
 *
 * A `sheet` canvas is a workbook: its one tab holds the workbook as JSON
 * (`shared/ui/canvas/sheet-model`), versioned and conflict-checked exactly
 * like a document's Markdown. Every write of a sheet's tab must parse as a
 * workbook — checked here, so neither the agent nor a client can save text
 * that would leave the grid unable to open it.
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
import { mergeSettings, type DocSettings } from './doc-settings.js';
import { emptyBook, parseBook, serializeBook } from '../../shared/ui/canvas/sheet-model.js';
import { emptyDeck, parseDeck, serializeDeck } from '../../shared/ui/canvas/deck-model.js';
import {
  addressesAgent, anchorFor, reanchor, type CanvasComment, type CommentAnchor, type CommentReply,
} from './comments.js';

export type { CanvasComment, CommentAnchor, CommentReply } from './comments.js';

/** `deck`: an AICO Slides presentation — like a sheet, one tab holding the deck as JSON (`shared/ui/canvas/deck-model`, ADR 0023). */
export type CanvasKind = 'document' | 'code' | 'sheet' | 'deck';
export type CanvasAuthor = 'agent' | 'user';

export interface CanvasVersion {
  version: number;
  content: string;
  author: CanvasAuthor;
  /** Epoch milliseconds. */
  at: number;
  note?: string;
  /** The tab this version belongs to. Absent on entries written before tabs: `t1`. */
  tab?: string;
}

export interface CanvasTab {
  id: string;
  title: string;
  content: string;
  version: number;
  /** Pending ids already written, mapped to the heading they became. */
  sectionIds?: Record<string, string>;
}

export interface CanvasDoc {
  id: string;
  title: string;
  kind: CanvasKind;
  /** For `code`: the language ("typescript", "python"…). */
  language?: string;
  /** Read alias of `tabs[0].content`. */
  content: string;
  /** Read alias of `tabs[0].version`. */
  version: number;
  /** Bumped on every change of any kind (any tab, tabs themselves, the title). */
  revision: number;
  tabs: CanvasTab[];
  comments: CanvasComment[];
  /** Export setup (page, header/footer, cover…); absent keys take the defaults. */
  docSettings?: Partial<DocSettings>;
  createdAt: number;
  updatedAt: number;
  /** Oldest first, capped at {@link CANVAS_VERSION_CAP} per tab. The last entry of a tab is its current content. */
  versions: CanvasVersion[];
}

/** What a list shows — no content, no history. */
export interface CanvasSummary {
  id: string;
  title: string;
  kind: CanvasKind;
  language?: string;
  version: number;
  revision: number;
  tabs: number;
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
  revision: number;
  /** The tab that changed (for `tabs`: the tab added/renamed/deleted). */
  tabId: string;
  tabVersion: number;
  author: CanvasAuthor;
  action: 'create' | 'update' | 'restore' | 'tabs' | 'settings' | 'rename';
  at: number;
}

/** The agent is writing (or has finished writing) somewhere in a canvas. */
export interface CanvasActivity {
  sessionId: string;
  canvasId: string;
  tabId: string;
  /** Pending id or heading text; absent when the write covers the whole tab. */
  section?: string;
  heading?: string;
  status: 'writing' | 'done';
  by: 'agent';
}

/** Comments on a canvas changed. */
export interface CanvasCommentsChange {
  sessionId: string;
  canvasId: string;
  commentId: string;
  action: 'add' | 'reply' | 'resolve' | 'reopen';
  author: CanvasAuthor;
  /** Set when a person's comment or reply asked the agent to act. */
  askAgent?: boolean;
}

export type WriteResult =
  | { ok: true; canvas: CanvasDoc; changed: boolean }
  | { ok: false; conflict: true; canvas: CanvasDoc };

/** How many versions each tab keeps. Older ones fall off the front. */
export const CANVAS_VERSION_CAP = 50;
/** Largest content a tab accepts, in characters. A book chapter, not a book. */
export const CANVAS_MAX_CHARS = 400_000;
export const CANVAS_MAX_TABS = 20;
const MAX_COMMENTS = 500;
const MAX_COMMENT_CHARS = 10_000;
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
const activityListeners = new Set<(activity: CanvasActivity) => void>();
const commentListeners = new Set<(change: CanvasCommentsChange) => void>();

/** Hear about every canvas write in this process. Returns the unsubscribe. */
export function onCanvasChange(listener: (change: CanvasChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hear the agent start and finish writing in a canvas. */
export function onCanvasActivity(listener: (activity: CanvasActivity) => void): () => void {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}

/** Hear comments being added, answered and resolved. */
export function onCanvasComments(listener: (change: CanvasCommentsChange) => void): () => void {
  commentListeners.add(listener);
  return () => { commentListeners.delete(listener); };
}

function fan<T>(set: Set<(v: T) => void>, value: T): void {
  for (const listener of set) {
    // One broken subscriber must not fail a write that has already happened.
    try { listener(value); } catch { /* ignored */ }
  }
}

export function announceActivity(activity: CanvasActivity): void {
  fan(activityListeners, activity);
}

function announce(ctx: CanvasContext, doc: CanvasDoc, action: CanvasChange['action'], tabId?: string): void {
  const tab = doc.tabs.find(t => t.id === tabId) ?? doc.tabs[0]!;
  const last = [...doc.versions].reverse().find(v => (v.tab ?? 't1') === tab.id);
  fan(listeners, {
    sessionId: ctx.sessionId, id: doc.id, title: doc.title, kind: doc.kind,
    version: doc.version, revision: doc.revision, tabId: tab.id, tabVersion: tab.version,
    author: last?.author ?? 'agent', action, at: doc.updatedAt,
  });
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

/** Bring a document read from disk up to the current shape. Pure. */
export function migrateCanvas(raw: unknown): CanvasDoc | undefined {
  const doc = raw as Partial<CanvasDoc> | null;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.versions)) return undefined;
  let tabs: CanvasTab[];
  if (Array.isArray(doc.tabs) && doc.tabs.length > 0
    && doc.tabs.every(t => t && typeof t.id === 'string' && typeof t.content === 'string' && typeof t.version === 'number')) {
    tabs = doc.tabs.map(t => ({ ...t, title: typeof t.title === 'string' ? t.title : t.id }));
  } else if (typeof doc.content === 'string' && typeof doc.version === 'number') {
    // Written before tabs: the whole document becomes the first tab, keeping
    // its version number so a client holding it saves without a conflict.
    tabs = [{ id: 't1', title: 'Tab 1', content: doc.content, version: doc.version }];
  } else {
    return undefined;
  }
  const out = {
    ...doc,
    tabs,
    comments: Array.isArray(doc.comments) ? doc.comments : [],
    revision: typeof doc.revision === 'number' ? doc.revision : (doc.version ?? tabs[0]!.version),
    versions: doc.versions.map(v => (v.tab ? v : { ...v, tab: 't1' })),
  } as CanvasDoc;
  return sync(out);
}

/** Refresh the first-tab aliases. */
function sync(doc: CanvasDoc): CanvasDoc {
  doc.content = doc.tabs[0]!.content;
  doc.version = doc.tabs[0]!.version;
  return doc;
}

async function readDoc(file: string): Promise<CanvasDoc | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return undefined; }
  try {
    return migrateCanvas(JSON.parse(text));
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
    throw new Error(`content is ${content.length.toLocaleString()} characters; a canvas tab holds at most ${CANVAS_MAX_CHARS.toLocaleString()}`);
  }
  return content;
}

/** A sheet's text must be a workbook; the error says what is wrong. */
function checkSheet(content: string): string {
  try { parseBook(content); } catch (err) { throw new Error(`not a workbook: ${(err as Error).message}`); }
  return content;
}

/** A deck's text must be a deck. */
function checkDeck(content: string): string {
  try { parseDeck(content); } catch (err) { throw new Error(`not a deck: ${(err as Error).message}`); }
  return content;
}

function cleanTitle(title: unknown, fallback = 'Untitled'): string {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  return (t || fallback).slice(0, MAX_TITLE);
}

function cleanLanguage(language: unknown): string | undefined {
  if (typeof language !== 'string') return undefined;
  const l = language.trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 32);
  return l || undefined;
}

/** Keep the newest {@link CANVAS_VERSION_CAP} entries of each tab. */
function capVersions(versions: CanvasVersion[]): CanvasVersion[] {
  const seen = new Map<string, number>();
  const kept: CanvasVersion[] = [];
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i]!;
    const tab = v.tab ?? 't1';
    const n = (seen.get(tab) ?? 0) + 1;
    seen.set(tab, n);
    if (n <= CANVAS_VERSION_CAP) kept.push(v);
  }
  return kept.reverse();
}

function withVersion(doc: CanvasDoc, tabId: string, content: string, author: CanvasAuthor, note?: string): CanvasDoc {
  const at = Math.max(stamp(), doc.updatedAt + 1);
  const tabs = doc.tabs.map(t => t.id === tabId ? { ...t, content, version: t.version + 1 } : t);
  const tab = tabs.find(t => t.id === tabId)!;
  const entry: CanvasVersion = {
    version: tab.version, content, author, at, tab: tabId, ...(note ? { note: note.slice(0, 200) } : {}),
  };
  const moved = reanchor(doc.comments, tabId, content);
  return sync({
    ...doc,
    tabs,
    comments: moved.comments,
    revision: doc.revision + 1,
    updatedAt: at,
    versions: capVersions([...doc.versions, entry]),
  });
}

/**
 * A clock that never repeats within this process. Two canvases made in the same
 * millisecond (a fast machine, a script) had equal times, so "newest first" was
 * a coin toss — CI on Linux lost it.
 */
let lastStamp = 0;
function stamp(): number {
  const t = Date.now();
  lastStamp = t > lastStamp ? t : lastStamp + 1;
  return lastStamp;
}

function tabOf(doc: CanvasDoc, tab: string | undefined): CanvasTab {
  if (tab === undefined || tab === '') return doc.tabs[0]!;
  const wanted = String(tab).trim();
  const found = doc.tabs.find(t => t.id === wanted)
    ?? doc.tabs.filter(t => t.title.toLowerCase() === wanted.toLowerCase()).at(0);
  if (!found) throw new CanvasTabNotFound(doc, wanted);
  return found;
}

export class CanvasNotFound extends Error {
  constructor(id: string) {
    super(`no canvas "${id}" in this chat`);
    this.name = 'CanvasNotFound';
  }
}

export class CanvasTabNotFound extends Error {
  constructor(doc: CanvasDoc, tab: string) {
    super(`canvas ${doc.id} has no tab "${tab}". Tabs: ${doc.tabs.map(t => `${t.id} "${t.title}"`).join(', ')}.`);
    this.name = 'CanvasTabNotFound';
  }
}

// ── The API ──────────────────────────────────────────────────────────

export function summarize(doc: CanvasDoc): CanvasSummary {
  const last = doc.versions[doc.versions.length - 1];
  return {
    id: doc.id, title: doc.title, kind: doc.kind,
    ...(doc.language ? { language: doc.language } : {}),
    version: doc.version, revision: doc.revision, tabs: doc.tabs.length,
    updatedAt: doc.updatedAt, author: last?.author ?? 'agent',
    chars: doc.tabs.reduce((n, t) => n + t.content.length, 0),
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
  /** Further tabs after the first (whose content is `content`). */
  tabs?: { title?: string; content?: string }[];
  firstTabTitle?: string;
  docSettings?: unknown;
}): Promise<CanvasDoc> {
  if (input.kind !== undefined && input.kind !== 'document' && input.kind !== 'code' && input.kind !== 'sheet' && input.kind !== 'deck') {
    throw new Error('kind must be "document", "code", "sheet" or "deck"');
  }
  if (input.kind === 'sheet' && input.tabs?.length) throw new Error('a sheet keeps its sheets inside its one workbook — add sheets with add_sheet, not tabs');
  if (input.kind === 'deck' && input.tabs?.length) throw new Error('a deck keeps its slides inside its one tab — add slides, not tabs');
  // A sheet starts as an empty workbook (a deck as an empty deck), and whatever it is given must be one.
  const content = checkContent(input.kind === 'sheet'
    ? (input.content.trim() ? checkSheet(input.content) : serializeBook(emptyBook()))
    : input.kind === 'deck' ? (input.content.trim() ? checkDeck(input.content) : serializeDeck(emptyDeck()))
      : input.content);
  const extra = input.tabs ?? [];
  if (extra.length + 1 > CANVAS_MAX_TABS) throw new Error(`a canvas holds at most ${CANVAS_MAX_TABS} tabs`);
  const kind: CanvasKind = input.kind === 'code' || input.kind === 'sheet' || input.kind === 'deck' ? input.kind : 'document';
  const language = kind === 'code' ? cleanLanguage(input.language) : undefined;
  const author = input.author ?? 'agent';
  const now = stamp();
  let id = newId();
  // Ten hex characters make a collision in one session vanishingly rare; the
  // check makes it impossible.
  while (await getCanvas(ctx, id)) id = newId();
  const tabs: CanvasTab[] = [
    { id: 't1', title: cleanTitle(input.firstTabTitle, 'Tab 1'), content, version: 1 },
    ...extra.map((t, i) => ({
      id: `t${i + 2}`, title: cleanTitle(t.title, `Tab ${i + 2}`), content: checkContent(t.content ?? ''), version: 1,
    })),
  ];
  const note = input.note ? { note: input.note.slice(0, 200) } : {};
  const doc: CanvasDoc = sync({
    id, title: cleanTitle(input.title), kind, ...(language ? { language } : {}),
    content, version: 1, revision: 1, tabs, comments: [], createdAt: now, updatedAt: now,
    ...(input.docSettings !== undefined ? { docSettings: mergeSettings(undefined, input.docSettings) } : {}),
    versions: tabs.map(t => ({ version: 1, content: t.content, author, at: now, tab: t.id, ...note })),
  });
  const file = fileFor(ctx, id);
  await withLock(file, () => writeDoc(file, doc));
  announce(ctx, doc, 'create');
  return doc;
}

/**
 * Replace a tab's content, if nobody has changed that tab since `baseVersion`.
 *
 * A stale base is a conflict, answered with the current document so the caller
 * can merge or choose — never a silent overwrite. Writing the content it
 * already has is a no-op that reports success without minting a version, so
 * an autosave that fires twice does not fill the history with duplicates.
 * `tab` omitted means the first tab — what every client before tabs meant.
 */
export async function writeCanvas(ctx: CanvasContext, id: string, input: {
  content: string; baseVersion: number; author: CanvasAuthor; note?: string; title?: string; tab?: string;
  /** A pending id that this write filled, and the heading it became. */
  sectionAlias?: { id: string; heading: string };
}): Promise<WriteResult> {
  const content = checkContent(input.content);
  const file = fileFor(ctx, id);
  let tabId = 't1';
  const result = await withLock(file, async (): Promise<WriteResult> => {
    const doc = await readDoc(file);
    if (!doc) throw new CanvasNotFound(id);
    const tab = tabOf(doc, input.tab);
    tabId = tab.id;
    if (!Number.isInteger(input.baseVersion) || input.baseVersion !== tab.version) {
      return { ok: false, conflict: true, canvas: doc };
    }
    if (doc.kind === 'sheet') checkSheet(content);
    if (doc.kind === 'deck') checkDeck(content);
    const title = input.title !== undefined ? cleanTitle(input.title) : doc.title;
    if (content === tab.content && title === doc.title) return { ok: true, canvas: doc, changed: false };
    let next = content === tab.content
      ? { ...doc, revision: doc.revision + 1, updatedAt: Math.max(stamp(), doc.updatedAt + 1) }
      : withVersion(doc, tab.id, content, input.author, input.note);
    next = { ...next, title };
    if (input.sectionAlias) {
      next.tabs = next.tabs.map(t => t.id === tab.id
        ? { ...t, sectionIds: { ...(t.sectionIds ?? {}), [input.sectionAlias!.id]: input.sectionAlias!.heading } }
        : t);
    }
    await writeDoc(file, sync(next));
    return { ok: true, canvas: next, changed: true };
  });
  if (result.ok && result.changed) announce(ctx, result.canvas, 'update', tabId);
  return result;
}

/**
 * Bring back an earlier version — as a new version on top, so the history
 * keeps what was replaced and a restore can itself be undone.
 */
export async function restoreCanvas(ctx: CanvasContext, id: string, version: number, input: {
  author: CanvasAuthor; baseVersion?: number; tab?: string;
}): Promise<WriteResult> {
  const file = fileFor(ctx, id);
  let tabId = 't1';
  const result = await withLock(file, async (): Promise<WriteResult> => {
    const doc = await readDoc(file);
    if (!doc) throw new CanvasNotFound(id);
    const tab = tabOf(doc, input.tab);
    tabId = tab.id;
    if (input.baseVersion !== undefined && input.baseVersion !== tab.version) {
      return { ok: false, conflict: true, canvas: doc };
    }
    const mine = doc.versions.filter(v => (v.tab ?? 't1') === tab.id);
    const old = mine.find(v => v.version === version);
    if (!old) {
      const kept = mine.length ? `${mine[0]!.version}–${tab.version}` : 'none';
      throw new Error(`version ${version} of canvas ${id}${doc.tabs.length > 1 ? ` tab ${tab.id}` : ''} is not kept (versions ${kept} are)`);
    }
    if (version === tab.version) return { ok: true, canvas: doc, changed: false };
    const next = withVersion(doc, tab.id, old.content, input.author, `Restored version ${version}`);
    await writeDoc(file, next);
    return { ok: true, canvas: next, changed: true };
  });
  if (result.ok && result.changed) announce(ctx, result.canvas, 'restore', tabId);
  return result;
}

/** Mutate a document under its lock; `fn` returns the next document, or undefined for no change. */
async function mutate(ctx: CanvasContext, id: string, fn: (doc: CanvasDoc) => CanvasDoc | undefined): Promise<{ doc: CanvasDoc; changed: boolean }> {
  const file = fileFor(ctx, id);
  return withLock(file, async () => {
    const doc = await readDoc(file);
    if (!doc) throw new CanvasNotFound(id);
    const next = fn(doc);
    if (!next) return { doc, changed: false };
    await writeDoc(file, sync(next));
    return { doc: next, changed: true };
  });
}

// ── Tabs ─────────────────────────────────────────────────────────────

export async function addTab(ctx: CanvasContext, id: string, input: {
  title?: string; content?: string; author: CanvasAuthor;
}): Promise<{ canvas: CanvasDoc; tab: CanvasTab }> {
  const content = checkContent(input.content ?? '');
  let made: CanvasTab | undefined;
  const { doc } = await mutate(ctx, id, (doc) => {
    if (doc.kind === 'sheet') throw new Error('a sheet canvas keeps its sheets inside its workbook — add a sheet instead of a tab');
    if (doc.kind === 'deck') throw new Error('a deck keeps its slides inside its one tab — add a slide instead of a tab');
    if (doc.tabs.length >= CANVAS_MAX_TABS) throw new Error(`a canvas holds at most ${CANVAS_MAX_TABS} tabs`);
    const n = Math.max(0, ...doc.tabs.map(t => Number(t.id.slice(1)) || 0)) + 1;
    made = { id: `t${n}`, title: cleanTitle(input.title, `Tab ${n}`), content, version: 1 };
    const at = Math.max(stamp(), doc.updatedAt + 1);
    return {
      ...doc, tabs: [...doc.tabs, made], revision: doc.revision + 1, updatedAt: at,
      versions: capVersions([...doc.versions, { version: 1, content, author: input.author, at, tab: made.id }]),
    };
  });
  announce(ctx, doc, 'tabs', made!.id);
  return { canvas: doc, tab: made! };
}

export async function renameTab(ctx: CanvasContext, id: string, tab: string, title: string): Promise<CanvasDoc> {
  let tabId = 't1';
  const { doc, changed } = await mutate(ctx, id, (doc) => {
    const t = tabOf(doc, tab);
    tabId = t.id;
    const clean = cleanTitle(title, t.title);
    if (clean === t.title) return undefined;
    return {
      ...doc, tabs: doc.tabs.map(x => x.id === t.id ? { ...x, title: clean } : x),
      revision: doc.revision + 1, updatedAt: Math.max(stamp(), doc.updatedAt + 1),
    };
  });
  if (changed) announce(ctx, doc, 'tabs', tabId);
  return doc;
}

export async function deleteTab(ctx: CanvasContext, id: string, tab: string): Promise<CanvasDoc> {
  const { doc } = await mutate(ctx, id, (doc) => {
    const t = tabOf(doc, tab);
    if (doc.tabs.length <= 1) throw new Error('a canvas needs at least one tab — the last one cannot be deleted');
    return {
      ...doc,
      tabs: doc.tabs.filter(x => x.id !== t.id),
      comments: doc.comments.filter(c => c.tabId !== t.id),
      versions: doc.versions.filter(v => (v.tab ?? 't1') !== t.id),
      revision: doc.revision + 1, updatedAt: Math.max(stamp(), doc.updatedAt + 1),
    };
  });
  // The deleted tab no longer exists to name; the frame carries the first tab.
  announce(ctx, doc, 'tabs');
  return doc;
}

/** Rename a canvas (title only — no content version; the revision moves). */
export async function renameCanvas(ctx: CanvasContext, id: string, title: string): Promise<CanvasDoc> {
  const { doc, changed } = await mutate(ctx, id, (doc) => {
    const clean = cleanTitle(title, doc.title);
    if (clean === doc.title) return undefined;
    return { ...doc, title: clean, revision: doc.revision + 1, updatedAt: Math.max(stamp(), doc.updatedAt + 1) };
  });
  if (changed) announce(ctx, doc, 'rename');
  return doc;
}

// ── Document settings ────────────────────────────────────────────────

/** Merge export settings into the canvas (`null` clears a key). Not a content version. */
export async function setDocSettings(ctx: CanvasContext, id: string, patch: unknown): Promise<CanvasDoc> {
  const { doc, changed } = await mutate(ctx, id, (doc) => {
    const next = mergeSettings(doc.docSettings, patch);
    if (JSON.stringify(next) === JSON.stringify(doc.docSettings ?? {})) return undefined;
    return { ...doc, docSettings: next, revision: doc.revision + 1 };
  });
  if (changed) announce(ctx, doc, 'settings');
  return doc;
}

// ── Comments ─────────────────────────────────────────────────────────

function commentId(): string {
  return `c-${crypto.randomBytes(4).toString('hex')}`;
}

function cleanBody(body: unknown): string {
  const b = typeof body === 'string' ? body.trim() : '';
  if (!b) throw new Error('a comment needs a body');
  if (b.length > MAX_COMMENT_CHARS) throw new Error(`a comment holds at most ${MAX_COMMENT_CHARS.toLocaleString()} characters`);
  return b;
}

export async function listComments(ctx: CanvasContext, id: string, opts: { open?: boolean } = {}): Promise<CanvasComment[]> {
  const doc = await getCanvas(ctx, id);
  if (!doc) throw new CanvasNotFound(id);
  return opts.open ? doc.comments.filter(c => !c.resolved) : doc.comments;
}

/**
 * Add a comment on a passage. A quote that cannot be found in the tab is kept
 * as an orphaned comment rather than refused: the person's words must not be
 * lost because the text moved under their selection.
 */
export async function addComment(ctx: CanvasContext, id: string, input: {
  tabId?: string; anchor: Partial<CommentAnchor>; body: string; author: CanvasAuthor; askAgent?: boolean;
}): Promise<{ canvas: CanvasDoc; comment: CanvasComment }> {
  const body = cleanBody(input.body);
  const quote = typeof input.anchor?.quote === 'string' ? input.anchor.quote.slice(0, 5000) : '';
  if (!quote.trim()) throw new Error('a comment needs anchor.quote — the selected text it is about');
  let made: CanvasComment | undefined;
  const { doc } = await mutate(ctx, id, (doc) => {
    if (doc.comments.length >= MAX_COMMENTS) throw new Error(`a canvas holds at most ${MAX_COMMENTS} comments — resolve or delete some`);
    const tab = tabOf(doc, input.tabId);
    const anchor = anchorFor(tab.content, { quote, prefix: String(input.anchor.prefix ?? ''), suffix: String(input.anchor.suffix ?? '') });
    const ask = input.author === 'user' && (input.askAgent === true || addressesAgent(body));
    made = {
      id: commentId(), tabId: tab.id,
      anchor: anchor ?? { quote, prefix: String(input.anchor.prefix ?? '').slice(-64), suffix: String(input.anchor.suffix ?? '').slice(0, 64) },
      body, author: input.author, createdAt: stamp(), replies: [], resolved: false,
      ...(anchor ? {} : { orphaned: true }),
      ...(ask ? { askAgent: true } : {}),
    };
    return { ...doc, comments: [...doc.comments, made] };
  });
  fan(commentListeners, {
    sessionId: ctx.sessionId, canvasId: id, commentId: made!.id, action: 'add', author: input.author,
    ...(made!.askAgent ? { askAgent: true } : {}),
  });
  return { canvas: doc, comment: made! };
}

export async function replyToComment(ctx: CanvasContext, id: string, cid: string, input: {
  body: string; author: CanvasAuthor; resolve?: boolean;
}): Promise<{ canvas: CanvasDoc; comment: CanvasComment; reply: CommentReply }> {
  const body = cleanBody(input.body);
  let reply: CommentReply | undefined;
  let comment: CanvasComment | undefined;
  const { doc } = await mutate(ctx, id, (doc) => {
    const c = doc.comments.find(x => x.id === cid);
    if (!c) throw new CommentNotFound(doc, cid);
    reply = { id: `r-${crypto.randomBytes(4).toString('hex')}`, body, author: input.author, createdAt: stamp() };
    comment = { ...c, replies: [...c.replies, reply], ...(input.resolve ? { resolved: true } : {}) };
    return { ...doc, comments: doc.comments.map(x => x.id === cid ? comment! : x) };
  });
  const ask = input.author === 'user' && addressesAgent(body);
  fan(commentListeners, {
    sessionId: ctx.sessionId, canvasId: id, commentId: cid, action: input.resolve ? 'resolve' : 'reply', author: input.author,
    ...(ask ? { askAgent: true } : {}),
  });
  return { canvas: doc, comment: comment!, reply: reply! };
}

export async function resolveComment(ctx: CanvasContext, id: string, cid: string, input: {
  resolved?: boolean; author: CanvasAuthor;
}): Promise<{ canvas: CanvasDoc; comment: CanvasComment }> {
  const resolved = input.resolved !== false;
  let comment: CanvasComment | undefined;
  const { doc, changed } = await mutate(ctx, id, (doc) => {
    const c = doc.comments.find(x => x.id === cid);
    if (!c) throw new CommentNotFound(doc, cid);
    comment = c;
    if (c.resolved === resolved) return undefined;
    comment = { ...c, resolved };
    // Re-opened: find the passage again, since edits since resolving were not tracked.
    if (!resolved) {
      const tab = doc.tabs.find(t => t.id === c.tabId);
      if (tab) comment = reanchor([comment], tab.id, tab.content).comments[0]!;
    }
    return { ...doc, comments: doc.comments.map(x => x.id === cid ? comment! : x) };
  });
  if (changed) {
    fan(commentListeners, {
      sessionId: ctx.sessionId, canvasId: id, commentId: cid, action: resolved ? 'resolve' : 'reopen', author: input.author,
    });
  }
  return { canvas: doc, comment: comment! };
}

export class CommentNotFound extends Error {
  constructor(doc: CanvasDoc, cid: string) {
    const open = doc.comments.filter(c => !c.resolved).map(c => c.id);
    super(`canvas ${doc.id} has no comment "${cid}".${open.length ? ` Open comments: ${open.join(', ')}.` : ' It has no open comments.'}`);
    this.name = 'CommentNotFound';
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
