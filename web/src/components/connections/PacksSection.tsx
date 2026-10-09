/**
 * Connectors built by AICO (ADR 0039 section 3): the Packs list on the Connections page, the review
 * card a person reads before enabling one, and the buttons that follow.
 *
 * WHY a review card and not a switch. A pack is data an agent wrote that decides which hosts get
 * your token and which requests may be sent with it. Enabling it is therefore the one moment a
 * person looks at all of it: the hosts, how the token is sent, every operation grouped by what it
 * can change (read, write, cannot-be-undone), the classes the engine raised above what the file
 * claimed, and what failed its test and stays off. The button sends the digest of the content on
 * the card, and the engine refuses it if the pack changed since; "Needs re-approval" is the same
 * card again after any edit.
 *
 * Colour is never the only signal: statuses are words, the class of each operation is a word.
 *
 * What it does not do: write or edit a pack (the agent does, in a chat), hold a token, or enable
 * anything on its own: the engine refuses enable, disable and connect on the API token alone.
 *
 * @module web/components/connections/PacksSection
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { Connection } from '../../../../shared/connections/types';
import type { ConnectorPackView, PackOperationView } from '../../../../shared/connections/packs';
import { canEnablePack, packChip, packReview, packSummary } from '../../connections';
import { BTN_GHOST, BTN_OUTLINE, BTN_PRIMARY, Callout, ErrorLine, Modal, Pill, Skeleton, Spinner } from '../delivery/ui';
import { DvIcon } from '../delivery/icons';
import { ChipPill } from './parts';

const CLASS_WORD: Record<PackOperationView['effective'], string> = { read: 'Reads', external: 'Writes', destructive: 'Cannot be undone' };

export function PacksSection({ allowed, reloadKey, onConnected, onAsk }: {
  /** The organisation allows connector packs. */
  allowed: boolean;
  /** Bump to reload (after the agent drafts something in another window). */
  reloadKey?: number;
  onConnected: (c: Connection) => void;
  /** "Ask AICO to build one": opens a chat with the instruction in the composer. */
  onAsk: () => void;
}): React.ReactElement | null {
  const [packs, setPacks] = useState<ConnectorPackView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api.connectionPacks();
      if (alive.current) { setPacks(r.packs); setError(null); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, reloadKey]);
  // The agent may be drafting in a chat while this page is open: look again when the window regains focus.
  useEffect(() => {
    const on = (): void => { void refresh(); };
    window.addEventListener('focus', on);
    return () => window.removeEventListener('focus', on);
  }, [refresh]);

  if (packs === null && !error) return <Skeleton className="h-[52px]" />;
  if ((packs ?? []).length === 0 && !error) return null;
  const review = packs?.find(p => p.id === reviewing);

  return (
    <section aria-label="Connectors built by AICO" className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="min-w-0 flex-1 text-[14px] font-semibold text-aico-primary">Connectors built by AICO</h3>
        {allowed && <button type="button" className={BTN_OUTLINE} onClick={onAsk}><DvIcon name="plus" size={14} />Ask AICO to build another</button>}
      </div>
      <p className="text-[12.5px] leading-relaxed text-aico-secondary">
        For platforms AICO has no built-in support for. AICO writes the connector and tests it against recorded examples; you review what it may do and switch it on.
        Any later edit switches it off until you approve it again.
      </p>
      {notice && <Callout tone="success" role="status" onDismiss={() => setNotice(null)}>{notice}</Callout>}
      {error && <ErrorLine>Could not load connectors: {error}</ErrorLine>}
      <ul className="space-y-2" aria-label="Connector packs">
        {(packs ?? []).map(p => (
          <li key={p.id}>
            <PackCard
              pack={p} onReview={() => setReviewing(p.id)} onChanged={next => setPacks(cur => (cur ?? []).map(x => (x.id === next.id ? next : x)))}
              onConnected={c => { onConnected(c); setNotice(`${c.label} was added. Paste its token to finish: it goes to the vault, bound to the approved hosts.`); void refresh(); }}
              onDisabled={() => setNotice(`${p.label} is switched off.`)}
            />
          </li>
        ))}
      </ul>
      {review && (
        <ReviewDialog
          pack={review} onClose={() => setReviewing(null)}
          onChanged={next => { setPacks(cur => (cur ?? []).map(x => (x.id === next.id ? next : x))); }}
          onEnabled={next => { setReviewing(null); setNotice(`${next.label} is enabled for exactly the content you reviewed. Add a connection from it below.`); void refresh(); }}
        />
      )}
    </section>
  );
}

function PackCard({ pack: p, onReview, onChanged, onConnected, onDisabled }: {
  pack: ConnectorPackView; onReview: () => void; onChanged: (p: ConnectorPackView) => void; onConnected: (c: Connection) => void; onDisabled: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<'test' | 'connect' | 'disable' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> => {
    setBusy(what); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const plainHttp = p.baseUrl.startsWith('http:');
  return (
    <article className="rounded-xl border border-aico-border-subtle bg-aico-bg" aria-label={p.label}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="truncate text-[14px] font-medium text-aico-primary">{p.label}</h4>
            <ChipPill chip={packChip(p)} />
          </div>
          <p className="mt-0.5 truncate text-[12px] text-aico-muted">
            {p.provider} · <span className="font-mono" title={p.hosts.join(', ')}>{p.hosts.join(', ') || 'no hosts'}</span>
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-aico-secondary">{p.status === 'enabled' || p.status === 'tests-passing' ? packSummary(p) : p.statusDetail}</p>
          {p.blockedByPolicy && <p className="mt-1 text-[12.5px] text-aico-danger">{p.blockedByPolicy}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={BTN_OUTLINE} disabled={busy !== null || p.status === 'invalid' || Boolean(p.blockedByPolicy)} onClick={() => void run('test', async () => { onChanged(await api.connectionPackTest(p.id)); })}>
            {busy === 'test' ? <><Spinner />Testing…</> : 'Test'}
          </button>
          {p.status !== 'enabled' && (
            <button type="button" className={BTN_PRIMARY} onClick={onReview} disabled={busy !== null || p.status === 'invalid'}>Review and enable…</button>
          )}
          {p.status === 'enabled' && p.connections.length === 0 && (
            <button type="button" className={BTN_PRIMARY} disabled={busy !== null || Boolean(p.blockedByPolicy)} onClick={() => void run('connect', async () => { onConnected(await api.connectionPackConnect(p.id, plainHttp)); })}>
              {busy === 'connect' ? <><Spinner />Adding…</> : 'Add a connection'}
            </button>
          )}
          {p.status === 'enabled' && (
            <button type="button" className={BTN_GHOST} disabled={busy !== null} onClick={() => void run('disable', async () => { onChanged(await api.connectionPackDisable(p.id)); onDisabled(); })}>Switch off</button>
          )}
        </div>
      </div>
      {p.status === 'invalid' && (
        <div className="px-4 pb-3">
          <button type="button" className="text-[12.5px] text-aico-accent hover:underline" aria-expanded={showErrors} onClick={() => setShowErrors(s => !s)}>{showErrors ? 'Hide the problems' : 'Show the problems'}</button>
          {showErrors && <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] text-aico-secondary">{p.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      )}
      {error && <div className="px-4 pb-3"><ErrorLine>{error}</ErrorLine></div>}
    </article>
  );
}

function ClassPill({ cls }: { cls: PackOperationView['effective'] }): React.ReactElement {
  return <Pill tone={cls === 'read' ? 'neutral' : cls === 'external' ? 'warning' : 'danger'}>{CLASS_WORD[cls]}</Pill>;
}

function OpList({ title, ops, note }: { title: string; ops: PackOperationView[]; note?: string }): React.ReactElement | null {
  if (ops.length === 0) return null;
  return (
    <section aria-label={title}>
      <h4 className="mb-1 text-[12px] font-medium text-aico-secondary">{title}</h4>
      {note && <p className="mb-1.5 text-[12.5px] text-aico-secondary">{note}</p>}
      <ul className="overflow-hidden rounded-lg border border-aico-border-subtle">
        {ops.map(o => (
          <li key={o.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-aico-border-subtle px-3 py-2 text-[12.5px] last:border-b-0">
            <span className="font-mono text-[12px] text-aico-primary">{o.name}</span>
            <ClassPill cls={o.effective} />
            {o.declared !== o.effective && <span className="text-[11.5px] text-aico-warning">the file said {CLASS_WORD[o.declared].toLowerCase()}</span>}
            {o.readOnlyPost && <span className="text-[11.5px] text-aico-muted">read sent as POST</span>}
            <span className="min-w-0 flex-1 basis-60 truncate font-mono text-[11.5px] text-aico-muted" title={o.does}>{o.does}</span>
            {o.contract === 'failed' && <span className="text-[11.5px] text-aico-danger" title={o.detail}>failed its test</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewDialog({ pack, onClose, onChanged, onEnabled }: {
  pack: ConnectorPackView; onClose: () => void; onChanged: (p: ConnectorPackView) => void; onEnabled: (p: ConnectorPackView) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<'enable' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The digest of the content this card was drawn from: what Enable approves. If the pack moves, the card says so.
  const [seen] = useState(pack.hash);
  const moved = pack.hash !== seen;
  const r = packReview(pack);
  const can = canEnablePack(pack);
  const act = async (what: 'enable' | 'test'): Promise<void> => {
    setBusy(what); setError(null);
    try {
      if (what === 'test') onChanged(await api.connectionPackTest(pack.id));
      else onEnabled(await api.connectionPackEnable(pack.id, seen));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try { onChanged((await api.connectionPacks()).packs.find(x => x.id === pack.id) ?? pack); } catch { /* the message above stands */ }
    } finally { setBusy(null); }
  };
  return (
    <Modal title={`Review ${pack.label}`} onClose={onClose} width="max-w-2xl" busy={busy !== null}>
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-aico-secondary">
          AICO wrote this connector for <strong className="font-medium text-aico-primary">{pack.provider}</strong>. If you enable it, AICO may send requests to the hosts below with the token you add, and nowhere else.
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-aico-muted">Hosts</dt><dd className="font-mono text-aico-primary">{pack.hosts.join(', ')}</dd>
          <dt className="text-aico-muted">Token is sent as</dt><dd className="text-aico-primary">{pack.auth}</dd>
          {pack.authHelp && <><dt className="text-aico-muted">Token help</dt><dd className="text-aico-secondary">{pack.authHelp}</dd></>}
          {pack.mcpServers.length > 0 && <><dt className="text-aico-muted">Uses MCP servers</dt><dd className="font-mono text-aico-primary">{pack.mcpServers.join(', ')}</dd></>}
          <dt className="text-aico-muted">Content</dt><dd className="font-mono text-aico-primary" title={seen}>{seen.slice(0, 12)}</dd>
        </dl>
        {moved && <Callout tone="warning" role="alert">This connector changed while the card was open. Close it and review the new content.</Callout>}
        <OpList title="It can read" ops={r.reads} />
        <OpList title="It can write to the platform" ops={r.writes} note="These change things there: comments, status changes, new pull requests." />
        <OpList title="It can do things that cannot be undone" ops={r.destructive} note="These run only when you click for them in AICO, one at a time." />
        {r.raised.length > 0 && (
          <Callout tone="warning">
            AICO raised the class of {r.raised.map(o => o.name).join(', ')} above what the connector file claimed, because of what the operation is.
          </Callout>
        )}
        {r.off.length > 0 && <OpList title="Stays off (failed or untested)" ops={r.off} />}
        {pack.warnings.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-aico-secondary">{pack.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}</ul>
        )}
        {!can.ok && pack.status !== 'enabled' && <Callout tone="info" role="status">{can.why}</Callout>}
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_PRIMARY} disabled={!can.ok || moved || busy !== null} onClick={() => void act('enable')}>
            {busy === 'enable' ? <><Spinner />Enabling…</> : 'Enable this connector'}
          </button>
          <button type="button" className={BTN_OUTLINE} disabled={busy !== null} onClick={() => void act('test')}>
            {busy === 'test' ? <><Spinner />Testing…</> : 'Run the test again'}
          </button>
          <button type="button" className={BTN_GHOST} disabled={busy !== null} onClick={onClose}>Not now</button>
        </div>
        <p className="text-[11.5px] text-aico-muted">Enabling approves exactly this content. If anything in it changes, it switches off until you approve again.</p>
      </div>
    </Modal>
  );
}
