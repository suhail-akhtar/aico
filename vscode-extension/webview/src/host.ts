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

/** A tool call the run is blocked on, as the panel forwards it. */
export interface PermissionRequest {
  id: string;
  tool: string;
  detail: string;
  fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string };
}

export interface PermissionDecision {
  id: string;
  allow: boolean;
}

/** A file write the run handed to this client to apply. */
export interface EditRequest {
  id: string;
  path: string;
  after: string;
}

export interface EditOutcome {
  id: string;
  applied: boolean;
  reason?: string;
}

type HostMessage =
  | ({ t: 'boot' } & BootInfo)
  | ({ t: 'ask' } & AskRequest)
  | { t: 'new-session' }
  | { t: 'focus-composer' }
  | ({ t: 'permission:decided' } & PermissionDecision)
  | ({ t: 'edit:done' } & EditOutcome);

type Listener<T> = (value: T) => void;

const bootListeners = new Set<Listener<BootInfo>>();
const askListeners = new Set<Listener<AskRequest>>();
const newSessionListeners = new Set<Listener<void>>();
const focusListeners = new Set<Listener<void>>();
const decisionListeners = new Set<Listener<PermissionDecision>>();
const editListeners = new Set<Listener<EditOutcome>>();

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
  if (message?.t === 'focus-composer') {
    for (const listener of focusListeners) listener();
  }
  if (message?.t === 'permission:decided') {
    for (const listener of decisionListeners) listener({ id: message.id, allow: message.allow });
  }
  if (message?.t === 'edit:done') {
    const done = message;
    for (const listener of editListeners) {
      listener({ id: done.id, applied: done.applied, reason: done.reason });
    }
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

/** The editor asked for the caret — "ask about this selection" and friends. */
export function onFocusComposer(listener: Listener<void>): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
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

/** VS Code's answer to a tool approval. */
export function onPermissionDecided(listener: Listener<PermissionDecision>): () => void {
  decisionListeners.add(listener);
  return () => decisionListeners.delete(listener);
}

/**
 * Ask VS Code to put a tool approval to the user.
 *
 * Fire and forget: the answer arrives as `permission:decided`, because a modal
 * can stay open for as long as somebody takes to read it and a promise held
 * across that would have to survive the panel being hidden and shown again.
 */
export function requestPermission(request: PermissionRequest): void {
  vscodeApi.postMessage({ t: 'permission', request });
}

/** What VS Code did with a write it was handed. */
export function onEditDone(listener: Listener<EditOutcome>): () => void {
  editListeners.add(listener);
  return () => editListeners.delete(listener);
}

/**
 * Ask VS Code to apply a file write as a WorkspaceEdit.
 *
 * Fire and forget, like the permission request: applying can involve opening a
 * document and saving it, and the answer comes back as `edit:done`.
 */
export function requestEdit(request: EditRequest): void {
  vscodeApi.postMessage({ t: 'edit', request });
}

export const host = {
  openWorkspace: () => vscodeApi.postMessage({ t: 'open-workspace' }),
  openSettings: () => vscodeApi.postMessage({ t: 'open-settings' }),
  openFolder: () => vscodeApi.postMessage({ t: 'open-folder' }),
};
