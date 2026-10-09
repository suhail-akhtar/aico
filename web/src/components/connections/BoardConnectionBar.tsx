/**
 * The Delivery board's line about its connection: which forge the project is tied to and
 * whether it is in sync, a Sync now action, a way to the Connections page, and, on a board
 * with no connection whose `origin` matches a known host, one quiet suggestion.
 *
 * "Zero-click discovery" (ADR 0039 section 5) means exactly that: the suggestion is a
 * single line with a Connect button and a Not now, never a modal that opens by itself and
 * never a prompt that comes back. Not now is remembered per project in this browser (a
 * convenience, not state: if storage is unavailable the line simply shows again).
 *
 * What it does not do: decide whether the project is connected (the board carries
 * `connection`, the engine's word) or sync by itself (the engine polls; this only asks it
 * to do it now).
 *
 * @module web/components/connections/BoardConnectionBar
 */

import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { refreshBoard } from '../../delivery';
import type { BoardConnection } from '../../../../shared/connections/types';
import { boardConnectionLabel, detectHint, landingWord, syncChip, syncResultLine, type DetectHint } from '../../connections';
import { BTN_GHOST, Spinner } from '../delivery/ui';
import { DvIcon } from '../delivery/icons';
import { ChipPill } from './parts';
import { ConnectDialog } from './ConnectionsPage';

const DISMISS_KEY = 'aico.connections.hint.dismissed';

function dismissed(project: string): boolean {
  try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]).includes(project); } catch { return false; }
}
function dismiss(project: string): void {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...new Set([...(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]), project])])); } catch { /* best effort: the line shows again */ }
}

/** Ask the engine whether this project's origin matches something we can connect; once per project, only while unconnected. */
function useRepoHint(project: string, enabled: boolean): DetectHint | null {
  const [hint, setHint] = useState<DetectHint | null>(null);
  useEffect(() => {
    setHint(null);
    if (!enabled || dismissed(project)) return;
    let live = true;
    Promise.all([api.connectionDetect(project), api.connectionList().catch(() => ({ connections: [] }))])
      .then(([det, list]) => { if (live) setHint(detectHint(det, list.connections, false)); })
      .catch(() => { /* a hint is optional: no engine support, no line */ });
    return () => { live = false; };
  }, [project, enabled]);
  return hint;
}

export function BoardConnectionBar({ project, projectName, connection, onOpenConnections, onInfo, onError }: {
  project: string;
  projectName: string;
  connection: BoardConnection | undefined;
  /** Absent in a host that has no Settings to open (the link is then left out). */
  onOpenConnections?: (() => void) | undefined;
  onInfo: (message: string) => void;
  onError: (message: string) => void;
}): React.ReactElement | null {
  const hint = useRepoHint(project, !connection);
  // "Synced 3m ago" must not freeze between board frames.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const [hidden, setHidden] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => { setHidden(false); setConnecting(false); }, [project]);

  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    try { onInfo(syncResultLine(await api.connectionSync(project))); void refreshBoard(); }
    catch (e) { onError(`Could not sync: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSyncing(false); }
  };

  const link = onOpenConnections && (
    <button type="button" onClick={onOpenConnections} className={`${BTN_GHOST} !px-2 !py-1 !text-[12.5px]`}>Connections</button>
  );

  if (connection) {
    const sync = syncChip(syncing ? { state: 'syncing' } : connection.sync, now);
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]" aria-label="Connection">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-aico-secondary" title={`${connection.label}. Finished work ${connection.landing === 'pr' ? 'goes to the remote as a pull request' : 'lands on this computer'}.`}>
          <DvIcon name="link" size={13} className="shrink-0 text-aico-muted" />
          <span className="truncate">{boardConnectionLabel(connection)}</span>
        </span>
        {connection.landing === 'pr' && <ChipPill chip={{ id: 'landing', label: landingWord('pr'), tone: 'info', title: 'Approving a task opens a pull request instead of landing it here.' }} />}
        <span role="status" aria-live="polite"><ChipPill chip={{ id: 'sync', label: sync.label, tone: sync.tone, ...(sync.title ? { title: sync.title } : {}) }} /></span>
        <button type="button" onClick={() => void syncNow()} disabled={syncing || connection.sync.state === 'blocked'} className={`${BTN_GHOST} !px-2 !py-1 !text-[12.5px]`} title="Pull work items and check pull requests now">
          {syncing ? <Spinner /> : <DvIcon name="refresh" size={13} />}Sync now
        </button>
        {link}
      </div>
    );
  }

  const showHint = hint && !hidden;
  if (!showHint && !link) return null;
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px]" aria-label="Connection">
        {showHint ? (
          <>
            <DvIcon name="link" size={13} className="shrink-0 text-aico-muted" />
            <span className="text-aico-primary">{hint.text}</span>
            {hint.detail && <span className="font-mono text-[12px] text-aico-muted">{hint.detail}</span>}
            <button type="button" onClick={() => setConnecting(true)} className="rounded-md px-2 py-1 text-[12.5px] font-medium text-aico-accent hover:bg-aico-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent">
              {hint.action === 'map' ? 'Use it' : 'Connect'}
            </button>
            <button type="button" onClick={() => { dismiss(project); setHidden(true); }} className={`${BTN_GHOST} !px-2 !py-1 !text-[12.5px]`}>Not now</button>
          </>
        ) : null}
        {link}
      </div>
      {connecting && showHint && (
        <ConnectDialog
          project={project} projectName={projectName} provider={hint.provider} connection={hint.action === 'map' ? hint.connection : undefined}
          onClose={() => setConnecting(false)}
          onMapped={m => { setConnecting(false); setHidden(true); onInfo(m); void refreshBoard(); }}
        />
      )}
    </>
  );
}
