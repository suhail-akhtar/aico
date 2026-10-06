/**
 * The morning brief on the home screen (engine: brief/), shared by the web
 * home and the desktop Home.
 *
 * Urgent first. Dependency advisories are GROUPED, not listed per project: one
 * row per advisory (package, severity, id, fixed-in version) with the affected
 * projects as chips, sorted by severity then by how many projects it touches,
 * or the same data by project. Long lists collapse behind a count; sections
 * have counts and fold. The header stays put while the list scrolls.
 *
 * Actions, and what each one does:
 *  - "Start a fix" (and a project chip) opens a new chat in that project with
 *    the prompt PREFILLED, not sent — the person's Enter is the start. It used
 *    to do this silently, with the composer scrolled out of sight above the
 *    card, so it looked dead. It now says what happened, scrolls the composer
 *    into view and focuses it.
 *  - "Fix all" (per advisory, per project, or for the whole section) first
 *    shows the plan the engine would run (`brief/fix-plan`: projects, packages,
 *    target versions, branch names, what will be skipped and why) and starts
 *    nothing until the person confirms. Starting needs a person; one
 *    background task per project, on its own branch (engine: brief/fix).
 *  - Non-advisory items (uncommitted changes, stale branches) get "Review",
 *    never a fix.
 *  - Any failure is shown in the status line with its reason; a button that is
 *    working shows it (aria-busy) instead of looking inert.
 *
 * Also here, folded away: the history (one line per earlier brief) and the
 * per-project monitor switches (CI on the default branch, review requests,
 * critical advisories, code structure after a re-index) — opt-in, off for
 * every project until switched on.
 *
 * Code-structure items offer "Show in Code map" and "Ask AICO to fix"
 * (prefilled, not sent). The host supplies how to open things (a browser tab in
 * the web client, the OS browser and the Inbox page in the desktop); the
 * defaults suit the web.
 *
 * @module components/BriefCard
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import {
  advisoryByProject, baseName, countLabel, fixSummary, groupAdvisories, groupByUrgency, MONITOR_FLAGS, MONITOR_LABEL, noticeActions,
  projectLabels, severityRank, URGENCY_LABEL, visibleRows, whenLabel,
  type AdvisoryGroup, type Brief, type BriefAction, type BriefItem, type BriefLatest, type BriefSummaryRow, type FixPlanResponse, type MonitorFlag,
} from '../brief';

export interface BriefHost {
  openUrl?: (url: string) => void;
  openInbox?: () => void;
  openChat?: (sessionId: string) => void;
  /** A new chat in that folder with the prompt prefilled (never sent). */
  startFix?: (cwd: string | undefined, prompt: string) => void;
  /** The project's Code map, on a file and view. */
  openCodeMap?: (cwd: string, file?: string, mode?: string) => void;
  /** Also tell the host's own notification surface (the desktop's toasts). */
  notify?: (kind: 'success' | 'error', title: string, detail?: string) => void;
}

const btn = 'rounded-md px-2 py-0.5 text-[11.5px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:opacity-50 aria-busy:animate-pulse';
const outlined = `${btn} border border-aico-border text-aico-secondary hover:bg-aico-hover`;
const accentBtn = `${btn} border border-aico-accent/40 bg-aico-accent/10 text-aico-accent hover:bg-aico-accent/20`;

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-aico-danger/15 text-aico-danger',
  high: 'bg-aico-warning/15 text-aico-warning',
  moderate: 'bg-aico-info/15 text-aico-info',
  low: 'bg-aico-hover text-aico-muted',
};
const URGENCY_CLASS: Record<BriefItem['urgency'], string> = {
  urgent: 'bg-aico-danger/15 text-aico-danger',
  soon: 'bg-aico-accent/10 text-aico-accent',
  fyi: 'bg-aico-hover text-aico-muted',
};

function SeverityChip({ severity }: { severity: string }): React.ReactElement {
  return <span className={`shrink-0 rounded px-1.5 text-[10.5px] font-semibold uppercase tracking-wide ${SEVERITY_CLASS[severity] ?? SEVERITY_CLASS.low}`}>{severity}</span>;
}

function Section({ id, title, count, hint, open, onToggle, right, children }: {
  id: string; title: string; count: number; hint?: string; open: boolean; onToggle: () => void; right?: React.ReactNode; children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mt-3" data-brief-section={id}>
      <div className="flex items-center gap-2">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 text-left text-[11px] font-semibold uppercase tracking-wide text-aico-muted hover:text-aico-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
          aria-expanded={open} aria-controls={`brief-sec-${id}`} onClick={onToggle}>
          <span aria-hidden className={`inline-block text-[9px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          <span>{title}</span>
          <span className="rounded-full bg-aico-hover px-1.5 text-[10.5px] font-medium normal-case tracking-normal text-aico-secondary">{count}</span>
          {hint && <span className="truncate text-[11px] font-normal normal-case tracking-normal">{hint}</span>}
        </button>
        {right}
      </div>
      {open && <div id={`brief-sec-${id}`} className="mt-1">{children}</div>}
    </div>
  );
}

/** What Fix all would do, and the one click that starts it. */
function FixConfirm({ title, keys, onClose, onDone, onError }: {
  title: string; keys: string[]; onClose: () => void; onDone: (text: string) => void; onError: (text: string) => void;
}): React.ReactElement {
  const [plan, setPlan] = useState<FixPlanResponse | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { api.briefFixPlan(keys).then(setPlan).catch(e => setProblem(e instanceof Error ? e.message : String(e))); }, [keys]);
  useEffect(() => { cancel.current?.focus(); }, [plan]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startable = plan?.plan.projects.filter(p => !p.blocked) ?? [];
  const labels = projectLabels(plan?.plan.projects.map(p => p.project) ?? []);
  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      const r = await api.briefFixAll(keys);
      if (r.ok) onDone(fixSummary(r.results)); else onError(fixSummary(r.results));
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      onError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[80vh] w-full max-w-[540px] overflow-y-auto rounded-2xl border border-aico-border bg-aico-bg p-4 text-[13px] shadow-xl" data-brief-confirm>
        <h3 className="text-[14px] font-medium text-aico-primary">{title}</h3>
        {!plan && !problem && <p className="mt-2 text-aico-muted">Preparing the plan…</p>}
        {problem && <p className="mt-2 text-aico-danger" role="alert">{problem}</p>}
        {plan && (
          <>
            <p className="mt-1 text-[12px] text-aico-secondary">
              Nothing has started. For each project, AICO will switch it to a new branch, upgrade these packages, run the project&apos;s tests and commit there — never on the default branch, nothing is pushed. Each project is its own background task (up to ${plan.budgetUsd.toFixed(2)} each), so one failing does not stop the others. Anything unusual waits for you: a write outside the project, a download, a global install or a safety-reviewer flag is never done unasked — it goes to Waiting for you when it can be replayed, and is otherwise stopped and reported.
            </p>
            <ul className="mt-3 space-y-2">
              {[...plan.plan.projects].sort((x, y) => Number(Boolean(x.blocked)) - Number(Boolean(y.blocked))).map(p => (
                <li key={p.project} className={`rounded-lg border border-aico-border px-2.5 py-2 ${p.blocked ? 'opacity-70' : ''}`} data-brief-confirm-project>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-aico-primary" title={p.project}>{labels.get(p.project) ?? p.name}</span>
                    {!p.blocked && <code className="shrink-0 rounded bg-aico-code px-1.5 text-[11px] text-aico-secondary">{p.branch}</code>}
                  </div>
                  <ul className="mt-1 space-y-0.5 text-[12px] text-aico-secondary">
                    {p.targets.map(t => (
                      <li key={t.id + t.pkg} className="flex items-center gap-1.5"><SeverityChip severity={t.severity} /><span className="font-mono">{t.pkg}</span><span className="text-aico-muted">→ {t.fix ?? 'smallest fixed version'}</span><span className="truncate text-aico-muted">{t.id}</span></li>
                    ))}
                  </ul>
                  {p.blocked && <div className="mt-1 text-[12px] text-aico-warning">Will be skipped: {p.blocked}</div>}
                </li>
              ))}
            </ul>
            {plan.plan.skipped.map((s, i) => <p key={i} className="mt-2 text-[12px] text-aico-muted">{s}</p>)}
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancel} className={outlined} onClick={onClose}>Cancel</button>
          <button className={accentBtn} disabled={!startable.length || starting} aria-busy={starting} onClick={() => void start()} data-brief-confirm-start>
            {starting ? 'Starting…' : startable.length ? `Start ${countLabel(startable.length, 'fix', 'fixes')}` : 'Nothing to start'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BriefCard({ host = {} }: { host?: BriefHost }): React.ReactElement | null {
  const [latest, setLatest] = useState<BriefLatest | null>(null);
  const [shown, setShown] = useState<Brief | null>(null);
  const [panel, setPanel] = useState<'none' | 'history' | 'monitors'>('none');
  const [history, setHistory] = useState<BriefSummaryRow[]>([]);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ title: string; keys: string[] } | null>(null);
  const [view, setView] = useState<'advisory' | 'project'>('advisory');
  const [folded, setFolded] = useState<Set<string>>(new Set(['fyi']));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const projects = useStore(s => s.projects);

  const say = useCallback((kind: 'success' | 'error', text: string): void => {
    setStatus({ kind, text });
    host.notify?.(kind, kind === 'error' ? 'Morning brief' : 'Done', text);
  }, [host]);
  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, key: string): void =>
    set(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const withBusy = async (key: string, fn: () => Promise<void> | void): Promise<void> => {
    setBusy(b => new Set(b).add(key));
    try { await fn(); }
    catch (err) { say('error', `${err instanceof Error ? err.message : String(err)}`); }
    finally { setTimeout(() => setBusy(b => { const n = new Set(b); n.delete(key); return n; }), 600); }
  };

  const refresh = useCallback(() => {
    api.brief().then(r => { setLatest(r); }).catch(() => { /* an older engine without the brief: the card stays away */ });
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, latest?.generating ? 3_000 : 60_000);
    return () => clearInterval(t);
  }, [refresh, latest?.generating]);
  useEffect(() => { if (panel === 'history') void api.briefHistory(7).then(r => setHistory(r.briefs)).catch(() => {}); }, [panel, latest?.brief?.id]);

  const brief = shown ?? latest?.brief ?? null;
  const { groups: advisories, rest } = useMemo(() => groupAdvisories(brief?.items ?? []), [brief]);
  const byProject = useMemo(() => advisoryByProject(advisories), [advisories]);
  const labels = useMemo(() => projectLabels((brief?.items ?? []).flatMap(i => (i.project ? [i.project] : []))), [brief]);
  const restGroups = useMemo(() => groupByUrgency(rest), [rest]);
  const label = (p: string): string => labels.get(p) ?? baseName(p);
  const canFix = !shown; // Fix all plans from the latest brief

  /** Open a new chat in the project with the prompt in the composer — and make that visible. */
  const startChat = (cwd: string | undefined, prompt: string): void => {
    if (host.startFix) host.startFix(cwd, prompt);
    else {
      const s = useStore.getState();
      if (cwd) s.newSessionIn(cwd); else s.newSession();
      s.prefillComposer(prompt);
    }
    // The composer is above the card on the desktop Home and may be scrolled out of sight.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea');
      ta?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ta?.focus({ preventScroll: true });
    }));
    say('success', `Prompt ready in the composer${cwd ? ` for ${label(cwd)}` : ''} — read it, then press Enter to send. Nothing runs until you do.`);
  };

  const act = (a: BriefAction, key: string): void => {
    void withBusy(key, () => {
      if (a.kind === 'open-url' && a.url) (host.openUrl ?? ((u: string) => window.open(u, '_blank', 'noopener,noreferrer')))(a.url);
      else if (a.kind === 'open-inbox') (host.openInbox ?? (() => window.dispatchEvent(new CustomEvent('aico:navigate', { detail: 'inbox' }))))();
      else if (a.kind === 'open-chat' && a.sessionId) (host.openChat ?? ((id: string) => void useStore.getState().openSession(id)))(a.sessionId);
      else if (a.kind === 'open-codemap' && a.cwd) {
        (host.openCodeMap ?? ((cwd: string, file?: string, mode?: string) => window.dispatchEvent(new CustomEvent('aico:navigate', { detail: { destination: 'project', projectPath: cwd, codemap: { ...(file ? { file } : {}), ...(mode ? { mode } : {}) } } }))))(a.cwd, a.file, a.mode);
      }
      else if (a.kind === 'start-fix' && a.prompt) startChat(a.cwd, a.prompt);
      else throw new Error(`"${a.label}" has nothing to open — this brief may be from an older version; press "Brief me now".`);
    });
  };
  const runNow = async (): Promise<void> => {
    setStatus(null);
    try {
      const r = await api.runBrief();
      if (!r.ok) say('error', r.error ?? 'Could not start a brief.');
      setShown(null);
      setLatest(l => (l ? { ...l, generating: true } : l));
    } catch (err) { say('error', err instanceof Error ? err.message : String(err)); }
  };
  const toggleMonitor = async (path: string, flag: MonitorFlag, on: boolean): Promise<void> => {
    const cur = latest?.monitors.find(m => m.path === path) ?? { path };
    try { await api.setBriefMonitor(path, { ci: cur.ci, reviews: cur.reviews, advisories: cur.advisories, codeGraph: cur.codeGraph, [flag]: on }); refresh(); }
    catch (err) { say('error', err instanceof Error ? err.message : String(err)); }
  };
  const askFix = (title: string, keys: string[]): void => { setStatus(null); setConfirm({ title, keys: [...new Set(keys)] }); };

  if (!latest) return null;
  if (!latest.settings.enabled && !brief) return null;

  const notices = latest.notices.filter(n => Date.now() - (n.releasedAt ?? n.at) < 24 * 3_600_000).slice(0, 3);
  const urgentCount = brief?.items.filter(i => i.urgency === 'urgent').length ?? 0;
  const allKeys = advisories.flatMap(g => g.projects.map(p => p.itemKey));
  const advSummary = advisories.length ? `${countLabel(advisories.length, 'advisory', 'advisories')} in ${countLabel(byProject.length, 'project')}` : '';

  const fixAllButton = (title: string, keys: string[], text: string, key: string): React.ReactElement => (
    <button className={accentBtn} disabled={!canFix || busy.has(key)} aria-busy={busy.has(key)} onClick={() => askFix(title, keys)}
      title={canFix ? 'Shows what will happen first; nothing starts until you confirm' : 'Switch to the latest brief to fix from it'} data-brief-fixall={key}>{text}</button>
  );
  const chip = (p: string, key: string): React.ReactElement => {
    const prompt = (brief?.items ?? []).find(i => i.project === p && i.key === key)?.actions.find(a => a.kind === 'start-fix' && a.prompt);
    return (
      <button key={p} className="max-w-[160px] truncate rounded-full border border-aico-border bg-aico-hover/50 px-2 py-px text-[11px] text-aico-secondary hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent disabled:cursor-default"
        title={`${p}${prompt ? '\nClick to start a fix chat here (prompt prefilled, not sent)' : ''}`} disabled={!prompt}
        onClick={() => prompt && act(prompt, `chip|${key}`)} data-brief-chip>{label(p)}</button>
    );
  };

  /** "Start a fix" for a one-project advisory: the same prefilled chat the chip opens. */
  const chatAction = (p: { path: string; itemKey: string }): React.ReactElement | null => {
    const a = (brief?.items ?? []).find(i => i.project === p.path && i.key === p.itemKey)?.actions.find(x => x.kind === 'start-fix' && x.prompt);
    return a ? <button className={outlined} aria-busy={busy.has(`chat|${p.itemKey}`)} onClick={() => act(a, `chat|${p.itemKey}`)} title="Opens a new chat with the prompt filled in — nothing runs until you send it">Start a fix</button> : null;
  };

  const advRows = (g: AdvisoryGroup): React.ReactElement => {
    const keys = g.projects.map(p => p.itemKey);
    return (
      <li key={g.key} className="rounded-lg px-2 py-1.5 hover:bg-aico-hover/60" data-brief-advisory={g.id}>
        <div className="flex items-start gap-2">
          <SeverityChip severity={g.severity} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[12.5px] font-medium text-aico-primary">{g.pkg}</span>
              <span className="font-mono text-[11px] text-aico-muted">{g.id}</span>
              <span className="text-[11px] text-aico-muted">{g.fix ? `fixed in ${g.fix}` : 'fix version not recorded'}</span>
            </div>
            <div className="text-[12px] text-aico-secondary" title={g.title}>{g.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="mr-0.5 text-[11px] text-aico-muted">{countLabel(g.projects.length, 'project')}</span>
              {g.projects.map(p => chip(p.path, p.itemKey))}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {g.projects.length === 1 && chatAction(g.projects[0]!)}
            {fixAllButton(`Fix ${g.pkg} (${g.id}) in ${countLabel(g.projects.length, 'project')}?`, keys, g.projects.length > 1 ? `Fix all ${g.projects.length}` : 'Fix', `g|${g.key}`)}
          </div>
        </div>
      </li>
    );
  };

  const advList = visibleRows(advisories, expanded.has('adv'));
  const projList = visibleRows(byProject, expanded.has('proj'));

  return (
    <section className="relative mx-auto mt-6 w-full max-w-[640px] rounded-2xl border border-aico-border bg-aico-bg/80 text-left text-[13px]" aria-label="Morning brief" data-brief-card>
      <header className="sticky top-0 z-10 rounded-t-2xl border-b border-transparent bg-aico-bg/95 px-4 pb-2 pt-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[14px] font-medium text-aico-primary">{shown ? 'Earlier brief' : 'Morning brief'}</h2>
          {brief && <span className="text-[11.5px] text-aico-muted">{whenLabel(brief.createdAt)}{urgentCount ? ` · ${urgentCount} urgent` : ''}</span>}
          <span className="flex-1" />
          {shown && <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} onClick={() => setShown(null)}>Latest</button>}
          <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} aria-expanded={panel === 'history'} onClick={() => setPanel(p => (p === 'history' ? 'none' : 'history'))}>History</button>
          <button className={`${btn} text-aico-secondary hover:bg-aico-hover`} aria-expanded={panel === 'monitors'} onClick={() => setPanel(p => (p === 'monitors' ? 'none' : 'monitors'))}>Monitors</button>
          <button className={`${btn} bg-aico-accent/10 text-aico-accent hover:bg-aico-accent/20`} disabled={latest.generating} aria-busy={latest.generating} onClick={() => void runNow()} data-brief-run>
            {latest.generating ? 'Preparing…' : 'Brief me now'}
          </button>
        </div>
        {status && (
          <div role={status.kind === 'error' ? 'alert' : 'status'} className={`mt-2 flex items-start gap-2 rounded-lg px-2 py-1 text-[12px] ${status.kind === 'error' ? 'bg-aico-danger/10 text-aico-danger' : 'bg-aico-success/10 text-aico-success'}`} data-brief-status={status.kind}>
            <span className="min-w-0 flex-1">{status.text}</span>
            <button className="shrink-0 rounded px-1 hover:bg-aico-hover" aria-label="Dismiss" onClick={() => setStatus(null)}>×</button>
          </div>
        )}
      </header>

      <div className="px-4 pb-4">
        {notices.length > 0 && !shown && (
          <ul className="mt-1 space-y-1" aria-label="Monitor alerts">
            {notices.map(n => (
              <li key={n.key} className="flex items-center gap-2 rounded-lg bg-aico-danger/5 px-2 py-1 text-[12px]">
                <span className="rounded bg-aico-danger/10 px-1.5 text-[10.5px] font-medium uppercase text-aico-danger">Monitor</span>
                <span className="min-w-0 flex-1 truncate text-aico-primary" title={n.body}>{n.title}</span>
                {noticeActions(n).map((a, i) => (
                  <button key={i} className={`${btn} ${a.kind === 'start-fix' ? 'text-aico-accent' : 'text-aico-secondary'} hover:bg-aico-hover`} aria-busy={busy.has(`n|${n.key}|${i}`)} onClick={() => act(a, `n|${n.key}|${i}`)}
                    title={a.kind === 'start-fix' ? 'Opens a new chat with the prompt filled in — nothing runs until you send it' : undefined}>{a.label}</button>
                ))}
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
            <p className="mt-1 text-aico-primary" data-brief-summary>{brief.summary}</p>

            {advisories.length > 0 && (
              <Section id="advisories" title="Dependency advisories" count={advisories.length} hint={advSummary}
                open={!folded.has('advisories')} onToggle={() => toggle(setFolded, 'advisories')}
                right={(
                  <div className="flex shrink-0 items-center gap-1">
                    <div className="flex rounded-md border border-aico-border p-px" role="group" aria-label="Group advisories">
                      {(['advisory', 'project'] as const).map(v => (
                        <button key={v} className={`${btn} ${view === v ? 'bg-aico-hover text-aico-primary' : 'text-aico-muted hover:bg-aico-hover'}`} aria-pressed={view === v} onClick={() => setView(v)}>{v === 'advisory' ? 'By advisory' : 'By project'}</button>
                      ))}
                    </div>
                    {fixAllButton(`Fix ${countLabel(advisories.length, 'advisory', 'advisories')} in ${countLabel(byProject.length, 'project')}?`, allKeys, 'Fix all', 'all')}
                  </div>
                )}>
                {view === 'advisory' ? (
                  <>
                    <ul className="space-y-0.5">{advList.rows.map(advRows)}</ul>
                    {(advList.hidden > 0 || expanded.has('adv')) && advisories.length > 5 && (
                      <button className={`${btn} mt-1 text-aico-muted hover:bg-aico-hover`} onClick={() => toggle(setExpanded, 'adv')}>{expanded.has('adv') ? 'Show fewer' : `Show ${advList.hidden} more`}</button>
                    )}
                  </>
                ) : (
                  <>
                    <ul className="space-y-0.5">
                      {projList.rows.map(p => (
                        <li key={p.path} className="rounded-lg px-2 py-1.5 hover:bg-aico-hover/60" data-brief-project={label(p.path)}>
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2"><span className="font-medium text-aico-primary" title={p.path}>{label(p.path)}</span><span className="text-[11px] text-aico-muted">{countLabel(p.advisories.length, 'advisory', 'advisories')}</span></div>
                              <ul className="mt-0.5 space-y-0.5 text-[12px] text-aico-secondary">
                                {[...p.advisories].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)).map(a => (
                                  <li key={a.id + a.pkg} className="flex flex-wrap items-center gap-1.5"><SeverityChip severity={a.severity} /><span className="font-mono">{a.pkg}</span><span className="font-mono text-[11px] text-aico-muted">{a.id}</span>{a.fix && <span className="text-[11px] text-aico-muted">→ {a.fix}</span>}</li>
                                ))}
                              </ul>
                            </div>
                            {fixAllButton(`Fix ${countLabel(p.advisories.length, 'advisory', 'advisories')} in ${label(p.path)}?`, p.advisories.map(a => a.itemKey), 'Fix project', `p|${p.path}`)}
                          </div>
                        </li>
                      ))}
                    </ul>
                    {(projList.hidden > 0 || expanded.has('proj')) && byProject.length > 5 && (
                      <button className={`${btn} mt-1 text-aico-muted hover:bg-aico-hover`} onClick={() => toggle(setExpanded, 'proj')}>{expanded.has('proj') ? 'Show fewer' : `Show ${projList.hidden} more`}</button>
                    )}
                  </>
                )}
              </Section>
            )}

            {restGroups.map(g => {
              const secKey = g.urgency === 'fyi' ? 'fyi' : `u-${g.urgency}`;
              const list = visibleRows(g.items, expanded.has(secKey));
              return (
                <Section key={g.urgency} id={secKey} title={URGENCY_LABEL[g.urgency]} count={g.items.length} open={!folded.has(secKey)} onToggle={() => toggle(setFolded, secKey)}>
                  <ul className="space-y-0.5">
                    {list.rows.map(it => (
                      <li key={it.key} className="rounded-lg px-2 py-1.5 hover:bg-aico-hover/60" data-brief-item={it.urgency}>
                        <div className="flex items-start gap-2">
                          <span className={`mt-[1px] shrink-0 rounded px-1.5 text-[10.5px] font-medium ${URGENCY_CLASS[it.urgency]}`}>{URGENCY_LABEL[it.urgency]}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-aico-primary">{it.title}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1">
                              {it.project && <span className="max-w-[200px] truncate rounded-full border border-aico-border px-2 py-px text-[11px] text-aico-secondary" title={it.project}>{label(it.project)}</span>}
                              {it.detail && <span className="min-w-0 truncate text-[11.5px] text-aico-muted" title={it.detail}>{it.detail}</span>}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap justify-end gap-1">
                            {it.actions.map((a, i) => (
                              <button key={i} className={`${outlined} ${a.kind === 'start-fix' && a.label !== 'Review' ? 'text-aico-accent' : ''}`} aria-busy={busy.has(`${it.key}|${i}`)} onClick={() => act(a, `${it.key}|${i}`)}
                                title={a.kind === 'start-fix' ? 'Opens a new chat with the prompt filled in — nothing runs until you send it' : undefined}>{a.label}</button>
                            ))}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {(list.hidden > 0 || (expanded.has(secKey) && g.items.length > 5)) && (
                    <button className={`${btn} mt-1 text-aico-muted hover:bg-aico-hover`} onClick={() => toggle(setExpanded, secKey)}>{expanded.has(secKey) ? 'Show fewer' : `Show ${list.hidden} more`}</button>
                  )}
                </Section>
              );
            })}
            {brief.notes.length > 0 && <ul className="mt-3 space-y-0.5 text-[11.5px] text-aico-muted">{brief.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            <div className="mt-3 text-[11px] text-aico-muted">
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
                <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-aico-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-aico-accent"
                  onClick={() => void api.briefById(h.id).then(r => setShown(r.brief)).catch(err => say('error', err instanceof Error ? err.message : String(err)))}>
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
            <p className="mb-1 text-[11.5px] text-aico-muted">Polled quietly with backoff; you are notified only when something changes{latest.settings.quietHours && latest.settings.quietHours !== 'off' ? ` (held during quiet hours ${latest.settings.quietHours})` : ''}. No model is used. Code: new import cycles, broken layering rules, hotspots and unused files, checked after each re-index.</p>
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[10.5px] uppercase tracking-wide text-aico-muted"><th className="py-1 font-medium">Project</th>{MONITOR_FLAGS.map(f => <th key={f} className="font-medium">{MONITOR_LABEL[f]}</th>)}</tr></thead>
              <tbody>
                {projects.filter(p => p.exists !== false).slice(0, 10).map(p => {
                  const m = latest.monitors.find(x => x.path === p.path);
                  return (
                    <tr key={p.path} title={m?.error ? `Last poll: ${m.error}` : p.path}>
                      <td className="max-w-[220px] truncate py-0.5 text-aico-secondary">{p.name}{m?.error ? ' ⚠' : ''}</td>
                      {MONITOR_FLAGS.map(f => (
                        <td key={f}><input type="checkbox" aria-label={`${f} monitor for ${p.name}`} checked={Boolean(m?.[f])} onChange={e => void toggleMonitor(p.path, f, e.target.checked)} /></td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirm && (
        <FixConfirm title={confirm.title} keys={confirm.keys} onClose={() => setConfirm(null)}
          onDone={text => { say('success', text); refresh(); }} onError={text => say('error', text)} />
      )}
    </section>
  );
}
