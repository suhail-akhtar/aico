/**
 * Scheduled — ChatGPT's "Ask ChatGPT to schedule tasks" page, for agent jobs.
 *
 * You describe the job in plain words; the agent turns it into a schedule with
 * its own scheduling tool (so the same job is visible from every client and
 * runs while AICO runs). Existing jobs can be paused, resumed or deleted, and
 * show what their last run actually did.
 *
 * @module desktop/renderer/pages/ScheduledPage
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '@web/store';
import { api } from '@web/api';
import { toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { newChat } from '@/chat/actions';

const RECOMMENDED = [
  { icon: 'sun', title: 'Morning project brief', text: 'Every weekday at 9am, summarise yesterday’s commits, open pull requests and failing CI for my projects.' },
  { icon: 'flask', title: 'Nightly test run', text: 'Every night at 2am, run the test suite in this project and tell me only if something fails, with the cause.' },
  { icon: 'shield', title: 'Weekly dependency audit', text: 'Every Monday, check this project for outdated or vulnerable dependencies and propose safe upgrades.' },
  { icon: 'globe', title: 'Site uptime check', text: 'Every hour, open my website in the built-in browser, check the home page and sign-in work, and alert me if not.' },
  { icon: 'book', title: 'Weekly learning digest', text: 'Every Friday, collect what I worked on this week across chats and write a short digest of lessons learned.' },
];

function describe(schedule: string): string {
  const m = schedule.trim().split(/\s+/);
  if (m.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = m;
  const t = hour !== '*' && min !== '*' ? `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}` : null;
  if (dom === '*' && mon === '*' && dow === '*' && t) return `Every day at ${t}`;
  if (dom === '*' && mon === '*' && dow === '1-5' && t) return `Weekdays at ${t}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (dom === '*' && mon === '*' && /^\d$/.test(dow!) && t) return `Every ${days[Number(dow)]} at ${t}`;
  if (hour === '*' && min !== '*' && dom === '*') return `Every hour at :${min!.padStart(2, '0')}`;
  if (min?.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
  return schedule;
}

export function ScheduledPage(): React.ReactElement {
  const system = useStore(s => s.system);
  const refreshSystem = useStore(s => s.refreshSystem);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<'active' | 'paused' | 'all'>('all');
  useEffect(() => { void refreshSystem(); const t = setInterval(() => void refreshSystem(), 10_000); return () => clearInterval(t); }, [refreshSystem]);
  const jobs = (system?.cron ?? []).filter(j => filter === 'all' || (filter === 'paused') === Boolean(j.paused));

  const schedule = (description: string): void => {
    if (!description.trim()) return;
    newChat({ prompt: `Schedule this as a recurring job (use the scheduling tool; confirm the schedule and what each run will do):\n\n${description.trim()}`, send: true });
    setText('');
  };
  const act = async (action: 'pause' | 'resume' | 'delete', id: string): Promise<void> => {
    if (action === 'delete' && !(await desktop.dialog.confirm({ title: 'Delete job', message: 'Delete this scheduled job?', ok: 'Delete', danger: true }))) return;
    try { await api.cronAction(action, id); await refreshSystem(); toast.success(action === 'delete' ? 'Job deleted' : action === 'pause' ? 'Job paused' : 'Job resumed'); }
    catch (e) { toast.error('Could not change the job', (e as Error).message); }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-16 pt-10">
        <div className="flex items-center">
          <h1 className="text-[28px] font-semibold tracking-tight">Scheduled</h1>
          <div className="flex-1" />
          <div className="segmented">
            {(['all', 'active', 'paused'] as const).map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f[0]!.toUpperCase() + f.slice(1)}</button>)}
          </div>
        </div>
        <p className="mt-2 text-[14px] text-aico-secondary">Ask AICO to run tasks on a schedule, remind you, or watch for changes. Jobs run on this computer while AICO is running.</p>
        <div className="composer-shell mt-6 flex items-center gap-2 rounded-[26px] border border-aico-border-subtle px-3 py-2">
          <Icon name="plus" size={18} className="text-aico-muted" />
          <input className="flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-aico-muted" placeholder="Schedule a task" value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') schedule(text); }} />
          <button className={cls('flex h-9 w-9 items-center justify-center rounded-full', text.trim() ? 'bg-aico-primary text-aico-bg' : 'bg-aico-hover text-aico-muted')} onClick={() => schedule(text)} disabled={!text.trim()} aria-label="Schedule">
            <Icon name="send" size={16} strokeWidth={2.2} />
          </button>
        </div>

        {jobs.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-2 text-[13px] font-medium text-aico-muted">Your jobs</h2>
            <div className="overflow-hidden rounded-2xl border border-aico-border-subtle">
              {jobs.map(j => (
                <div key={j.id} className="flex items-start gap-3 border-b border-aico-border-subtle px-4 py-3.5 last:border-b-0">
                  <Icon name="clock" size={18} className={cls('mt-0.5', j.paused ? 'text-aico-muted' : 'text-aico-accent')} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{describe(j.schedule)} {j.paused && <span className="badge ml-1 bg-aico-hover text-aico-muted">paused</span>}</div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] text-aico-secondary">{j.prompt ?? j.task}</div>
                    <div className="mt-1 text-[12px] text-aico-muted">
                      {j.nextRun && !j.paused ? `Next: ${new Date(j.nextRun).toLocaleString()}` : ''}{j.lastOutcome ? ` · Last run: ${j.lastOutcome}` : ''} · <span className="font-mono">{j.schedule}</span>
                    </div>
                  </div>
                  <button className="btn-ghost btn-sm" onClick={() => void act(j.paused ? 'resume' : 'pause', j.id)}><Icon name={j.paused ? 'play' : 'pause'} size={13} />{j.paused ? 'Resume' : 'Pause'}</button>
                  <button className="icon-btn-sm" onClick={() => void act('delete', j.id)} aria-label="Delete job"><Icon name="trash" size={14} /></button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-8">
          <h2 className="mb-1 flex items-center gap-1 text-[14px] font-medium text-aico-secondary">Recommended <Icon name="chevron-down" size={14} /></h2>
          <div className="divide-y divide-aico-border-subtle">
            {RECOMMENDED.map(r => (
              <div key={r.title} className="group flex items-center gap-4 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-aico-hover"><Icon name={r.icon} size={18} className="text-aico-accent" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-medium">{r.title}</div>
                  <div className="text-[13px] text-aico-muted">{r.text}</div>
                </div>
                <button className="icon-btn" onClick={() => setText(r.text)} title="Use this" aria-label={`Use ${r.title}`}><Icon name="plus" size={18} /></button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
