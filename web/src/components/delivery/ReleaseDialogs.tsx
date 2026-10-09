/**
 * The three confirmations behind Releases: make a release, deploy one, roll one
 * back. Each says exactly what will happen BEFORE the click, because each is a
 * person's act the engine gates the same way (a bare API token cannot do them).
 *
 *  - Create: the version (prefilled from the plan; editing it re-previews through
 *    the engine, so "Must be higher than 1.2.0" and "that tag exists" come from the
 *    same code that will make the release), whether to add a CHANGELOG section, the
 *    files that will change, and the one-line effect — a commit and a local tag,
 *    nothing pushed.
 *  - Deploy: the EXACT command, character for character, and where it comes from
 *    (the app's own deploy script or the person's setting). A deploy runs a command
 *    on this computer; nobody should click "Deploy" without having seen it.
 *  - Roll back: it does not touch the trunk. It creates a task that reverts the
 *    release's commits, which then waits in the Review queue like any other work.
 *
 * Errors stay in the dialog beside the button that failed, in the engine's words
 * (a 409 already says what to do), and the dialog stays open so nothing is lost.
 *
 * @module web/components/delivery/ReleaseDialogs
 */

import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { upsertTask } from '../../delivery';
import type { Release, ReleasePlan, Task } from '../../delivery-types';
import {
  DEPLOY_SOURCE_WORD, normaliseVersionInput, releaseCreateState, releaseEffect, releaseFiles, releaseSummaryLine, validateVersion, whyLine,
} from '../../delivery-model';
import { DvIcon } from './icons';
import { BTN_GHOST, BTN_PRIMARY, Callout, ErrorLine, INPUT, LABEL, Modal, Spinner, useTaskRef } from './ui';

export function CreateReleaseDialog({ project, initial, onClose, onCreated }: {
  project: string; initial: ReleasePlan; onClose: () => void; onCreated: (r: Release) => void;
}): React.ReactElement {
  const [version, setVersion] = useState(initial.next?.version ?? '');
  const [changelog, setChangelog] = useState(true);
  // The plan the engine drew for `checked`: the version the person has typed once it has been previewed.
  const [preview, setPreview] = useState<{ plan: ReleasePlan; checked: string }>({ plan: initial, checked: initial.next?.version ?? '' });
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const typed = normaliseVersionInput(version);
  const base = initial.baseVersion;
  const versionError = validateVersion(version, base);
  const settled = !versionError && preview.checked === typed;

  // Editing the version re-previews through the engine (debounced), so every refusal is the engine's own.
  useEffect(() => {
    if (versionError || typed === preview.checked) { setChecking(false); return; }
    const mine = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      api.deliveryReleases(project, typed)
        .then(r => { if (mine === seq.current) setPreview({ plan: r.plan, checked: typed }); })
        .catch(e => { if (mine === seq.current) setError((e as Error).message); })
        .finally(() => { if (mine === seq.current) setChecking(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [typed, versionError, project, preview.checked]);

  const plan = preview.plan;
  const state = !settled && !versionError
    ? { enabled: false as const, reason: 'Checking this version.' }
    : releaseCreateState(plan, versionError);
  const files = releaseFiles(plan, changelog);

  const create = async (): Promise<void> => {
    if (!state.enabled || busy) return;
    setBusy(true); setError(null);
    try { onCreated(await api.deliveryRelease(project, { version: typed, changelog })); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title="Create a release" onClose={onClose} busy={busy} width="max-w-xl">
      <form onSubmit={e => { e.preventDefault(); void create(); }} className="space-y-4">
        <div>
          <label className={LABEL} htmlFor="rl-version">Version</label>
          <div className="flex items-center gap-2">
            <div className="relative w-44">
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-[13px] text-aico-muted">v</span>
              <input
                id="rl-version" value={version} onChange={e => { setVersion(e.target.value); setError(null); }} onBlur={() => setVersion(v => normaliseVersionInput(v))}
                inputMode="decimal" autoComplete="off" spellCheck={false}
                aria-invalid={Boolean(versionError)} aria-describedby={versionError ? 'rl-version-error' : 'rl-version-why'}
                className={`${INPUT} !pl-7 font-mono tabular-nums`}
              />
            </div>
            {checking && <span className="inline-flex items-center gap-1.5 text-[12px] text-aico-muted" role="status"><Spinner size={12} />Checking</span>}
          </div>
          {versionError
            ? <p id="rl-version-error" className="mt-1 text-[12px] text-aico-danger" role="alert">{versionError}</p>
            : <p id="rl-version-why" className="mt-1 text-[12px] text-aico-secondary">{settled ? whyLine(plan) ?? 'Chosen by you.' : 'Checking this version.'}</p>}
        </div>

        <p className="text-[13px] text-aico-secondary">{releaseSummaryLine(plan)}.</p>

        <label className="flex items-start gap-2.5 text-[13px] text-aico-primary">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--aico-accent)]" checked={changelog} onChange={e => setChangelog(e.target.checked)} />
          <span>
            Add a CHANGELOG section
            <span className="block text-[12px] text-aico-muted">A section for this version with the notes, at the top of CHANGELOG.md.</span>
          </span>
        </label>

        <section aria-label="Files that will change">
          <span className={LABEL}>Files that will change</span>
          {files.length > 0 ? (
            <ul className="overflow-hidden rounded-lg border border-aico-border-subtle">
              {files.map(f => (
                <li key={f} className="flex items-center gap-2 border-b border-aico-border-subtle px-2.5 py-1.5 text-[12.5px] last:border-b-0">
                  <DvIcon name="file" size={13} className="shrink-0 text-aico-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-aico-primary" title={f}>{f}</span>
                  <span className="shrink-0 text-[11.5px] text-aico-muted">{f === 'CHANGELOG.md' ? 'new section' : `set to ${typed || '…'}`}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-[12.5px] text-aico-secondary">None. This project has no version file, so only a tag marks the release.</p>}
        </section>

        <p className="flex items-start gap-2 rounded-lg bg-aico-surface px-3 py-2 text-[12.5px] text-aico-primary">
          <DvIcon name="tag" size={15} className="mt-px shrink-0 text-aico-muted" />{releaseEffect(plan.trunk, files)}
        </p>

        {!versionError && plan.blockers.length > 0 && settled && (
          <Callout tone="warning" role="alert">
            {plan.blockers.length === 1 ? plan.blockers[0] : <ul className="list-disc space-y-0.5 pl-4">{plan.blockers.map(b => <li key={b}>{b}</li>)}</ul>}
          </Callout>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy || !state.enabled} title={state.enabled ? undefined : state.reason}>
            {busy ? <Spinner /> : <DvIcon name="tag" size={14} />}{busy ? 'Creating…' : `Create release v${typed || '…'}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeployDialog({ project, release, plan, onClose, onStarted }: {
  project: string; release: Release; plan: ReleasePlan; onClose: () => void; onStarted: (r: Release) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = plan.deploy.command ?? '';
  const again = release.deploy?.state === 'ok' || release.deploy?.state === 'failed';

  const run = async (): Promise<void> => {
    if (busy || !command) return;
    setBusy(true); setError(null);
    try { onStarted(await api.deliveryDeploy(project, release.version)); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={`Deploy v${release.version}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-[13.5px] leading-relaxed text-aico-primary">This runs the command below on this computer. It runs exactly as written, and its output is kept with the release.</p>
        <div>
          <span className={LABEL}>Command</span>
          <code className="block max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-aico-code px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-aico-primary">{command || 'No command is set.'}</code>
          <p className="mt-1.5 text-[12px] text-aico-secondary">Comes from {DEPLOY_SOURCE_WORD[plan.deploy.source]}.</p>
        </div>
        {again && (
          <Callout tone="warning">
            {release.deploy?.state === 'ok' ? `v${release.version} was deployed before. Running this deploys it again.` : `The last deploy of v${release.version} failed. Running this tries again.`}
          </Callout>
        )}
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy || !command} onClick={() => void run()}>
            {busy ? <Spinner /> : <DvIcon name="rocket" size={14} />}{busy ? 'Starting…' : `Run deploy of v${release.version}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RollbackDialog({ project, release, onClose, onCreated }: {
  project: string; release: Release; onClose: () => void; onCreated: (t: Task) => void;
}): React.ReactElement {
  const ref = useTaskRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try { const t = await api.deliveryRollback(project, release.version); upsertTask(t); onCreated(t); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={`Roll back v${release.version}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-[13.5px] leading-relaxed text-aico-primary">
          This does not change the trunk. It creates a task that reverts the commits of v{release.version}
          {release.tasks.length > 0 ? <> ({release.tasks.length} {release.tasks.length === 1 ? 'task' : 'tasks'})</> : null}.
          The task goes through the normal review queue, so nothing is undone until you read the change and approve it.
        </p>
        {release.tasks.length > 0 && (
          <ul className="max-h-36 overflow-y-auto rounded-lg border border-aico-border-subtle">
            {release.tasks.map(t => (
              <li key={t.id} className="flex items-center gap-2 border-b border-aico-border-subtle px-2.5 py-1.5 text-[12.5px] last:border-b-0">
                <span className="font-mono tabular-nums text-aico-muted">{ref(t.id)}</span>
                <span className="min-w-0 flex-1 truncate text-aico-primary">{t.title}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12.5px] text-aico-secondary">The revert is mechanical: no agent runs and nothing is spent. If the commits no longer revert cleanly, nothing is created and the files in the way are named.</p>
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void run()}>
            {busy ? <Spinner /> : <DvIcon name="undo" size={14} />}{busy ? 'Creating…' : 'Create the rollback task'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
