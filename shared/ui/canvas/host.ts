/**
 * How a canvas card and editor reach the engine — registered by each client.
 *
 * `shared/ui` is store-free on purpose (see its index): these components
 * render in the browser portal, the desktop app and the VS Code panel, and
 * know nothing about how any of them talk to the engine. So each client
 * registers a host at boot — the same seam `setMediaUrlResolver` uses — and
 * the canvas components ask it for documents, saves, and the one thing only
 * the client can do: send a chat message ("Ask AI to edit").
 *
 * Live updates travel the other way through {@link emitCanvasEvent}: the web
 * store forwards the session stream's `canvas` frames here, and every open
 * card and editor listens. No polling, and no store import in shared code.
 *
 * AICO Docs adds optional host methods (tabs, comments, export, settings,
 * create, turn state) and two more event channels — `canvas-activity` (the
 * agent writing a section) and `canvas-comments` — on the same pattern. Every
 * one is optional so an older engine or a thinner client still gets a working
 * editor: a missing route is a hidden or disabled control, not an error.
 *
 * @module shared/ui/canvas/host
 */

import type React from 'react';
import type { CanvasComment, CommentAnchor } from './comments';
import type { PartEditRequest, PartEditResponse } from './scoped-edit';

/** `sheet`: an AICO Sheets workbook (`sheet-model.ts`), its one tab holding the workbook JSON. `deck`: an AICO Slides presentation (`deck-model.ts`), likewise. */
export type CanvasKind = 'document' | 'code' | 'sheet' | 'deck';
export type CanvasAuthor = 'agent' | 'user';

export interface CanvasVersion {
  version: number;
  content: string;
  author: CanvasAuthor;
  at: number;
  note?: string;
  /** The tab this version belongs to (AICO Docs); absent on legacy entries, which are the first tab's. */
  tab?: string;
}

/** One tab of an AICO Docs document. Each is versioned on its own. */
export interface CanvasTab {
  id: string;
  title: string;
  content: string;
  version: number;
  /** Pending ids the agent has already written, mapped to the heading each became. */
  sectionIds?: Record<string, string>;
}

export interface CanvasDoc {
  id: string;
  title: string;
  kind: CanvasKind;
  language?: string;
  content: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  versions: CanvasVersion[];
  /** AICO Docs. `content`/`version` alias the first tab; older engines send no tabs. */
  tabs?: CanvasTab[];
  /** Bumped on any change to the document (any tab, tab list, title). */
  revision?: number;
  /** Export settings remembered with the document (AICO Docs). */
  docSettings?: DocSettings;
}

/** How a document exports — page, header/footer, cover, contents, watermark, font. See the contract doc. */
export interface DocSettings {
  pageSize?: 'A4' | 'Letter';
  orientation?: 'portrait' | 'landscape';
  /** A preset, or millimetres (how the engine stores a preset once saved). */
  margins?: 'narrow' | 'normal' | 'wide' | { top: number; right: number; bottom: number; left: number };
  header?: string;
  footer?: string;
  pageNumbers?: boolean;
  cover?: { enabled: boolean; title?: string; subtitle?: string; author?: string; date?: string; logo?: string };
  toc?: boolean;
  watermark?: string;
  font?: 'sans' | 'serif';
  /** A document theme (`doc-themes.ts`, round 3 of the contract). */
  theme?: string;
  /** `#RRGGBB`, overriding the theme's accent. */
  accent?: string;
  /** A banner on every page, e.g. CONFIDENTIAL. */
  classification?: string;
  /** The editor's page width. */
  pageWidth?: 'narrow' | 'normal' | 'wide' | 'full';
}

/** The tabs of a document — one synthesised from `content` for an engine that has none. */
export function tabsOf(doc: CanvasDoc): CanvasTab[] {
  if (doc.tabs && doc.tabs.length) return doc.tabs;
  return [{ id: 't1', title: 'Tab 1', content: doc.content, version: doc.version }];
}

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

/** What a ```canvas block carries: enough to draw the card before the fetch lands. */
export interface CanvasRef {
  id: string;
  title?: string;
  kind?: CanvasKind;
  language?: string;
}

/** A write somebody made, as the session stream announces it. */
export interface CanvasChange {
  sessionId: string;
  id: string;
  title: string;
  kind: CanvasKind;
  version: number;
  author: CanvasAuthor;
  action: 'create' | 'update' | 'restore' | 'tabs' | 'rename';
  at: number;
  tabId?: string;
  tabVersion?: number;
  revision?: number;
}

/** The agent starting or finishing a write, so the page can show where it is working. */
export interface CanvasActivity {
  canvasId: string;
  tabId?: string;
  /** A pending id or heading text; absent for a whole-tab write. */
  section?: string;
  heading?: string;
  status: 'writing' | 'done';
  by: 'agent';
}

/** `xlsx` and `csv` are a sheet's formats; `pptx`, `pdf` and `png` (a zip of slides) a deck's; the others a document's. */
export type ExportFormat = 'md' | 'html' | 'docx' | 'pdf' | 'xlsx' | 'csv' | 'pptx' | 'png';

export type CanvasWriteResult =
  | { ok: true; canvas: CanvasDoc; changed: boolean }
  | { ok: false; conflict: true; canvas: CanvasDoc };

/** A code editor a client can lend the canvas (the desktop lends Monaco). */
export interface CanvasCodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  /** The selected text, or '' when the selection collapses. */
  onSelection?: (text: string) => void;
  /** Ctrl+S. */
  onSave?: () => void;
}

export interface CanvasHost {
  /** The chat the cards on screen belong to. */
  sessionId(): string;
  list(): Promise<CanvasSummary[]>;
  /** `light`: only the current version in `versions` — what a card needs, without the history. */
  get(id: string, opts?: { light?: boolean }): Promise<CanvasDoc>;
  /** `baseVersion` is the tab's version; `tab` omitted means the first tab. */
  save(id: string, content: string, baseVersion: number, note?: string, tab?: string): Promise<CanvasWriteResult>;
  restore(id: string, version: number, baseVersion?: number, tab?: string): Promise<CanvasWriteResult>;
  /** Add, rename or delete a tab (AICO Docs). Absent on hosts whose engine has no tabs route. */
  tabs?: (id: string, op: { op: 'add' | 'rename' | 'delete'; tab?: string; title?: string; content?: string }) => Promise<CanvasDoc>;
  /** Comment threads (AICO Docs). */
  comments?: {
    list(id: string): Promise<CanvasComment[]>;
    add(id: string, input: { tabId: string; anchor: CommentAnchor; body: string; askAgent?: boolean }): Promise<CanvasComment>;
    reply(id: string, commentId: string, body: string): Promise<CanvasComment>;
    resolve(id: string, commentId: string, resolved: boolean): Promise<CanvasComment>;
  };
  /** The engine's export of a tab, as a file. `settings` override the stored ones for this export. */
  exportFile?: (id: string, format: ExportFormat, tab?: string, settings?: DocSettings) => Promise<{ blob: Blob; name: string }>;
  /** Remember export settings with the document. */
  saveSettings?: (id: string, settings: DocSettings) => Promise<CanvasDoc>;
  /** Create a document from the editor (a template), or an empty sheet (`kind: 'sheet'`, content ''). */
  create?: (input: { title: string; content: string; kind?: CanvasKind }) => Promise<CanvasDoc>;
  /**
   * A scoped AI edit of one part of a tab (ADR 0024): the engine answers with
   * a validated proposal and writes nothing. Absent on an engine without the
   * route: "Ask AICO" then falls back to a chat message.
   */
  editPart?: (id: string, req: PartEditRequest, signal?: AbortSignal) => Promise<PartEditResponse>;
  /** Rename a canvas (title only). */
  rename?: (id: string, title: string) => Promise<CanvasDoc>;
  /** A .xlsx/.csv file as a new sheet canvas. */
  importSheet?: (file: { name: string; data: string /* base64 */ }) => Promise<CanvasDoc>;
  /** Whether a turn is running in this chat, and a way to hear when that changes. */
  turnBusy?: () => boolean;
  onTurn?: (listener: (busy: boolean) => void) => () => void;
  /** Send a message to the agent in this chat. */
  ask(text: string): void;
  /** Open the canvas beside the chat. Absent where there is no side slot — the card expands in place instead. */
  openPanel?: (ref: CanvasRef) => void;
  /** A richer code editor than the built-in textarea. */
  CodeEditor?: React.ComponentType<CanvasCodeEditorProps>;
}

let current: CanvasHost | null = null;

export function setCanvasHost(host: CanvasHost | null): void {
  current = host;
}

export function getCanvasHost(): CanvasHost | null {
  return current;
}

// ── Live changes ─────────────────────────────────────────────────────

const listeners = new Set<(change: CanvasChange) => void>();

/** Forward a `canvas` stream frame. Anything that is not one is ignored. */
export function emitCanvasEvent(data: unknown): void {
  const d = data as Partial<CanvasChange> | null;
  if (!d || typeof d.id !== 'string' || typeof d.version !== 'number') return;
  const change: CanvasChange = {
    sessionId: String(d.sessionId ?? ''),
    id: d.id,
    title: String(d.title ?? ''),
    kind: d.kind === 'code' || d.kind === 'sheet' || d.kind === 'deck' ? d.kind : 'document',
    version: d.version,
    author: d.author === 'user' ? 'user' : 'agent',
    action: d.action === 'create' || d.action === 'restore' || d.action === 'tabs' || d.action === 'rename' ? d.action : 'update',
    at: typeof d.at === 'number' ? d.at : Date.now(),
    ...(typeof d.tabId === 'string' ? { tabId: d.tabId } : {}),
    ...(typeof d.tabVersion === 'number' ? { tabVersion: d.tabVersion } : {}),
    ...(typeof d.revision === 'number' ? { revision: d.revision } : {}),
  };
  for (const listener of listeners) {
    try { listener(change); } catch { /* one broken listener must not starve the rest */ }
  }
}

export function onCanvasEvent(listener: (change: CanvasChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ── The agent at work, and comment threads ───────────────────────────

const activityListeners = new Set<(a: CanvasActivity) => void>();

/** Forward a `canvas-activity` stream frame. */
export function emitCanvasActivity(data: unknown): void {
  const d = data as Partial<CanvasActivity> | null;
  if (!d || typeof d.canvasId !== 'string' || (d.status !== 'writing' && d.status !== 'done')) return;
  const a: CanvasActivity = {
    canvasId: d.canvasId, status: d.status, by: 'agent',
    ...(typeof d.tabId === 'string' ? { tabId: d.tabId } : {}),
    ...(typeof d.section === 'string' && d.section ? { section: d.section } : {}),
    ...(typeof d.heading === 'string' && d.heading ? { heading: d.heading } : {}),
  };
  for (const l of activityListeners) {
    try { l(a); } catch { /* one broken listener must not starve the rest */ }
  }
}

export function onCanvasActivity(listener: (a: CanvasActivity) => void): () => void {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}

const commentListeners = new Set<(canvasId: string) => void>();

/** Forward a `canvas-comments` stream frame: somebody added, answered or resolved a thread. */
export function emitCanvasComments(data: unknown): void {
  const id = (data as { canvasId?: unknown } | null)?.canvasId;
  if (typeof id !== 'string') return;
  for (const l of commentListeners) {
    try { l(id); } catch { /* as above */ }
  }
}

export function onCanvasComments(listener: (canvasId: string) => void): () => void {
  commentListeners.add(listener);
  return () => { commentListeners.delete(listener); };
}
