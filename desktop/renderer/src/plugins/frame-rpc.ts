/**
 * What a sandboxed plugin frame may ask the app to do.
 *
 * A short, explicit list. Each call names itself (`{ type: 'aico:call', id,
 * method, params }`) and gets `{ type: 'aico:reply', id, result | error }`.
 * Anything that changes something visible — sending a prompt, opening a view,
 * notifying — is something the user could have done themselves from the
 * palette; nothing here reads files, settings or other chats.
 *
 * @module desktop/renderer/plugins/frame-rpc
 */

import { useDesk } from '@/state/desk';
import { runAction } from './registry';
import { useStore } from '@web/store';

type Reply = (msg: unknown) => void;

const METHODS: Record<string, (pluginId: string, params: Record<string, unknown>) => unknown | Promise<unknown>> = {
  /** Put text in the composer (does not send). */
  'composer.prefill': (_p, params) => { useStore.getState().prefillComposer(String(params.text ?? '')); return true; },
  /** Start a new chat with this prompt and send it. */
  'chat.ask': (pluginId, params) => runAction({ type: 'prompt', prompt: String(params.prompt ?? ''), newChat: params.newChat !== false, send: true }, pluginId),
  'view.open': (pluginId, params) => runAction({ type: 'open-view', view: String(params.view ?? '') }, pluginId),
  'browser.open': (pluginId, params) => runAction({ type: 'browse', url: String(params.url ?? '') }, pluginId),
  'notify': (_p, params) => {
    useDesk.getState().toast({ kind: (['info', 'success', 'warning', 'error'].includes(String(params.kind)) ? params.kind : 'info') as 'info', title: String(params.title ?? ''), body: params.body ? String(params.body) : undefined });
    return true;
  },
  'theme.get': () => ({ mode: useDesk.getState().mode }),
  /** Remember small values for this plugin only (localStorage, namespaced). */
  'storage.get': (pluginId, params) => {
    try { return JSON.parse(localStorage.getItem(`plugin.${pluginId}.${String(params.key)}`) ?? 'null'); } catch { return null; }
  },
  'storage.set': (pluginId, params) => {
    try { localStorage.setItem(`plugin.${pluginId}.${String(params.key)}`, JSON.stringify(params.value ?? null)); return true; } catch { return false; }
  },
};

export async function handleFrameMessage(pluginId: string, data: unknown, reply: Reply): Promise<void> {
  const msg = data as { type?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | null;
  if (!msg || msg.type !== 'aico:call' || typeof msg.method !== 'string') return;
  const fn = METHODS[msg.method];
  if (!fn) { reply({ type: 'aico:reply', id: msg.id, error: `Unknown method ${msg.method}` }); return; }
  try {
    const result = await fn(pluginId, msg.params ?? {});
    reply({ type: 'aico:reply', id: msg.id, result: result ?? null });
  } catch (err) {
    reply({ type: 'aico:reply', id: msg.id, error: (err as Error).message });
  }
}

export const FRAME_METHODS = Object.keys(METHODS);
