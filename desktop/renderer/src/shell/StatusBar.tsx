/**
 * A quiet line at the foot of the window: engine health, what is running in
 * the background, and whatever status items plugins contribute. Clicking the
 * activity count opens the Activity monitor.
 *
 * @module desktop/renderer/shell/StatusBar
 */

import React from 'react';
import { useStore } from '@web/store';
import { useDesk, go } from '@/state/desk';
import { useStatusItems, runCommand } from '@/plugins/registry';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';

export function StatusBar(): React.ReactElement | null {
  const engine = useDesk(s => s.engine);
  const activity = useDesk(s => s.activity);
  const sessions = useStore(s => s.sessions);
  const status = useStore(s => s.status);
  const items = useStatusItems();
  const disabled = useDesk(s => s.prefs.plugins.disabled);
  if (disabled.includes('aico.statusbar')) return null;
  const runningChats = sessions.filter(s => s.running).length;
  const runningWork = activity.filter(a => a.status === 'running').length;
  const running = runningChats + runningWork;
  const tone = engine.status === 'ready' ? (status === 'lost' ? 'bg-aico-warning' : 'bg-aico-success') : engine.status === 'crashed' ? 'bg-aico-danger' : 'bg-aico-warning';
  const label = engine.status === 'ready' ? (status === 'lost' ? 'Reconnecting' : 'Engine ready') : engine.status === 'crashed' ? 'Engine stopped' : 'Starting engine';
  const left = items.filter(i => i.align !== 'right');
  const right = items.filter(i => i.align === 'right');
  const item = (i: typeof items[number]): React.ReactElement => (
    <button key={`${i.pluginId}:${i.id}`} className="rounded px-1.5 hover:bg-aico-hover hover:text-aico-primary" title={i.tooltip}
      onClick={() => { if (i.command) runCommand(i.command); }}>{i.text}</button>
  );
  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-aico-border-subtle bg-aico-sidebar px-3 text-[11.5px] text-aico-muted">
      <button className="flex items-center gap-1.5 rounded px-1.5 hover:bg-aico-hover" onClick={() => useDesk.getState().openSettings('application')} title={label}>
        <span className={cls('h-1.5 w-1.5 rounded-full', tone)} />{label}
      </button>
      {left.map(item)}
      <div className="flex-1" />
      {right.map(item)}
      <button className={cls('flex items-center gap-1.5 rounded px-1.5 hover:bg-aico-hover', running > 0 && 'text-aico-accent')} onClick={() => go('activity')} title="Background activity">
        {running > 0 ? <span className="live-dot h-1.5 w-1.5" /> : <Icon name="activity" size={12} />}
        {running > 0 ? `${running} running` : 'Idle'}
      </button>
    </footer>
  );
}
