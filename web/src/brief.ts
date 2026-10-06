/**
 * The morning brief, as the clients show it: the shapes `brief/latest`
 * returns (engine: brief/core, brief/service) and the few pure helpers the
 * card needs. Shared by the web home and the desktop Home; free of React and
 * the API client so it stays cheap to import and easy to test.
 *
 * Actions are performed by the client, on a click, through routes that
 * already guard them — the engine never executes one (brief/core).
 *
 * Also here: the grouping the card shows — one row per advisory across projects
 * (`groupAdvisories`), the same data by project (`advisoryByProject`), chip labels
 * that tell two folders with one name apart (`projectLabels`) — and the shapes of
 * Fix all's plan and result (engine: brief/fix).
 *
 * @module web/brief
 */

export type BriefUrgency = 'urgent' | 'soon' | 'fyi';

export interface BriefAction {
  kind: 'open-url' | 'open-chat' | 'open-inbox' | 'start-fix' | 'open-codemap';
  label: string;
  url?: string;
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  /** `open-codemap`: the project-relative file to select and the view. */
  file?: string;
  mode?: string;
}

export interface BriefItem {
  key: string;
  source: 'inbox' | 'longjob' | 'work' | 'cron' | 'github' | 'advisory' | 'git' | 'mcp' | 'codegraph';
  urgency: BriefUrgency;
  title: string;
  detail?: string;
  project?: string;
  at?: number;
  actions: BriefAction[];
  /** `advisory` items: the structured facts (older stored briefs lack it; see {@link advisoryOf}). */
  advisory?: BriefAdvisory;
}

export interface BriefAdvisory { id: string; pkg: string; severity: string; title: string; fix?: string }

export interface Brief {
  id: string;
  createdAt: number;
  since: number;
  items: BriefItem[];
  summary: string;
  rankedBy: 'model' | 'rules';
  model?: string;
  costUsd?: number;
  notes: string[];
  trigger: 'schedule' | 'manual';
}

export interface BriefNotice {
  key: string;
  project: string;
  kind: 'ci' | 'review' | 'advisory' | 'codegraph';
  title: string;
  body: string;
  url?: string;
  /** `codegraph`: what "Show in Code map" selects, and what "Ask AICO to fix" prefills. */
  file?: string;
  mode?: string;
  prompt?: string;
  at: number;
  releasedAt?: number;
}

export interface BriefMonitor { path: string; ci?: boolean; reviews?: boolean; advisories?: boolean; codeGraph?: boolean; error?: string; nextAt?: number }

/** The monitor switches, in table order. `codeGraph`: new cycles, broken layering rules, hotspots, orphans after a re-index. */
export const MONITOR_FLAGS = ['ci', 'reviews', 'advisories', 'codeGraph'] as const;
export type MonitorFlag = (typeof MONITOR_FLAGS)[number];
export const MONITOR_LABEL: Record<MonitorFlag, string> = { ci: 'CI', reviews: 'Reviews', advisories: 'Advisories', codeGraph: 'Code' };

/** The actions a code-graph notice offers (the same two a brief item has). */
export function noticeActions(n: BriefNotice): BriefAction[] {
  if (n.kind !== 'codegraph') return n.url ? [{ kind: 'open-url', label: 'Open', url: n.url }] : [];
  return [
    { kind: 'open-codemap', label: 'Show in Code map', cwd: n.project, ...(n.file ? { file: n.file } : {}), ...(n.mode ? { mode: n.mode } : {}) },
    ...(n.prompt ? [{ kind: 'start-fix' as const, label: 'Ask AICO to fix', cwd: n.project, prompt: n.prompt }] : []),
  ];
}

export interface BriefLatest {
  brief: Brief | null;
  generating: boolean;
  nextAt: number | null;
  quietNow: boolean;
  settings: { enabled: boolean; time: string; useModel: boolean; notify: boolean; quietHours: string };
  monitors: BriefMonitor[];
  notices: BriefNotice[];
}

export interface BriefSummaryRow { id: string; createdAt: number; summary: string; items: number; urgent: number; trigger: string }

/** A word for each urgency — status is never only a colour. */
export const URGENCY_LABEL: Record<BriefUrgency, string> = { urgent: 'Urgent', soon: 'Today', fyi: 'FYI' };

/** Grouped in display order, empty groups dropped. */
export function groupByUrgency(items: BriefItem[]): Array<{ urgency: BriefUrgency; items: BriefItem[] }> {
  return (['urgent', 'soon', 'fyi'] as const)
    .map(urgency => ({ urgency, items: items.filter(i => i.urgency === urgency) }))
    .filter(g => g.items.length > 0);
}

/** "08:00 today", "yesterday 08:00", or a date. */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at); const n = new Date(now);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86_400_000);
  if (diff === 0) return `${hm} today`;
  if (diff === 1) return `yesterday ${hm}`;
  if (diff === -1) return `tomorrow ${hm}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` ${hm}`;
}

/** Notices newer than the last one this client showed. */
export function freshNotices(notices: BriefNotice[], lastSeen: number): BriefNotice[] {
  return notices.filter(n => (n.releasedAt ?? 0) > lastSeen);
}

// ── grouping (the card) ──────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3 };
export const severityRank = (s: string): number => SEVERITY_RANK[s] ?? 9;
export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** The advisory an item carries; older stored briefs only have it in their title and detail. */
export function advisoryOf(it: BriefItem): BriefAdvisory | undefined {
  if (it.source !== 'advisory') return undefined;
  if (it.advisory) return it.advisory;
  const m = /^New (\w+) advisory in .+?: (.+?) — (.*)$/.exec(it.title);
  const id = /^([^;\s]+)/.exec(it.detail ?? '')?.[1];
  if (!m || !id) return undefined;
  const fix = /fix: ([^;\s]+)/.exec(it.detail ?? '')?.[1];
  return { id, pkg: m[2]!, severity: m[1]!, title: m[3]!, ...(fix ? { fix } : {}) };
}

export interface AdvisoryGroup {
  /** `id|pkg` */
  key: string;
  id: string;
  pkg: string;
  severity: string;
  title: string;
  fix?: string;
  /** One entry per affected project (the same project twice counts once). */
  projects: Array<{ path: string; itemKey: string }>;
}

/**
 * One group per (advisory id, package) across projects, most severe first,
 * then the most projects, then the package name. Items that are not advisories
 * come back in `rest`, in their order.
 */
export function groupAdvisories(items: BriefItem[]): { groups: AdvisoryGroup[]; rest: BriefItem[] } {
  const map = new Map<string, AdvisoryGroup>();
  const rest: BriefItem[] = [];
  for (const it of items) {
    const a = advisoryOf(it);
    if (!a || !it.project) { rest.push(it); continue; }
    const key = `${a.id}|${a.pkg}`;
    const g = map.get(key) ?? { key, id: a.id, pkg: a.pkg, severity: a.severity, title: a.title, projects: [] };
    if (severityRank(a.severity) < severityRank(g.severity)) g.severity = a.severity;
    if (a.fix && !g.fix) g.fix = a.fix;
    if (!g.projects.some(p => p.path === it.project)) g.projects.push({ path: it.project, itemKey: it.key });
    map.set(key, g);
  }
  const groups = [...map.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.projects.length - a.projects.length || a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id));
  return { groups, rest };
}

export interface ProjectAdvisories { path: string; advisories: Array<{ id: string; pkg: string; severity: string; fix?: string; itemKey: string }> }

/** The same advisories by project: the most severe first, then the most advisories. */
export function advisoryByProject(groups: AdvisoryGroup[]): ProjectAdvisories[] {
  const map = new Map<string, ProjectAdvisories>();
  for (const g of groups) for (const p of g.projects) {
    const e = map.get(p.path) ?? { path: p.path, advisories: [] };
    e.advisories.push({ id: g.id, pkg: g.pkg, severity: g.severity, ...(g.fix ? { fix: g.fix } : {}), itemKey: p.itemKey });
    map.set(p.path, e);
  }
  const worst = (e: ProjectAdvisories): number => Math.min(...e.advisories.map(a => severityRank(a.severity)));
  return [...map.values()].sort((a, b) => worst(a) - worst(b) || b.advisories.length - a.advisories.length || baseName(a.path).localeCompare(baseName(b.path)));
}

/** Chip text per path: the folder name, with its parent when two paths share a name. */
export function projectLabels(paths: string[]): Map<string, string> {
  const uniq = [...new Set(paths)];
  const count = new Map<string, number>();
  for (const p of uniq) count.set(baseName(p), (count.get(baseName(p)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of uniq) {
    const name = baseName(p);
    if ((count.get(name) ?? 0) < 2) { out.set(p, name); continue; }
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
    out.set(p, parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name);
  }
  return out;
}

/** "3 projects", "1 project". */
export const countLabel = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How many rows a collapsed list shows before "Show N more". */
export const COLLAPSED_ROWS = 4;

/** What a list shows: all of it, or the first `limit`, and how many are hidden. */
export function visibleRows<T>(rows: T[], expanded: boolean, limit = COLLAPSED_ROWS): { rows: T[]; hidden: number } {
  if (expanded || rows.length <= limit + 1) return { rows, hidden: 0 }; // never hide a single row behind "Show 1 more"
  return { rows: rows.slice(0, limit), hidden: rows.length - limit };
}

// ── Fix all (engine: brief/fix) ──────────────────────────────────────

export interface FixTargetRow { id: string; pkg: string; severity: string; title: string; fix?: string; itemKey: string }
export interface FixPlanProject { project: string; name: string; branch: string; targets: FixTargetRow[]; blocked?: string }
export interface FixPlanResponse { ok: boolean; plan: { projects: FixPlanProject[]; skipped: string[] }; budgetUsd: number }
export interface FixResultRow { project: string; name: string; branch: string; status: 'started' | 'skipped'; agentId?: string; reason?: string }
export interface FixAllResponse { ok: boolean; results: FixResultRow[]; skipped: string[] }

/** One sentence for what Fix all did, for the card's status line. */
export function fixSummary(results: FixResultRow[]): string {
  const started = results.filter(r => r.status === 'started').length;
  const skipped = results.length - started;
  if (!started) return `Nothing was started: ${results.map(r => `${r.name} (${r.reason ?? 'skipped'})`).join('; ') || 'no project could be fixed'}.`;
  return `Started ${countLabel(started, 'fix', 'fixes')} on their own branches — follow them in Tasks.${skipped ? ` ${skipped} skipped: ${results.filter(r => r.status === 'skipped').map(r => `${r.name} (${r.reason ?? 'skipped'})`).join('; ')}.` : ''}`;
}
