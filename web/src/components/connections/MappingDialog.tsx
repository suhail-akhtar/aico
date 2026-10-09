/**
 * "Use this connection for a project": the one place a connection meets a repository.
 *
 * Four answers and nothing else: which repo (read from the project's `origin`, one
 * confirm), where work lands (this computer, or a pull request), which remote items
 * become tasks, and what the remote calls each state. Everything past that sits behind
 * one collapsed "Advanced".
 *
 * The decision this dialog exists to protect: switching a project to pull request mode
 * makes the engine push branches to a remote. That is a standing change, so choosing it
 * opens a card that says exactly what will happen, and the flag the engine requires
 * (`confirmLanding`) is set only when the person accepts the card. Staying in the mode,
 * or choosing local, never asks.
 *
 * It is a dialog (focus trapped, Escape closes, returns focus) rather than a drawer: the
 * Settings window it is usually opened from is itself a dialog, and a second sheet on the
 * side is two overlays to dismiss. On a narrow panel it becomes a bottom sheet.
 *
 * What it does not do: store a token, or change the connection's address or CA bundle
 * (those are fixed at creation; the engine refuses a later change).
 *
 * @module web/components/connections/MappingDialog
 */

import React, { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../../api';
import { DEFAULT_STATE_MAP, type Connection, type ConnectionsPolicyView, type ProjectMapping, type RepoDetection } from '../../../../shared/connections/types';
import { CATEGORY_STATE_MAP } from '../../../../shared/connections/process';
import {
  STATE_ROWS, initialMappingForm, landingNeedsConfirm, mappingBody, parseRepo, policyView, prConfirmText, providerLabel,
  stateMapOf, validateMapping, workItemOptions, type MappingForm,
} from '../../connections';
import { azureStatePreview, processSummary, type ProcessInfo } from '../../connections-azure';
import { basename } from '../../grouping';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, Callout, ErrorLine, INPUT, LABEL, Modal, Skeleton, Spinner } from '../delivery/ui';

export function MappingDialog({ connection, project, projects, policy, onClose, onSaved }: {
  connection: Connection;
  project: string;
  /** Registered projects, for the switcher when there is more than one. */
  projects: Array<{ path: string; name: string }>;
  policy: ConnectionsPolicyView | undefined;
  onClose: () => void;
  /** After a save or a removal: the page refreshes its list and says what happened. */
  onSaved: (message: string) => void;
}): React.ReactElement {
  const [path, setPath] = useState(project);
  const [loaded, setLoaded] = useState<{ existing: ProjectMapping | undefined; other: string | undefined; detection: RepoDetection | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<MappingForm | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const uid = useId();

  const caps = connection.probe?.capabilities;
  const canItems = !caps || caps.items.query;
  const canPulls = !caps || caps.pulls.create;
  const canIterations = !caps || caps.iterations !== 'none';
  const pol = policyView(policy);
  const isAzure = connection.provider === 'azure-devops';
  const options = workItemOptions(connection.provider);
  // Azure DevOps: the repositories to pick from, and the project's work item process to preview state names with.
  const [repos, setRepos] = useState<Array<{ owner: string; name: string }>>([]);
  const [proc, setProc] = useState<{ owner: string; info: ProcessInfo | null; error?: string } | null>(null);

  // Read the project's current mapping and what its origin looks like; a fresh form per project.
  useEffect(() => {
    let live = true;
    setLoaded(null); setForm(null); setLoadError(null); setError(null); setConfirming(false); setConfirmRemove(false); setTouched(false);
    Promise.all([api.connectionMapping(path), api.connectionDetect(path).catch(() => null)])
      .then(([m, d]) => {
        if (!live) return;
        const existing = m.mapping && m.mapping.connection === connection.id ? m.mapping : undefined;
        const other = m.mapping && m.mapping.connection !== connection.id ? m.connection?.label ?? m.mapping.connection : undefined;
        setLoaded({ existing, other, detection: d });
        setForm(initialMappingForm({ connection: connection.id, existing, detection: d, provider: connection.provider }));
      })
      .catch(e => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [path, connection.id]);

  useEffect(() => {
    if (!isAzure) return;
    let live = true;
    api.connectionRepos(connection.id).then(r => { if (live) setRepos(r.repos); }).catch(() => undefined);
    return () => { live = false; };
  }, [isAzure, connection.id]);

  const repoOwner = form && isAzure ? parseRepo(form.repo, 'azure-devops')?.owner : undefined;
  useEffect(() => {
    if (!isAzure || !repoOwner) { setProc(null); return; }
    let live = true;
    api.connectionProcess(connection.id, repoOwner)
      .then(r => { if (live) setProc({ owner: repoOwner, info: r.process }); })
      .catch(e => { if (live) setProc({ owner: repoOwner, info: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [isAzure, connection.id, repoOwner]);

  const existing = loaded?.existing;
  const check = useMemo(() => (form ? validateMapping(form, policy) : { ok: false, errors: {} }), [form, policy]);
  const defaultMap = isAzure ? CATEGORY_STATE_MAP : DEFAULT_STATE_MAP;
  const customised = form ? STATE_ROWS.some(r => form.stateMap[r.id] !== defaultMap[r.id]) : false;
  const set = (patch: Partial<MappingForm>): void => { setForm(f => (f ? { ...f, ...patch } : f)); setTouched(true); };

  const chooseLanding = (landing: 'local' | 'pr'): void => {
    if (!form) return;
    if (landing === 'local') { set({ landing: 'local', prConfirmed: false }); setConfirming(false); return; }
    if (!landingNeedsConfirm({ landing: 'pr' }, existing)) { set({ landing: 'pr' }); return; }
    setConfirming(true);
  };

  const save = async (): Promise<void> => {
    if (!form) return;
    setTouched(true);
    const body = mappingBody(path, form, existing);
    if (!check.ok || !body) { setError(!body && check.ok ? 'Choose how work lands first.' : 'Fix the highlighted fields first.'); return; }
    setSaving(true); setError(null);
    try {
      await api.connectionMap(body);
      onSaved(`${connection.label} is now used for ${projects.find(p => p.path === path)?.name ?? basename(path)}${form.landing === 'pr' ? ', in pull request mode' : ''}.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const unmap = async (): Promise<void> => {
    setRemoving(true); setError(null);
    try { await api.connectionUnmap(path); onSaved(`${connection.label} is no longer used for ${projects.find(p => p.path === path)?.name ?? basename(path)}. Tasks and pull requests already made stay as they are.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setConfirmRemove(false); }
    finally { setRemoving(false); }
  };

  const busy = saving || removing;
  const err = touched ? check.errors : {};

  return (
    <Modal title={`Use ${connection.label} for a project`} onClose={onClose} busy={busy} width="max-w-xl">
      {projects.length > 1 ? (
        <div className="mb-4">
          <label className={LABEL} htmlFor={`${uid}-project`}>Project</label>
          <select id={`${uid}-project`} className={INPUT} value={path} disabled={busy} onChange={e => setPath(e.target.value)}>
            {projects.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}
          </select>
        </div>
      ) : (
        <p className="mb-4 text-[13px] text-aico-secondary">Project: <span className="font-medium text-aico-primary">{projects[0]?.name ?? basename(path)}</span></p>
      )}

      {loadError && <ErrorLine>Could not read this project&rsquo;s connection: {loadError}</ErrorLine>}
      {!form && !loadError && <div className="space-y-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-10" /><Skeleton className="h-24" /><Skeleton className="h-16" /></div>}

      {form && loaded && (
        <form className="space-y-5" onSubmit={e => { e.preventDefault(); void save(); }} noValidate>
          {loaded.other && <Callout tone="warning">This project already uses <strong>{loaded.other}</strong>. A project has one connection, so saving replaces it.</Callout>}

          {/* Repository */}
          <section aria-label="Repository">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div>
                <label className={LABEL} htmlFor={`${uid}-repo`}>{isAzure ? 'Project / repository' : 'Repository'} on {providerLabel(connection.provider)}</label>
                <input
                  id={`${uid}-repo`} className={INPUT} value={form.repo} onChange={e => set({ repo: e.target.value })} placeholder={isAzure ? 'Shop/web' : 'owner/name'}
                  autoComplete="off" spellCheck={false} aria-invalid={Boolean(err.repo)} aria-describedby={`${uid}-repo-note`}
                  {...(isAzure && repos.length ? { list: `${uid}-repos` } : {})}
                />
                {isAzure && repos.length > 0 && <datalist id={`${uid}-repos`}>{repos.map(r => <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`} />)}</datalist>}
              </div>
              <div>
                <label className={LABEL} htmlFor={`${uid}-trunk`}>Branch</label>
                <input
                  id={`${uid}-trunk`} className={`${INPUT} font-mono`} value={form.trunk} onChange={e => set({ trunk: e.target.value })}
                  autoComplete="off" spellCheck={false} aria-invalid={Boolean(err.trunk)}
                />
              </div>
            </div>
            <p id={`${uid}-repo-note`} className={`mt-1 text-[12px] ${err.repo || err.trunk ? 'text-aico-danger' : 'text-aico-muted'}`}>
              {err.repo ?? err.trunk ?? (loaded.detection?.origin ? `Read from this project's origin: ${loaded.detection.origin}` : 'No origin remote was found. Type the repository.')}
            </p>
          </section>

          {/* Landing */}
          <fieldset>
            <legend className={LABEL}>Where finished work goes</legend>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Where finished work goes">
              <LandingChoice
                on={form.landing === 'local' && !confirming} onPick={() => chooseLanding('local')}
                title="On this computer" body={`Approved work is merged into ${form.trunk || 'the trunk'} here. Nothing is pushed.`}
              />
              <LandingChoice
                on={form.landing === 'pr' || confirming} onPick={() => chooseLanding('pr')}
                disabled={!pol.prAllowed || !canPulls}
                title="Pull request" body="AICO pushes a branch and opens a pull request. The remote's checks and reviews decide when it lands."
                {...(!pol.prAllowed ? { why: 'Your organization does not allow pull request mode.' } : !canPulls ? { why: 'This token cannot open pull requests. Test the connection to see what is missing.' } : {})}
              />
            </div>
            {err.landing && <p className="mt-1 text-[12px] text-aico-danger">{err.landing}</p>}
            {confirming && (
              <Callout tone="warning" role="alert" className="mt-3">
                <p className="font-medium">Switch to pull request mode?</p>
                <p className="mt-1 text-aico-secondary">{prConfirmText(form.repo.trim())}</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button type="button" className={BTN_PRIMARY} onClick={() => { set({ landing: 'pr', prConfirmed: true }); setConfirming(false); }}>Use pull request mode</button>
                  <button type="button" className={BTN_GHOST} onClick={() => setConfirming(false)}>Keep it local</button>
                </div>
              </Callout>
            )}
          </fieldset>

          {/* Work items */}
          <fieldset>
            <legend className={LABEL}>Tasks from the remote</legend>
            {canItems ? (
              <>
                <div className="grid gap-1.5" role="radiogroup" aria-label="Tasks from the remote">
                  {options.map(o => (
                    <label key={o.id} className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] ${form.source === o.id ? 'border-aico-accent bg-aico-accent-soft' : 'border-aico-border-subtle hover:bg-aico-hover'}`}>
                      <input type="radio" name={`${uid}-source`} className="mt-0.5 accent-[var(--aico-accent)]" checked={form.source === o.id} onChange={() => set({ source: o.id })} />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-aico-primary">{o.label}</span>
                        <span className="block text-[12px] text-aico-secondary">{o.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {options.find(o => o.id === form.source)?.valueLabel && (
                  <div className="mt-2">
                    <label className={LABEL} htmlFor={`${uid}-value`}>{options.find(o => o.id === form.source)?.valueLabel}</label>
                    <input
                      id={`${uid}-value`} className={INPUT} value={form.value} onChange={e => set({ value: e.target.value })}
                      placeholder={options.find(o => o.id === form.source)?.placeholder} autoComplete="off" spellCheck={false} aria-invalid={Boolean(err.value)}
                    />
                    {err.value && <p className="mt-1 text-[12px] text-aico-danger">{err.value}</p>}
                  </div>
                )}
                {form.source !== 'off' && <p className="mt-2 text-[12px] text-aico-muted">Imported items arrive in Backlog. Nothing starts until you move it to Ready.</p>}
              </>
            ) : (
              <p className="text-[12.5px] text-aico-secondary">This connection cannot read work items, so tasks stay on the board.</p>
            )}
          </fieldset>

          {/* Sprints */}
          {canIterations && canItems && (
            <fieldset>
              <legend className={LABEL}>Sprints</legend>
              <label className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] ${form.iterations === 'native' ? 'border-aico-accent bg-aico-accent-soft' : 'border-aico-border-subtle hover:bg-aico-hover'}`}>
                <input
                  type="checkbox" className="mt-0.5 accent-[var(--aico-accent)]" checked={form.iterations === 'native'}
                  onChange={e => set({ iterations: e.target.checked ? 'native' : 'off' })}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-aico-primary">Mirror {isAzure ? 'Azure DevOps iterations' : 'the platform’s sprints'} as Scrum sprints</span>
                  <span className="block text-[12px] text-aico-secondary">
                    The current and next one arrive as planned sprints with the platform’s name and dates; story points and sprint membership follow it (the platform wins when both changed). AICO never starts a sprint, and creates none on the platform unless you ask.
                  </span>
                </span>
              </label>
            </fieldset>
          )}

          {/* State names */}
          <details open={customised || isAzure} className="rounded-lg border border-aico-border-subtle">
            <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-[13px] text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
              State names on the remote <span className="text-aico-muted">{customised ? '(customised)' : '(defaults)'}</span>
            </summary>
            <div className="border-t border-aico-border-subtle px-3 py-3">
              <p className="mb-2 text-[12px] text-aico-muted">{isAzure
                ? 'What AICO does on the work item when a task reaches each state: move it to the work item type’s own state of that category (Proposed, InProgress, Resolved or Completed), or add a tag. It only moves items forward and never reopens one.'
                : 'What AICO writes to the remote when a task reaches each state: a label, or a status name. AICO writes only its own fields.'}</p>
              <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
                {STATE_ROWS.map(r => (
                  <div key={r.id}>
                    <label className="mb-0.5 block text-[12px] text-aico-secondary" htmlFor={`${uid}-st-${r.id}`}>{r.label}</label>
                    <input
                      id={`${uid}-st-${r.id}`} className={`${INPUT} font-mono !py-1.5 !text-[12.5px]`} value={form.stateMap[r.id] ?? ''}
                      onChange={e => set({ stateMap: { ...form.stateMap, [r.id]: e.target.value } })} autoComplete="off" spellCheck={false}
                      aria-invalid={Boolean(err.states?.[r.id])}
                    />
                    {err.states?.[r.id] && <p className="mt-0.5 text-[11.5px] text-aico-danger">{err.states[r.id]}</p>}
                  </div>
                ))}
              </div>
              {customised && <button type="button" className={`${BTN_GHOST} mt-2 !px-2 !py-1 !text-[12px]`} onClick={() => set({ stateMap: stateMapOf(undefined, connection.provider) })}>Reset to defaults</button>}
              {isAzure && <StatePreview stateMap={form.stateMap} proc={proc} hasProject={Boolean(repoOwner)} />}
            </div>
          </details>

          {/* Advanced */}
          <details className="rounded-lg border border-aico-border-subtle">
            <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-[13px] text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">Advanced</summary>
            <div className="border-t border-aico-border-subtle px-3 py-3">
              <label className={LABEL} htmlFor={`${uid}-trusted`}>Also trust comments from</label>
              <input
                id={`${uid}-trusted`} className={INPUT} value={form.trustedCommenters} onChange={e => set({ trustedCommenters: e.target.value })}
                placeholder="logins, separated by commas" autoComplete="off" spellCheck={false}
              />
              <p className="mt-1 text-[12px] text-aico-muted">Review comments from members and collaborators reach the agent. Comments from anyone else are shown to you only, unless you list them here.</p>
            </div>
          </details>

          {error && <ErrorLine>{error}</ErrorLine>}

          <div className="flex flex-wrap items-center gap-2 border-t border-aico-border-subtle pt-4">
            <button type="submit" className={BTN_PRIMARY} disabled={busy || confirming}>
              {saving ? <><Spinner />Saving…</> : existing ? 'Save changes' : 'Use for this project'}
            </button>
            <button type="button" className={BTN_GHOST} disabled={busy} onClick={onClose}>Cancel</button>
            <span className="flex-1" />
            {existing && !confirmRemove && <button type="button" className={`${BTN_GHOST} !text-aico-danger`} disabled={busy} onClick={() => setConfirmRemove(true)}>Stop using for this project</button>}
          </div>
          {existing && confirmRemove && (
            <Callout tone="danger" role="alert">
              <p className="font-medium">Stop using {connection.label} for this project?</p>
              <p className="mt-0.5 text-aico-secondary">Syncing and pull requests stop. Tasks already imported and pull requests already open stay as they are.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={`${BTN_OUTLINE} !border-aico-danger`} disabled={removing} onClick={() => void unmap()}>{removing ? 'Removing…' : 'Stop using'}</button>
                <button type="button" className={BTN_GHOST} disabled={removing} onClick={() => setConfirmRemove(false)}>Keep it</button>
              </div>
            </Callout>
          )}
        </form>
      )}
    </Modal>
  );
}

/** What each state would become, per work item type of the project's process: the same function the engine writes with. */
function StatePreview({ stateMap, proc, hasProject }: { stateMap: Record<string, string>; proc: { owner: string; info: ProcessInfo | null; error?: string } | null; hasProject: boolean }): React.ReactElement {
  if (!hasProject) return <p className="mt-3 text-[12px] text-aico-muted">Enter the project above to see which state each type would move to.</p>;
  if (!proc) return <p className="mt-3 text-[12px] text-aico-muted" aria-busy="true">Reading the project&rsquo;s process…</p>;
  if (!proc.info) return <p className="mt-3 text-[12px] text-aico-secondary">{proc.error ? `The project’s states could not be read: ${proc.error}` : 'The project’s work item states could not be read with this token (it needs Work Items: read).'}</p>;
  const rows = azureStatePreview(stateMap, proc.info, STATE_ROWS.map(r => r.id));
  const types = proc.info.types.slice(0, 4);
  return (
    <div className="mt-3 overflow-x-auto" data-testid="state-preview">
      <p className="mb-1.5 text-[12px] text-aico-secondary">{processSummary(proc.info)}</p>
      <table className="w-full min-w-[420px] border-collapse text-left text-[12px]">
        <caption className="sr-only">The work item state each AICO state moves an item to, per work item type</caption>
        <thead>
          <tr className="text-aico-muted">
            <th scope="col" className="py-1 pr-3 font-medium">When a task is</th>
            <th scope="col" className="py-1 pr-3 font-medium">Becomes</th>
            {types.map(t => <th key={t.name} scope="col" className="py-1 pr-3 font-medium">{t.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.aico} className="border-t border-aico-border-subtle">
              <th scope="row" className="py-1 pr-3 font-normal text-aico-primary">{STATE_ROWS.find(s => s.id === r.aico)?.label ?? r.aico}</th>
              {r.kind === 'tag'
                ? <td colSpan={types.length + 1} className="py-1 pr-3 text-aico-secondary">adds the tag <span className="font-mono">{r.value}</span></td>
                : <>
                  <td className="py-1 pr-3 font-mono text-aico-secondary">{r.value}</td>
                  {types.map(t => {
                    const cell = r.perType.find(p => p.type === t.name)?.state;
                    return <td key={t.name} className={`py-1 pr-3 ${cell ? 'text-aico-primary' : 'text-aico-muted'}`}>{cell ?? 'left as it is'}</td>;
                  })}
                </>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LandingChoice({ on, onPick, title, body, disabled, why }: {
  on: boolean; onPick: () => void; title: string; body: string; disabled?: boolean; why?: string;
}): React.ReactElement {
  return (
    <button
      type="button" role="radio" aria-checked={on} aria-disabled={disabled} onClick={() => { if (!disabled) onPick(); }} title={why}
      className={`rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent ${
        on ? 'border-aico-accent bg-aico-accent-soft' : disabled ? 'cursor-not-allowed border-aico-border-subtle opacity-60' : 'border-aico-border-subtle hover:bg-aico-hover'}`}
    >
      <span className="block text-[13px] font-medium text-aico-primary">{title}</span>
      <span className="mt-0.5 block text-[12px] leading-snug text-aico-secondary">{why ?? body}</span>
    </button>
  );
}
