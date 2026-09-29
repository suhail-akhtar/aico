/**
 * "Sources · 21" — the pages behind an answer, in a panel beside the chat.
 *
 * What the agent opened comes first (with the page title it read), then what
 * it saw in search results. Each row names the site with its favicon, the page
 * title and a line of snippet; a click opens the page in the system browser,
 * or the built-in one from the row's menu.
 *
 * @module desktop/renderer/chat/SourcesPanel
 */

import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Icon } from '@/lib/icons';
import { desktop, invoke, isDesktop } from '@/desktop';
import { go } from '@/state/desk';
import { siteName, type Source } from './sources';

export const useSourcesPanel = create<{ sources: Source[] | null; label: string; show: (s: Source[], label: string) => void; close: () => void }>(set => ({
  sources: null,
  label: '',
  show: (sources, label) => set({ sources, label }),
  close: () => set({ sources: null }),
}));

/** A site's icon, or its first letter when the icon cannot be fetched. */
export function Favicon({ host, size = 16 }: { host: string; size?: number }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-aico-hover text-[9px] font-semibold uppercase text-aico-secondary" style={{ width: size, height: size }}>
        {host.charAt(0)}
      </span>
    );
  }
  return (
    <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size * 2}`} alt="" width={size} height={size}
      className="shrink-0 rounded-[4px]" onError={() => setFailed(true)} loading="lazy" />
  );
}

export function SourcesPanel(): React.ReactElement | null {
  const { sources, label, close } = useSourcesPanel();
  useEffect(() => {
    if (!sources) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !document.querySelector('[role="menu"]')) close(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [sources, close]);
  if (!sources) return null;
  const read = sources.filter(s => s.via === 'read');
  const searched = sources.filter(s => s.via === 'search');

  const open = (s: Source, builtIn?: boolean): void => {
    if (builtIn && isDesktop) { go('browser'); void invoke('browser:open', s.url).catch(() => desktop.shell.openExternal(s.url)); }
    else void desktop.shell.openExternal(s.url);
  };

  const row = (s: Source): React.ReactElement => (
    <li key={s.url} className="group">
      <button className="w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-aico-hover" onClick={() => open(s)} title={s.url}>
        <span className="flex items-center gap-2 text-[12.5px] text-aico-secondary">
          <Favicon host={s.host} />
          <span className="truncate">{siteName(s.host)}</span>
          <span className="truncate text-aico-muted">· {s.host}</span>
        </span>
        <span className="mt-1 line-clamp-2 block text-[13.5px] font-medium leading-snug text-aico-primary">{s.title || s.url}</span>
        {s.snippet && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-aico-muted">{s.snippet}</span>}
      </button>
      {isDesktop && (
        <button className="ml-3 hidden text-[11.5px] text-aico-muted hover:text-aico-accent group-hover:inline" onClick={() => open(s, true)}>Open in the built-in browser</button>
      )}
    </li>
  );

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg animate-fade-in" aria-label="Sources">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h2 className="text-[15px] font-semibold">Sources</h2>
        <span className="text-[13px] text-aico-muted">· {sources.length}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-aico-muted">{label}</span>
        <button className="icon-btn-sm" onClick={close} title="Close sources (Esc)"><Icon name="x" size={16} /></button>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
        {read.length > 0 && <div className="px-3 pb-1 pt-2 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">Read</div>}
        <ul>{read.map(row)}</ul>
        {searched.length > 0 && <div className="px-3 pb-1 pt-3 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">Seen in search</div>}
        <ul>{searched.map(row)}</ul>
      </div>
    </aside>
  );
}
