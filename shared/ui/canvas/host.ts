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
 * @module shared/ui/canvas/host
 */

import type React from 'react';

export type CanvasKind = 'document' | 'code';
export type CanvasAuthor = 'agent' | 'user';

export interface CanvasVersion {
  version: number;
  content: string;
  author: CanvasAuthor;
  at: number;
  note?: string;
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
  action: 'create' | 'update' | 'restore';
  at: number;
}

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
  save(id: string, content: string, baseVersion: number, note?: string): Promise<CanvasWriteResult>;
  restore(id: string, version: number, baseVersion?: number): Promise<CanvasWriteResult>;
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
    kind: d.kind === 'code' ? 'code' : 'document',
    version: d.version,
    author: d.author === 'user' ? 'user' : 'agent',
    action: d.action === 'create' || d.action === 'restore' ? d.action : 'update',
    at: typeof d.at === 'number' ? d.at : Date.now(),
  };
  for (const listener of listeners) {
    try { listener(change); } catch { /* one broken listener must not starve the rest */ }
  }
}

export function onCanvasEvent(listener: (change: CanvasChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
