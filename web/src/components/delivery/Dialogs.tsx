/**
 * The three things a person starts from the Delivery header: a new task, a plan
 * from a brief, and the dispatcher.
 *
 * Starting the dispatcher is the one that spends money, so its dialog says so
 * in plain words and asks for the concurrency in the same place — the number of
 * agents running at once is the number of meters running. Pausing never asks:
 * stopping spend should be one click. Every dialog keeps its error inside
 * itself and stays open on failure, so nothing typed is lost to a refusal.
 *
 * @module web/components/delivery/Dialogs
 */

import React, { useMemo, useState } from 'react';
import { api } from '../../api';
import { setBoard, upsertTask } from '../../delivery';
import type { Priority, Task } from '../../delivery-types';
import { PRIORITY_LABEL } from '../../delivery-model';
import { DvIcon } from './icons';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, ErrorLine, INPUT, LABEL, Modal, useTaskRef } from './ui';

export function NewTaskDialog({ project, tasks, onClose, onCreated }: {
  project: string; tasks: readonly Task[]; onClose: () => void; onCreated: (t: Task) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [acceptance, setAcceptance] = useState<string[]>(['']);
  const [priority, setPriority] = useState<Priority>(3);
  const [deps, setDeps] = useState<string[]>([]);
  const [labels, setLabels] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useMemo(() => tasks.filter(t => t.status !== 'merged' && t.status !== 'cancelled'), [tasks]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim()) { setError('Give the task a title: one line saying what should be true when it is done.'); return; }
    setBusy(true); setError(null);
    try {
      let t = await api.deliveryCreate({
        project, title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        acceptance: acceptance.map(a => a.trim()).filter(Boolean),
        priority, dependsOn: deps,
        labels: labels.split(',').map(l => l.trim()).filter(Boolean),
      });
      if (ready) t = await api.deliveryUpdate(t.id, project, { status: 'ready' });
      upsertTask(t);
      onCreated(t);
      onClose();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Modal title="New task" onClose={onClose} busy={busy} width="max-w-xl">
      <form onSubmit={e => void submit(e)} className="space-y-4">
        <div>
          <label className={LABEL} htmlFor="nt-title">Title</label>
          <input id="nt-title" className={INPUT} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Add rate limiting to the login endpoint" required />
        </div>
        <div>
          <label className={LABEL} htmlFor="nt-body">Details <span className="font-normal text-aico-muted">(optional)</span></label>
          <textarea id="nt-body" rows={4} className={`${INPUT} resize-y leading-relaxed`} value={body} onChange={e => setBody(e.target.value)} placeholder="Context the agent needs: where the code lives, what to avoid, links." />
        </div>
        <div>
          <span className={LABEL}>Acceptance criteria</span>
          <div className="space-y-1.5">
            {acceptance.map((a, i) => (
              <div key={i} className="flex gap-1.5">
                <input aria-label={`Criterion ${i + 1}`} className={INPUT} value={a} placeholder={i === 0 ? 'A check you can verify, e.g. "6th attempt in a minute returns 429"' : ''} onChange={e => setAcceptance(acceptance.map((x, j) => (j === i ? e.target.value : x)))} />
                {acceptance.length > 1 && <button type="button" aria-label={`Remove criterion ${i + 1}`} className={`${BTN_GHOST} !px-2`} onClick={() => setAcceptance(acceptance.filter((_, j) => j !== i))}><DvIcon name="close" size={14} /></button>}
              </div>
            ))}
            <button type="button" className={`${BTN_GHOST} !px-2 !py-1 !text-[12px]`} onClick={() => setAcceptance([...acceptance, ''])}><DvIcon name="plus" size={13} />Add a criterion</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL} htmlFor="nt-priority">Priority</label>
            <select id="nt-priority" className={INPUT} value={priority} onChange={e => setPriority(Number(e.target.value) as Priority)}>
              {([1, 2, 3, 4] as Priority[]).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="nt-labels">Labels <span className="font-normal text-aico-muted">(comma separated)</span></label>
            <input id="nt-labels" className={INPUT} value={labels} onChange={e => setLabels(e.target.value)} placeholder="api, security" />
          </div>
        </div>
        {candidates.length > 0 && (
          <fieldset>
            <legend className={LABEL}>Depends on <span className="font-normal text-aico-muted">(an agent waits until these are merged)</span></legend>
            <div className="max-h-36 overflow-y-auto rounded-lg border border-aico-border-subtle">
              {candidates.map(t => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2 border-b border-aico-border-subtle px-2.5 py-1.5 text-[13px] last:border-b-0 hover:bg-aico-hover">
                  <input type="checkbox" checked={deps.includes(t.id)} onChange={e => setDeps(e.target.checked ? [...deps, t.id] : deps.filter(d => d !== t.id))} />
                  <span className="font-mono text-[12px] text-aico-muted">{ref(t.id)}</span>
                  <span className="min-w-0 flex-1 truncate text-aico-primary">{t.title}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="flex items-start gap-2 text-[13px] text-aico-secondary">
          <input type="checkbox" className="mt-0.5" checked={ready} onChange={e => setReady(e.target.checked)} />
          <span>Put it straight in Ready<span className="block text-[12px] text-aico-muted">Agents can take it as soon as the dispatcher is running. Otherwise it waits in Backlog.</span></span>
        </label>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function PlanDialog({ project, host, onClose }: {
  project: string; host: { openSession: (id: string) => void }; onClose: () => void;
}): React.ReactElement {
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!brief.trim()) { setError('Describe what you want built; a few sentences is enough.'); return; }
    setBusy(true); setError(null);
    try { setSessionId((await api.deliveryPlan(project, brief.trim())).sessionId); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Plan from a brief" onClose={onClose} busy={busy}>
      {sessionId ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-aico-primary">
            <DvIcon name="check" size={16} className="mt-0.5 shrink-0 text-aico-success" />
            <span>A planner is reading the code and breaking your brief into tasks. They appear in Backlog as it writes them; nothing runs until you move tasks to Ready and start the dispatcher.</span>
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN_GHOST} onClick={onClose}>Back to the board</button>
            <button type="button" className={BTN_PRIMARY} onClick={() => { host.openSession(sessionId); onClose(); }}><DvIcon name="chat" size={14} />Watch the planner</button>
          </div>
        </div>
      ) : (
        <form onSubmit={e => void submit(e)} className="space-y-3">
          <p className="text-[13px] leading-relaxed text-aico-secondary">Describe the outcome. A planner reads the project and proposes small tasks with acceptance criteria and dependencies. You review them before any agent starts.</p>
          <div>
            <label className={LABEL} htmlFor="pl-brief">Brief</label>
            <textarea id="pl-brief" rows={7} className={`${INPUT} resize-y leading-relaxed`} value={brief} onChange={e => setBrief(e.target.value)} placeholder="e.g. Let teams share a dashboard by link: read-only for viewers, revocable by the owner, with an audit trail." />
          </div>
          {error && <ErrorLine>{error}</ErrorLine>}
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className={BTN_PRIMARY} disabled={busy}><DvIcon name="sparkles" size={14} />{busy ? 'Starting…' : 'Plan tasks'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function StartDispatcherDialog({ project, initial, readyCount, onClose }: {
  project: string; initial: number; readyCount: number; onClose: () => void;
}): React.ReactElement {
  const [n, setN] = useState(Math.min(4, Math.max(1, initial)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { setBoard(await api.deliveryDispatch(project, 'start', n)); onClose(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Modal title="Start the agents" onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-[13.5px] leading-relaxed text-aico-primary">
          Agents will take tasks from Ready in priority order and work on each in its own branch. <strong className="font-semibold">This spends money</strong>: every running agent uses model credits until it finishes or you pause. Nothing lands on the trunk without your approval.
        </p>
        <div>
          <span className={LABEL} id="sd-n">Agents at once</span>
          <div role="radiogroup" aria-labelledby="sd-n" className="inline-flex overflow-hidden rounded-lg border border-aico-border">
            {[1, 2, 3, 4].map(v => (
              <button
                key={v} type="button" role="radio" aria-checked={n === v} onClick={() => setN(v)}
                className={`w-12 py-1.5 text-[13px] tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent ${n === v ? 'bg-aico-accent text-aico-on-accent' : 'text-aico-primary hover:bg-aico-hover'}`}
              >{v}</button>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] text-aico-muted">More agents finish sooner and cost the same per task, but touch more files at once, which raises the chance two tasks conflict.</p>
        </div>
        {readyCount === 0 && <p className="rounded-lg bg-aico-surface px-3 py-2 text-[12.5px] text-aico-secondary">Nothing is in Ready yet, so no agent will start until you move a task there.</p>}
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_OUTLINE} disabled={busy} onClick={onClose}>Not now</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void start()}><DvIcon name="play" size={13} />{busy ? 'Starting…' : `Start ${n} ${n === 1 ? 'agent' : 'agents'}`}</button>
        </div>
      </div>
    </Modal>
  );
}
