/**
 * The morning brief on the home screen (engine: brief/), shared by the web
 * home and the desktop Home.
 *
 * Urgent first, each item with its one-click actions — open the PR, open the
 * chat, review in the inbox, start a fix in a new chat. "Start a fix" opens a
 * new chat in that project with the prompt **prefilled, not sent**: the brief
 * never starts work on its own, so the last click is always the person's.
 *
 * Also here, folded away: the history (one line per earlier brief) and the
 * per-project monitor switches (CI on the default branch, review requests,
 * critical advisories) — opt-in, off for every project until switched on.
 *
 * The host supplies how to open things (a browser tab in the web client, the
 * OS browser and the Inbox page in the desktop); the defaults suit the web.
 *
 * @module components/BriefCard
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { groupByUrgency, URGENCY_LABEL, whenLabel, type Brief, type BriefAction, type BriefItem, type BriefLatest, type BriefSummaryRow } from '../brief';

export interface BriefHost {
  openUrl?: (url: string) => void;
  openInbox?: () => void;
  openChat?: (sessionId: string) => void;
  /** A new chat in that folder with the prompt prefilled (never sent). */
  startFix?: (cwd: string | undefined, prompt: string) => void;
}

const FYI_SHOWN = 3;
const btn = 'rounded-md px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-50';
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

const URGENCY_CLASS: Record<BriefItem['urgency'], string> = {
  urgent: 'bg-aico-danger/10 text-aico-danger',
  soon: 'bg-aico-accent/10 text-aico-accent',
  fyi: 'bg-aico-hover text-aico-muted',
};

export function BriefCard({ host = {} }: { host?: BriefHost }): React.ReactElement | null {
  const [latest, setLatest] = useState<BriefLatest | null>(null);
  const [shown, setShown] = useState<Brief | null>(null);
  const [panel, setPanel] = useState<'none' | 'history' | 'monitors'>('none');
  const [history, setHistory] = useState<BriefSummaryRow[]>([]);
  const [allFyi, setAllFyi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useStore(s => s.projects);

  const refresh = useCallback(() => {
    api.brief().then(r => { setLatest(r); setError(null); }).catch(() => { /* an older engine without the brief: the card stays away */ });
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, latest?.generating ? 3_000 : 60_000);
    return () => clearInterval(t);
  }, [refresh, latest?.generating]);
  useEffect(() => { if (panel === 'history') void api.briefHistory(7).then(r => setHistory(r.briefs)).catch(() => {}); }, [panel, latest?.brief?.id]);

  const brief = shown ?? latest?.brief ?? null;
  const groups = useMemo(() => groupByUrgency(brief?.items ?? []), [brief]);

  const act = (a: BriefAction): void => {
    if (a.kind === 'open-url' && a.url) (host.openUrl ?? ((u: string) => window.open(u, '_blank', 'noopener,noreferrer')))(a.url);
    else if (a.kind === 'open-inbox') (host.openInbox ?? (() => window.dispatchEvent(new CustomEvent('aico:navigate', { detail: 'inbox' }))))();
    else if (a.kind === 'open-chat' && a.sessionId) (host.openChat ?? ((id: string) => void useStore.getState().openSession(id)))(a.sessionId);
    else if (a.kind === 'start-fix' && a.prompt && host.startFix) host.startFix(a.cwd, a.prompt);
    else if (a.kind === 'start-fix' && a.prompt) {
      // A new chat in that project, the prompt in the composer — not sent.
      const s = useStore.getState();
      if (a.cwd) s.newSessionIn(a.cwd); else s.newSession();
      s.prefillComposer(a.prompt);
    }
  };
  const runNow = async (): Promise<void> => {
    setError(null);
    try {
      const r = await api.runBrief();
      if (!r.ok) setError(r.error ?? 'Could not start a brief.');
      setShown(null);
      setLatest(l => (l ? { ...l, generating: true } : l));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const toggleMonitor = async (path: string, flag: 'ci' | 'reviews' | 'advisories', on: boolean): Promise<void> => {
    const cur = latest?.monitors.find(m => m.path === path) ?? { path };
    try { await api.setBriefMonitor(path, { ci: cur.ci, reviews: cur.reviews, advisories: cur.advisories, [flag]: on }); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  if (!latest) return null;
  if (!latest.settings.enabled && !brief) return null;

  const notices = latest.notices.filter(n => Date.now() - (n.releasedAt ?? n.at) < 24 * 3_600_000).slice(0, 3);
  const urgentCount = brief?.items.filter(i => i.urgency === 'urgent').length ?? 0;

  return (
    <section className="mx-auto mt-6 w-full max-w-[640px] rounded-2xl border border-aico-border bg-aico-bg/80 p-4 text-left text-[13px]" aria-label="Morning brief" data-brief-card>
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-medium text-aico-primary">{shown ? 'Earlier brief' : 'Morning brief'}</h2>
        {brief && <span className="text-[11.5px] text-aico-muted">{whenLabel(brief.createdAt)}{urgentCount ? ` · ${urgentCount} urgent` : ''}</span>}
        <span className="flex-1" />
        {shown && <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} onClick={() => setShown(null)}>Latest</button>}
        <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} aria-expanded={panel === 'history'} onClick={() => setPanel(p => (p === 'history' ? 'none' : 'history'))}>History</button>
        <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} aria-expanded={panel === 'monitors'} onClick={() => setPanel(p => (p === 'monitors' ? 'none' : 'monitors'))}>Monitors</button>
        <button className={`${btn} bg-aico-accent/10 text-aico-accent hover:bg-aico-accent/20`} disabled={latest.generating} onClick={() => void runNow()} data-brief-run>
          {latest.generating ? 'Preparing…' : 'Brief me now'}
        </button>
      </header>

      {notices.length > 0 && !shown && (
        <ul className="mt-2 space-y-1" aria-label="Monitor alerts">
          {notices.map(n => (
            <li key={n.key} className="flex items-center gap-2 rounded-lg bg-aico-danger/5 px-2 py-1 text-[12px]">
              <span className="rounded bg-aico-danger/10 px-1.5 text-[10.5px] font-medium uppercase text-aico-danger">Monitor</span>
              <span className="min-w-0 flex-1 truncate text-aico-primary" title={n.body}>{n.title}</span>
              {n.url && <button className={`${btn} text-aico-accent hover:bg-aico-hover`} onClick={() => act({ kind: 'open-url', label: 'Open', url: n.url })}>Open</button>}
            </li>
          ))}
        </ul>
      )}

      {!brief ? (
        <p className="mt-2 text-aico-secondary">
          {latest.nextAt ? `Your first brief arrives ${whenLabel(latest.nextAt)}` : 'No brief yet'} — waiting approvals, long jobs, background runs, and your PRs, issues and CI. Or ask for one now.
        </p>
      ) : (
        <>
          <p className="mt-2 text-aico-primary" data-brief-summary>{brief.summary}</p>
          {groups.map(g => {
            const items = g.urgency === 'fyi' && !allFyi ? g.items.slice(0, FYI_SHOWN) : g.items;
            return (
              <div key={g.urgency} className="mt-3">
                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-aico-muted">{URGENCY_LABEL[g.urgency]} · {g.items.length}</div>
                <ul className="space-y-1">
                  {items.map(it => (
                    <li key={it.key} className="rounded-lg px-2 py-1.5 hover:bg-aico-hover/60" data-brief-item={it.urgency}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-[1px] shrink-0 rounded px-1.5 text-[10.5px] font-medium ${URGENCY_CLASS[it.urgency]}`}>{URGENCY_LABEL[it.urgency]}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-aico-primary">{it.title}</div>
                          {(it.detail || it.project) && (
                            <div className="truncate text-[11.5px] text-aico-muted" title={it.detail}>
                              {it.project ? baseName(it.project) : ''}{it.project && it.detail ? ' · ' : ''}{it.detail ?? ''}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1">
                          {it.actions.map((a, i) => (
                            <button key={i} className={`${btn} ${a.kind === 'start-fix' ? 'text-aico-accent' : 'text-aico-secondary'} border border-aico-border hover:bg-aico-hover`} onClick={() => act(a)}
                              title={a.kind === 'start-fix' ? 'Opens a new chat with the prompt filled in — nothing runs until you send it' : undefined}>{a.label}</button>
                          ))}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                {g.urgency === 'fyi' && g.items.length > FYI_SHOWN && (
                  <button className={`${btn} mt-1 text-aico-muted hover:bg-aico-hover`} onClick={() => setAllFyi(v => !v)}>{allFyi ? 'Show fewer' : `Show ${g.items.length - FYI_SHOWN} more`}</button>
                )}
              </div>
            );
          })}
          {brief.notes.length > 0 && <ul className="mt-3 space-y-0.5 text-[11.5px] text-aico-muted">{brief.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <div className="mt-2 text-[11px] text-aico-muted">
            {brief.rankedBy === 'model' ? `Ranked by ${brief.model ?? 'a small model'}${brief.costUsd !== undefined ? ` · $${brief.costUsd.toFixed(4)}` : ''}` : 'In rule order (no model call)'}
            {latest.nextAt && !shown ? ` · next ${whenLabel(latest.nextAt)}` : ''}
          </div>
        </>
      )}

      {panel === 'history' && (
        <ul className="mt-3 border-t border-aico-border pt-2" aria-label="Brief history">
          {history.length === 0 && <li className="text-[12px] text-aico-muted">No earlier briefs.</li>}
          {history.map(h => (
            <li key={h.id}>
              <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-aico-hover"
                onClick={() => void api.briefById(h.id).then(r => setShown(r.brief)).catch(() => {})}>
                <span className="shrink-0 text-aico-muted">{whenLabel(h.createdAt)}</span>
                <span className="min-w-0 flex-1 truncate text-aico-secondary">{h.summary}</span>
                {h.urgent > 0 && <span className="shrink-0 text-[11px] text-aico-danger">{h.urgent} urgent</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {panel === 'monitors' && (
        <div className="mt-3 border-t border-aico-border pt-2" aria-label="Monitors">
          <p className="mb-1 text-[11.5px] text-aico-muted">Polled quietly with backoff; you are notified only when something changes{latest.settings.quietHours && latest.settings.quietHours !== 'off' ? ` (held during quiet hours ${latest.settings.quietHours})` : ''}. No model is used.</p>
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-aico-muted"><th className="py-1 font-medium">Project</th><th className="font-medium">CI</th><th className="font-medium">Reviews</th><th className="font-medium">Advisories</th></tr></thead>
            <tbody>
              {projects.filter(p => p.exists !== false).slice(0, 10).map(p => {
                const m = latest.monitors.find(x => x.path === p.path);
                return (
                  <tr key={p.path} title={m?.error ? `Last poll: ${m.error}` : p.path}>
                    <td className="max-w-[220px] truncate py-0.5 text-aico-secondary">{p.name}{m?.error ? ' ⚠' : ''}</td>
                    {(['ci', 'reviews', 'advisories'] as const).map(f => (
                      <td key={f}><input type="checkbox" aria-label={`${f} monitor for ${p.name}`} checked={Boolean(m?.[f])} onChange={e => void toggleMonitor(p.path, f, e.target.checked)} /></td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error && <div className="mt-2 text-[11.5px] text-aico-danger">{error}</div>}
    </section>
  );
}
