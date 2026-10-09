/**
 * PR-mode landing: the network half of Delivery's `pr` landing mode (ADR 0039 section 2).
 *
 * Delivery decides WHAT happens to a task (its states, the queue, who may say yes) and never
 * touches a network. This module is what it calls through the {@link LandingHooks} seam:
 * push the task branch, open or update the pull request with the evidence packet, merge when a
 * person clicks and the remote allows, and report what the remote says so Delivery can move the
 * task. Every rule that keeps it safe is enforced here or in `git.ts`, not requested in a prompt:
 *
 *  - **A person starts every push.** The only caller of `openPr` is Delivery's landing, reached
 *    from a human-gated route; there is no auto path and no tool that calls it.
 *  - **Only `aico/task-*` goes out, never forced** (git.ts), to the mapped repository's clone URL
 *    on the connection's own host, with the token delivered through the read-once sink.
 *  - **The remote's rules are the gate.** AICO never calls an admin-bypass merge, edits a
 *    protection or approves its own pull request. `mergePr` refuses unless the remote reports the
 *    pull request mergeable with its requirements met, and passes the head SHA it saw so a push
 *    after review cannot be merged unseen.
 *  - **Remote text is data.** A failing check's summary or a reviewer's comment that reaches the
 *    agent is sanitised and fenced as untrusted, and review comments reach it only from authors
 *    the provider marks as members or collaborators, or the connection's own trusted list
 *    ({@link trustedComments}); other comments are counted and shown to the person, not the agent.
 *  - **No AI credit** is written to the remote: bodies and comments pass through
 *    `withoutAttribution` (AGENTS.md section 4).
 *
 * What it does not do: decide a task's state, or run on a timer (poller.ts).
 *
 * @module connections/landing
 */

import os from 'node:os';
import * as D from '../delivery/index.js';
import * as G from '../delivery/git.js';
import type { LandingHooks } from '../delivery/index.js';
import * as S from '../delivery/store.js';
import type { Task } from '../delivery/types.js';
import { connectionDecision } from '../policy/enforce.js';
import { sinkRedactText } from '../vault/sink.js';
import type { Comment } from './adapter.js';
import { auditConnection } from './audit.js';
import { pushTaskBranch, refreshTrunk } from './git.js';
import { REMOTE_LIMITS, fenceRemote, sanitizeLine, sanitizeRemoteText, withoutAttribution } from './sanitize.js';
import { asError, ctxFor } from './service.js';
import * as Store from './store.js';
import type { ProjectMapping, PullState, StoredConnection } from './types.js';

interface Linked { mapping: ProjectMapping; conn: StoredConnection }

export function linkedFor(project: string): Linked | undefined {
  const mapping = Store.getMapping(project);
  if (!mapping) return undefined;
  const conn = Store.getConnection(mapping.connection);
  return conn ? { mapping, conn } : undefined;
}

/** The mode in force: `pr` only while the mapping says so AND the connection is usable and allowed. */
export function landingMode(project: string): 'local' | 'pr' {
  const l = linkedFor(project);
  if (!l || l.mapping.landing !== 'pr' || l.conn.disabled || !l.conn.credential) return 'local';
  return connectionDecision({ provider: l.conn.provider, host: new URL(l.conn.baseUrl).hostname, landing: 'pr' }).ok ? 'pr' : 'local';
}

// ── the pull request's text ──────────────────────────────────────────────

/** Replace this machine's paths in text that is about to leave it. */
export function scrubLocalPaths(text: string, project: string, worktree?: string): string {
  let out = text;
  const repl = (needle: string | undefined, label: string): void => {
    if (!needle || needle.length < 4) return;
    for (const v of new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\//g, '\\')])) out = out.split(v).join(label);
  };
  repl(worktree, '<worktree>');
  repl(project, '<project>');
  repl(os.homedir(), '<home>');
  return out;
}

export function prTitle(task: Task): string { return sanitizeLine(task.title, 200) || `Task ${task.id}`; }

/** The pull request description: the evidence packet, with no AI credit and none of this machine's paths. */
export function prBody(task: Task, project: string, opts: { closes?: string } = {}): string {
  const parts = [
    task.evidence?.md ?? `## Task ${task.id}: ${task.title}`,
    opts.closes ? `\nCloses #${opts.closes}` : '',
    `\n---\nDelivery task \`${task.id}\`.`,
  ];
  return withoutAttribution(sinkRedactText(scrubLocalPaths(parts.join('\n'), project, task.worktree))).trim();
}

// ── trusted feedback ─────────────────────────────────────────────────────

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * Which of a pull request's comments may reach the agent. A drive-by commenter on a public
 * repository must not steer a fix: only owners, members and collaborators (as the provider marks
 * them), the token's own account (the person) and the connection's listed commenters. The rest
 * are counted so the person can look.
 */
export function trustedComments(comments: readonly Comment[], opts: { me?: string; trusted?: readonly string[] }): { trusted: Comment[]; hidden: number } {
  const names = new Set([...(opts.trusted ?? []), ...(opts.me ? [opts.me] : [])].map(s => s.toLowerCase()));
  const trusted = comments.filter(c => TRUSTED_ASSOCIATIONS.has(c.association.toUpperCase()) || names.has(c.author.toLowerCase()));
  return { trusted, hidden: comments.length - trusted.length };
}

function feedbackText(pr: PullState, comments: Comment[], linked: Linked): string | undefined {
  const { trusted, hidden } = trustedComments(comments, { ...(linked.conn.probe?.user ? { me: linked.conn.probe.user } : {}), trusted: linked.mapping.trustedCommenters ?? [] });
  const blocks: string[] = [];
  const failing = pr.checks.items.filter(c => c.state === 'failure' && c.summary);
  if (failing.length > 0) {
    blocks.push(fenceRemote('Failing check output', failing.slice(0, 4).map(c => `${c.name}: ${c.summary}`).join('\n\n'), `the remote's checks on ${pr.url}`));
  }
  const reviews = trusted.filter(c => c.review === 'changes' || (c.review === undefined && c.body)).slice(-4);
  if (reviews.length > 0) {
    blocks.push(fenceRemote('Review comments', reviews.map(c => `${c.author}: ${sanitizeRemoteText(c.body, REMOTE_LIMITS.comment)}`).join('\n\n'), `reviewers of ${pr.url}`));
  }
  if (hidden > 0) blocks.push(`(${hidden} comment${hidden === 1 ? '' : 's'} from people who are not members or collaborators were not passed to the agent; read them on ${pr.url}.)`);
  return blocks.length ? blocks.join('\n\n') : undefined;
}

// ── the hooks ────────────────────────────────────────────────────────────

type Opened = { ok: true; pr: PullState } | { ok: false; reason: string; status?: number };

async function openPr(project: string, task: Task): Promise<Opened> {
  const linked = linkedFor(project);
  if (!linked || linked.mapping.landing !== 'pr') return { ok: false, reason: 'This project is not set to pull-request mode (Connections page).', status: 409 };
  const { mapping, conn } = linked;
  const d = connectionDecision({ provider: conn.provider, host: new URL(conn.baseUrl).hostname, landing: 'pr' });
  if (!d.ok) return { ok: false, reason: d.message, status: 403 };
  if (!task.branch) return { ok: false, reason: 'The task has no branch to push.', status: 409 };
  try {
    const { adapter, ctx } = ctxFor(conn, { repo: mapping.repo, project });
    if (!adapter.pulls) return { ok: false, reason: `${conn.label} cannot open pull requests.`, status: 409 };
    const info = await adapter.repos.get(ctx, mapping.repo);
    const repoRoot = await G.repoRootOf(project);
    if (!repoRoot) return { ok: false, reason: 'This project is not a git repository.', status: 409 };
    const pushed = await pushTaskBranch({ conn, repo: repoRoot, cloneUrl: info.cloneUrl, branch: task.branch, trunk: mapping.trunk, project });
    if (!pushed.ok) return { ok: false, reason: pushed.message, status: pushed.kind === 'non-fast-forward' ? 409 : pushed.kind === 'auth' ? 403 : 502 };
    const closes = task.remote && task.remote.connection === conn.id ? task.remote.id : undefined;
    const body = prBody(task, project, closes ? { closes } : {});
    const existing = await adapter.pulls.find(ctx, task.branch);
    if (existing) {
      const updated = await adapter.pulls.update(ctx, existing.id, { title: prTitle(task), body });
      await adapter.pulls.comment(ctx, existing.id, withoutAttribution(`New commits were pushed to \`${task.branch}\` for task \`${task.id}\`.`)).catch(() => undefined);
      auditConnection({ action: 'pr.open', connection: conn.id, provider: conn.provider, ref: `${mapping.repo.owner}/${mapping.repo.name}#${existing.id}`, detail: 'updated', project });
      return { ok: true, pr: updated };
    }
    const created = await adapter.pulls.create(ctx, { head: task.branch, base: mapping.trunk, title: prTitle(task), body });
    if (created.overflow) await adapter.pulls.comment(ctx, created.pull.id, withoutAttribution(`The rest of the change report:\n\n${created.overflow}`)).catch(() => undefined);
    auditConnection({ action: 'pr.open', connection: conn.id, provider: conn.provider, ref: `${mapping.repo.owner}/${mapping.repo.name}#${created.pull.id}`, project });
    return { ok: true, pr: created.pull };
  } catch (e) {
    const err = asError(e);
    return { ok: false, reason: err.message, status: err.status };
  }
}

async function mergePr(project: string, task: Task, opts: { method?: 'merge' | 'squash' | 'rebase' }): Promise<Opened> {
  const linked = linkedFor(project);
  if (!linked || !task.pr) return { ok: false, reason: 'This task has no pull request on a connected remote.', status: 409 };
  const { mapping, conn } = linked;
  const d = connectionDecision({ provider: conn.provider, host: new URL(conn.baseUrl).hostname, landing: 'pr' });
  if (!d.ok) return { ok: false, reason: d.message, status: 403 };
  try {
    const { adapter, ctx } = ctxFor(conn, { repo: mapping.repo, project });
    if (!adapter.pulls?.merge) return { ok: false, reason: `${conn.label} cannot merge from here; merge on the platform.`, status: 409 };
    const now = await adapter.pulls.get(ctx, task.pr.id);
    if (now.state === 'merged') return { ok: true, pr: now };
    if (!now.canMerge) {
      return { ok: false, reason: `The remote says this pull request cannot be merged yet: ${now.mergeBlockers.join('; ') || 'its requirements are not met'}.`, status: 409 };
    }
    await adapter.pulls.merge(ctx, task.pr.id, { method: opts.method ?? 'merge', sha: now.headSha });
    auditConnection({ action: 'pr.merge', connection: conn.id, provider: conn.provider, ref: `${mapping.repo.owner}/${mapping.repo.name}#${task.pr.id}`, project });
    return { ok: true, pr: await adapter.pulls.get(ctx, task.pr.id) };
  } catch (e) {
    const err = asError(e);
    return { ok: false, reason: err.message, status: err.status };
  }
}

async function cloneUrlOf(linked: Linked, project: string): Promise<string | undefined> {
  const { adapter, ctx } = ctxFor(linked.conn, { repo: linked.mapping.repo, project });
  return (await adapter.repos.get(ctx, linked.mapping.repo)).cloneUrl;
}

/** Fetch the trunk and fast-forward the local copy; reports `{from,to}` only when it moved. */
export async function refreshLocalTrunk(project: string): Promise<{ from?: string; to?: string; message: string }> {
  const linked = linkedFor(project);
  if (!linked) return { message: 'no connection' };
  const repoRoot = await G.repoRootOf(project);
  if (!repoRoot) return { message: 'not a git repository' };
  const cloneUrl = await cloneUrlOf(linked, project);
  if (!cloneUrl) return { message: 'no clone URL' };
  const r = await refreshTrunk({ conn: linked.conn, repo: repoRoot, cloneUrl, trunk: linked.mapping.trunk, project });
  return { ...(r.moved ? { from: r.moved.from, to: r.moved.to } : {}), message: r.message };
}

export const prLandingHooks: LandingHooks = {
  mode: landingMode,
  async beforePrepare(project) { await refreshLocalTrunk(project); },
  openPr,
  mergePr,
  async afterMerged(project) {
    const r = await refreshLocalTrunk(project);
    return r.from && r.to ? { from: r.from, to: r.to } : undefined;
  },
};

/** Install PR mode into Delivery (server start-up). */
export function installLanding(): void { D.setLandingHooks(prLandingHooks); }

// ── observing ────────────────────────────────────────────────────────────

export interface ObserveResult { observed: number; moved: number; errors: string[] }

/** Read the remote's state of every task in `pr` and hand it to Delivery. */
export async function observeProject(project: string, signal?: AbortSignal): Promise<ObserveResult> {
  const out: ObserveResult = { observed: 0, moved: 0, errors: [] };
  const linked = linkedFor(project);
  if (!linked || linked.conn.disabled || !linked.conn.credential) return out;
  const tasks = S.boardState(project).tasks.filter(t => t.status === 'pr' && t.pr);
  if (tasks.length === 0) return out;
  const { adapter, ctx } = ctxFor(linked.conn, { repo: linked.mapping.repo, project, ...(signal ? { signal } : {}) });
  if (!adapter.pulls) return out;
  for (const t of tasks) {
    try {
      const pr = await adapter.pulls.get(ctx, t.pr!.id);
      let feedback: string | undefined;
      if (pr.state === 'open' && (pr.checks.state === 'failing' || pr.reviews.state === 'changes')) {
        const comments = pr.reviews.state === 'changes' ? await adapter.pulls.comments(ctx, t.pr!.id).catch(() => [] as Comment[]) : [];
        feedback = feedbackText(pr, comments, linked);
      }
      const before = t.status;
      const after = await D.observePr(project, t.id, pr, feedback ? { feedback } : {});
      out.observed++;
      if (after && after.status !== before) out.moved++;
    } catch (e) {
      out.errors.push(`${t.id}: ${asError(e).message}`);
    }
  }
  return out;
}

