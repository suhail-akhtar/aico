/**
 * The canvas host for every client built on this state layer — the browser
 * portal, the desktop app and the VS Code panel.
 *
 * Canvas components in `shared/ui` cannot import the store; this is where the
 * store and the API are handed to them. A client with room beside the chat
 * (the desktop) adds `openPanel`, and one with a better code editor adds
 * `CodeEditor`; without them the card expands in place and code is edited in
 * the shared highlighted textarea.
 *
 * @module web/canvas-host
 */

import { setCanvasHost, type CanvasHost } from '../../shared/ui/canvas/host';
import { api } from './api';
import { useStore } from './store';

export function installCanvasHost(extra: Partial<Pick<CanvasHost, 'openPanel' | 'CodeEditor'>> = {}): void {
  const sessionId = (): string => useStore.getState().sessionId;
  setCanvasHost({
    sessionId,
    list: async () => (await api.canvasList(sessionId())).canvases,
    get: async (id, opts) => (await api.canvasGet(sessionId(), id, opts?.light === true)).canvas,
    save: (id, content, baseVersion, note, tab) => api.canvasSave(sessionId(), id, content, baseVersion, note, tab),
    restore: (id, version, baseVersion, tab) => api.canvasRestore(sessionId(), id, version, baseVersion, tab),
    tabs: async (id, op) => (await api.canvasTabs(sessionId(), id, op)).canvas,
    comments: {
      list: async id => (await api.canvasComments(sessionId(), id)).comments,
      add: async (id, input) => (await api.canvasComment(sessionId(), id, input)).comment,
      reply: async (id, cid, body) => (await api.canvasCommentReply(sessionId(), id, cid, body)).comment,
      resolve: async (id, cid, resolved) => (await api.canvasCommentResolve(sessionId(), id, cid, resolved)).comment,
    },
    exportFile: (id, format, tab, settings) => api.canvasExport(sessionId(), id, format, tab, settings),
    saveSettings: async (id, settings) => (await api.canvasSettings(sessionId(), id, settings)).canvas,
    create: async input => (await api.canvasCreate(sessionId(), input)).canvas,
    turnBusy: () => useStore.getState().busy,
    onTurn: listener => useStore.subscribe((s, prev) => { if (s.busy !== prev.busy) listener(s.busy); }),
    ask: (text) => { void useStore.getState().submit(text); },
    ...extra,
  });
}
