/**
 * Everything the panel says to VS Code that is not an API call.
 *
 * The tunnel carries traffic destined for the aico server. This carries the
 * other direction of the relationship: what folder is open, what the user just
 * selected, and the handful of things only the extension host can do — reveal a
 * settings page, open the full workspace, put a question in the composer.
 *
 * Kept separate from `tunnel.ts` because they fail differently. A tunnel error
 * means the server is unreachable and the panel should say so; a host message
 * that goes unanswered means VS Code is busy, and the panel should carry on.
 *
 * @module host
 */

import { vscodeApi } from './tunnel';

export interface BootInfo {
  /** Absolute path of the first workspace folder, or null if none is open. */
  folder: string | null;
  folderName: string | null;
  version: string;
}

/** A question routed in from the editor, and whether it should go straight out. */
export interface AskRequest {
  text: string;
  send: boolean;
}

type HostMessage =
  | ({ t: 'boot' } & BootInfo)
  | ({ t: 'ask' } & AskRequest)
  | { t: 'new-session' };

type Listener<T> = (value: T) => void;

const bootListeners = new Set<Listener<BootInfo>>();
const askListeners = new Set<Listener<AskRequest>>();
const newSessionListeners = new Set<Listener<void>>();

/**
 * The boot frame, remembered.
 *
 * It arrives once, in reply to `ready`, and a component that mounts later would
 * otherwise never learn which folder it is working in. Held rather than
 * re-requested because the host has no notion of "ask again".
 */
let lastBoot: BootInfo | null = null;

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostMessage | undefined;
  if (message?.t === 'boot') {
    lastBoot = { folder: message.folder, folderName: message.folderName, version: message.version };
    for (const listener of bootListeners) listener(lastBoot);
  }
  if (message?.t === 'ask') {
    for (const listener of askListeners) listener({ text: message.text, send: message.send });
  }
  if (message?.t === 'new-session') {
    for (const listener of newSessionListeners) listener();
  }
});

export function onBoot(listener: Listener<BootInfo>): () => void {
  if (lastBoot) listener(lastBoot);
  bootListeners.add(listener);
  return () => bootListeners.delete(listener);
}

/** A question sent from the editor — "ask about this selection" and friends. */
export function onAsk(listener: Listener<AskRequest>): () => void {
  askListeners.add(listener);
  return () => askListeners.delete(listener);
}

export function onNewSession(listener: Listener<void>): () => void {
  newSessionListeners.add(listener);
  return () => newSessionListeners.delete(listener);
}

/**
 * Tell the host the panel has mounted.
 *
 * Sent from an effect rather than at module scope: at import time the React tree
 * has not rendered, and the boot frame that comes back would arrive before
 * anything was listening for it.
 */
export function signalReady(): void {
  vscodeApi.postMessage({ t: 'ready' });
}

export const host = {
  openWorkspace: () => vscodeApi.postMessage({ t: 'open-workspace' }),
  openSettings: () => vscodeApi.postMessage({ t: 'open-settings' }),
};
