/**
 * The bottom panel: terminals, and output from background work. Resizable,
 * remembered, toggled with Ctrl+J.
 *
 * @module desktop/renderer/shell/BottomPanel
 */

import React, { Suspense, lazy } from 'react';
import { useDesk } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';

const TerminalPanel = lazy(() => import('@/ide/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
const OutputPanel = lazy(() => import('@/ide/OutputPanel').then(m => ({ default: m.OutputPanel })));

const TABS = [
  { id: 'terminal', title: 'Terminal', icon: 'terminal' },
  { id: 'output', title: 'Output', icon: 'list' },
];

export function BottomPanel(): React.ReactElement {
  const panel = useDesk(s => s.panel);
  const setPanel = useDesk(s => s.setPanel);

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.height;
    const move = (ev: MouseEvent): void => setPanel({ height: Math.max(140, Math.min(window.innerHeight - 200, startH - (ev.clientY - startY))) });
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <section className="relative flex shrink-0 flex-col border-t border-aico-border-subtle bg-aico-bg" style={{ height: panel.height }} aria-label="Bottom panel">
      <div className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize" onMouseDown={startResize} role="separator" aria-orientation="horizontal" />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-aico-border-subtle px-2">
        {TABS.map(t => (
          <button key={t.id} className={cls('flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px]', panel.tab === t.id ? 'bg-aico-hover text-aico-primary' : 'text-aico-muted hover:text-aico-primary')}
            onClick={() => setPanel({ tab: t.id })}>
            <Icon name={t.icon} size={13} />{t.title}
          </button>
        ))}
        <div className="flex-1" />
        <button className="icon-btn-sm" onClick={() => setPanel({ height: panel.height > window.innerHeight * 0.6 ? 280 : Math.round(window.innerHeight * 0.7) })} title="Maximise panel" aria-label="Maximise panel"><Icon name="expand" size={14} /></button>
        <button className="icon-btn-sm" onClick={() => setPanel({ open: false })} title="Close panel (Ctrl+J)" aria-label="Close panel"><Icon name="x" size={14} /></button>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="p-4 text-[12px] text-aico-muted">Loading…</div>}>
          <div className={cls('h-full', panel.tab !== 'terminal' && 'hidden')}><TerminalPanel /></div>
          {panel.tab === 'output' && <OutputPanel />}
        </Suspense>
      </div>
    </section>
  );
}
