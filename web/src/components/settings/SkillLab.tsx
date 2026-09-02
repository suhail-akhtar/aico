/**
 * Measuring and improving one skill, from the settings screen.
 *
 * The CLI got this first because a terminal is where a person can watch a
 * five-minute job spend money. The settings screen is where they go to *change*
 * a skill, though, and asking them to switch to a shell to find out whether the
 * change was any good is asking them not to check.
 *
 * ## It is a job, watched
 *
 * Neither run is a request that waits for its answer — a browser would time out
 * and closing the tab would orphan the run. The server starts a job and this
 * polls it, which is unglamorous and exactly right: a poll survives a reload, a
 * hidden tab, and a laptop lid, and the job carries on regardless.
 *
 * ## Nothing here is automatic
 *
 * Every button spends the user's money on their account, so every button says
 * what it is about to do — which model, how many tasks, what ceiling — before
 * it does it. And adoption is a separate, deliberate click after the diff is on
 * screen. The loop can prove a candidate is not worse on the corpus; only a
 * reader can judge the task the corpus does not contain.
 *
 * @module components/settings/SkillLab
 */

import React, { useEffect, useRef, useState } from 'react';
import { api, type SkillCorpus, type SkillJob } from '../../api';
import { useStore } from '../../store';

const POLL_MS = 1500;

export function SkillLab({ skill, onAdopted }: {
  skill: string;
  /** Called after a candidate is registered, so the list can refresh. */
  onAdopted?: () => void;
}): React.ReactElement {
  const defaultModel = useStore(s => s.defaultModel);
  const [corpus, setCorpus] = useState<SkillCorpus | null>(null);
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('1.00');
  const [steps, setSteps] = useState('3');
  const [candidates, setCandidates] = useState('1');
  const [job, setJob] = useState<SkillJob | null>(null);
  const [starting, setStarting] = useState<'eval' | 'optimize' | null>(null);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [current, setCurrent] = useState<string>('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    void api.skillCorpus(skill).then(setCorpus).catch(() => setCorpus(null));
    void api.readSkill(skill).then(r => setCurrent(r.body)).catch(() => setCurrent(''));
  }, [skill]);

  // The model field follows the configured default until the reader types.
  useEffect(() => { if (!model && defaultModel) setModel(defaultModel); }, [defaultModel, model]);

  // Poll while a job is live. Stops on its own when the job says it is done.
  useEffect(() => {
    if (!job || job.done) return;
    timer.current = window.setTimeout(async () => {
      try { setJob(await api.skillJob(job.id)); }
      catch (err) { setNote({ tone: 'bad', text: (err as Error).message }); }
    }, POLL_MS);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [job]);

  const start = async (kind: 'eval' | 'optimize'): Promise<void> => {
    setStarting(kind);
    setNote(null);
    setShowDiff(false);
    try {
      const started = kind === 'eval'
        ? await api.startSkillEval({ skill, model, budgetUsd: Number(budget) })
        : await api.startSkillOptimize({
          skill, model, budgetUsd: Number(budget),
          steps: Number(steps), candidates: Number(candidates),
        });
      if (!('id' in started)) { setNote({ tone: 'bad', text: started.error }); return; }
      setJob(started);
    } catch (err) {
      setNote({ tone: 'bad', text: (err as Error).message });
    } finally {
      setStarting(null);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!job) return;
    await api.cancelSkillJob(job.id).catch(() => { /* already finished */ });
  };

  const adopt = async (): Promise<void> => {
    if (!job) return;
    const result = await api.adoptSkillCandidate(job.id);
    setNote({ tone: result.ok ? 'good' : 'bad', text: result.message });
    if (result.ok) onAdopted?.();
  };

  const busy = Boolean(job && !job.done);
  const trainCount = corpus?.train ?? 0;
  const valCount = corpus?.val ?? 0;
  const canOptimize = trainCount > 0 && valCount > 0;

  return (
    <div className="border-t border-aico-border bg-aico-surface px-3 py-2.5">
      {/* ── what will run ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-aico-secondary">
        <span className="font-medium text-aico-primary">Measure</span>
        {corpus ? (
          <span>
            {corpus.tasks.length} task{corpus.tasks.length === 1 ? '' : 's'}
            <span className="text-aico-muted"> · {trainCount} train / {valCount} val</span>
          </span>
        ) : (
          <span className="text-aico-muted">reading the corpus…</span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-aico-muted">
          Add your own under <code>~/.aico/skill-evals/{skill}/</code>
        </span>
      </div>

      {corpus && corpus.tasks.length === 0 && (
        <p className="mt-1.5 text-[12px] text-aico-muted">
          No tasks for this skill yet, so there is nothing to measure against. A task is a
          planted, checkable answer — see the four built-in skills for the shape.
        </p>
      )}

      {/* ── controls ──────────────────────────────────────────────────── */}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <Labelled label="Model">
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            disabled={busy}
            className="w-[180px] rounded-md border border-aico-border bg-aico-bg px-2 py-1 text-[12px]
                       text-aico-primary focus:border-aico-accent/50 focus:outline-none"
          />
        </Labelled>
        <Labelled label="Ceiling $">
          <input
            value={budget}
            onChange={e => setBudget(e.target.value)}
            disabled={busy}
            inputMode="decimal"
            className="w-[64px] rounded-md border border-aico-border bg-aico-bg px-2 py-1 text-[12px]
                       text-aico-primary focus:border-aico-accent/50 focus:outline-none"
          />
        </Labelled>
        <Labelled label="Steps">
          <input
            value={steps}
            onChange={e => setSteps(e.target.value)}
            disabled={busy}
            inputMode="numeric"
            className="w-[48px] rounded-md border border-aico-border bg-aico-bg px-2 py-1 text-[12px]
                       text-aico-primary focus:border-aico-accent/50 focus:outline-none"
          />
        </Labelled>
        <Labelled label="Candidates" hint="Proposals scored per step; only the best is validated">
          <input
            value={candidates}
            onChange={e => setCandidates(e.target.value)}
            disabled={busy}
            inputMode="numeric"
            className="w-[48px] rounded-md border border-aico-border bg-aico-bg px-2 py-1 text-[12px]
                       text-aico-primary focus:border-aico-accent/50 focus:outline-none"
          />
        </Labelled>

        <span className="flex-1" />

        {!busy ? (
          <>
            <button
              onClick={() => void start('eval')}
              disabled={starting !== null || !corpus || corpus.tasks.length === 0 || !model}
              title={`Run ${corpus?.tasks.length ?? 0} task(s) on ${model || 'a model'} and score them, stopping at $${budget}`}
              className="rounded-lg border border-aico-border px-3 py-1.5 text-[12px] text-aico-primary
                         transition-colors hover:bg-aico-hover disabled:opacity-40"
            >
              {starting === 'eval' ? 'Starting…' : 'Evaluate'}
            </button>
            <button
              onClick={() => void start('optimize')}
              disabled={starting !== null || !canOptimize || !model}
              title={canOptimize
                ? `Propose bounded edits for ${steps} step(s) and keep only what scores higher on the ${valCount} validation task(s), stopping at $${budget}`
                : 'Needs at least one training and one validation task'}
              className="rounded-lg bg-aico-accent px-3 py-1.5 text-[12px] font-medium text-white
                         transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {starting === 'optimize' ? 'Starting…' : 'Optimize'}
            </button>
          </>
        ) : (
          <button
            onClick={() => void cancel()}
            className="rounded-lg border border-aico-border px-3 py-1.5 text-[12px] text-aico-danger
                       transition-colors hover:bg-aico-danger/10"
          >
            Stop
          </button>
        )}
      </div>

      {note && (
        <p className={`mt-2 text-[12px] ${note.tone === 'good' ? 'text-aico-success' : 'text-aico-danger'}`}>
          {note.text}
        </p>
      )}

      {/* ── the job, live ─────────────────────────────────────────────── */}
      {job && (
        <div className="mt-2.5">
          <div className="flex items-center gap-2 text-[12px]">
            {!job.done && <span className="size-2 animate-pulse rounded-full bg-aico-accent" aria-hidden />}
            <span className="text-aico-primary">{job.kind === 'eval' ? 'Evaluating' : 'Optimising'}</span>
            <span className="text-aico-muted">· {job.phase}</span>
            <span className="flex-1" />
            <span className="tabular-nums text-aico-muted">${job.costUsd.toFixed(3)}</span>
          </div>

          {job.error && <p className="mt-1 text-[12px] text-aico-danger">{job.error}</p>}

          {job.tasks.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {job.tasks.map((t, i) => (
                <li key={`${t.id}-${i}`} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className={t.score === 1 ? 'text-aico-success' : t.score === 0 ? 'text-aico-danger' : 'text-aico-warning'}>
                      {t.score === 1 ? '✓' : t.score === 0 ? '✗' : '◐'}
                    </span>
                    {t.phase && <span className="w-9 text-[10px] uppercase tracking-wide text-aico-muted">{t.phase}</span>}
                    <span className="min-w-0 flex-1 truncate font-mono text-aico-secondary">{t.id}</span>
                    <span className="tabular-nums text-aico-muted">{t.score.toFixed(2)}</span>
                    <span className="w-14 text-right tabular-nums text-aico-muted">{t.toolCalls.length} calls</span>
                    <span className="w-14 text-right tabular-nums text-aico-muted">
                      {t.costUsd === 0 ? 'cached' : `$${t.costUsd.toFixed(3)}`}
                    </span>
                  </div>
                  {t.checks.filter(c => !c.passed).map((c, j) => (
                    <p key={j} className="ml-6 text-[11px] leading-[15px] text-aico-muted">– {c.check.why}</p>
                  ))}
                  {t.error && <p className="ml-6 text-[11px] text-aico-danger">crashed: {t.error}</p>}
                </li>
              ))}
            </ul>
          )}

          {job.steps.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-aico-border-subtle pt-2">
              {job.steps.map(s => (
                <li key={s.step} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="text-aico-secondary">step {s.step}</span>
                    <span className="tabular-nums text-aico-muted">
                      train {s.trainMean.toFixed(2)}
                      {s.candidateTrainMean !== undefined && ` → ${s.candidateTrainMean.toFixed(2)}`}
                      {s.valMean !== undefined && ` · val ${s.valMean.toFixed(2)}`}
                    </span>
                    <span className={s.accepted ? 'text-aico-success' : 'text-aico-muted'}>
                      {s.accepted ? 'kept' : 'rejected'}
                    </span>
                    {s.candidates !== undefined && s.candidates > 1 && (
                      <span className="text-aico-muted">· {s.candidates} candidates</span>
                    )}
                  </div>
                  {s.proposed.map((e, j) => (
                    <p key={j} className="ml-4 text-[11px] leading-[15px] text-aico-secondary">· {e.reason}</p>
                  ))}
                  {s.dropped.map((d, j) => (
                    <p key={`d${j}`} className="ml-4 text-[11px] leading-[15px] text-aico-muted">✗ {d.because}</p>
                  ))}
                </li>
              ))}
            </ul>
          )}

          {job.done && job.report && (
            <p className="mt-2 text-[12px] text-aico-primary">
              Mean <span className="font-medium">{job.report.mean.toFixed(2)}</span> over {job.report.tasks.length} task(s)
              {job.report.overBudget && <span className="text-aico-warning"> · stopped at the ceiling</span>}
            </p>
          )}

          {job.done && job.outcome && (
            <div className="mt-2 rounded-lg border border-aico-border bg-aico-bg px-3 py-2">
              <p className="text-[12px] text-aico-primary">
                Validation {job.outcome.baselineValMean.toFixed(2)} →{' '}
                <span className="font-medium">{job.outcome.bestValMean.toFixed(2)}</span>
                {job.outcome.stoppedBecause && (
                  <span className="text-aico-muted"> · {job.outcome.stoppedBecause}</span>
                )}
              </p>
              {job.outcome.improved && job.outcome.best ? (
                <>
                  <p className="mt-1 text-[12px] text-aico-secondary">
                    A candidate scored higher on tasks the optimiser never saw. Read the change,
                    then decide — it becomes a user skill of the same name and the built-in is untouched.
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      onClick={() => setShowDiff(v => !v)}
                      className="rounded-lg border border-aico-border px-2.5 py-1 text-[12px] text-aico-primary
                                 transition-colors hover:bg-aico-hover"
                    >
                      {showDiff ? 'Hide the change' : 'Show the change'}
                    </button>
                    <button
                      onClick={() => void adopt()}
                      className="rounded-lg bg-aico-accent px-2.5 py-1 text-[12px] font-medium text-white
                                 transition-opacity hover:opacity-90"
                    >
                      Adopt it
                    </button>
                  </div>
                  {showDiff && <LineDiff before={current} after={job.outcome.best} />}
                </>
              ) : (
                <p className="mt-1 text-[12px] text-aico-secondary">
                  Nothing beat the current skill on validation, so it is unchanged. That is the
                  honest outcome when the shipped tasks already pass — add a task it fails.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Labelled({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-0.5" title={hint}>
      <span className="text-[10px] uppercase tracking-wide text-aico-muted">{label}</span>
      {children}
    </label>
  );
}

/**
 * A plain line diff, enough to read a prompt change.
 *
 * Not the transcript's `FileDiff`, which expects a tool's change record. This
 * is two strings and the question "what did it alter", answered line by line
 * with the longest common subsequence — small inputs, so the quadratic table
 * is fine, and it never has to be fast.
 */
function LineDiff({ before, after }: { before: string; after: string }): React.ReactElement {
  const a = before.split('\n');
  const b = after.split('\n');
  const rows = lcsDiff(a, b);
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-aico-border-subtle bg-aico-code
                    px-3 py-2 font-mono text-[11px] leading-[16px] selectable">
      {rows.map((r, i) => (
        <div
          key={i}
          style={r.kind === 'add'
            ? { color: 'var(--aico-diff-add-gutter)' }
            : r.kind === 'del' ? { color: 'var(--aico-diff-remove-gutter)' } : undefined}
          className={r.kind === 'same' ? 'text-aico-muted' : ''}
        >
          {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  '}{r.text}
        </div>
      ))}
    </pre>
  );
}

function lcsDiff(a: string[], b: string[]): Array<{ kind: 'same' | 'add' | 'del'; text: string }> {
  const n = a.length; const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i += 1; j += 1; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ kind: 'del', text: a[i]! }); i += 1; }
    else { out.push({ kind: 'add', text: b[j]! }); j += 1; }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i]! }); i += 1; }
  while (j < m) { out.push({ kind: 'add', text: b[j]! }); j += 1; }
  return out;
}
