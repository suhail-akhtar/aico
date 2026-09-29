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
    save: (id, content, baseVersion, note) => api.canvasSave(sessionId(), id, content, baseVersion, note),
    restore: (id, version, baseVersion) => api.canvasRestore(sessionId(), id, version, baseVersion),
    ask: (text) => { void useStore.getState().submit(text); },
    ...extra,
  });
}
