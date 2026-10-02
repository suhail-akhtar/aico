/**
 * The long-job proposal card, and the job it becomes (engine: longjob/).
 *
 * A plan estimated above the long-job threshold is not answered like a plan.
 * "Go ahead with that plan." is a chat message, and a chat message is exactly
 * what a model could produce for itself — so the plan card's buttons are
 * replaced by this one, whose Approve goes to `longjob/decide` as a person
 * (`postAsPerson`; in the desktop, main attaches its one-time grant). The
 * engine refuses the token alone.
 *
 * Shared by the web side panel and the desktop's attention stack: one
 * component, one place the proposal is read and answered. The job's state
 * comes from the engine's journal, not from the transcript — the decision is
 * not a message, so it cannot be derived from one.
 *
 * @module components/LongJobCard
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type LongJob } from '../api';
import { useStore } from '../store';

/** The newest long job of this session whose title matches the plan on the table. */
export function useLongJob(title: string | undefined, tick: unknown): [LongJob | undefined, () => void] {
  const sessionId = useStore(s => s.sessionId);
  const [job, setJob] = useState<LongJob | undefined>();
  const refresh = useCallback(() => {
    if (!title || !sessionId) { setJob(undefined); return; }
    api.longJobs(sessionId)
      .then(r => setJob(r.jobs.find(j => j.title === title)))
      .catch(() => { /* an older engine without long jobs: the ordinary plan card stands */ });
  }, [sessionId, title]);
  useEffect(() => { refresh(); }, [refresh, tick]);
  return [job, refresh];
}

const STATUS: Record<LongJob['status'], string> = {
  pending: 'Waiting for your approval',
  declined: 'Declined',
  superseded: 'Replaced by a newer proposal',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  stopped: 'Stopped',
  budget: 'Stopped at budget',
};

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;

export function LongJobCard({ job, onChange }: { job: LongJob; onChange: () => void }): React.ReactElement {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (run: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setSending(true); setError(null);
    try {
      const r = await run();
      if (!r.ok) setError(r.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      onChange();
    }
  };
  const done = job.milestones.filter(m => m.doneAt).length;
  const btn = 'rounded-lg px-2 py-1 text-[11px] transition-colors disabled:opacity-50';

  return (
    <div className="rounded-xl border border-aico-accent/40 bg-aico-bg p-3 text-[12px]" aria-label="Long job proposal">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-aico-primary">Long job: {job.title}</span>
        <span className="shrink-0 text-[11px] text-aico-muted">{STATUS[job.status]}</span>
      </div>
      <div className="mt-1 text-[11px] text-aico-secondary">
        Estimate {job.estimateHours}h{job.costUsd ? ` · ~$${job.costUsd}` : ''} · Budget cap ${job.budget.usd}, {job.budget.hours}h
        {job.status !== 'pending' && ` · ${done}/${job.milestones.length} milestones · $${job.spentUsd.toFixed(2)} spent · ${hours(job.activeMs)}`}
      </div>
      {job.note && job.status !== 'pending' && <div className="mt-1 text-[11px] text-aico-muted">{job.note}</div>}
      {job.status === 'pending' && (
        <>
          {job.missing.length > 0 && (
            <div className="mt-2 rounded-lg bg-aico-danger/10 px-2 py-1 text-[11px] text-aico-danger">
              Incomplete — cannot be approved yet. Missing: {job.missing.join('; ')}
            </div>
          )}
          <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Research and requirements</div>
          <p className="whitespace-pre-wrap text-aico-secondary">{job.research || '—'}</p>
          <div className="mt-2 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Design</div>
          <p className="whitespace-pre-wrap text-aico-secondary">{job.design || '—'}</p>
        </>
      )}
      <ol className="mt-2 max-h-56 space-y-1 overflow-y-auto">
        {job.milestones.map((m, i) => (
          <li key={i}>
            <span className={m.doneAt ? 'text-aico-success' : 'text-aico-primary'}>{m.doneAt ? '✓ ' : `${i + 1}. `}{m.title}</span>
            {m.acceptance.length > 0 && (
              <ul className="ml-4 text-[11px] text-aico-muted">
                {m.acceptance.map((a, k) => <li key={k}>— {a}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {error && <div className="mt-2 text-[11px] text-aico-danger">{error}</div>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {job.status === 'pending' && (
          <>
            <button className={`${btn} bg-aico-accent font-medium text-white hover:opacity-90`} disabled={sending || job.missing.length > 0}
              onClick={() => void act(() => api.decideLongJob(job.id, 'approve'))}>Approve and start</button>
            <button className={`${btn} text-aico-muted hover:bg-aico-danger/10 hover:text-aico-danger`} disabled={sending}
              onClick={() => void act(() => api.decideLongJob(job.id, 'decline'))}>Decline</button>
          </>
        )}
        {job.status === 'running' && (
          <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} disabled={sending}
            onClick={() => void act(() => api.controlLongJob(job.id, 'pause'))}>Pause</button>
        )}
        {job.status === 'paused' && (
          <button className={`${btn} bg-aico-accent font-medium text-white hover:opacity-90`} disabled={sending}
            onClick={() => void act(() => api.controlLongJob(job.id, 'resume'))}>Resume</button>
        )}
        {(job.status === 'running' || job.status === 'paused') && (
          <button className={`${btn} text-aico-muted hover:bg-aico-danger/10 hover:text-aico-danger`} disabled={sending}
            onClick={() => void act(() => api.controlLongJob(job.id, 'stop'))}>Stop</button>
        )}
      </div>
    </div>
  );
}
