/**
 * The built-in browser's chrome: tabs, the address bar, and a placeholder the
 * native page is laid over.
 *
 * The page itself is a native view drawn by main above this element, sized to
 * it on every layout change. When a menu or dialog opens, the native view
 * steps aside (it would cover the menu) and a still of the page stands in.
 *
 * When the agent drives the browser, a strip says so; when it needs you —
 * a sign-in, an MFA code, a CAPTCHA it must not solve — it hands over, and
 * the strip becomes a "Done" button.
 *
 * @module desktop/renderer/ide/BrowserPane
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke, on } from '@/desktop';
import { useDesk, toast } from '@/state/desk';
import { useOverlays } from '@/lib/overlay';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import type { ViewProps } from '@/plugins/registry';

interface TabInfo { id: string; url: string; title: string; favicon?: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; active: boolean; zoom: number }

export function BrowserView({ params }: ViewProps): React.ReactElement {
  return <BrowserPane initialUrl={params?.url} />;
}

export function BrowserPane({ docked, initialUrl }: { docked?: boolean; initialUrl?: string }): React.ReactElement {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [still, setStill] = useState<string | null>(null);
  const [agentAt, setAgentAt] = useState(0);
  const [handoff, setHandoff] = useState<{ id: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const overlays = useOverlays(s => s.count);
  const settingsOpen = useDesk(s => s.settings !== null);
  const covered = overlays > 0 || settingsOpen || Boolean(handoff && false);
  const activeTab = tabs.find(t => t.active);

  useEffect(() => {
    void invoke<TabInfo[]>('browser:tabs').then(setTabs).catch(() => {});
    const offs = [
      on<TabInfo[]>('browser:tabs', setTabs),
      on<{ at: number }>('browser:agent-active', (e) => setAgentAt(e.at)),
      on<{ id: string; message: string }>('browser:handoff', (h) => setHandoff(h)),
      on<{ message: string; url: string }>('browser:error', (e) => setError(`${e.message} — ${e.url}`)),
      on<{ file: string; state: string }>('browser:download', (d) => toast[d.state === 'completed' ? 'success' : 'warning'](d.state === 'completed' ? 'Downloaded' : 'Download failed', d.file)),
      on('browser:focus-address', () => { addressRef.current?.focus(); addressRef.current?.select(); }),
    ];
    return () => offs.forEach(f => f());
  }, []);

  useEffect(() => {
    if (initialUrl) void invoke('browser:open', initialUrl).catch((e: Error) => setError(e.message));
  }, [initialUrl]);

  useEffect(() => { if (!editing) setAddress(activeTab?.url ?? ''); }, [activeTab?.url, editing]);
  useEffect(() => { setError(null); }, [activeTab?.url]);

  // Keep the native view exactly over the placeholder.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    let frame = 0;
    const push = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const z = window.devicePixelRatio ? 1 : 1;
        void invoke('browser:setBounds', { x: r.left * z, y: r.top * z, width: r.width * z, height: r.height * z }, !covered && r.width > 0);
      });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', push);
      void invoke('browser:setBounds', null, false);
    };
  }, [covered, docked]);

  // A still of the page while something covers it.
  useEffect(() => {
    if (!covered) { setStill(null); return; }
    void invoke<{ dataUrl: string }>('browser:screenshot').then(s => setStill(s.dataUrl)).catch(() => setStill(null));
  }, [covered]);

  const go = (): void => {
    setEditing(false);
    if (address.trim()) void invoke('browser:open', address.trim()).catch((e: Error) => setError(e.message));
  };
  const agentLive = Date.now() - agentAt < 8000;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!docked && (
        <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-aico-border-subtle px-2 thin-scroll">
          {tabs.map(t => (
            <div key={t.id} className={cls('group flex h-8 max-w-[220px] min-w-[120px] items-center gap-1.5 rounded-t-lg px-2.5 text-[12.5px]',
              t.active ? 'bg-aico-surface text-aico-primary' : 'text-aico-muted hover:bg-aico-hover')}>
              <button className="flex min-w-0 flex-1 items-center gap-1.5" onClick={() => void invoke('browser:select', t.id)} title={t.url}>
                {t.loading ? <span className="spinner h-3 w-3" /> : t.favicon ? <img src={t.favicon} className="h-3.5 w-3.5" alt="" /> : <Icon name="globe" size={13} />}
                <span className="truncate">{t.title || t.url || 'New tab'}</span>
              </button>
              <button className="icon-btn-sm h-5 w-5 opacity-60 hover:opacity-100" onClick={() => void invoke('browser:close', t.id)} aria-label="Close tab"><Icon name="x" size={11} /></button>
            </div>
          ))}
          <button className="icon-btn-sm mb-0.5" onClick={() => void invoke('browser:newTab')} title="New tab" aria-label="New tab"><Icon name="plus" size={14} /></button>
        </div>
      )}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-aico-border-subtle px-2">
        <button className="icon-btn-sm" disabled={!activeTab?.canGoBack} onClick={() => void invoke('browser:back')} aria-label="Back"><Icon name="arrow-left" size={15} /></button>
        <button className="icon-btn-sm" disabled={!activeTab?.canGoForward} onClick={() => void invoke('browser:forward')} aria-label="Forward"><Icon name="arrow-right" size={15} /></button>
        <button className="icon-btn-sm" onClick={() => void invoke(activeTab?.loading ? 'browser:stop' : 'browser:reload')} aria-label={activeTab?.loading ? 'Stop' : 'Reload'}>
          <Icon name={activeTab?.loading ? 'x' : 'refresh'} size={14} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-aico-hover px-3 py-1">
          <Icon name={activeTab?.url.startsWith('https:') ? 'lock' : 'globe'} size={12} className="shrink-0 text-aico-muted" />
          <input ref={addressRef} value={address} onChange={e => { setAddress(e.target.value); setEditing(true); }}
            onFocus={e => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)}
            onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { setEditing(false); (e.target as HTMLInputElement).blur(); } }}
            placeholder="Search or enter an address" aria-label="Address"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-aico-muted" />
        </div>
        {activeTab && activeTab.zoom !== 1 && (
          <button className="chip py-0.5" onClick={() => void invoke('browser:zoom', 0)} title="Reset zoom">{Math.round(activeTab.zoom * 100)}%</button>
        )}
        <button className="icon-btn-sm" onClick={() => void invoke('browser:devtools')} title="Developer tools" aria-label="Developer tools"><Icon name="code" size={14} /></button>
        <button className="icon-btn-sm" onClick={() => void invoke('browser:external')} title="Open in your browser" aria-label="Open in system browser"><Icon name="external" size={14} /></button>
      </div>
      {(agentLive || handoff) && (
        <div className={cls('flex shrink-0 items-center gap-2 px-3 py-1.5 text-[12.5px]', handoff ? 'bg-aico-warning/15 text-aico-warning' : 'bg-aico-accent-soft text-aico-accent')}>
          <Icon name={handoff ? 'hand' : 'cursor'} size={14} />
          <span className="min-w-0 flex-1 truncate">{handoff ? `The agent needs you: ${handoff.message}` : 'The agent is using this browser'}</span>
          {handoff && (
            <button className="btn-primary btn-sm" onClick={() => { void invoke('browser:handoffDone', handoff.id); setHandoff(null); }}>Done — hand back</button>
          )}
        </div>
      )}
      {error && (
        <div className="flex shrink-0 items-center gap-2 bg-aico-danger/10 px-3 py-1.5 text-[12.5px] text-aico-danger">
          <Icon name="alert" size={13} /><span className="min-w-0 flex-1 truncate">{error}</span>
          <button className="icon-btn-sm" onClick={() => setError(null)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
        </div>
      )}
      <div ref={host} className="relative min-h-0 flex-1 bg-white">
        {still && <img src={still} alt="" className="absolute inset-0 h-full w-full object-cover object-left-top" />}
        {tabs.length === 0 && !still && (
          <div className="absolute inset-0 flex items-center justify-center bg-aico-bg text-[13px] text-aico-muted">Opening…</div>
        )}
      </div>
    </div>
  );
}
