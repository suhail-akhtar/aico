/**
 * Home and the conversation — one view.
 *
 * An empty chat is the home screen: "Where should we begin?" over a centred
 * composer, the folder it will work in just above it (Antigravity), and quick
 * prompts from plugins below, then the morning brief (`@web/components/BriefCard`,
 * engine brief/). Once anything is said, the same chat becomes a
 * transcript with the composer pinned to the bottom.
 *
 * @module desktop/renderer/chat/ChatView
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { useStore } from '@web/store';
import { useDesk, toast } from '@/state/desk';
import { usePrompts } from '@/plugins/registry';
import { Icon } from '@/lib/icons';
import { markSeen } from '@/lib/local';
import type { ViewProps } from '@/plugins/registry';
import { Composer, ProjectChip } from './Composer';
import { Transcript } from './Transcript';
import { Attention } from './Attention';
import { SourcesPanel, useSourcesPanel } from './SourcesPanel';
import { CanvasPanel, useCanvasPanel } from './CanvasPanel';
import { ArtifactsPanel, useArtifactsPanel } from './ArtifactsPanel';
import { onCanvasEvent } from '@aico/ui';
import { newChat, openChat } from './actions';
import { BriefCard, type BriefHost } from '@web/components/BriefCard';
import { desktop } from '@/desktop';
import { TasksChipHost } from '@/tasks/TasksHost';

/** How the brief's one-click actions open things here: the OS browser, the Inbox page, the chat. */
const BRIEF_HOST: BriefHost = {
  openUrl: (url) => { void desktop.shell.openExternal(url); },
  openInbox: () => useDesk.getState().navigate({ view: 'inbox' }),
  openChat: (id) => { void openChat(id); },
  notify: (kind, title, detail) => { if (kind === 'error') toast.error(title, detail); else toast.success(title, detail); },
  startFix: (cwd, prompt) => newChat({ ...(cwd ? { project: cwd } : {}), prompt }),
  openCodeMap: (cwd, file, mode) => useDesk.getState().navigate({ view: 'codemap', params: { path: cwd, ...(file ? { file } : {}), ...(mode ? { mode } : {}) } }),
};

function greeting(name: string | undefined): string {
  const h = new Date().getHours();
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name.split(/[.\s_-]/)[0]!.replace(/^./, c => c.toUpperCase())}` : part;
}

export function ChatView({ params }: ViewProps): React.ReactElement {
  const sessionId = useStore(s => s.sessionId);
  const logged = useStore(s => s.logged);
  const busy = useStore(s => s.busy);
  const route = useDesk(s => s.route);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Arriving at chat/<id> (back/forward, a link) opens that chat. Only when the
  // route changes — never because the session did, which is the other half of
  // installChatRouteSync and reacting here too is what made chats flicker.
  useEffect(() => {
    const id = params?.id;
    if (route.view === 'chat' && id && id !== useStore.getState().sessionId) void useStore.getState().openSession(id);
  }, [params?.id, route.view]);

  useEffect(() => { if (!busy) markSeen(sessionId); }, [busy, sessionId, logged.size]);
  // Sources and canvases belong to the chat they came from.
  useEffect(() => { useSourcesPanel.getState().close(); useCanvasPanel.getState().close(); useArtifactsPanel.getState().close(); }, [sessionId]);
  // One right panel at a time: showing Sources puts the canvas away.
  useEffect(() => useSourcesPanel.subscribe((s, prev) => {
    if (s.sources && !prev.sources) { useCanvasPanel.getState().close(); useArtifactsPanel.getState().close(); }
  }), []);
  // Artifacts take the slot while open (the canvas stays open behind them, for "Open beside");
  // opening a canvas puts the list away.
  useEffect(() => useArtifactsPanel.subscribe((s, prev) => {
    if (s.open && !prev.open) useSourcesPanel.getState().close();
  }), []);
  useEffect(() => useCanvasPanel.subscribe((s, prev) => {
    if ((s.open && s.open !== prev.open) || (s.second && s.second !== prev.second)) useArtifactsPanel.getState().close();
  }), []);
  // A canvas the agent has just created in this chat opens beside it, the way
  // ChatGPT's does — the card in the reply reopens it later.
  useEffect(() => onCanvasEvent((c) => {
    if (c.action !== 'create' || c.author !== 'agent') return;
    if (c.sessionId && c.sessionId !== useStore.getState().sessionId) return;
    useCanvasPanel.getState().show({ id: c.id, title: c.title, kind: c.kind });
  }), []);
  const canvasOpen = useCanvasPanel(s => s.open !== null);
  const artifactsOpen = useArtifactsPanel(s => s.open);

  const empty = logged.size === 0 && !busy;
  if (empty) return <Home />;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <Transcript scrollRef={scrollRef} />
        </div>
        <div className="shrink-0 px-6 pb-4 pt-1">
          <TasksChipHost />
          <Attention />
          <Composer />
          <p className="mt-1.5 text-center text-[11px] text-aico-muted">AICO runs on this computer. The agent can make mistakes — check important work.</p>
        </div>
      </div>
      {artifactsOpen ? <ArtifactsPanel /> : canvasOpen ? <CanvasPanel /> : <SourcesPanel />}
    </div>
  );
}

function Home(): React.ReactElement {
  const info = useDesk(s => s.info);
  const prompts = usePrompts();
  const prefill = useStore(s => s.prefillComposer);
  const home = useMemo(() => prompts.filter(p => p.home).slice(0, 6), [prompts]);
  const recent = useStore(s => s.sessions);
  const latest = useMemo(() => [...recent].filter(s => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3), [recent]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-16">
      <div className="home-glow pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[900px] -translate-x-1/2 -translate-y-1/2" />
      <div className="relative w-full max-w-[760px]">
        <h1 className="mb-7 text-center text-[28px] font-medium tracking-tight text-aico-primary">
          Where should we begin?
        </h1>
        <div className="mb-2 flex justify-center"><ProjectChip large /></div>
        <Attention />
        <Composer home />
        {home.length > 0 && (
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {home.map(p => (
              <button key={`${p.pluginId}:${p.id}`} className="chip py-1.5 text-[13px]" onClick={() => prefill(p.prompt)}>
                {p.icon && <Icon name={p.icon} size={14} />}{p.title}
              </button>
            ))}
          </div>
        )}
        <BriefCard host={BRIEF_HOST} />
        {latest.length > 0 && (
          <div className="mx-auto mt-10 max-w-[560px]">
            <div className="mb-2 text-center text-[12px] text-aico-muted">{greeting(info?.user)} — pick up where you left off</div>
            <div className="flex flex-col gap-1">
              {latest.map(s => (
                <button key={s.id} className="flex items-center gap-3 rounded-xl px-3 py-2 text-left text-[13.5px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary"
                  onClick={() => void openChat(s.id)}>
                  <Icon name={s.running ? 'activity' : 'chat'} size={15} className={s.running ? 'text-aico-accent' : 'text-aico-muted'} />
                  <span className="min-w-0 flex-1 truncate">{s.title || 'New chat'}</span>
                  <Icon name="arrow-right" size={14} className="text-aico-muted" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
