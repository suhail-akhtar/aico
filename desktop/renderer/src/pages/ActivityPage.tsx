/**
 * Activity — everything running in the background, in one list.
 *
 * The engine's work ledger (sub-agents, background agents, scheduled firings,
 * backgrounded processes, app servers, watchers), the chats with a turn in
 * flight, terminals, and this window's own activity feed. Live, with Stop.
 *
 * @module desktop/renderer/pages/ActivityPage
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '@web/store';
import { api, type SentinelList, type WorkRow } from '@web/api';
import { invoke } from '@/desktop';
import { useDesk, toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { ago, cls, duration } from '@/lib/util';
import { openChat } from '@/chat/actions';

const KIND_ICON: Record<string, string> = { agent: 'user', run: 'play', process: 'terminal', watcher: 'eye', schedule: 'clock', remote: 'cloud' };
const SENTINEL_OUTCOME: Record<string, string> = {
  'no-objection': 'no objection', refused: 'refused', 'person-allowed': 'flagged, you allowed it', 'person-refused': 'flagged, you refused it',
  parked: 'flagged, parked in the inbox', 'refused-unattended': 'flagged, nobody to ask — not run',
};
const STATE_TONE: Record<string, string> = { running: 'text-aico-accent', queued: 'text-aico-warning', blocked: 'text-aico-warning', done: 'text-aico-success', failed: 'text-aico-danger', cancelled: 'text-aico-muted', lost: 'text-aico-danger' };

export function ActivityPage(): React.ReactElement {
  const system = useStore(s => s.system);
  const refreshSystem = useStore(s => s.refreshSystem);
  const sessions = useStore(s => s.sessions);
  const refreshSessions = useStore(s => s.refreshSessions);
  const feed = useDesk(s => s.activity);
  const clear = useDesk(s => s.clearFinishedActivity);
  const [terms, setTerms] = useState<Array<{ id: string; title: string; cwd: string; exited: boolean }>>([]);
  const [sentinel, setSentinel] = useState<SentinelList | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const load = (): void => {
      void refreshSystem(); void refreshSessions(); void invoke<typeof terms>('term:list').then(setTerms).catch(() => {});
      // The safety reviewer's audit file (engine sentinel/). An older engine has no route: the section stays empty.
      void api.sentinel(20).then(setSentinel).catch(() => {});
      tick(t => t + 1);
    };
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [refreshSystem, refreshSessions]);

  const work: WorkRow[] = system?.work ?? [];
  const live = work.filter(w => ['running', 'queued', 'blocked'].includes(w.state));
  const settled = work.filter(w => !['running', 'queued', 'blocked'].includes(w.state)).slice(0, 30);
  const running = sessions.filter(s => s.running);

  const stop = async (w: WorkRow): Promise<void> => {
    try { await api.stopWork(w.id, 'Stopped from the Activity monitor'); toast.info('Stopping', w.title); void refreshSystem(); }
    catch (e) { toast.error('Could not stop it', (e as Error).message); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 pb-16 pt-8">
        <div className="flex items-center">
          <h1 className="text-[26px] font-semibold tracking-tight">Activity</h1>
          <div className="flex-1" />
          <span className="flex items-center gap-2 text-[12.5px] text-aico-muted"><span className="live-dot" />Live</span>
        </div>
        <div className="mt-5 grid grid-cols-4 gap-3">
          {[['Chats running', running.length], ['Background work', live.length], ['Terminals', terms.filter(t => !t.exited).length], ['Scheduled jobs', (system?.cron ?? []).filter(c => !c.paused).length]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-aico-border-subtle px-4 py-3">
              <div className="text-[12px] text-aico-muted">{k}</div>
              <div className="text-[22px] font-semibold tabular-nums">{v}</div>
            </div>
          ))}
        </div>

        <Section title="Chats with a turn in flight" empty="No chat is running.">
          {running.map(s => (
            <Row key={s.id} icon="chat" title={s.title || 'New chat'} sub={`updated ${ago(s.updatedAt)} ago`} tone="text-aico-accent" spinning
              action={<button className="btn-ghost btn-sm" onClick={() => void openChat(s.id)}>Open</button>} />
          ))}
        </Section>

        <Section title="Background work" empty="Nothing is running in the background.">
          {live.map(w => (
            <Row key={w.id} icon={KIND_ICON[w.kind] ?? 'activity'} title={w.title} tone={STATE_TONE[w.state]} spinning={w.state === 'running'}
              sub={`${w.kind} · ${w.state} · ${duration(Date.now() - w.startedAt)}${w.lastTool ? ` · ${w.lastTool}` : ''}${w.steps ? ` · ${w.steps} steps` : ''}${w.costUsd ? ` · $${w.costUsd.toFixed(3)}` : ''}${w.note ? ` · ${w.note}` : ''}`}
              action={<button className="btn-danger btn-sm" onClick={() => void stop(w)}><Icon name="stop" size={12} />Stop</button>} />
          ))}
        </Section>

        <Section
          title={`Sentinel — safety reviews${sentinel?.totals.reviews ? ` · ${sentinel.totals.reviews} reviewed, ${sentinel.totals.denied} refused, ${sentinel.totals.escalated} to a person · $${sentinel.totals.costUsd.toFixed(4)}` : ''}`}
          empty="No high-risk call has been reviewed yet.">
          {(sentinel?.verdicts ?? []).map(v => (
            <Row key={`${v.at}-${v.tool}-${v.call.length}`} icon="shield" title={`${v.tool} — ${SENTINEL_OUTCOME[v.outcome] ?? v.outcome}`}
              tone={v.verdict === 'deny' ? 'text-aico-danger' : v.verdict === 'escalate' ? 'text-aico-warning' : 'text-aico-success'}
              sub={`${ago(v.at)} ago · ${v.effect} · ${v.reason}${v.agentName ? ` · ${v.agentName}` : ''}${v.level ? ` · ${v.level}` : ''} · ${v.model} · $${v.costUsd.toFixed(4)} · ${(v.ms / 1000).toFixed(1)} s`} />
          ))}
        </Section>

        <Section title="Terminals" empty="No terminals open.">
          {terms.map(t => (
            <Row key={t.id} icon="terminal" title={t.title} sub={t.cwd} tone={t.exited ? 'text-aico-muted' : 'text-aico-success'}
              action={<button className="btn-ghost btn-sm" onClick={() => useDesk.getState().setPanel({ open: true, tab: 'terminal' })}>Show</button>} />
          ))}
        </Section>

        <Section title="Recently finished" empty="Nothing finished recently." action={feed.length ? <button className="btn-ghost btn-sm" onClick={clear}>Clear</button> : undefined}>
          {settled.map(w => (
            <Row key={w.id} icon={KIND_ICON[w.kind] ?? 'activity'} title={w.title} tone={STATE_TONE[w.state]}
              sub={`${w.kind} · ${w.state}${w.endedAt ? ` ${ago(w.endedAt)} ago` : ''}${w.outcome ? ` · ${w.outcome}` : ''}`} />
          ))}
          {feed.filter(a => a.status !== 'running').slice(0, 30).map(a => (
            <Row key={a.id + a.startedAt} icon={a.kind === 'turn' ? 'chat' : 'activity'} title={a.title} tone={a.status === 'failed' ? 'text-aico-danger' : 'text-aico-success'}
              sub={`${a.status}${a.endedAt ? ` ${ago(a.endedAt)} ago · took ${duration(a.endedAt - a.startedAt)}` : ''}`}
              action={a.route ? <button className="btn-ghost btn-sm" onClick={() => useDesk.getState().navigate(a.route!)}>Open</button> : undefined} />
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, empty, children, action }: { title: string; empty: string; children: React.ReactNode; action?: React.ReactNode }): React.ReactElement {
  const has = React.Children.toArray(children).some(Boolean) && React.Children.toArray(children).length > 0;
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center"><h2 className="flex-1 text-[13px] font-medium text-aico-muted">{title}</h2>{action}</div>
      <div className="overflow-hidden rounded-xl border border-aico-border-subtle">
        {has ? children : <div className="px-4 py-5 text-center text-[13px] text-aico-muted">{empty}</div>}
      </div>
    </section>
  );
}

function Row({ icon, title, sub, tone, spinning, action }: { icon: string; title: string; sub?: string; tone?: string; spinning?: boolean; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 border-b border-aico-border-subtle px-4 py-2.5 last:border-b-0">
      {spinning ? <span className="spinner h-4 w-4" /> : <Icon name={icon} size={16} className={cls(tone ?? 'text-aico-muted')} />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px]">{title}</div>
        {sub && <div className="truncate text-[12px] text-aico-muted">{sub}</div>}
      </div>
      {action}
    </div>
  );
}
