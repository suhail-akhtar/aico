/**
 * Settings → Connections: the team's forge and tracker, in one place.
 *
 * One list, one add flow, one mapping dialog (ADR 0039 section 5). A row says what the
 * connection is (provider, name, host), whether it works (a status chip and, when it does
 * not, one sentence why), and which projects use it. Everything else is behind the row's
 * menu: Test, Turn off or on, Remove. There is no per-provider section and no setting that
 * is not a property of a connection or of a project's use of one.
 *
 * Shared by the web portal's Settings window and the desktop's Settings (both render this
 * component), and by the Delivery board, which opens the same add flow in a dialog from its
 * "Connect GitHub for this repo?" hint (`ConnectDialog`).
 *
 * Managed policy is shown, not enforced here: a banner says what the organisation limits,
 * and the tiles and options it forbids are disabled with the reason. The engine enforces it
 * again at every route.
 *
 * What it does not do: hold a token (the add flow's input is uncontrolled), decide what a
 * scope is worth (the probe does), or create a connection without a person: the engine
 * refuses create, credential, update, remove and map on the API token alone.
 *
 * @module web/components/connections/ConnectionsPage
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Portal } from '../Portal';
import { api } from '../../api';
import { useStore } from '../../store';
import { basename } from '../../grouping';
import type { Connection, ProviderId } from '../../../../shared/connections/types';
import { connectionStatus, connectorPrompt, packsAllowed, policyView, providerInfo, providerLabel } from '../../connections';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, Callout, ErrorLine, Modal, Skeleton, Spinner } from '../delivery/ui';
import { DvIcon } from '../delivery/icons';
import { AddConnection } from './AddConnection';
import { MappingDialog } from './MappingDialog';
import { PacksSection } from './PacksSection';
import { Monogram, ProbePanel, StatusPill } from './parts';
import { TokenForm } from './TokenForm';
import { useConnections } from './useConnections';

type ProjectOption = { path: string; name: string };

function useProjectOptions(): { project: string | undefined; projects: ProjectOption[] } {
  const current = useStore(s => s.project);
  const registered = useStore(s => s.projects);
  const projects = useMemo(() => registered.map(p => ({ path: p.path, name: p.name ?? basename(p.path) })), [registered]);
  const project = current && projects.some(p => p.path === current) ? current : projects[0]?.path;
  return { project, projects };
}

export function ConnectionsPane({ startChat }: {
  /** Open a new chat with this text in the composer (the host closes its Settings window / navigates). Default: a new chat in the store. */
  startChat?: (prompt: string) => void;
} = {}): React.ReactElement {
  const data = useConnections();
  const { project, projects } = useProjectOptions();
  const [adding, setAdding] = useState(false);
  const [mapFor, setMapFor] = useState<Connection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pol = policyView(data.policy);
  const { connections, loading, error } = data;
  const askConnector = useCallback((): void => {
    const prompt = connectorPrompt();
    if (startChat) { startChat(prompt); return; }
    const st = useStore.getState();
    st.newSession();
    st.prefillComposer(prompt);
    setAdding(false);
    setNotice('A new chat is ready with the instruction in the composer. Read it, then press Enter to send.');
  }, [startChat]);

  // The "ago" and rate-limit wording ticks over once a minute, not on every render.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const projectName = (path: string): string => projects.find(p => p.path === path)?.name ?? basename(path);
  const addButton = (
    <button type="button" className={BTN_PRIMARY} onClick={() => { setAdding(true); setNotice(null); }} disabled={pol.forbidden || adding}>
      <DvIcon name="plus" size={14} />Add connection
    </button>
  );

  return (
    <div className="space-y-4">
      {pol.banner && <Callout tone="warning" role="status">{pol.banner}</Callout>}
      {notice && <Callout tone="success" role="status" onDismiss={() => setNotice(null)}>{notice}</Callout>}

      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-aico-secondary">
          Connect a project to the place your team keeps its code and tasks. AICO can then import work items and open pull requests.
          Tokens go to the encrypted vault; the agent never sees one.
        </p>
        {connections.length > 0 && !adding && addButton}
      </div>

      {adding && (
        <AddConnection
          providers={data.providers} policy={data.policy} policyShownAbove
          projectName={project ? projectName(project) : undefined}
          onChanged={data.upsert}
          onUse={c => { setAdding(false); setMapFor(c); }}
          onCancel={removed => { if (removed) data.drop(removed); setAdding(false); }}
          onDone={() => { setAdding(false); void data.refresh(); }}
          onAskConnector={askConnector}
        />
      )}

      {error && !loading && (
        <div className="space-y-2">
          <ErrorLine>Could not load connections: {error}</ErrorLine>
          <button type="button" className={BTN_OUTLINE} onClick={() => void data.refresh()}><DvIcon name="refresh" size={14} />Try again</button>
        </div>
      )}
      {loading && <div className="space-y-2" aria-busy="true" aria-label="Loading connections"><Skeleton className="h-[68px]" /><Skeleton className="h-[68px]" /></div>}

      {!loading && !error && connections.length === 0 && !adding && (
        <div className="rounded-xl border border-dashed border-aico-border px-6 py-9 text-center">
          <DvIcon name="link" size={26} className="mx-auto text-aico-muted" />
          <p className="mt-3 text-[15px] font-medium text-aico-primary">No connections yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-aico-secondary">
            Add your team’s code host (GitHub, GitLab, Gitea, Azure DevOps and others) to import issues as tasks and to open pull requests for the work an agent finishes. It takes a minute and a token.
          </p>
          <div className="mt-4">{addButton}</div>
        </div>
      )}

      {connections.length > 0 && (
        <ul className="space-y-2" aria-label="Connections">
          {connections.map(c => (
            <li key={c.id}>
              <ConnectionRow
                connection={c} now={now} projectName={projectName} canMap={Boolean(project)}
                onChanged={data.upsert} onRemoved={data.drop}
                onMap={() => setMapFor(c)} onNotice={setNotice}
              />
            </li>
          ))}
        </ul>
      )}

      <PacksSection allowed={packsAllowed(data.policy)} onAsk={askConnector} onConnected={c => { data.upsert(c); }} />

      {mapFor && project && (
        <MappingDialog
          connection={mapFor} project={project} projects={projects} policy={data.policy}
          onClose={() => setMapFor(null)}
          onSaved={m => { setMapFor(null); setNotice(m); void data.refresh(); }}
        />
      )}
    </div>
  );
}

// ── a row ────────────────────────────────────────────────────────────────

function ConnectionRow({ connection: c, now, projectName, canMap, onChanged, onRemoved, onMap, onNotice }: {
  connection: Connection; now: number; projectName: (path: string) => string; canMap: boolean;
  onChanged: (c: Connection) => void; onRemoved: (id: string) => void; onMap: () => void; onNotice: (m: string) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<'test' | 'toggle' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const status = connectionStatus(c, now);
  const off = status.label === 'Off';

  const test = async (): Promise<void> => {
    setBusy('test'); setError(null);
    try { const t = await api.connectionTest(c.id); onChanged(t); setOpen(true); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const toggle = async (): Promise<void> => {
    setBusy('toggle'); setError(null);
    try { onChanged(await api.connectionUpdate(c.id, { disabled: !c.disabled })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const remove = async (): Promise<void> => {
    setBusy('remove'); setError(null);
    try { await api.connectionRemove(c.id); onRemoved(c.id); onNotice(`${c.label} was removed, with its stored token.`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(null); setConfirmRemove(false); }
  };

  return (
    <article className={`rounded-xl border border-aico-border-subtle bg-aico-bg ${off ? 'opacity-80' : ''}`} aria-label={c.label}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Monogram provider={c.provider} />
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="truncate text-[14px] font-medium text-aico-primary">{c.label}</h4>
            <StatusPill status={status} />
          </div>
          <p className="mt-0.5 truncate text-[12px] text-aico-muted">
            {providerLabel(c.provider)} · <span className="font-mono" title={c.baseUrl}>{c.host}</span>
            {c.createdBy === 'agent' ? ' · set up by the agent' : ''}
          </p>
          {status.reason && <p className="mt-1 text-[12.5px] leading-snug text-aico-secondary">{status.reason}</p>}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Projects using this connection">
          {c.projects.length === 0 ? <span className="text-[12px] text-aico-muted">No project yet</span> : c.projects.slice(0, 2).map(p => (
            <span key={p} title={p} className="max-w-[130px] truncate rounded-md bg-aico-hover px-1.5 py-px text-[11.5px] text-aico-secondary">{projectName(p)}</span>
          ))}
          {c.projects.length > 2 && <span className="text-[11.5px] text-aico-muted" title={c.projects.slice(2).map(projectName).join(', ')}>+{c.projects.length - 2}</span>}
        </div>

        <div className="flex items-center gap-1">
          {!off && c.hasCredential && canMap && (
            <button type="button" className={BTN_OUTLINE} onClick={onMap} disabled={busy !== null}>{c.projects.length ? 'Projects' : 'Use for a project'}</button>
          )}
          {!off && (!c.hasCredential || status.label === 'Needs attention') && (
            <button type="button" className={BTN_OUTLINE} onClick={() => setTokenOpen(o => !o)} aria-expanded={tokenOpen} disabled={busy !== null}>{c.hasCredential ? 'Replace token' : 'Add token'}</button>
          )}
          <RowMenu
            label={c.label} busy={busy !== null}
            items={[
              { id: 'test', label: busy === 'test' ? 'Testing…' : 'Test', disabled: off || !c.hasCredential, hint: off ? 'Turn it on first.' : !c.hasCredential ? 'Add a token first.' : undefined, run: () => void test() },
              { id: 'token', label: 'Replace token…', disabled: off, hint: 'Turn it on first.', run: () => setTokenOpen(true) },
              { id: 'toggle', label: c.disabled ? 'Turn on' : 'Turn off', run: () => void toggle() },
              { id: 'remove', label: 'Remove…', danger: true, run: () => setConfirmRemove(true) },
            ]}
          />
        </div>
      </div>

      {(c.probe || busy === 'test') && (
        <div className="border-t border-aico-border-subtle px-4 py-2">
          <button
            type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} disabled={!c.probe}
            className="inline-flex items-center gap-1.5 rounded-md py-1 text-[12.5px] text-aico-secondary hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
          >
            <DvIcon name="chevron" size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
            {busy === 'test' ? <span className="inline-flex items-center gap-1.5"><Spinner />Testing…</span> : 'What this connection can do'}
          </button>
          {open && c.probe && <div className="pb-2 pt-2"><ProbePanel connection={c} now={now} /></div>}
        </div>
      )}

      {tokenOpen && (
        <div className="px-4 pb-3">
          <TokenForm connection={c} onCancel={() => setTokenOpen(false)} onSaved={t => { onChanged(t); setTokenOpen(false); setOpen(true); }} />
        </div>
      )}

      {error && <div className="px-4 pb-3"><ErrorLine>{error}</ErrorLine></div>}

      {confirmRemove && (
        <div className="px-4 pb-3">
          <Callout tone="danger" role="alert">
            <p className="font-medium">Remove {c.label}?</p>
            <p className="mt-0.5 text-aico-secondary">
              This deletes the stored token{c.projects.length ? ` and stops using it for ${c.projects.length} project${c.projects.length === 1 ? '' : 's'}` : ''}.
              Tasks already imported and pull requests already open stay as they are.
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className={`${BTN_OUTLINE} !border-aico-danger`} disabled={busy === 'remove'} onClick={() => void remove()}>{busy === 'remove' ? 'Removing…' : 'Remove'}</button>
              <button type="button" className={BTN_GHOST} disabled={busy === 'remove'} onClick={() => setConfirmRemove(false)}>Keep it</button>
            </div>
          </Callout>
        </div>
      )}
    </article>
  );
}

// ── the row's overflow menu ──────────────────────────────────────────────

interface MenuItem { id: string; label: string; danger?: boolean; disabled?: boolean; hint?: string | undefined; run: () => void }

/** A menu button: opens under its trigger, arrow keys move, Escape closes and gives focus back. */
function RowMenu({ label, items, busy }: { label: string; items: MenuItem[]; busy: boolean }): React.ReactElement {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => { setAt(null); if (refocus) btn.current?.focus(); }, []);
  useEffect(() => {
    if (!at) return;
    const enabled = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    enabled()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const els = enabled();
      if (!els.length) return;
      e.preventDefault();
      const i = els.indexOf(document.activeElement as HTMLElement);
      els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
    };
    const onDown = (e: MouseEvent): void => { if (!menu.current?.contains(e.target as Node) && e.target !== btn.current) close(false); };
    const onResize = (): void => close(false);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown); window.removeEventListener('resize', onResize); };
  }, [at, close]);

  return (
    <>
      <button
        ref={btn} type="button" aria-haspopup="menu" aria-expanded={Boolean(at)} aria-label={`More actions for ${label}`} disabled={busy}
        onClick={() => { const r = btn.current!.getBoundingClientRect(); setAt(a => (a ? null : { x: Math.min(r.right, window.innerWidth - 8), y: r.bottom + 4 })); }}
        className="rounded-md p-1.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:opacity-50"
      >
        <DvIcon name="more" size={16} />
      </button>
      {at && (
        <Portal>
          <div
            ref={menu} role="menu" aria-label={`Actions for ${label}`}
            style={{ position: 'fixed', top: at.y, left: Math.max(8, at.x - 176), width: 176 }}
            className="z-[90] rounded-xl border border-aico-border bg-aico-bg p-1 shadow-xl"
          >
            {items.map(i => (
              <button
                key={i.id} type="button" role="menuitem" aria-disabled={i.disabled} title={i.disabled ? i.hint : undefined}
                onClick={() => { if (i.disabled) return; close(true); i.run(); }}
                className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] focus:outline-none ${
                  i.disabled ? 'cursor-not-allowed text-aico-muted' : i.danger ? 'text-aico-danger hover:bg-aico-hover focus:bg-aico-hover' : 'text-aico-primary hover:bg-aico-hover focus:bg-aico-hover'}`}
              >
                {i.label}
              </button>
            ))}
          </div>
        </Portal>
      )}
    </>
  );
}

// ── the add flow, opened from the Delivery board ─────────────────────────

/**
 * The add flow in a dialog, for the board's "Connect GitHub for this repo?" hint: the
 * provider is already chosen, the project is the board's, and finishing hands straight to
 * the mapping dialog, so a person goes from the hint to a connected board without leaving it.
 */
export function ConnectDialog({ project, projectName, provider, connection, onClose, onMapped }: {
  project: string;
  projectName: string;
  provider?: ProviderId | undefined;
  /** An existing connection to map instead of making a new one. */
  connection?: string | undefined;
  onClose: () => void;
  onMapped: (message: string) => void;
}): React.ReactElement {
  const data = useConnections();
  const [mapFor, setMapFor] = useState<Connection | null>(null);
  const existing = connection ? data.connections.find(c => c.id === connection) : undefined;
  const projects = useMemo(() => [{ path: project, name: projectName }], [project, projectName]);

  // An existing connection goes straight to the mapping step.
  useEffect(() => { if (existing && !mapFor) setMapFor(existing); }, [existing, mapFor]);

  if (mapFor) {
    return (
      <MappingDialog
        connection={mapFor} project={project} projects={projects} policy={data.policy}
        onClose={onClose} onSaved={onMapped}
      />
    );
  }
  const info = provider ? providerInfo(provider, data.providers) : undefined;
  return (
    <Modal title={info ? `Connect ${info.label}` : 'Add a connection'} onClose={onClose} width="max-w-3xl">
      {data.loading && connection ? <Skeleton className="h-32" /> : (
        <AddConnection
          providers={data.providers} policy={data.policy} projectName={projectName} initialProvider={provider}
          onChanged={data.upsert} onUse={c => setMapFor(c)} onCancel={onClose} onDone={onClose}
        />
      )}
    </Modal>
  );
}
