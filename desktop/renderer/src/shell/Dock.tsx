/**
 * The right-hand dock: the built-in browser (or another dockable view) beside
 * the chat, so you can watch the agent drive a page while it tells you what it
 * is doing.
 *
 * @module desktop/renderer/shell/Dock
 */

import React, { Suspense, lazy } from 'react';
import { useDesk } from '@/state/desk';
import { Icon } from '@/lib/icons';

const BrowserPane = lazy(() => import('@/ide/BrowserPane').then(m => ({ default: m.BrowserPane })));

export function Dock(): React.ReactElement {
  const dock = useDesk(s => s.dock);
  const setDock = useDesk(s => s.setDock);

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = dock.width;
    const move = (ev: MouseEvent): void => setDock({ width: Math.max(320, Math.min(window.innerWidth - 480, startW - (ev.clientX - startX))) });
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg" style={{ width: dock.width }} aria-label="Side panel">
      <div className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize" onMouseDown={startResize} role="separator" aria-orientation="vertical" />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-aico-border-subtle px-3 text-[12.5px] text-aico-secondary">
        <Icon name="globe" size={14} /> Browser
        <div className="flex-1" />
        <button className="icon-btn-sm" onClick={() => { setDock({ open: false }); useDesk.getState().navigate({ view: 'browser' }); }} title="Open full size" aria-label="Open browser full size"><Icon name="expand" size={13} /></button>
        <button className="icon-btn-sm" onClick={() => setDock({ open: false })} title="Close" aria-label="Close side panel"><Icon name="x" size={14} /></button>
      </div>
      <Suspense fallback={<div className="p-4 text-[12px] text-aico-muted">Loading…</div>}>
        <BrowserPane docked />
      </Suspense>
    </aside>
  );
}
