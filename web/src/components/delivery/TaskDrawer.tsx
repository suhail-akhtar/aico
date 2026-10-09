/**
 * The task drawer: everything a person needs to decide about one task, and the
 * two decisions.
 *
 * Four tabs because the questions come in an order — what was asked (Overview),
 * what changed (Changes: the diff), why it should be trusted (Evidence: the
 * agent's report, rendered as markdown), and what was said about it
 * (Discussion). The decision bar is NOT in a tab: for a task in Review,
 * "Approve and land" and "Request changes" stay at the foot whatever you are
 * reading, because the point of reading is to reach them.
 *
 * Landing is a person's act: the call goes through `api.deliveryApprove`
 * (sent as a person), and for a high-risk change the button asks twice. Errors
 * stay in the drawer, beside the thing that failed, never in a toast that
 * vanishes while the reason is still being read.
 *
 * A task whose run waits for a person shows that at the top, above the tabs and
 * outside the scrolling panel, so it is in front of the reader whichever tab is
 * open and does not scroll away. "Open the agent's chat" is in the header and
 * opens the task's real chat (`sessionOf`), for finished tasks too.
 *
 * On a phone the drawer is a full-screen sheet (the board's own header would otherwise
 * eat a third of it); from `sm` up it overlays the board's right edge.
 *
 * Editing is allowed only while the task is Backlog or Ready — once an agent
 * has a branch, changing the brief under it would be a lie about what it did.
 *
 * @module web/components/delivery/TaskDrawer
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../../../../shared/ui/MarkdownRenderer';
import { api } from '../../api';
import { upsertTask } from '../../delivery';
import type { Priority, Task } from '../../delivery-types';
import { PRIORITY_LABEL, STATUS_LABEL, ago, elapsed, formatUsd, sessionOf, toMs, unmetDeps } from '../../delivery-model';
import { DiffViewer } from './DiffViewer';
import { DvIcon } from './icons';
import { NeedsYou } from './NeedsYou';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, INPUT, LABEL, PriorityChip, RiskBadge, Skeleton, Tabs, panelId, tabId, useTaskRef } from './ui';
import type { DeliveryHost } from './DeliveryView';

type Tab = 'overview' | 'changes' | 'evidence' | 'discussion';

export function TaskDrawer({ task, tasks, project, host, now, runStartedAt, onClose, onOpenTask, onLanded, onHandled }: {
  task: Task;
  tasks: readonly Task[];
  project: string;
  host: DeliveryHost;
  now: number;
  runStartedAt?: string | number | undefined;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  /** After a landing: the review queue advances to the next task. */
  onLanded: (id: string) => void;
  /** A "Needs you" answer went through. */
  onHandled: (message: string) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const [tab, setTab] = useState<Tab>('overview');
  const root = useRef<HTMLElement>(null);
  const byId = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const reviewing = task.status === 'review';
  const fileCount = task.touches?.files.length ?? 0;
  const sessionId = sessionOf(task);

  // A different task starts on the tab that answers its likely question.
  useEffect(() => { setTab(task.status === 'review' ? 'changes' : 'overview'); }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, [task.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && root.current?.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { el.blur(); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: Array<{ id: Tab; label: string; badge?: string | undefined }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'changes', label: 'Changes', badge: fileCount ? String(fileCount) : undefined },
    { id: 'evidence', label: 'Evidence' },
    { id: 'discussion', label: 'Discussion', badge: task.review?.comments.length ? String(task.review.comments.length) : undefined },
  ];
  const prefix = 'dv-drawer';

  return (
    <aside
      ref={root}
      tabIndex={-1}
      aria-label={`Task ${ref(task.id)}: ${task.title}`}
      className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[640px] flex-col border-l border-aico-border bg-aico-bg shadow-[-12px_0_32px_rgba(0,0,0,0.12)] outline-none max-sm:fixed max-sm:inset-0 max-sm:z-[60] max-sm:max-w-none max-sm:border-l-0"
    >
      <header className="shrink-0 border-b border-aico-border-subtle px-5 pb-0 pt-4">
        <div className="flex items-center gap-2 text-[12px] text-aico-muted">
          <span className="font-mono tabular-nums">{ref(task.id)}</span>
          <span className="rounded-full bg-aico-hover px-2 py-0.5 text-[11px] font-medium text-aico-primary">{STATUS_LABEL[task.status]}</span>
          <PriorityChip priority={task.priority} />
          {task.status === 'running' && runStartedAt ? <span className="tabular-nums">{elapsed(runStartedAt, now)}</span> : null}
          {task.costUsd ? <span className="tabular-nums">{formatUsd(task.costUsd)}</span> : null}
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close details" className="rounded-md p-1 text-aico-muted hover:bg-aico-hover hover:text-aico-primary">
            <DvIcon name="close" size={16} />
          </button>
        </div>
        <h2 className="mt-1.5 text-[17px] font-semibold leading-snug text-aico-primary">{task.title}</h2>
        {(task.branch || sessionId) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-aico-muted">
            {task.branch && (
              <p className="flex min-w-0 items-center gap-1.5">
                <DvIcon name="branch" size={13} className="shrink-0" /><span className="truncate font-mono" title={task.worktree ?? task.branch}>{task.branch}</span>
              </p>
            )}
            {sessionId && (
              <button
                type="button" onClick={() => host.openSession(sessionId)} title="Open the agent's chat"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-aico-accent transition-colors hover:bg-aico-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
              >
                <DvIcon name="chat" size={13} />Open the agent&rsquo;s chat
              </button>
            )}
          </div>
        )}
        <Tabs label="Task sections" prefix={prefix} value={tab} onChange={setTab} items={tabs} variant="underline" className="-mb-px mt-3" />
      </header>

      {task.needs && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-aico-border-subtle px-5 py-3">
          <NeedsYou task={task} variant="drawer" now={now} onHandled={onHandled} onOpenSession={host.openSession} />
        </div>
      )}

      <div role="tabpanel" id={panelId(prefix)} aria-labelledby={tabId(prefix, tab)} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'overview' && <Overview task={task} byId={byId} project={project} host={host} onOpenTask={onOpenTask} />}
        {tab === 'changes' && <Changes task={task} project={project} host={host} />}
        {tab === 'evidence' && <Evidence task={task} />}
        {tab === 'discussion' && <Discussion task={task} now={now} />}
      </div>

      {reviewing && <DecisionBar task={task} project={project} onLanded={onLanded} />}
    </aside>
  );
}

// ── Overview ──────────────────────────────────────────────────────────

function Overview({ task, byId, project, host, onOpenTask }: {
  task: Task; byId: ReadonlyMap<string, Task>; project: string; host: DeliveryHost; onOpenTask: (id: string) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const editable = task.status === 'backlog' || task.status === 'ready';
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body);
  const [acceptance, setAcceptance] = useState(task.acceptance);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = editable && (title !== task.title || body !== task.body || priority !== task.priority
    || JSON.stringify(acceptance) !== JSON.stringify(task.acceptance));
  // Follow the server while nothing is being edited; never overwrite a draft.
  useEffect(() => {
    if (dirty) return;
    setTitle(task.title); setBody(task.body); setAcceptance(task.acceptance); setPriority(task.priority);
  }, [task.id, task.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (): Promise<void> => {
    if (!title.trim()) { setError('A task needs a title.'); return; }
    setSaving(true); setError(null);
    try {
      upsertTask(await api.deliveryUpdate(task.id, project, {
        title: title.trim(), body, priority, acceptance: acceptance.map(a => a.trim()).filter(Boolean),
      }));
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  const unmet = unmetDeps(task, byId);
  const risk = task.risk;

  return (
    <div className="space-y-5">
      {task.status === 'review' && risk && (
        <section aria-label="Risk">
          <div className="flex items-center gap-2"><RiskBadge level={risk.level} score={risk.score} /><span className="text-[12px] text-aico-muted">score {risk.score}</span></div>
          {risk.reasons.length > 0 && (
            <ul className="mt-2 space-y-1 text-[13px] text-aico-secondary">
              {risk.reasons.map((r, i) => <li key={i} className="flex gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-aico-muted" />{r}</li>)}
            </ul>
          )}
        </section>
      )}

      {editable && (
        <div>
          <label className={LABEL} htmlFor="dv-title">Title</label>
          <input id="dv-title" className={INPUT} value={title} onChange={e => setTitle(e.target.value)} />
        </div>
      )}

      <div>
        <label className={LABEL} htmlFor="dv-body">Details</label>
        {editable ? (
          <textarea id="dv-body" rows={5} className={`${INPUT} resize-y leading-relaxed`} value={body} onChange={e => setBody(e.target.value)} placeholder="What should be built or fixed, and any context the agent will need." />
        ) : task.body ? (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-aico-primary">{task.body}</p>
        ) : <p className="text-[13px] text-aico-muted">No details were written for this task.</p>}
      </div>

      <div>
        <span className={LABEL}>Acceptance criteria</span>
        {editable ? (
          <AcceptanceEditor items={acceptance} onChange={setAcceptance} />
        ) : task.acceptance.length ? (
          <ul className="space-y-1.5">
            {task.acceptance.map((a, i) => (
              <li key={i} className="flex gap-2 text-[13.5px] text-aico-primary">
                <DvIcon name="check" size={15} className={`mt-0.5 shrink-0 ${task.status === 'merged' ? 'text-aico-success' : 'text-aico-muted'}`} />{a}
              </li>
            ))}
          </ul>
        ) : <p className="text-[13px] text-aico-muted">None were written. The agent worked from the details alone.</p>}
      </div>

      {editable && (
        <div className="max-w-[200px]">
          <label className={LABEL} htmlFor="dv-priority">Priority</label>
          <select id="dv-priority" className={INPUT} value={priority} onChange={e => setPriority(Number(e.target.value) as Priority)}>
            {([1, 2, 3, 4] as Priority[]).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
      )}

      {editable && (dirty || error) && (
        <div className="space-y-2">
          {error && <ErrorLine>{error}</ErrorLine>}
          {dirty && (
            <div className="flex gap-2">
              <button type="button" className={BTN_PRIMARY} disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button>
              <button type="button" className={BTN_GHOST} disabled={saving} onClick={() => { setTitle(task.title); setBody(task.body); setAcceptance(task.acceptance); setPriority(task.priority); setError(null); }}>Discard</button>
            </div>
          )}
        </div>
      )}

      {task.dependsOn.length > 0 && (
        <section aria-label="Dependencies">
          <span className={LABEL}>Depends on</span>
          <ul className="space-y-1">
            {task.dependsOn.map(id => {
              const d = byId.get(id);
              const done = d?.status === 'merged';
              return (
                <li key={id}>
                  <button type="button" onClick={() => d && onOpenTask(id)} disabled={!d} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-aico-hover disabled:cursor-default disabled:hover:bg-transparent">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${done ? 'bg-aico-success' : 'bg-aico-warning'}`} aria-hidden="true" />
                    <span className="font-mono text-[12px] text-aico-muted">{ref(id)}</span>
                    <span className="min-w-0 flex-1 truncate text-aico-primary">{d?.title ?? 'Unknown task'}</span>
                    <span className="shrink-0 text-[11px] text-aico-muted">{done ? 'merged' : d ? STATUS_LABEL[d.status].toLowerCase() : 'missing'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {unmet.length > 0 && <p className="mt-1 text-[12px] text-aico-muted">An agent will not start this until these are merged.</p>}
        </section>
      )}

      {(task.touches?.files.length ?? 0) > 0 && (
        <section aria-label="Touched files">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[12px] font-medium text-aico-secondary">{task.touches!.predicted ? 'Files it is expected to touch' : 'Files it touched'}</span>
            {task.touches!.predicted && <span className="rounded bg-aico-hover px-1.5 text-[11px] text-aico-muted" title="A prediction from the code map, before any agent has run">predicted</span>}
          </div>
          <ul className="overflow-hidden rounded-lg border border-aico-border-subtle">
            {task.touches!.files.slice(0, 40).map(f => (
              <li key={f} className="flex items-center gap-2 border-b border-aico-border-subtle px-2.5 py-1 text-[12px] last:border-b-0">
                <DvIcon name="file" size={13} className="shrink-0 text-aico-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-aico-primary" title={f}>{f}</span>
                <button type="button" onClick={() => host.openCodeMap(f)} className="shrink-0 rounded px-1.5 py-0.5 text-aico-accent hover:bg-aico-accent-soft" title="Focus this file in the Code map: who uses it and what it uses">
                  Code map
                </button>
              </li>
            ))}
          </ul>
          {task.touches!.files.length > 40 && <p className="mt-1 text-[12px] text-aico-muted">and {task.touches!.files.length - 40} more</p>}
          {task.touches!.symbols.length > 0 && <p className="mt-1.5 text-[12px] text-aico-muted">Symbols: <span className="font-mono">{task.touches!.symbols.slice(0, 8).join(', ')}{task.touches!.symbols.length > 8 ? ' …' : ''}</span></p>}
        </section>
      )}

      {task.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">{task.labels.map(l => <span key={l} className="rounded-md bg-aico-hover px-1.5 py-0.5 text-[12px] text-aico-secondary">{l}</span>)}</div>
      )}
    </div>
  );
}

function AcceptanceEditor({ items, onChange }: { items: string[]; onChange: (v: string[]) => void }): React.ReactElement {
  return (
    <div className="space-y-1.5">
      {items.map((a, i) => (
        <div key={i} className="flex gap-1.5">
          <input aria-label={`Criterion ${i + 1}`} className={INPUT} value={a} onChange={e => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
          <button type="button" aria-label={`Remove criterion ${i + 1}`} className={`${BTN_GHOST} !px-2`} onClick={() => onChange(items.filter((_, j) => j !== i))}><DvIcon name="close" size={14} /></button>
        </div>
      ))}
      <button type="button" className={`${BTN_GHOST} !px-2 !py-1 !text-[12px]`} onClick={() => onChange([...items, ''])}><DvIcon name="plus" size={13} />Add a criterion</button>
    </div>
  );
}

// ── Changes ───────────────────────────────────────────────────────────

function Changes({ task, project, host }: { task: Task; project: string; host: DeliveryHost }): React.ReactElement {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const has = Boolean(task.branch) || ['review', 'changes', 'merged', 'running'].includes(task.status);

  useEffect(() => {
    if (!has) return;
    let live = true;
    setDiff(null); setError(null);
    api.deliveryDiff(task.id, project)
      .then(r => { if (live) setDiff(r.diff ?? ''); })
      .catch(e => { if (live) setError((e as Error).message); });
    return () => { live = false; };
    // Reloaded when the task is re-submitted for review (updatedAt moves), not on every board frame.
  }, [task.id, task.updatedAt, task.status, project, tries, has]);

  if (!has) return <p className="text-[13px] text-aico-secondary">There is no branch yet. Changes appear here once an agent starts on this task.</p>;
  if (error) {
    return (
      <div className="space-y-2">
        <ErrorLine>Could not load the diff: {error}</ErrorLine>
        <button type="button" className={BTN_OUTLINE} onClick={() => setTries(n => n + 1)}><DvIcon name="refresh" size={14} />Try again</button>
      </div>
    );
  }
  if (diff === null) return <div className="space-y-2"><Skeleton className="h-8" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>;
  return <DiffViewer diff={diff} onOpenFile={host.openCodeMap} />;
}

// ── Evidence ──────────────────────────────────────────────────────────

function Evidence({ task }: { task: Task }): React.ReactElement {
  if (!task.evidence?.md) {
    return (
      <div className="rounded-lg border border-dashed border-aico-border px-4 py-5 text-[13px] text-aico-secondary">
        <p className="font-medium text-aico-primary">No evidence report yet.</p>
        <p className="mt-1">When an agent finishes, it attaches what it ran and what happened: tests, checks and notes. That report appears here, and its one-line summary appears on the card.</p>
      </div>
    );
  }
  return (
    <div>
      {task.evidence.summary && <p className="mb-3 rounded-lg bg-aico-surface px-3 py-2 text-[13px] text-aico-primary">{task.evidence.summary}</p>}
      <div className="markdown-body text-[14px]"><MarkdownRenderer content={task.evidence.md} /></div>
    </div>
  );
}

// ── Discussion ────────────────────────────────────────────────────────

function Discussion({ task, now }: { task: Task; now: number }): React.ReactElement {
  const comments = task.review?.comments ?? [];
  return (
    <div className="space-y-3">
      {comments.length === 0 ? (
        <p className="text-[13px] text-aico-secondary">Nothing has been said yet. When you request changes, your note goes to the agent and stays here with its reply.</p>
      ) : (
        <ol className="space-y-2.5">
          {comments.map((c, i) => (
            <li key={i} className={`rounded-xl px-3 py-2 ${c.by === 'person' ? 'bg-aico-accent-soft' : 'bg-aico-surface'}`}>
              <p className="mb-0.5 text-[11.5px] text-aico-muted"><span className="font-medium text-aico-secondary">{c.by === 'person' ? 'You' : 'Agent'}</span>{toMs(c.at) ? ` · ${ago(c.at, now)}` : ''}</p>
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-aico-primary">{c.text}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Decision ──────────────────────────────────────────────────────────

function DecisionBar({ task, project, onLanded }: { task: Task; project: string; onLanded: (id: string) => void }): React.ReactElement {
  const [mode, setMode] = useState<'idle' | 'confirm' | 'changes'>('idle');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'land' | 'changes' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const high = task.risk?.level === 'high';

  useEffect(() => { setMode('idle'); setComment(''); setError(null); setBusy(null); }, [task.id]);
  useEffect(() => {
    if (mode !== 'confirm') return;
    const t = setTimeout(() => setMode('idle'), 5000);
    return () => clearTimeout(t);
  }, [mode]);

  const land = async (): Promise<void> => {
    if (high && mode !== 'confirm') { setMode('confirm'); return; }
    setBusy('land'); setError(null);
    try { upsertTask(await api.deliveryApprove(task.id, project)); setMode('idle'); onLanded(task.id); }
    catch (e) { setError((e as Error).message); setMode('idle'); }
    finally { setBusy(null); }
  };
  const send = async (): Promise<void> => {
    const text = comment.trim();
    if (!text) return;
    setBusy('changes'); setError(null);
    try { upsertTask(await api.deliveryRequestChanges(task.id, project, text)); setComment(''); setMode('idle'); onLanded(task.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <footer className="shrink-0 space-y-2 border-t border-aico-border-subtle bg-aico-bg px-5 py-3">
      {error && <ErrorLine>{error}</ErrorLine>}
      {mode === 'changes' ? (
        <div className="space-y-2">
          <label className={LABEL} htmlFor="dv-changes">What should change? The agent receives this as written.</label>
          <textarea
            id="dv-changes" rows={3} className={`${INPUT} resize-y`} value={comment} onChange={e => setComment(e.target.value)}
            placeholder="e.g. Keep the old endpoint working; add a test for the empty case."
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
            autoFocus
          />
          <div className="flex gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={!comment.trim() || busy !== null} onClick={() => void send()}>{busy === 'changes' ? 'Sending…' : 'Send to the agent'}</button>
            <button type="button" className={BTN_GHOST} disabled={busy !== null} onClick={() => { setMode('idle'); setComment(''); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={`${BTN_PRIMARY} ${mode === 'confirm' ? '!bg-aico-danger !text-white' : ''}`} disabled={busy !== null} onClick={() => void land()}>
            <DvIcon name="check" size={15} />
            {busy === 'land' ? 'Landing…' : mode === 'confirm' ? 'Confirm: land a high-risk change' : 'Approve and land'}
          </button>
          <button type="button" className={BTN_OUTLINE} disabled={busy !== null} onClick={() => setMode('changes')}>Request changes</button>
          <span className="ml-auto text-[12px] text-aico-muted">Lands on the trunk</span>
        </div>
      )}
    </footer>
  );
}
