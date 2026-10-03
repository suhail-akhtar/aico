/**
 * Chat verbs used from everywhere: the sidebar, the palette, the tray, plugin
 * commands and the agent's own IDE tools.
 *
 * @module desktop/renderer/chat/actions
 */

import React from 'react';
import { useStore } from '@web/store';
import { api, type SessionSummary } from '@web/api';
import { useDesk, go, toast } from '@/state/desk';
import { markSeen } from '@/lib/local';
import { MenuItem, MenuSep } from '@/shell/Popover';
import { desktop } from '@/desktop';
import { slug } from '@/lib/util';

/** Start a fresh chat and show the home composer. */
export function newChat(opts?: { workspace?: boolean; project?: string; prompt?: string; send?: boolean }): void {
  const st = useStore.getState();
  if (opts?.project) st.newSessionIn(opts.project);
  else if (opts?.workspace) {
    const ws = st.projects.find(p => p.isWorkspace);
    if (ws) st.newSessionIn(ws.path); else st.newSession();
  } else st.newSession();
  go('home');
  if (opts?.prompt) {
    if (opts.send) void sendPrompt(opts.prompt);
    else st.prefillComposer(opts.prompt);
  }
}

/**
 * Show a chat. The route moves first and the session follows it (see
 * {@link installChatRouteSync}); the old order — switch the session, await,
 * then move the route — left a moment where the two disagreed, and the view
 * "corrected" it by reopening the previous chat, which corrected back: chats
 * flickered between two ids until the app was killed.
 */
export async function openChat(id: string): Promise<void> {
  go('chat', { id });
  const st = useStore.getState();
  if (st.sessionId !== id) await st.openSession(id);
  markSeen(id);
}

/**
 * Keeps "which chat is on screen" in one place without a tug of war.
 *
 * Two things name the open chat: the route (`chat/<id>`, what back/forward,
 * links and notifications move) and the store's `sessionId` (what the stream is
 * connected to). Each direction is synced only on *its own* change — a route
 * change opens that session; a session change the store made by itself
 * (branching, a new chat) moves the route to it — and each side checks the other
 * already agrees before acting, so neither can undo the other.
 */
export function installChatRouteSync(): () => void {
  const offRoute = useDesk.subscribe((s, prev) => {
    if (s.route === prev.route || s.route.view !== 'chat') return;
    const id = s.route.params?.id;
    const st = useStore.getState();
    if (id && id !== st.sessionId) void st.openSession(id);
  });
  const offStore = useStore.subscribe((s, prev) => {
    if (s.sessionId === prev.sessionId) return;
    const { route, navigate } = useDesk.getState();
    if (route.view !== 'chat' || route.params?.id === s.sessionId) return;
    navigate({ view: 'chat', params: { id: s.sessionId } }, { replace: true });
  });
  return () => { offRoute(); offStore(); };
}

/** Send in the current chat (switching the view to it). */
export async function sendPrompt(text: string, opts?: Parameters<ReturnType<typeof useStore.getState>['submit']>[1]): Promise<void> {
  const st = useStore.getState();
  const composer = useDesk.getState();
  void composer;
  go('chat', { id: st.sessionId });
  await st.submit(text, { ...currentSendOptions(), ...opts });
}

/** The composer's standing choices (approval, effort), kept here so every sender uses them. */
export interface SendOptions {
  approval: 'full' | 'auto' | 'edits' | 'ask';
  effort: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  planMode: boolean;
}

let sendOptions: SendOptions = (() => {
  try {
    const raw = localStorage.getItem('desk.sendOptions');
    if (raw) return { approval: 'auto', effort: 'auto', planMode: false, ...JSON.parse(raw) } as SendOptions;
  } catch { /* defaults */ }
  return { approval: 'auto', effort: 'auto', planMode: false };
})();
const listeners = new Set<() => void>();

export function getSendOptions(): SendOptions { return sendOptions; }
export function setSendOptions(patch: Partial<SendOptions>): void {
  sendOptions = { ...sendOptions, ...patch };
  try { localStorage.setItem('desk.sendOptions', JSON.stringify(sendOptions)); } catch { /* fine */ }
  for (const l of listeners) l();
}
export function useSendOptions(): SendOptions {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => { listeners.add(force); return () => { listeners.delete(force); }; }, []);
  return sendOptions;
}
function currentSendOptions(): { approval: SendOptions['approval']; effort: SendOptions['effort']; planMode: boolean } {
  return { approval: sendOptions.approval, effort: sendOptions.effort, planMode: sendOptions.planMode };
}

/** Export a chat in one of the engine's formats. */
export async function exportChat(id: string, format: 'md' | 'txt', title?: string): Promise<void> {
  try {
    const res = await fetch(`/api/session/export?id=${encodeURIComponent(id)}&format=${format}`);
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    const saved = await desktop.dialog.saveFile({
      defaultName: `${slug(title || 'chat')}.${format}`,
      content: text,
      filters: format === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'Text', extensions: ['txt'] }],
    });
    if (saved) toast.success('Exported', saved);
  } catch (err) {
    toast.error('Export failed', (err as Error).message);
  }
}

/** The "…" menu of a chat row. */
export function chatCommands(session: SessionSummary, close: () => void, rename: () => void): React.ReactElement[] {
  const st = useStore.getState();
  const groups = st.groups;
  return [
    <MenuItem key="open" icon="chat" label="Open" onClick={() => { close(); void openChat(session.id); }} />,
    <MenuItem key="rename" icon="edit" label="Rename" onClick={() => { close(); rename(); }} />,
    <MenuItem key="fork" icon="git-branch" label="Branch into a new chat" onClick={() => {
      close();
      void st.forkSession(session.id).then(() => go('chat', { id: useStore.getState().sessionId }))
        .catch((e: Error) => toast.error('Could not branch', e.message));
    }} />,
    ...(groups.length ? [
      <MenuSep key="sep-g" />,
      ...groups.slice(0, 8).map(g => (
        <MenuItem key={`g-${g.id}`} icon="stack" label={`Move to ${g.name}`} checked={session.group === g.id}
          onClick={() => { close(); void st.moveToGroup(session.id, session.group === g.id ? null : g.id); }} />
      )),
    ] : []),
    <MenuSep key="sep-e" />,
    <MenuItem key="md" icon="download" label="Export as Markdown" onClick={() => { close(); void exportChat(session.id, 'md', session.title); }} />,
    <MenuItem key="txt" icon="file-text" label="Export as text" onClick={() => { close(); void exportChat(session.id, 'txt', session.title); }} />,
    <MenuSep key="sep-d" />,
    <MenuItem key="archive" icon="archive" label={session.archived ? 'Restore' : 'Archive'} onClick={() => {
      close(); void st.archiveSession(session.id, !session.archived);
    }} />,
    <MenuItem key="delete" icon="trash" danger label="Delete…" onClick={() => {
      close();
      void desktop.dialog.confirm({
        title: 'Delete chat', message: `Delete “${session.title || 'New chat'}” for good?`,
        detail: 'Its transcript is removed from disk. This cannot be undone.', ok: 'Delete', danger: true,
      }).then(ok => {
        if (!ok) return;
        return st.deleteSessions([session.id]).then(r => {
          if (r.skipped.length) toast.warning('Not deleted', r.skipped[0]!.reason);
          else toast.success('Chat deleted');
          if (useDesk.getState().route.params?.id === session.id) go('home');
        });
      }).catch((e: Error) => toast.error('Could not delete', e.message));
    }} />,
  ];
}

/** Server-side search over titles is instant; this also reads each chat's first prompt lazily. */
export function searchSessions(q: string): SessionSummary[] {
  const needle = q.trim().toLowerCase();
  const all = useStore.getState().sessions;
  if (!needle) return [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  return all.filter(s => (s.title ?? '').toLowerCase().includes(needle) || (s.project ?? '').toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export { api };
