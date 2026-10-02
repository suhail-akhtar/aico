/**
 * Everything that needs you, pinned just above the composer: a permission to
 * grant, a question to answer, a plan to approve, a secret moved out of your
 * message into the vault — plus the running task list
 * and delegated sub-agents, so a long turn is legible at a glance.
 *
 * When the window is not in front, the same moments raise a native
 * notification (see notifications.ts).
 *
 * @module desktop/renderer/chat/Attention
 */

import React, { useMemo, useState } from 'react';
import { useStore, type PlanAnswer } from '@web/store';
import { planFrom } from '@web/plans';
import { LongJobCard, useLongJob } from '@web/components/LongJobCard';
import { todosFrom } from '@web/todos';
import { Icon } from '@/lib/icons';
import { cls, duration } from '@/lib/util';
import { useTranscript } from './Transcript';
import { VaultNotice } from '@web/components/VaultPrompts';

export function Attention(): React.ReactElement | null {
  return (
    <div className="mx-auto mb-2 w-full max-w-column space-y-2 empty:hidden">
      <Permission />
      {/* A secret caught in your message and moved into the vault. (Credential
          requests and approvals are main's own secure windows in the desktop.) */}
      <VaultNotice />
      <Question />
      <PlanApproval />
      <Progress />
      <Banners />
    </div>
  );
}

function Permission(): React.ReactElement | null {
  const permission = useStore(s => s.permission);
  const permit = useStore(s => s.permit);
  const [busy, setBusy] = useState(false);
  if (!permission) return null;
  const diff = permission.fileDiff;
  const act = async (allow: boolean): Promise<void> => { setBusy(true); try { await permit(allow); } finally { setBusy(false); } };
  return (
    <div className="rounded-2xl border border-aico-warning/40 bg-aico-bg p-4 shadow-[var(--desk-shadow)] animate-pop-in" role="alertdialog" aria-label="Permission request">
      <div className="flex items-start gap-3">
        <Icon name="shield" size={18} className="mt-0.5 text-aico-warning" />
        <div className="min-w-0 flex-1">
          {/* Workspace trust rides the same card; its detail lists exactly what would run. */}
          <div className="text-[14px] font-medium">{permission.tool === 'TrustProjectSettings'
            ? <>Trust this project&apos;s settings?</>
            : <>Allow <span className="font-mono">{permission.tool}</span>?</>}</div>
          <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-aico-secondary selectable">{permission.detail}</div>
          {diff && (
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-aico-border-subtle bg-aico-code font-mono text-[12px]">
              <div className="border-b border-aico-border-subtle px-3 py-1.5 text-aico-muted">{diff.path}</div>
              {diff.preview && <pre className="whitespace-pre-wrap px-3 py-2">{diff.preview}</pre>}
              {diff.removed?.map((l, i) => <div key={`r${i}`} className="diff-remove px-3"><span className="diff-gutter">−</span>{l}</div>)}
              {diff.added?.map((l, i) => <div key={`a${i}`} className="diff-add px-3"><span className="diff-gutter">+</span>{l}</div>)}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-outline" onClick={() => void act(false)} disabled={busy}>Deny</button>
        <button className="btn-primary" onClick={() => void act(true)} disabled={busy} autoFocus>Allow</button>
      </div>
    </div>
  );
}

function Question(): React.ReactElement | null {
  const question = useStore(s => s.question);
  const answer = useStore(s => s.answer);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  if (!question) return null;
  // "(a) … (b) …" or lines starting with "- " become buttons.
  const options = [...question.matchAll(/^\s*(?:[-*]|\(?[a-e1-9][).])\s+(.{2,120})$/gm)].map(m => m[1]!.trim()).slice(0, 6);
  const send = async (text: string): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    try { await answer(text.trim()); setValue(''); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-2xl border border-aico-accent/40 bg-aico-bg p-4 shadow-[var(--desk-shadow)] animate-pop-in" role="alertdialog" aria-label="The agent is asking">
      <div className="flex items-start gap-3">
        <Icon name="help" size={18} className="mt-0.5 text-aico-accent" />
        <div className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] selectable">{question}</div>
      </div>
      {options.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map(o => <button key={o} className="chip" onClick={() => void send(o)} disabled={busy}>{o}</button>)}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <input className="input flex-1" placeholder="Your answer" value={value} onChange={e => setValue(e.target.value)} autoFocus
          onKeyDown={e => { if (e.key === 'Enter') void send(value); }} />
        <button className="btn-primary" onClick={() => void send(value)} disabled={busy || !value.trim()}>Answer</button>
      </div>
    </div>
  );
}

function PlanApproval(): React.ReactElement | null {
  const { messages } = useTranscript();
  const answerPlan = useStore(s => s.answerPlan);
  const amendPlan = useStore(s => s.amendPlan);
  const busy = useStore(s => s.busy);
  const [sending, setSending] = useState(false);
  const { plan, decision } = useMemo(() => planFrom(messages), [messages]);
  // A plan over the long-job threshold is answered on its own card, as a person (engine: longjob/).
  const [longJob, refreshLongJob] = useLongJob(plan?.title, `${messages.length}:${busy}`);
  if (plan && longJob && ['pending', 'running', 'paused'].includes(longJob.status)) return <LongJobCard job={longJob} onChange={refreshLongJob} />;
  if (!plan || decision !== undefined) return null;
  const act = async (d: PlanAnswer): Promise<void> => { setSending(true); try { await answerPlan(d); } finally { setSending(false); } };
  return (
    <div className="rounded-2xl border border-aico-accent/40 bg-aico-bg p-4 shadow-[var(--desk-shadow)] animate-pop-in" aria-label="Plan to approve">
      <div className="flex items-center gap-2 text-[14px] font-medium"><Icon name="list" size={16} className="text-aico-accent" /> {plan.title}</div>
      {plan.openQuestions.length > 0 && (
        <div className="mt-2 rounded-lg bg-aico-surface px-3 py-2 text-[12.5px] text-aico-secondary">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-aico-muted">Assumed — worth correcting first</div>
          {plan.openQuestions.map((q, i) => <div key={i}>— {q}</div>)}
        </div>
      )}
      <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[13px]">
        {plan.steps.map((s, i) => (
          <li key={i} className="flex gap-2"><span className="w-4 shrink-0 text-right tabular-nums text-aico-muted">{i + 1}</span>
            <span className="min-w-0"><span className="text-aico-primary">{s.title}</span>{s.detail && <span className="block text-[12px] text-aico-muted">{s.detail}</span>}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => amendPlan()} disabled={sending || busy}>Change it…</button>
        <button className="btn-outline" onClick={() => void act('declined')} disabled={sending || busy}>Decline</button>
        <button className="btn-outline" onClick={() => void act('deferred')} disabled={sending || busy}>Later</button>
        <button className="btn-primary" onClick={() => void act('approved')} disabled={sending || busy}>Approve and start</button>
      </div>
    </div>
  );
}

function Progress(): React.ReactElement | null {
  const { messages } = useTranscript();
  const subAgents = useStore(s => s.subAgents);
  const busy = useStore(s => s.busy);
  const [open, setOpen] = useState(false);
  const todos = useMemo(() => todosFrom(messages), [messages]);
  const running = subAgents.filter(a => (a as { status?: string }).status === 'running');
  if ((!busy || todos.total === 0 || todos.allSettled) && running.length === 0) return null;
  const current = todos.todos.find(t => t.status === 'in_progress');
  return (
    <div className="rounded-2xl border border-aico-border-subtle bg-aico-bg px-4 py-2.5">
      <button className="flex w-full items-center gap-3 text-left text-[13px]" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {todos.total > 0 && (
          <>
            <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-aico-hover">
              <span className="absolute inset-y-0 left-0 rounded-full bg-aico-accent transition-all" style={{ width: `${(todos.closed / Math.max(1, todos.total)) * 100}%` }} />
            </span>
            <span className="tabular-nums text-aico-secondary">{todos.done}/{todos.total} tasks</span>
            {current && <span className="min-w-0 flex-1 truncate text-aico-muted">· {current.title}</span>}
          </>
        )}
        {running.length > 0 && <span className="ml-auto flex items-center gap-1.5 text-aico-muted"><span className="live-dot" />{running.length} sub-agent{running.length === 1 ? '' : 's'}</span>}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="text-aico-muted" />
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-t border-aico-border-subtle pt-2 text-[12.5px]">
          {todos.todos.map(t => (
            <div key={t.id} className="flex items-center gap-2">
              <Icon name={t.status === 'done' ? 'check-circle' : t.status === 'in_progress' ? 'dot' : t.status === 'cancelled' ? 'x-circle' : 'minus'} size={13}
                className={cls(t.status === 'done' ? 'text-aico-success' : t.status === 'in_progress' ? 'text-aico-accent' : 'text-aico-muted')} />
              <span className={cls(t.status === 'done' && 'text-aico-muted line-through', t.status === 'cancelled' && 'text-aico-muted')}>{t.title}</span>
            </div>
          ))}
          {subAgents.map((a, i) => {
            const x = a as { id?: string; description?: string; name?: string; status?: string; startedAt?: number; endedAt?: number };
            return (
              <div key={x.id ?? i} className="flex items-center gap-2 text-aico-secondary">
                {x.status === 'running' ? <span className="spinner h-3 w-3" /> : <Icon name="check" size={13} className="text-aico-success" />}
                <span className="truncate">{x.description ?? x.name ?? 'Sub-agent'}</span>
                {x.startedAt && <span className="ml-auto text-aico-muted">{duration((x.endedAt ?? Date.now()) - x.startedAt)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Banners(): React.ReactElement | null {
  const error = useStore(s => s.error);
  const clearError = useStore(s => s.clearError);
  const notice = useStore(s => s.notice);
  const clearNotice = useStore(s => s.clearNotice);
  const status = useStore(s => s.status);
  if (!error && !notice && status !== 'lost') return null;
  return (
    <>
      {status === 'lost' && (
        <div className="flex items-center gap-2 rounded-xl border border-aico-warning/30 bg-aico-warning/10 px-4 py-2 text-[13px] text-aico-warning">
          <span className="spinner h-3.5 w-3.5" /> Reconnecting to the engine — the run keeps going; nothing is lost.
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-aico-danger/30 bg-aico-danger/10 px-4 py-2 text-[13px] text-aico-danger" role="alert">
          <Icon name="alert" size={15} className="mt-0.5" /><span className="min-w-0 flex-1 whitespace-pre-wrap selectable">{error}</span>
          <button className="icon-btn-sm" onClick={clearError} aria-label="Dismiss"><Icon name="x" size={13} /></button>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-aico-border-subtle bg-aico-surface px-4 py-2 text-[13px] text-aico-secondary">
          <Icon name="info" size={15} className="mt-0.5" /><span className="min-w-0 flex-1 whitespace-pre-wrap">{notice}</span>
          <button className="icon-btn-sm" onClick={clearNotice} aria-label="Dismiss"><Icon name="x" size={13} /></button>
        </div>
      )}
    </>
  );
}
