/**
 * The brief's collectors: each turns one source into `BriefItem`s, without a
 * model.
 *
 * Two kinds. The **local** ones (inbox, long jobs, the work ledger) take the
 * records the engine already holds and are pure. The **command** ones run
 * `gh` and `git` through an injected runner — `execFile` with an argument
 * array, never a shell string — so the tests drive them with recorded `gh`
 * output and no network.
 *
 * GitHub goes through the official CLI for the same reason the desktop's
 * GitHub page does (`desktop/electron/github.ts`): `gh` already holds the
 * person's sign-in in the OS keychain, so AICO never sees or stores a GitHub
 * token. Signed out or not installed is a note on the brief, not an error.
 * Everything here **reads**: no command in this file changes GitHub, a
 * repository or a branch.
 *
 * Deliberately not here: bodies, diffs, logs. An item is a title, a short
 * detail and the links to act on — that is all the brief shows and all the
 * ranking call ever sees.
 *
 * @module brief/collect
 */

import { execFile } from 'node:child_process';
import type { BriefAction, BriefItem, BriefMcpSource, Urgency } from './core.js';
import { baseName } from './core.js';

// ── running a command ────────────────────────────────────────────────

export interface Ran { code: number; stdout: string; stderr: string; missing?: boolean }
export type Runner = (cmd: 'gh' | 'git', args: string[], cwd?: string) => Promise<Ran>;

const RUN_TIMEOUT_MS = 30_000;

/** The real runner. No shell: `gh` and `git` are executables on every platform. */
export const defaultRunner: Runner = (cmd, args, cwd) => new Promise(resolve => {
  execFile(cmd, args, {
    cwd, windowsHide: true, timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' },
  }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : -1) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' });
  });
});

function json<T>(r: Ran): T | undefined {
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  try { return JSON.parse(r.stdout) as T; } catch { return undefined; }
}

const ts = (s: unknown): number => { const n = Date.parse(String(s ?? '')); return Number.isFinite(n) ? n : 0; };
const open = (url: string | undefined, label: string): BriefAction[] => (url ? [{ kind: 'open-url', label, url }] : []);

// ── local: inbox, long jobs, the work ledger ─────────────────────────

/** The fields of `autonomy/inbox` `PendingAction` the brief reads. */
export interface InboxLike { id: string; status: string; createdAt: number; expiresAt: number; tool: string; why: string; label?: string; cwd: string; sessionId?: string }

export function inboxItems(actions: InboxLike[], now: number): BriefItem[] {
  const pending = actions.filter(a => a.status === 'pending' && a.expiresAt > now);
  return pending.slice(0, 10).map(a => ({
    key: `inbox|${a.id}`,
    source: 'inbox',
    urgency: 'urgent',
    title: `Approval waiting: ${a.tool}${a.label ? ` (${a.label})` : ''}`,
    detail: `${a.why}; expires in ${Math.max(1, Math.round((a.expiresAt - now) / 3_600_000))}h`,
    project: a.cwd,
    at: a.createdAt,
    actions: [{ kind: 'open-inbox', label: 'Review in inbox' }, ...(a.sessionId ? [{ kind: 'open-chat' as const, label: 'Open chat', sessionId: a.sessionId }] : [])],
  }));
}

/** The fields of `longjob` `LongJob` the brief reads. */
export interface LongJobLike {
  id: string; sessionId: string; cwd: string; title: string; status: string; createdAt: number; decidedAt?: number;
  note?: string; spentUsd: number; budget: { usd: number }; milestones: Array<{ title: string; doneAt?: number }>;
}

export function longJobItems(jobs: LongJobLike[], since: number): BriefItem[] {
  const out: BriefItem[] = [];
  for (const j of jobs) {
    const done = j.milestones.filter(m => m.doneAt).length;
    const last = Math.max(j.createdAt, j.decidedAt ?? 0, ...j.milestones.map(m => m.doneAt ?? 0));
    const progress = `${done}/${j.milestones.length} milestones, $${j.spentUsd.toFixed(2)} of $${j.budget.usd.toFixed(2)}`;
    const chat: BriefAction[] = [{ kind: 'open-chat', label: 'Open chat', sessionId: j.sessionId }];
    let urgency: Urgency | undefined; let title = '';
    if (j.status === 'pending') { urgency = 'urgent'; title = `Long job waiting for your approval: ${j.title}`; }
    else if (j.status === 'paused' || j.status === 'budget') { urgency = 'soon'; title = `Long job ${j.status === 'budget' ? 'stopped at its budget' : 'paused'}: ${j.title}`; }
    else if (j.status === 'running') { urgency = 'fyi'; title = `Long job running: ${j.title}`; }
    else if ((j.status === 'done' || j.status === 'stopped') && last >= since) { urgency = 'fyi'; title = `Long job ${j.status === 'done' ? 'finished' : 'stopped'}: ${j.title}`; }
    if (!urgency) continue;
    out.push({ key: `longjob|${j.id}|${j.status}`, source: 'longjob', urgency, title, detail: j.note ? `${progress}; ${j.note}` : progress, project: j.cwd, at: last, actions: chat });
  }
  return out;
}

/** The fields of a `work/types` `WorkRecord` the brief reads. */
export interface WorkLike { id: string; kind: string; title: string; state: string; parent?: string; sessionId?: string; startedAt: number; endedAt?: number; error?: string; result?: string; origin: string }

/**
 * Background agents and schedule firings that settled since the last brief.
 * Top-level only: a chat's own sub-agents are that chat's business. Failures
 * one by one; successes counted into a single line — ten green nightly jobs
 * are one fact, not ten.
 */
export function workItems(records: WorkLike[], since: number): BriefItem[] {
  const top = records.filter(r => !r.parent && (r.kind === 'agent' || r.kind === 'schedule') && (r.endedAt ?? 0) >= since);
  const out: BriefItem[] = [];
  for (const r of top.filter(r => r.state === 'failed' || r.state === 'lost')) {
    const source = r.kind === 'schedule' ? 'cron' : 'work';
    out.push({
      key: `work|${r.id}`, source, urgency: 'soon',
      title: `${r.kind === 'schedule' ? 'Scheduled run' : 'Background run'} ${r.state === 'lost' ? 'was lost' : 'failed'}: ${r.title.replace(/^\[cron\]\s*/, '')}`,
      ...(r.error ? { detail: r.error.split('\n')[0]!.slice(0, 160) } : {}),
      at: r.endedAt,
      actions: r.sessionId ? [{ kind: 'open-chat', label: 'Open run', sessionId: r.sessionId }] : [],
    });
  }
  const ok = top.filter(r => r.state === 'done');
  if (ok.length) {
    out.push({
      key: `work|done|${ok.map(r => r.id).sort().join(',')}`, source: ok.every(r => r.kind === 'schedule') ? 'cron' : 'work', urgency: 'fyi',
      title: `${ok.length} background/scheduled run${ok.length === 1 ? '' : 's'} finished`,
      detail: ok.slice(0, 4).map(r => r.title.replace(/^\[cron\]\s*/, '')).join('; '),
      at: Math.max(...ok.map(r => r.endedAt ?? 0)),
      actions: ok.length === 1 && ok[0]!.sessionId ? [{ kind: 'open-chat', label: 'Open run', sessionId: ok[0]!.sessionId }] : [],
    });
  }
  return out;
}

// ── GitHub, through gh ───────────────────────────────────────────────

/** Signed in? `gh auth status` exits non-zero when not; its output (a masked token line) is discarded. */
export async function ghState(run: Runner): Promise<'ok' | 'missing' | 'signed-out'> {
  const r = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (r.missing) return 'missing';
  return r.code === 0 ? 'ok' : 'signed-out';
}

export interface RepoInfo { nameWithOwner: string; url: string; defaultBranch: string }

export async function repoInfo(run: Runner, cwd: string): Promise<RepoInfo | undefined> {
  const j = json<{ nameWithOwner?: string; url?: string; defaultBranchRef?: { name?: string } }>(await run('gh', ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], cwd));
  if (!j?.nameWithOwner) return undefined;
  return { nameWithOwner: j.nameWithOwner, url: j.url ?? '', defaultBranch: j.defaultBranchRef?.name || 'main' };
}

interface GhPr {
  number: number; title: string; url: string; updatedAt?: string; isDraft?: boolean; author?: { login?: string };
  reviewDecision?: string; headRefName?: string;
  statusCheckRollup?: Array<{ __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
}
interface GhIssue { number: number; title: string; url: string; createdAt?: string; updatedAt?: string }
interface GhRun { databaseId: number; workflowName?: string; displayTitle?: string; status?: string; conclusion?: string; url?: string; createdAt?: string; headBranch?: string }

const FAILED_CHECK = /^(FAILURE|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED|ERROR)$/i;

/** The failing check names on a PR's rollup (CheckRun conclusions and StatusContext states). */
export function failingChecks(pr: Pick<GhPr, 'statusCheckRollup'>): string[] {
  return (pr.statusCheckRollup ?? [])
    .filter(c => FAILED_CHECK.test(String(c.conclusion ?? '')) || FAILED_CHECK.test(String(c.state ?? '')))
    .map(c => c.name ?? c.context ?? 'check');
}

/** The latest completed run per workflow on the default branch (from `gh run list`, newest first). */
export function latestRuns(runs: GhRun[], branch: string): GhRun[] {
  const seen = new Map<string, GhRun>();
  for (const r of runs) {
    if (r.status !== 'completed' || (r.headBranch && r.headBranch !== branch)) continue;
    const wf = r.workflowName ?? 'workflow';
    if (!seen.has(wf)) seen.set(wf, r);
  }
  return [...seen.values()];
}

const failedRun = (r: GhRun): boolean => /^(failure|timed_out|startup_failure)$/.test(String(r.conclusion ?? ''));

export interface GithubProjectResult {
  repo?: RepoInfo;
  items: BriefItem[];
  /** For monitors: what was seen this time. */
  reviews: Array<{ number: number; title: string; url: string }>;
  runs: GhRun[];
}

const fixPrompt = (what: string): string =>
  `${what}\n\nInvestigate the cause first and tell me what you find before changing anything. Do not push, merge or comment on GitHub.`;

/** PR review requests, your PRs that need you, new issues assigned, and red default-branch CI — for one project. */
export async function githubForProject(run: Runner, cwd: string, since: number, parts: { reviews?: boolean; mine?: boolean; issues?: boolean; ci?: boolean } = {}): Promise<GithubProjectResult> {
  const want = { reviews: true, mine: true, issues: true, ci: true, ...parts };
  const repo = await repoInfo(run, cwd);
  if (!repo) return { items: [], reviews: [], runs: [] };
  const name = repo.nameWithOwner;
  const items: BriefItem[] = [];
  let reviews: GithubProjectResult['reviews'] = [];
  let runs: GhRun[] = [];

  if (want.reviews) {
    const prs = json<GhPr[]>(await run('gh', ['pr', 'list', '--search', 'review-requested:@me', '--state', 'open', '--limit', '20', '--json', 'number,title,url,author,updatedAt,isDraft'], cwd)) ?? [];
    reviews = prs.filter(p => !p.isDraft).map(p => ({ number: p.number, title: p.title, url: p.url }));
    for (const p of prs.filter(p => !p.isDraft)) {
      items.push({ key: `gh|${name}|pr|${p.number}|review`, source: 'github', urgency: 'urgent', title: `Review requested: ${name}#${p.number} ${p.title}`, ...(p.author?.login ? { detail: `by ${p.author.login}` } : {}), project: cwd, at: ts(p.updatedAt), actions: open(p.url, 'Open PR') });
    }
  }
  if (want.mine) {
    const prs = json<GhPr[]>(await run('gh', ['pr', 'list', '--author', '@me', '--state', 'open', '--limit', '20', '--json', 'number,title,url,reviewDecision,statusCheckRollup,headRefName,updatedAt'], cwd)) ?? [];
    for (const p of prs) {
      const failing = failingChecks(p);
      if (failing.length) {
        items.push({
          key: `gh|${name}|pr|${p.number}|checks`, source: 'github', urgency: 'urgent',
          title: `Checks failing on your PR ${name}#${p.number} ${p.title}`, detail: failing.slice(0, 4).join(', '), project: cwd, at: ts(p.updatedAt),
          actions: [...open(p.url, 'Open PR'), { kind: 'start-fix', label: 'Start a fix', cwd, prompt: fixPrompt(`The checks ${failing.slice(0, 4).join(', ')} are failing on my pull request ${name}#${p.number} ("${p.title}", branch ${p.headRefName ?? '?'}). Use \`gh pr checks ${p.number}\` and the failing run's log to find out why.`) }],
        });
      }
      if (p.reviewDecision === 'CHANGES_REQUESTED') {
        items.push({ key: `gh|${name}|pr|${p.number}|changes`, source: 'github', urgency: 'soon', title: `Changes requested on your PR ${name}#${p.number} ${p.title}`, project: cwd, at: ts(p.updatedAt), actions: open(p.url, 'Open PR') });
      }
    }
  }
  if (want.issues) {
    const issues = json<GhIssue[]>(await run('gh', ['issue', 'list', '--assignee', '@me', '--state', 'open', '--limit', '20', '--json', 'number,title,url,createdAt,updatedAt'], cwd)) ?? [];
    for (const i of issues.filter(i => Math.max(ts(i.createdAt), ts(i.updatedAt)) >= since)) {
      const isNew = ts(i.createdAt) >= since;
      items.push({ key: `gh|${name}|issue|${i.number}`, source: 'github', urgency: 'soon', title: `${isNew ? 'New issue assigned' : 'Assigned issue updated'}: ${name}#${i.number} ${i.title}`, project: cwd, at: ts(i.updatedAt), actions: open(i.url, 'Open issue') });
    }
  }
  if (want.ci) {
    runs = json<GhRun[]>(await run('gh', ['run', 'list', '--branch', repo.defaultBranch, '--limit', '20', '--json', 'databaseId,workflowName,displayTitle,status,conclusion,url,createdAt,headBranch'], cwd)) ?? [];
    for (const r of latestRuns(runs, repo.defaultBranch).filter(failedRun)) {
      items.push({
        key: `gh|${name}|run|${r.databaseId}`, source: 'github', urgency: 'urgent',
        title: `CI failing on ${repo.defaultBranch}: ${name} — ${r.workflowName ?? 'workflow'}`, ...(r.displayTitle ? { detail: r.displayTitle } : {}), project: cwd, at: ts(r.createdAt),
        actions: [...open(r.url, 'Open run'), { kind: 'start-fix', label: 'Start a fix', cwd, prompt: fixPrompt(`The "${r.workflowName ?? 'CI'}" workflow is failing on ${repo.defaultBranch} in ${name} (run ${r.databaseId}). Read its log with \`gh run view ${r.databaseId} --log-failed\`.`) }],
      });
    }
  }
  return { repo, items, reviews, runs };
}

// ── local git hygiene ────────────────────────────────────────────────

export const STALE_BRANCH_DAYS = 30;

/** Uncommitted work and local branches nobody has touched in a month. Read-only git. */
export async function gitHygiene(run: Runner, cwd: string, now: number, defaultBranch?: string): Promise<BriefItem[]> {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return [];
  const items: BriefItem[] = [];
  const name = baseName(cwd);
  const status = await run('git', ['status', '--porcelain=v1'], cwd);
  const changed = status.code === 0 ? status.stdout.split('\n').filter(l => l.trim()).length : 0;
  if (changed > 0) {
    items.push({ key: `git|${cwd}|dirty|${changed}`, source: 'git', urgency: 'fyi', title: `${changed} uncommitted change${changed === 1 ? '' : 's'} in ${name}`, project: cwd, actions: [] });
  }
  const current = (await run('git', ['branch', '--show-current'], cwd)).stdout.trim();
  const refs = await run('git', ['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads'], cwd);
  const keep = new Set([current, defaultBranch ?? '', 'main', 'master', 'develop'].filter(Boolean));
  const stale = refs.stdout.split('\n').map(l => l.split('\t')).filter(([b, t]) => b && t && !keep.has(b) && now - Number(t) * 1000 > STALE_BRANCH_DAYS * 86_400_000).map(([b]) => b!);
  if (stale.length) {
    items.push({ key: `git|${cwd}|stale|${stale.sort().join(',')}`, source: 'git', urgency: 'fyi', title: `${stale.length} stale branch${stale.length === 1 ? '' : 'es'} in ${name} (no commits for ${STALE_BRANCH_DAYS}+ days)`, detail: stale.slice(0, 5).join(', '), project: cwd, actions: [] });
  }
  return items;
}

// ── dependency advisories ────────────────────────────────────────────

export interface CachedAdvisory { id: string; pkg: string; severity: string; title: string; fix?: string }

/** Advisories first seen now, high and critical only — the rest wait for someone who runs DependencyAudit. */
export function advisoryItems(cwd: string, current: CachedAdvisory[], previousIds: string[] | undefined): BriefItem[] {
  if (!previousIds) return []; // the first audit of a project is a baseline, not news
  const had = new Set(previousIds);
  return current.filter(a => !had.has(a.id) && (a.severity === 'critical' || a.severity === 'high')).slice(0, 8).map(a => ({
    key: `adv|${cwd}|${a.id}`, source: 'advisory' as const, urgency: a.severity === 'critical' ? 'urgent' as const : 'soon' as const,
    title: `New ${a.severity} advisory in ${baseName(cwd)}: ${a.pkg} — ${a.title}`.slice(0, 200),
    detail: `${a.id}${a.fix ? `; fix: ${a.fix}` : ''}`, project: cwd,
    actions: [{ kind: 'start-fix', label: 'Start a fix', cwd, prompt: `A new ${a.severity} advisory ${a.id} affects ${a.pkg} in this project (${a.title}). Run DependencyAudit, explain the exposure and propose the smallest upgrade that fixes it. Do not change anything until I agree.` }],
  }));
}

// ── opted-in MCP sources ─────────────────────────────────────────────

export interface McpToolLike { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }

/** The text of an MCP tool result (`content[].text`), or a JSON rendering. */
export function mcpText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> } | string | undefined;
  if (typeof r === 'string') return r;
  if (r && Array.isArray(r.content)) return r.content.filter(c => typeof c.text === 'string').map(c => c.text).join('\n');
  try { return JSON.stringify(result ?? ''); } catch { return ''; }
}

/**
 * Read the MCP tools the person named in `brief.mcp` — nothing else, and only
 * tools the registry currently offers (an unapproved or changed tool is not
 * there). One item each, the first lines of what it returned.
 */
export async function mcpItems(sources: BriefMcpSource[], tools: McpToolLike[], redact: (s: string) => string): Promise<{ items: BriefItem[]; notes: string[] }> {
  const items: BriefItem[] = []; const notes: string[] = [];
  for (const s of sources.slice(0, 5)) {
    const tool = tools.find(t => t.name === `mcp__${s.server}__${s.tool}`);
    if (!tool) { notes.push(`MCP ${s.server}/${s.tool} is not available (not connected, or not approved).`); continue; }
    try {
      const text = redact(mcpText(await Promise.race([tool.execute(s.args ?? {}), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 20_000).unref?.())])));
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      items.push({ key: `mcp|${s.server}|${s.tool}|${lines.slice(0, 6).join('|').slice(0, 300)}`, source: 'mcp', urgency: 'fyi', title: s.label ?? `${s.server}: ${s.tool}`, detail: lines.slice(0, 6).join(' · ').slice(0, 400), actions: [] });
    } catch (err) {
      notes.push(`MCP ${s.server}/${s.tool} failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return { items, notes };
}
