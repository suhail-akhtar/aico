/**
 * A quiet line at the foot of the window: engine health, what is running in
 * the background, whatever status items plugins contribute, and the app
 * version (an update badge in its place while an update needs a click).
 * Clicking the running count opens the Tasks panel (the Activity page stays
 * in the nav).
 *
 * @module desktop/renderer/shell/StatusBar
 */

import React, { useEffect } from 'react';
import { useStore } from '@web/store';
import { useDesk } from '@/state/desk';
import { useStatusItems, runCommand } from '@/plugins/registry';
import { toggleTasks, useTaskTotals } from '@/tasks/TasksHost';
import { useUpdates } from '@/updates';
import { desktop } from '@/desktop';
import { updateBadge } from '@desk/update-policy';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';

/**
 * The installed version, and — while an update is on its way or waiting — a
 * badge that does the next step: Restart to install, Download, or the release
 * page when the update itself failed. Stays until acted on, unlike the toast.
 */
function UpdateItem(): React.ReactElement | null {
  const u = useUpdates(s => s.state);
  const info = useDesk(s => s.info);
  const badge = updateBadge(u);
  const version = u?.current ?? info?.app;
  const open = (): void => useDesk.getState().openSettings('application');
  if (badge) {
    const run = (): void => {
      if (badge.action === 'install') void desktop.updates.install();
      else if (badge.action === 'download') void desktop.updates.download();
      else if (badge.action === 'release-page' && u) void desktop.shell.openExternal(u.releaseUrl);
      else open();
    };
    return (
      <button data-testid="update-badge" onClick={run} title={badge.title}
        className={cls('flex items-center gap-1.5 rounded px-1.5 hover:bg-aico-hover',
          badge.tone === 'accent' ? 'text-aico-accent' : badge.tone === 'warning' ? 'text-aico-warning' : '')}>
        <Icon name={badge.action === 'install' ? 'refresh' : 'download'} size={12} />{badge.text}
      </button>
    );
  }
  if (!version) return null;
  return (
    <button data-testid="app-version" className="rounded px-1.5 font-mono hover:bg-aico-hover" onClick={open}
      title={info?.engine && info.engine !== version ? `AICO ${version} · engine ${info.engine} — updates in Settings` : `AICO ${version} — updates in Settings`}>
      v{version}
    </button>
  );
}

export function StatusBar(): React.ReactElement | null {
  const engine = useDesk(s => s.engine);
  const activity = useDesk(s => s.activity);
  const sessions = useStore(s => s.sessions);
  const status = useStore(s => s.status);
  const system = useStore(s => s.system);
  const refreshSystem = useStore(s => s.refreshSystem);
  // Background work lives in the engine's ledger; keep it fresh here too (the Activity page polls faster).
  useEffect(() => { const t = setInterval(() => { void refreshSystem(); }, 10_000); return () => clearInterval(t); }, [refreshSystem]);
  const items = useStatusItems();
  const tasks = useTaskTotals();
  const disabled = useDesk(s => s.prefs.plugins.disabled);
  if (disabled.includes('aico.statusbar')) return null;
  // The same count the Activity page shows: chats with a turn in flight plus live background work.
  // A chat's turn is also in this window's feed (kind 'turn'), so feed turns are not counted again —
  // that double count showed "2 running" for one chat.
  const runningChats = sessions.filter(s => s.running).length;
  const liveWork = (system?.work ?? []).filter(w => ['running', 'queued', 'blocked'].includes(w.state)).length;
  const otherFeed = activity.filter(a => a.status === 'running' && a.kind !== 'turn').length;
  // The Tasks panel's own count also sees terminal commands and browser procedures (tasks/TasksHost).
  const running = runningChats + Math.max(liveWork, otherFeed, tasks.running);
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
      <UpdateItem />
      <button className={cls('flex items-center gap-1.5 rounded px-1.5 hover:bg-aico-hover', running > 0 && 'text-aico-accent')} onClick={() => toggleTasks()}
        title="Tasks — what is running and what waits for you (Ctrl+Shift+Y)" aria-label={`Tasks: ${running} running, ${tasks.waiting} waiting for you`}>
        {running > 0 ? <span className="live-dot h-1.5 w-1.5" /> : <Icon name="activity" size={12} />}
        {running > 0 ? `${running} running` : 'Idle'}
        {tasks.waiting > 0 && <span className="text-aico-warning">· {tasks.waiting} need{tasks.waiting === 1 ? 's' : ''} you</span>}
      </button>
    </footer>
  );
}
