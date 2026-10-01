/**
 * The tab strip, as in a real browser: favicon (a spinner while loading),
 * title, the sound indicator that mutes on click, close — middle-click closes
 * too. Pinned tabs are icon-only and always first. Tabs are dragged to
 * reorder (the others slide aside, a line marks where it lands); a pinned tab
 * stays among the pinned ones. Right-click opens the native tab menu (pin,
 * duplicate, mute, close others / to the right, reopen closed). The ⌄ at the
 * end searches the open and recently closed tabs. A tab the agent is driving
 * wears an "AI" badge. A tab a chat opened for its own work (electron/
 * browser-owners.ts) carries that chat's colour along its top edge and a dot
 * whose tooltip names the chat — so a chat's tabs read as a group.
 *
 * In full view the strip is the top of the window: its empty space drags the
 * window, it keeps clear of the window's own controls, and it carries the
 * button that brings AICO's chrome back. In the browser's own window it
 * always is — the title bar, as in Chrome — with a button to the AICO window.
 *
 * @module desktop/renderer/browser/TabStrip
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { Popover } from '@/shell/Popover';
import { call, fire, useAvailable } from './ipc';
import { isBlankUrl, hostOf } from './urls';
import { Favicon } from './Omnibox';
import { closeTab, newTab, openUrl, useBrowser } from './store';
import { bookmarkTab } from './bookmarks';
import { dropIndex, ownerLine, previewOrder } from './tabs';
import { setFullView, useFullView } from './fullview';
import { inBrowserWindow, openAicoWindow } from './host';
import type { TabState } from './types';

interface Drag { id: string; startX: number; dx: number; to: number; from: number; width: number; boxes: Array<{ id: string; left: number; width: number; pinned?: boolean }> }

export function TabStrip(): React.ReactElement {
  const tabs = useBrowser(s => s.state.tabs);
  const activeId = useBrowser(s => s.state.activeId);
  const full = useFullView(s => s.on);
  /** The strip is the window's title bar: in full view, and always in the browser's own window. */
  const own = inBrowserWindow();
  const titlebar = full || own;
  const mac = navigator.platform.toLowerCase().includes('mac');
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Keep the dropped layout until main's new order arrives, so the tab does not jump back first. */
  const [settling, setSettling] = useState<{ id: string; to: number } | null>(null);
  const order = tabs.map(t => t.id).join('|');
  useEffect(() => { setSettling(null); }, [order]);
  useEffect(() => { if (!settling) return; const t = setTimeout(() => setSettling(null), 600); return () => clearTimeout(t); }, [settling]);

  // Keep the tab in front visible when the strip scrolls.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-tab="${activeId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const start = (e: React.PointerEvent, tab: TabState): void => {
    if (e.button !== 0 || !strip.current) return;
    const root = strip.current;
    const scroll = root.scrollLeft;
    const origin = root.getBoundingClientRect().left;
    const boxes = tabs.map((t) => {
      const r = root.querySelector<HTMLElement>(`[data-tab="${t.id}"]`)!.getBoundingClientRect();
      return { id: t.id, left: r.left - origin + scroll, width: r.width, pinned: t.pinned };
    });
    const from = tabs.findIndex(t => t.id === tab.id);
    const me = boxes[from]!;
    const startX = e.clientX;
    let d: Drag | null = null;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      if (!d && Math.abs(dx) < 5) return;
      const x = me.left + me.width / 2 + dx;
      d = { id: tab.id, startX, dx, from, width: me.width, boxes, to: dropIndex(boxes, tab.id, x) };
      setDrag(d);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (d && d.to !== d.from) { setSettling({ id: d.id, to: d.to }); fire('browser:move', d.id, d.to); }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // While dragging (or just dropped), show the order it will have.
  const shown = useMemo(() => {
    if (settling) return previewOrder(tabs, settling.id, settling.to);
    return tabs;
  }, [tabs, settling]);

  /** How far a tab slides aside while another is dragged over its slot. */
  const shift = (id: string): number => {
    if (!drag || id === drag.id) return 0;
    const rest = drag.boxes.filter(b => b.id !== drag.id).map(b => b.id);
    const r = rest.indexOf(id);
    const was = r < drag.from ? r : r + 1;
    const now = r < drag.to ? r : r + 1;
    return (now - was) * drag.width;
  };
  // Where it lands: the slot the dragged tab will take once the others have slid aside.
  const indicator = drag && drag.to !== drag.from ? (drag.boxes[drag.to]?.left ?? null) : null;

  return (
    <div className={cls('bx-tabstrip flex h-10 shrink-0 items-end', titlebar && 'drag bx-tabstrip-full', titlebar && mac && 'traffic-inset')}>
      <div ref={strip} className={cls('relative flex min-w-0 flex-1 items-end gap-0 overflow-x-auto px-2 pt-1.5 thin-scroll', drag && 'bx-dragging')}
        role="tablist" aria-label="Browser tabs">
        {shown.map(t => (
          <Tab key={t.id} tab={t} active={t.id === activeId} onPointerDown={start}
            dragging={drag?.id === t.id} style={drag ? { transform: `translateX(${drag.id === t.id ? drag.dx : shift(t.id)}px)` } : undefined} />
        ))}
        {indicator !== null && <span className="bx-drop-line" style={{ left: indicator }} aria-hidden />}
        <button className="no-drag icon-btn-sm mb-[3px] ml-1 shrink-0" onClick={() => newTab()} title="New tab (Ctrl+T)"><Icon name="plus" size={15} /></button>
        <div className="min-w-4 flex-1" />
      </div>
      <div className={cls('flex shrink-0 items-center gap-0.5 pb-[5px] pl-1 pr-2', titlebar && !mac && 'titlebar-inset !pr-[146px]')}>
        <TabSearch />
        {own && (
          <button className="no-drag btn-ghost btn-sm ml-0.5 !h-7 !py-0" onClick={openAicoWindow} title="Open the AICO window — chats, projects, settings">
            <Icon name="chat" size={14} />AICO
          </button>
        )}
        {full && (
          <button className="no-drag icon-btn-sm" onClick={() => setFullView(false)} title="Leave full view (F11 / Esc)" aria-label="Leave full view">
            <Icon name="collapse" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function tabTitle(t: TabState): string {
  if (isBlankUrl(t.url)) return 'New tab';
  return t.title || t.url || 'Untitled';
}

function Tab({ tab, active, onPointerDown, dragging, style }: {
  tab: TabState; active: boolean; dragging: boolean; style?: React.CSSProperties;
  onPointerDown: (e: React.PointerEvent, tab: TabState) => void;
}): React.ReactElement {
  const canMute = useAvailable('browser:mute');
  const bookmarked = useBrowser(s => s.bookmarks.some(b => b.url === tab.url));
  const pinned = Boolean(tab.pinned);
  const menu = async (): Promise<void> => {
    const action = await call<string | null>('browser:tabMenu', tab.id, { bookmarked }).catch(() => null);
    if (action === 'bookmark') void bookmarkTab(tab);
    else if (action === 'copyAddress') toast.success('Address copied');
    else if (action === undefined) fallbackMenu(tab);
  };
  const owner = ownerLine(tab);
  const ownerColour = tab.owner ? `hsl(${tab.owner.hue} 70% ${tab.owner.released ? '62%' : '50%'})` : undefined;
  return (
    <div role="tab" aria-selected={active} tabIndex={0} data-tab={tab.id} data-owner={tab.owner?.title}
      className={cls('bx-tab no-drag group cursor-default select-none', pinned && 'bx-tab-pinned', tab.agentActive && 'bx-agent', dragging && 'bx-tab-dragging')}
      style={ownerColour ? { ...style, boxShadow: `inset 0 2px 0 ${ownerColour}` } : style}
      onPointerDown={(e) => {
        if (e.button === 1) { e.preventDefault(); if (!pinned) closeTab(tab.id); return; }
        if (e.button === 0 && !active) fire('browser:select', tab.id);
        onPointerDown(e, tab);
      }}
      onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={e => e.preventDefault()}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fire('browser:select', tab.id); }}
      onContextMenu={e => { e.preventDefault(); void menu(); }}
      title={`${tabTitle(tab)}${isBlankUrl(tab.url) ? '' : `\n${hostOf(tab.url) || tab.url}`}${owner ? `\n${owner}` : ''}`}>
      <span className="bx-tab-icon relative flex h-4 w-4 shrink-0 items-center justify-center">
        {tab.loading ? <span className="spinner h-3.5 w-3.5" /> : isBlankUrl(tab.url) ? <span className="bx-orb h-3.5 w-3.5" /> : <Favicon src={tab.favicon} url={tab.url} size={16} />}
        {pinned && (tab.audible || tab.muted) && <span className="bx-pin-audio"><Icon name={tab.muted ? 'volume-x' : 'volume'} size={9} /></span>}
      </span>
      {!pinned && <span className="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>}
      {!pinned && tab.owner && !tab.agentActive && (
        <span className="bx-owner-dot" data-released={tab.owner.released ? '' : undefined} style={{ background: ownerColour }} title={owner} aria-label={owner} />
      )}
      {!pinned && tab.agentActive && <span className="bx-ai-badge" title={tab.driver ? `“${tab.driver}” is using this tab` : 'AICO is using this tab'}>AI</span>}
      {!pinned && (tab.audible || tab.muted) && (
        <button className={cls('icon-btn-sm h-5 w-5 shrink-0', tab.muted && 'text-aico-muted')} disabled={!canMute}
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); fire('browser:mute', tab.id, !tab.muted); }}
          title={tab.muted ? 'Unmute site' : 'Mute site'}>
          <Icon name={tab.muted ? 'volume-x' : 'volume'} size={13} />
        </button>
      )}
      {!pinned && (
        <button className="bx-tab-close icon-btn-sm h-5 w-5 shrink-0 rounded-full"
          onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); closeTab(tab.id); }} title="Close tab (Ctrl+W)">
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/** An older main without the native tab menu: the few things the chrome can do itself. */
function fallbackMenu(tab: TabState): void {
  toast.info('Tab menu unavailable', `Use Ctrl+W to close, or duplicate from the ⋮ menu (${tabTitle(tab)}).`);
}

// ── Search tabs ──

interface ClosedTab { url: string; title: string; favicon?: string; closedAt: number }

function TabSearch(): React.ReactElement {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={setAnchor} className={cls('no-drag icon-btn-sm', open && 'bg-aico-hover')} onClick={() => setOpen(o => !o)} title="Search tabs" aria-label="Search tabs" aria-expanded={open}>
        <Icon name="chevron-down" size={15} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={360}>
        {open && <TabSearchList close={() => setOpen(false)} />}
      </Popover>
    </>
  );
}

function TabSearchList({ close }: { close: () => void }): React.ReactElement {
  const tabs = useBrowser(s => s.state.tabs);
  const activeId = useBrowser(s => s.state.activeId);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<ClosedTab[]>([]);
  const [sel, setSel] = useState(0);
  useEffect(() => { void call<ClosedTab[]>('browser:closedTabs').then(c => setClosed(c ?? [])).catch(() => {}); }, []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (t: { title: string; url: string }): boolean => words.every(w => `${t.title} ${t.url}`.toLowerCase().includes(w));
  const openTabs = tabs.filter(hit);
  const recent = closed.filter(hit).slice(0, 8);
  const all: Array<{ kind: 'open'; tab: TabState } | { kind: 'closed'; tab: ClosedTab; index: number }> = [
    ...openTabs.map(tab => ({ kind: 'open' as const, tab })),
    ...recent.map((tab, index) => ({ kind: 'closed' as const, tab, index })),
  ];
  useEffect(() => setSel(0), [q]);
  const pick = (i: number): void => {
    const x = all[i];
    if (!x) return;
    close();
    if (x.kind === 'open') fire('browser:select', x.tab.id);
    else openUrl(x.tab.url, true);
  };
  return (
    <div className="flex max-h-[420px] flex-col" onKeyDown={(e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(all.length - 1, s + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    }}>
      <div className="px-2 pb-1.5 pt-1">
        <input autoFocus className="input h-8 w-full" placeholder="Search tabs" value={q} onChange={e => setQ(e.target.value)} aria-label="Search tabs" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto thin-scroll">
        {openTabs.length > 0 && <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Open tabs</div>}
        {all.map((x, i) => (
          <React.Fragment key={x.kind === 'open' ? x.tab.id : `c${x.index}`}>
            {x.kind === 'closed' && x.index === 0 && <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Recently closed</div>}
            <button className={cls('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', i === sel ? 'bg-aico-hover' : 'hover:bg-aico-hover')}
              onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              {isBlankUrl(x.tab.url) ? <span className="bx-orb h-3.5 w-3.5 shrink-0" /> : <Favicon src={x.tab.favicon} url={x.tab.url} size={15} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{x.tab.title || x.tab.url || 'New tab'}</span>
                <span className="block truncate text-[11.5px] text-aico-muted">{hostOf(x.tab.url) || x.tab.url}</span>
              </span>
              {x.kind === 'open' && x.tab.id === activeId && <span className="text-[11px] text-aico-muted">Current</span>}
              {x.kind === 'open' && x.tab.pinned && <Icon name="pin" size={12} className="text-aico-muted" />}
              {x.kind === 'open' && (
                <span role="button" tabIndex={-1} className="icon-btn-sm h-5 w-5" title="Close tab"
                  onClick={(e) => { e.stopPropagation(); closeTab(x.tab.id); }}><Icon name="x" size={11} /></span>
              )}
            </button>
          </React.Fragment>
        ))}
        {all.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-aico-muted">No tabs match “{q}”.</div>}
      </div>
    </div>
  );
}
