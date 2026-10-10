/**
 * Organisation — sign in to AICO Control, the organisation server (ADR 0040).
 *
 * Shared by web Settings and the desktop's Organisation section, for the same
 * reason AboutYouPane is: what an organisation is allowed to impose on this
 * engine must be visible, and removable by the person, from every client.
 *
 * Sign-in is the device flow: the engine returns a code and an address, this
 * pane opens the address (the host chooses how: a browser tab on the web, the
 * system browser on the desktop) and polls. Signing in and out go to the
 * engine as a person (`postAsPerson`) because the API token alone must not be
 * able to point the engine at another server or shed the organisation's rules.
 *
 * The pane never receives a token; `GET /api/control` has none to give.
 *
 * @module components/settings/OrganisationPane
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ControlView } from '../../api';

export interface OrganisationPaneProps {
  /** Open the approval page. Default: a new browser tab. */
  openUrl?: (url: string) => void;
}

const btn = 'rounded-lg border border-aico-border px-3 py-1.5 text-[13px] text-aico-primary hover:bg-aico-hover disabled:opacity-50';

function ago(ms?: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function OrganisationPane({ openUrl }: OrganisationPaneProps = {}): React.ReactElement {
  const [view, setView] = useState<ControlView | null>(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState<{ userCode: string; verificationUri: string; complete: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try { setView(await api.control()); } catch { setView({ enrolled: false }); }
  }, []);
  useEffect(() => { void refresh(); return () => { if (timer.current) clearInterval(timer.current); }; }, [refresh]);

  const open = (u: string): void => { if (openUrl) openUrl(u); else window.open(u, '_blank', 'noopener'); };

  const signIn = async (): Promise<void> => {
    setBusy(true); setNote(null);
    try {
      const r = await api.controlLogin(url.trim());
      setCode({ userCode: r.userCode, verificationUri: r.verificationUri, complete: r.verificationUriComplete });
      open(r.verificationUriComplete);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => {
        void api.controlLoginState().then(s => {
          if (s.state === 'done') { if (timer.current) clearInterval(timer.current); setCode(null); void refresh(); }
          else if (s.state === 'error') { if (timer.current) clearInterval(timer.current); setCode(null); setNote(s.error ?? 'Sign-in failed.'); }
        }).catch(() => undefined);
      }, 2500);
    } catch (e) { setNote(e instanceof Error ? e.message : 'Could not start sign-in.'); } finally { setBusy(false); }
  };

  const signOut = async (): Promise<void> => {
    if (!window.confirm(`Sign out of ${view?.organisation?.name ?? 'your organisation'}? Its rules stop applying on this computer.`)) return;
    setBusy(true);
    try { await api.controlLogout(); setNote('Signed out.'); await refresh(); } catch (e) { setNote(e instanceof Error ? e.message : 'Could not sign out.'); } finally { setBusy(false); }
  };

  const syncNow = async (): Promise<void> => {
    setBusy(true);
    try { const r = await api.controlSync(); setNote(r.ok ? 'Synced.' : r.error ?? 'Sync failed.'); await refresh(); } catch (e) { setNote(e instanceof Error ? e.message : 'Sync failed.'); } finally { setBusy(false); }
  };

  if (!view) return <p className="text-aico-muted">Loading...</p>;

  if (!view.enrolled) {
    return (
      <div className="max-w-xl space-y-4" data-testid="organisation-signed-out">
        <p className="text-[13.5px] text-aico-secondary">
          Not signed in. If your organisation runs AICO Control, enter its address. You will approve this computer in your browser; AICO never sees your password.
        </p>
        <div className="flex gap-2">
          <input className="input h-9 flex-1" placeholder="https://aico.your-company.com" value={url} onChange={e => setUrl(e.target.value)} aria-label="AICO Control address" onKeyDown={e => { if (e.key === 'Enter' && url.trim()) void signIn(); }} />
          <button className={btn} disabled={busy || !url.trim()} onClick={() => void signIn()}>Sign in</button>
        </div>
        {code && (
          <div className="rounded-xl border border-aico-border bg-aico-surface p-4" data-testid="organisation-code">
            <div className="text-[12px] text-aico-muted">Approve this code in the browser window that opened</div>
            <div className="my-1 font-mono text-[22px] tracking-[0.14em]">{code.userCode}</div>
            <div className="text-[12.5px] text-aico-secondary">
              No window? Go to <a className="underline" href={code.verificationUri} onClick={e => { e.preventDefault(); open(code.verificationUri); }}>{code.verificationUri}</a> and type the code. Waiting for approval...
            </div>
          </div>
        )}
        {note && <p className="text-[13px] text-aico-danger" role="alert">{note}</p>}
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5" data-testid="organisation-signed-in">
      <div className="rounded-xl border border-aico-border bg-aico-surface p-4">
        <div className="text-[12px] uppercase tracking-wide text-aico-muted">Managed by your organisation</div>
        <div className="mt-1 text-[18px] font-semibold">{view.organisation?.name}</div>
        <div className="mt-0.5 text-[13px] text-aico-secondary">
          Signed in as {view.user?.email} · role <strong>{view.role}</strong>{view.team ? <> · team {view.team}</> : null}
        </div>
        <div className="mt-1 text-[12.5px] text-aico-muted">{view.url} · last contact {ago(view.lastContactAt)}</div>
        <div className="mt-3 flex gap-2">
          <button className={btn} disabled={busy} onClick={() => void syncNow()}>Sync now</button>
          <button className={btn} disabled={busy} onClick={() => void signOut()}>Sign out</button>
        </div>
      </div>
      {view.budget?.blocked && <p className="rounded-lg border border-aico-danger px-3 py-2 text-[13px] text-aico-danger" role="alert">{view.budget.reason}</p>}
      {view.offlineAllowanceUsedUp && <p className="rounded-lg border border-aico-danger px-3 py-2 text-[13px] text-aico-danger" role="alert">AICO has not reached your organisation for too long, so model calls are paused. Connect to the network.</p>}
      {view.lastError && <p className="text-[12.5px] text-aico-muted">Last problem: {view.lastError}</p>}
      {(view.rules?.length ?? 0) > 0 && (
        <div>
          <h3 className="mb-1 text-[13px] font-semibold">Rules in force</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-aico-secondary">{view.rules!.map(r => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {view.budget && view.budget.limits.length > 0 && (
        <div>
          <h3 className="mb-1 text-[13px] font-semibold">Budgets (estimated)</h3>
          <ul className="space-y-0.5 text-[13px] text-aico-secondary">
            {view.budget.limits.map((l, i) => <li key={i}>{l.scope === 'tenant' ? 'Organisation' : l.scope === 'team' ? 'Team' : 'You'} · {l.period === 'day' ? 'per day' : 'per month'}: ${l.spentUsd.toFixed(2)} of ${l.limitUsd}</li>)}
          </ul>
        </div>
      )}
      {note && <p className="text-[13px] text-aico-secondary" role="status">{note}</p>}
    </div>
  );
}
