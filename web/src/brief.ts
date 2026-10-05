/**
 * The morning brief, as the clients show it: the shapes `brief/latest`
 * returns (engine: brief/core, brief/service) and the few pure helpers the
 * card needs. Shared by the web home and the desktop Home; free of React and
 * the API client so it stays cheap to import and easy to test.
 *
 * Actions are performed by the client, on a click, through routes that
 * already guard them — the engine never executes one (brief/core).
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
}

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
