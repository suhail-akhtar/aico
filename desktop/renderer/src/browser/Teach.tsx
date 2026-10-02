/**
 * Teach AICO in the chrome: the toolbar control that records a task on the
 * tab in front, and the review page that turns the recording into a saved
 * procedure (main does the recording, the checks and the saving —
 * electron/browser-teach.ts; this file only shows and edits).
 *
 * The review is where a person decides what the procedure is: rename, delete
 * or merge steps, choose which typed values are parameters (and their names),
 * and say what the whole thing is for. Screenshots exist only here, in
 * memory, until the procedure is saved or discarded.
 *
 * @module desktop/renderer/browser/Teach
 */

import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { on } from '@/desktop';
import { toast } from '@/state/desk';
import { call } from './ipc';
import { showInternal } from './store';
import type { DraftStep, ProcedureAction, TeachDraft, TeachState } from '@desk/teach-types';

const useTeach = create<{ state: TeachState; subscribed: boolean }>(() => ({ state: { recording: false, steps: 0 }, subscribed: false }));

function useTeachState(): TeachState {
  useEffect(() => {
    if (useTeach.getState().subscribed) return;
    useTeach.setState({ subscribed: true });
    on<TeachState>('browser:teach:state', (s) => useTeach.setState({ state: s }));
    void call<TeachState>('browser:teach:state').then(s => { if (s) useTeach.setState({ state: s }); }).catch(() => {});
  }, []);
  return useTeach(s => s.state);
}

async function startTeaching(): Promise<void> {
  try {
    const s = await call<TeachState>('browser:teach:start');
    if (s === undefined) { toast.info('Teaching is not available in this version'); return; }
    toast.info('Recording', 'Do the task once on this page. Passwords, cards and codes are never recorded. Press Stop when you are done.');
  } catch (err) { toast.error('Could not start teaching', (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}

async function stopTeaching(): Promise<void> {
  try {
    await call('browser:teach:stop');
    showInternal('teach');
  } catch (err) { toast.error('Could not stop recording', (err as Error).message); }
}

/** The toolbar control: Teach → (recording) Stop → Review. */
export function TeachButton({ disabled }: { disabled?: boolean }): React.ReactElement {
  const s = useTeachState();
  if (s.recording) {
    return (
      <button className="chip h-7 gap-1.5 py-0 text-aico-danger" onClick={() => void stopTeaching()} title="Stop recording and review the steps" aria-label="Stop teaching">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-aico-danger" />
        <span className="tabular-nums">Recording · {s.steps} step{s.steps === 1 ? '' : 's'}</span>
        <span className="font-semibold">Stop</span>
      </button>
    );
  }
  if (s.draft) {
    return (
      <button className="chip h-7 gap-1.5 py-0 text-aico-accent" onClick={() => showInternal('teach')} title="Review the task you taught" aria-label="Review taught steps">
        <Icon name="hand" size={13} />Review
      </button>
    );
  }
  return (
    <button className="icon-btn-sm" disabled={disabled} onClick={() => void startTeaching()} aria-label="Teach AICO"
      title="Teach AICO: do a task once on this page, and AICO can repeat it (passwords, cards and codes are never recorded)">
      <Icon name="hand" size={15} />
    </button>
  );
}

// ── Review ──

export function TeachReview(): React.ReactElement {
  const [draft, setDraft] = useState<TeachDraft | null | undefined>(undefined);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void call<TeachDraft | null>('browser:teach:draft').then((d) => {
      setDraft(d ?? null);
      if (d) {
        setSteps(d.steps);
        const slug = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const host = (() => { try { return new URL(d.origin).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        // A site name in front of the page's title ("example-support-request"); an address (127.0.0.1, localhost) adds nothing.
        const site = /^[\d.]+$|^localhost$|^\[/.test(host) ? '' : slug(host.split('.')[0] ?? '');
        setName([site, slug(d.title || '') || 'task'].filter(Boolean).join('-'));
      }
    }).catch(() => setDraft(null));
  }, []);

  if (draft === undefined) return <div className="bx-chrome-page" />;
  if (!draft) {
    return (
      <div className="bx-chrome-page thin-scroll">
        <div className="mx-auto max-w-[640px] px-8 pt-16 text-center text-[13.5px] text-aico-muted">
          Nothing to review. Open the page where a task starts and press <Icon name="hand" size={13} className="inline" /> Teach in the toolbar.
          <div className="mt-4"><button className="btn-outline btn-sm" onClick={() => showInternal(null)}>Close</button></div>
        </div>
      </div>
    );
  }

  const update = (i: number, patch: Partial<DraftStep>): void => setSteps(ss => ss.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const updateAction = (i: number, j: number, patch: Partial<ProcedureAction>): void =>
    setSteps(ss => ss.map((s, k) => (k === i ? { ...s, actions: s.actions.map((a, m) => (m === j ? { ...a, ...patch } : a)) } : s)));
  const remove = (i: number): void => setSteps(ss => ss.filter((_, k) => k !== i));
  const mergeUp = (i: number): void => setSteps(ss => {
    if (i < 1) return ss;
    const prev = ss[i - 1]!; const cur = ss[i]!;
    const merged: DraftStep = { ...prev, title: `${prev.title}; ${cur.title}`, intent: `${prev.intent} ${cur.intent}`, actions: [...prev.actions, ...cur.actions], shots: [...prev.shots, ...cur.shots] };
    return [...ss.slice(0, i - 1), merged, ...ss.slice(i + 1)];
  });

  const save = async (): Promise<void> => {
    setBusy(true); setResult(null);
    try {
      const r = await call<{ ok: boolean; message: string; name?: string }>('browser:teach:save', {
        draftId: draft.id, name, goal, overwrite,
        steps: steps.map(({ shots: _shots, ...s }) => s),
      });
      if (!r) { setResult({ ok: false, message: 'Saving is not available in this version.' }); return; }
      setResult(r);
      if (r.ok) toast.success('Procedure saved', `Chats can now run “${r.name}” with browser_run_procedure.`);
    } catch (err) { setResult({ ok: false, message: (err as Error).message }); } finally { setBusy(false); }
  };
  const discard = async (): Promise<void> => { await call('browser:teach:discard').catch(() => {}); showInternal(null); };

  return (
    <div className="bx-chrome-page thin-scroll" data-teach-review>
      <div className="mx-auto w-full max-w-[880px] px-8 pb-16 pt-8">
        <div className="mb-4 flex items-center gap-3">
          <Icon name="hand" size={20} className="text-aico-secondary" />
          <h1 className="flex-1 text-[22px] font-semibold tracking-tight">Review what you taught</h1>
          <button className="icon-btn" onClick={() => showInternal(null)} title="Close (the recording stays until you save or discard it)"><Icon name="x" size={16} /></button>
        </div>
        <p className="mb-5 text-[12.5px] text-aico-muted">On <span className="selectable">{draft.origin}</span>. AICO will repeat these steps in a chat’s own tab, finding each element again by what it is called — and asks you before anything that buys, sends or deletes.</p>

        <div className="mb-5 grid gap-3 sm:grid-cols-[220px_1fr]">
          <label className="text-[12.5px]"><span className="mb-1 block text-aico-muted">Name</span>
            <input className="input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="support-request" data-teach-name />
          </label>
          <label className="text-[12.5px]"><span className="mb-1 block text-aico-muted">Goal — what this does, so chats know when to use it</span>
            <input className="input w-full" value={goal} onChange={e => setGoal(e.target.value)} placeholder="Submit a support request for a customer" data-teach-goal />
          </label>
        </div>

        {draft.notes.length > 0 && (
          <div className="mb-4 rounded-xl bg-aico-hover/60 px-4 py-3 text-[12.5px] leading-relaxed">
            {draft.notes.map((n, i) => <div key={i} className="flex gap-2"><Icon name="lock" size={13} className="mt-0.5 shrink-0 text-aico-secondary" /><span>{n}</span></div>)}
          </div>
        )}

        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s.id} className="flex gap-3 rounded-xl border border-aico-border-subtle p-3" data-teach-step={i + 1}>
              <div className="w-[200px] shrink-0">
                {s.shots[0] ? <Shot shot={s.shots[s.shots.length - 1]!} /> : <div className="flex h-[112px] items-center justify-center rounded-lg bg-aico-hover text-[11px] text-aico-muted">no picture</div>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] tabular-nums text-aico-muted">{i + 1}.</span>
                  <input className="input h-8 min-w-0 flex-1 text-[13px]" value={s.title} onChange={e => update(i, { title: e.target.value })} aria-label={`Step ${i + 1} title`} />
                  <button className="icon-btn-sm" disabled={i === 0} onClick={() => mergeUp(i)} title="Merge into the step above"><Icon name="arrow-up" size={14} /></button>
                  <button className="icon-btn-sm" onClick={() => remove(i)} title="Delete this step" data-teach-delete={i + 1}><Icon name="trash" size={14} /></button>
                </div>
                <div className="mt-1 text-[11.5px] text-aico-muted">{s.intent}</div>
                {s.actions.map((a, j) => <ActionRow key={j} a={a} onChange={(p) => updateAction(i, j, p)} step={i + 1} />)}
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />Replace the existing procedure with this name</label>
          <span className="flex-1" />
          <button className="btn-outline btn-sm" onClick={() => void discard()} disabled={busy}>Discard</button>
          <button className="btn-primary btn-sm" onClick={() => void save()} disabled={busy || !steps.length} data-teach-save>{busy ? 'Saving…' : 'Save procedure'}</button>
        </div>
        {result && (
          <pre className={cls('mt-4 whitespace-pre-wrap rounded-xl px-4 py-3 text-[12px] selectable', result.ok ? 'bg-aico-hover/60' : 'bg-aico-danger/10 text-aico-danger')} data-teach-result>{result.message}</pre>
        )}
      </div>
    </div>
  );
}

function Shot({ shot }: { shot: DraftStep['shots'][number] }): React.ReactElement {
  const r = shot.rect; const vw = shot.vw || 1; const vh = shot.vh || 1;
  return (
    <div className="relative overflow-hidden rounded-lg border border-aico-border-subtle">
      <img src={shot.src} alt="" className="block w-full" />
      {r && r.w > 0 && (
        <span className="pointer-events-none absolute rounded-sm border-2 border-aico-accent"
          style={{ left: `${(r.x / vw) * 100}%`, top: `${(r.y / vh) * 100}%`, width: `${(r.w / vw) * 100}%`, height: `${(r.h / vh) * 100}%` }} />
      )}
    </div>
  );
}

function ActionRow({ a, onChange, step }: { a: ProcedureAction; onChange: (p: Partial<ProcedureAction>) => void; step: number }): React.ReactElement | null {
  if (a.kind === 'type') {
    const isParam = a.param !== undefined;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="text-aico-muted">{isParam ? 'Example' : 'Types'}</span>
        <input className="input h-7 w-48 text-[12.5px]" value={a.value ?? ''} onChange={e => onChange({ value: e.target.value })} aria-label={`Step ${step} value`} />
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={isParam} onChange={e => onChange({ param: e.target.checked ? (a.target?.label || a.target?.name || 'value').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'value' : undefined })} data-teach-param-toggle={step} />Parameter</label>
        {isParam && <span className="flex items-center gap-1 font-mono text-[12px]">{'{{'}<input className="input h-7 w-36 font-mono text-[12px]" value={a.param} onChange={e => onChange({ param: e.target.value })} aria-label={`Step ${step} parameter name`} data-teach-param={step} />{'}}'}</span>}
      </div>
    );
  }
  if (a.kind === 'secret') return <div className="mt-2 flex items-center gap-1.5 text-[12px] text-aico-muted"><Icon name="lock" size={12} />Not recorded — {a.secret?.kind === 'password' ? 'filled from a stored credential you name when it runs, or by you' : 'always entered by you'}.</div>;
  if (a.kind === 'upload') return <div className="mt-2 text-[12px] text-aico-muted">File path is the parameter <span className="font-mono">{`{{${a.param ?? 'file'}}}`}</span>; you approve each upload.</div>;
  if (a.kind === 'select') return <div className="mt-2 text-[12px] text-aico-muted">Chooses “{a.optionText || a.value}”.</div>;
  return null;
}
