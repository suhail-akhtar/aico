/**
 * Releases: what the next release would be, and what has been released.
 *
 * WHY a view and not a button: landing a task puts it on the trunk, but a
 * release is the decision to call a set of landed work "1.3.0" — a version, notes
 * a customer could read, a tag. That decision needs the whole picture in front of
 * it: the merged tasks since the last tag grouped the way the notes will read, the
 * commits that did not come from the board, the proposed version and WHY, the
 * files that will change, and — when something stops it — the reason in words,
 * not a greyed-out button.
 *
 * The plan is a read from the engine (`GET /api/delivery/releases`); the history is
 * the board's own `releases`, which arrive live on the board frames, so a deploy
 * that finishes updates its row without a refresh. The plan is fetched again when
 * the board's releases or merged tasks change, never on a timer.
 *
 * Making a release, deploying and rolling back are each a person's act with its own
 * confirmation (ReleaseDialogs), and each failure is shown on the row or button it
 * belongs to, in the engine's words.
 *
 * What it does not do: push anything, publish anywhere, or decide the version for
 * you — the proposal is a default in a field you can change.
 *
 * @module web/components/delivery/ReleasesView
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderer } from '../../../../shared/ui/MarkdownRenderer';
import { api } from '../../api';
import type { Release, ReleasePlan, Task } from '../../delivery-types';
import {
  BUMP_WORD, KIND_WORD, deployAction, groupReleaseTasks, releaseCreateState, releaseEmpty, releaseFiles, releaseSummaryLine, toMs, whyLine,
} from '../../delivery-model';
import { DvIcon } from './icons';
import { CreateReleaseDialog, DeployDialog, RollbackDialog } from './ReleaseDialogs';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, Callout, ErrorLine, Pill, Skeleton, Spinner, useTaskRef } from './ui';

type Dialog = { kind: 'create' } | { kind: 'deploy'; release: Release } | { kind: 'rollback'; release: Release } | null;

const dateOf = (at: string): string => {
  const ms = toMs(at);
  return ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
};

export function ReleasesView({ project, releases, tasks, onOpenTask, onShowBoard, onShowReview }: {
  project: string;
  /** The board's releases, newest first; they change live. */
  releases: readonly Release[];
  tasks: readonly Task[];
  onOpenTask: (id: string) => void;
  onShowBoard: () => void;
  onShowReview: () => void;
}): React.ReactElement {
  const taskRef = useTaskRef();
  const [plan, setPlan] = useState<ReleasePlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  // What the person just did. The words are composed at render time: a new task's number is not known until the board has it.
  const [done, setDone] = useState<{ kind: 'release'; version: string; tasks: number } | { kind: 'rollback'; version: string; taskId: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const seq = useRef(0);

  // Everything that changes what the plan says: a release was made, or a task landed.
  const signature = useMemo(
    () => `${releases.map(r => r.version).join(',')}|${tasks.filter(t => t.status === 'merged').map(t => `${t.id}:${t.landed?.to ?? ''}`).join(',')}`,
    [releases, tasks],
  );

  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current;
    try {
      const r = await api.deliveryReleases(project);
      if (mine !== seq.current) return;
      setPlan(r.plan); setLoadError(null);
    } catch (e) {
      if (mine === seq.current) setLoadError((e as Error).message);
    }
  }, [project]);
  useEffect(() => { void load(); }, [load, signature]);

  const setError = (version: string, message: string | null): void =>
    setErrors(prev => { const { [version]: _old, ...rest } = prev; return message ? { ...rest, [version]: message } : rest; });

  const create = releaseCreateState(plan);
  const empty = plan ? releaseEmpty(plan, releases.length) : null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {done && (
          <Callout tone="success" role="status" onDismiss={() => setDone(null)}>
            {done.kind === 'release'
              ? <span>Released v{done.version}: {done.tasks} {done.tasks === 1 ? 'task' : 'tasks'}, tagged locally. Nothing was pushed.</span>
              : <>
                  <span>Created {taskRef(done.taskId)} to revert v{done.version}. It waits in the review queue; nothing changes until you approve it.</span>
                  {' '}<button type="button" className="font-medium text-aico-accent underline underline-offset-2" onClick={() => onOpenTask(done.taskId)}>Open {taskRef(done.taskId)}</button>
                </>}
          </Callout>
        )}

        <section aria-labelledby="rel-next" className="rounded-2xl border border-aico-border-subtle bg-aico-bg">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-5 pb-4 pt-5">
            <div className="min-w-0">
              <h2 id="rel-next" className="text-[11.5px] font-semibold uppercase tracking-wide text-aico-secondary">Next release</h2>
              {!plan && !loadError && <Skeleton className="mt-2 h-9 w-40" />}
              {plan && (
                <>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {plan.next
                      ? <span className="font-mono text-[30px] font-semibold leading-none tracking-tight tabular-nums text-aico-primary">v{plan.next.version}</span>
                      : <span className="text-[20px] font-semibold leading-tight tracking-tight text-aico-primary">{empty ? 'Nothing to release' : 'No version to propose'}</span>}
                    {plan.next && <Pill tone="neutral">{BUMP_WORD[plan.next.bump]}{plan.next.bump === 'none' ? '' : ' bump'}</Pill>}
                  </p>
                  {plan.next && <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-aico-secondary">{whyLine(plan)}</p>}
                  {!empty && <p className="mt-0.5 text-[13px] tabular-nums text-aico-secondary">{releaseSummaryLine(plan)}.</p>}
                </>
              )}
            </div>
            <span className="flex-1" />
            {plan && (
              <button
                type="button" className={`${BTN_PRIMARY} !px-4 !py-2`} disabled={!create.enabled}
                aria-describedby={create.enabled ? undefined : empty ? 'rel-empty' : plan.blockers.length > 0 ? 'rel-blockers' : undefined}
                onClick={() => { setDone(null); setDialog({ kind: 'create' }); }}
              >
                <DvIcon name="tag" size={15} />{plan.next ? `Create release v${plan.next.version}` : 'Create release'}
              </button>
            )}
          </div>

          {loadError && (
            <div className="space-y-2 px-5 pb-5">
              <ErrorLine>Could not read what a release would contain: {loadError}</ErrorLine>
              <button type="button" className={BTN_OUTLINE} onClick={() => void load()}><DvIcon name="refresh" size={14} />Try again</button>
            </div>
          )}

          {plan && plan.blockers.length > 0 && !empty && (
            <div className="px-5 pb-4">
              <Callout tone="warning" id="rel-blockers" role="status">
                <p className="font-medium">A release cannot be made yet</p>
                {plan.blockers.length === 1 ? <p className="mt-0.5 text-aico-secondary">{plan.blockers[0]}</p>
                  : <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-aico-secondary">{plan.blockers.map(b => <li key={b}>{b}</li>)}</ul>}
              </Callout>
            </div>
          )}

          {plan && empty && (
            <div id="rel-empty" className="border-t border-aico-border-subtle px-5 py-8 text-center">
              <DvIcon name="tag" size={26} className="mx-auto text-aico-muted" />
              <p className="mt-2 text-[15px] font-medium text-aico-primary">{empty.title}</p>
              <p className="mt-1 text-[13px] text-aico-secondary">{empty.body}</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button type="button" className={BTN_OUTLINE} onClick={onShowReview}>Open the review queue</button>
                <button type="button" className={BTN_GHOST} onClick={onShowBoard}>Back to the board</button>
              </div>
            </div>
          )}

          {plan && !empty && <PlanBody plan={plan} onOpenTask={onOpenTask} />}
        </section>

        <section aria-labelledby="rel-history">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 id="rel-history" className="text-[11.5px] font-semibold uppercase tracking-wide text-aico-secondary">Release history</h2>
            <span className="text-[12px] tabular-nums text-aico-muted">{releases.length}</span>
          </div>
          {releases.length === 0 ? (
            <div className="rounded-xl border border-dashed border-aico-border px-5 py-6 text-center text-[13px] text-aico-secondary">
              <p className="font-medium text-aico-primary">Nothing has been released from this board</p>
              <p className="mt-1">Once you create a release it is listed here with its notes, and you can deploy or roll it back from the row.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {releases.map(r => (
                <li key={r.version}>
                  <ReleaseRow
                    release={r} plan={plan} error={errors[r.version]}
                    onDeploy={() => { setError(r.version, null); setDialog({ kind: 'deploy', release: r }); }}
                    onRollback={() => { setError(r.version, null); setDialog({ kind: 'rollback', release: r }); }}
                    onOpenTask={onOpenTask}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dialog?.kind === 'create' && plan && (
        <CreateReleaseDialog
          project={project} initial={plan} onClose={() => setDialog(null)}
          onCreated={r => { setDialog(null); setDone({ kind: 'release', version: r.version, tasks: r.tasks.length }); void load(); }}
        />
      )}
      {dialog?.kind === 'deploy' && plan && (
        <DeployDialog
          project={project} release={dialog.release} plan={plan} onClose={() => setDialog(null)}
          onStarted={() => { setDialog(null); setError(dialog.release.version, null); }}
        />
      )}
      {dialog?.kind === 'rollback' && (
        <RollbackDialog
          project={project} release={dialog.release} onClose={() => setDialog(null)}
          onCreated={t => {
            setDialog(null);
            setDone({ kind: 'rollback', version: dialog.release.version, taskId: t.id });
            onOpenTask(t.id);
          }}
        />
      )}
    </div>
  );
}

// ── the plan ──────────────────────────────────────────────────────────

function PlanBody({ plan, onOpenTask }: { plan: ReleasePlan; onOpenTask: (id: string) => void }): React.ReactElement {
  const taskRef = useTaskRef();
  const groups = useMemo(() => groupReleaseTasks(plan.tasks), [plan.tasks]);
  const files = releaseFiles(plan, true);
  return (
    <div className="space-y-5 border-t border-aico-border-subtle px-5 py-4">
      {groups.map(g => (
        <section key={g.section} aria-label={`${g.section}, ${g.tasks.length}`}>
          <h3 className="mb-1.5 flex items-center gap-2 text-[13px] font-semibold text-aico-primary">
            {g.section}
            <span className="rounded-full bg-aico-hover px-1.5 text-[11px] font-normal tabular-nums text-aico-secondary">{g.tasks.length}</span>
          </h3>
          <ul className="divide-y divide-aico-border-subtle overflow-hidden rounded-lg border border-aico-border-subtle">
            {g.tasks.map(t => (
              <li key={t.id}>
                <button
                  type="button" onClick={() => onOpenTask(t.id)}
                  className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent"
                >
                  <span className="mt-px font-mono text-[12px] tabular-nums text-aico-muted">{taskRef(t.id)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-aico-primary">{t.title}</span>
                    {t.summary && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-aico-secondary">{t.summary}</span>}
                  </span>
                  <span className="mt-px shrink-0 text-[11.5px] text-aico-muted">{t.breaking ? `breaking ${KIND_WORD[t.kind]}` : KIND_WORD[t.kind]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {plan.other.length > 0 && (
        <details className="group rounded-lg border border-aico-border-subtle">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent">
            <DvIcon name="chevron" size={14} className="text-aico-muted transition-transform group-open:rotate-90" />
            Other commits on {plan.trunk}
            <span className="rounded-full bg-aico-hover px-1.5 text-[11px] font-normal tabular-nums text-aico-secondary">{plan.other.length}</span>
            <span className="text-[12px] font-normal text-aico-muted">not made through the board</span>
          </summary>
          <ul className="divide-y divide-aico-border-subtle border-t border-aico-border-subtle">
            {plan.other.map(c => (
              <li key={c.sha} className="flex gap-3 px-3 py-1.5 text-[12.5px]">
                <span className="font-mono tabular-nums text-aico-muted">{c.sha.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 break-words text-aico-primary">{c.subject}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section aria-label="Version files" className="text-[13px] text-aico-secondary">
        <span className="font-medium text-aico-primary">Version files: </span>
        {plan.versionFiles.length > 0
          ? plan.versionFiles.map((f, i) => <React.Fragment key={f}>{i > 0 ? ', ' : ''}<span className="font-mono text-[12.5px] text-aico-primary">{f}</span></React.Fragment>)
          : 'none found, so a release is a tag only.'}
        {plan.versionFiles.length > 0 && <> will be updated{files.length > plan.versionFiles.length ? ', and CHANGELOG.md gets a section' : ''}.</>}
      </section>

      {plan.notes.trim() && (
        <details className="group rounded-lg border border-aico-border-subtle">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent">
            <DvIcon name="chevron" size={14} className="text-aico-muted transition-transform group-open:rotate-90" />
            Release notes preview
            <span className="text-[12px] font-normal text-aico-muted">what goes into the tag and CHANGELOG.md</span>
          </summary>
          <div className="markdown-body max-h-80 overflow-y-auto border-t border-aico-border-subtle px-4 py-3 text-[13.5px]"><MarkdownRenderer content={plan.notes} /></div>
        </details>
      )}
    </div>
  );
}

// ── the history ───────────────────────────────────────────────────────

function DeployPill({ release }: { release: Release }): React.ReactElement {
  const d = release.deploy;
  if (!d) return <Pill tone="neutral" icon={<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full border border-aico-muted" />}>Not deployed</Pill>;
  if (d.state === 'running') return <Pill tone="info" icon={<Spinner size={11} />}>Deploying</Pill>;
  if (d.state === 'ok') return <Pill tone="success" icon={<DvIcon name="checkCircle" size={13} className="text-aico-success" />} title={dateOf(d.at)}>Deployed</Pill>;
  return <Pill tone="danger" icon={<DvIcon name="xCircle" size={13} className="text-aico-danger" />} title={dateOf(d.at)}>Deploy failed</Pill>;
}

function ReleaseRow({ release, plan, error, onDeploy, onRollback, onOpenTask }: {
  release: Release; plan: ReleasePlan | null; error: string | undefined;
  onDeploy: () => void; onRollback: () => void; onOpenTask: (id: string) => void;
}): React.ReactElement {
  const taskRef = useTaskRef();
  const [open, setOpen] = useState(false);
  const deploy = deployAction(plan, release);
  const why = plan && !deploy.enabled && release.deploy?.state !== 'running' ? deploy.reason : '';
  const failed = release.deploy?.state === 'failed';
  const notesId = `rel-notes-${release.version}`;
  const whyId = `rel-deploy-why-${release.version}`;

  return (
    <article className="rounded-xl border border-aico-border-subtle bg-aico-bg" aria-label={`Release v${release.version}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <h3 className="font-mono text-[16px] font-semibold tabular-nums text-aico-primary">v{release.version}</h3>
        <span className="text-[12.5px] text-aico-secondary" title={release.at}>{dateOf(release.at)}</span>
        <Pill tone="neutral">{BUMP_WORD[release.bump]}{release.bump === 'none' ? '' : ' bump'}</Pill>
        <span className="text-[12.5px] tabular-nums text-aico-secondary">{release.tasks.length} {release.tasks.length === 1 ? 'task' : 'tasks'}</span>
        <DeployPill release={release} />
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button" className={BTN_OUTLINE} disabled={!deploy.enabled} onClick={onDeploy}
            aria-describedby={why ? whyId : undefined} title={why || undefined}
          >
            {release.deploy?.state === 'running' ? <Spinner size={13} /> : <DvIcon name="rocket" size={14} />}{deploy.label}
          </button>
          {release.rollback ? (
            <button type="button" className={BTN_OUTLINE} onClick={() => onOpenTask(release.rollback!.taskId)}>
              <DvIcon name="undo" size={14} />Rollback task {taskRef(release.rollback.taskId)}
            </button>
          ) : (
            <button type="button" className={BTN_OUTLINE} onClick={onRollback}><DvIcon name="undo" size={14} />Roll back</button>
          )}
        </div>
      </div>
      {why && <p id={whyId} className="px-4 pb-2 text-[12px] text-aico-muted">Deploy is unavailable: {why}</p>}
      {error && <div className="px-4 pb-3"><ErrorLine>{error}</ErrorLine></div>}
      {failed && release.deploy?.tail && (
        <div className="px-4 pb-3">
          <p className="mb-1 text-[12px] font-medium text-aico-secondary">Output of the failed deploy</p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-aico-code px-3 py-2 font-mono text-[12px] leading-relaxed text-aico-primary">{release.deploy.tail}</pre>
        </div>
      )}

      <div className="border-t border-aico-border-subtle">
        <button
          type="button" aria-expanded={open} aria-controls={notesId} onClick={() => setOpen(o => !o)}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px] text-aico-secondary transition-colors hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aico-accent"
        >
          <DvIcon name="chevron" size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          {open ? 'Hide release notes' : 'Show release notes'}
        </button>
        {open && (
          <div id={notesId} className="space-y-3 px-4 pb-4">
            {release.notes.trim()
              ? <div className="markdown-body text-[13.5px]"><MarkdownRenderer content={release.notes} /></div>
              : <p className="text-[13px] text-aico-muted">These release notes are empty.</p>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-aico-muted">Commit</dt><dd className="font-mono tabular-nums text-aico-primary">{release.commit.slice(0, 10)}</dd>
              {release.files.length > 0 && <><dt className="text-aico-muted">Files changed</dt><dd className="break-words font-mono text-aico-primary">{release.files.join(', ')}</dd></>}
              {release.deploy && <><dt className="text-aico-muted">Deploy command</dt><dd className="break-all font-mono text-aico-primary">{release.deploy.command}</dd></>}
            </dl>
            {release.deploy?.state === 'ok' && release.deploy.tail && (
              <details>
                <summary className="cursor-pointer text-[12px] text-aico-secondary">Deploy output</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-aico-code px-3 py-2 font-mono text-[12px] text-aico-primary">{release.deploy.tail}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
