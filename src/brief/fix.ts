/**
 * "Fix all" for the morning brief: turn advisory items into one confirmed
 * plan, then one background agent per project.
 *
 * WHY IT EXISTS. The brief listed the same advisory once per project and every
 * row had its own "Start a fix", so fixing five projects meant five chats.
 * Fix all is the same work done in one confirmed click — but it spawns paid,
 * unattended work that edits files, so it is shaped to be safe by construction
 * rather than by asking the model nicely:
 *
 *  - The client sends item KEYS, never prompts, paths or versions. Everything
 *    the agents are told comes from the stored brief (what the engine itself
 *    found), so a page, a tool result or another client cannot smuggle text
 *    into the prompt of an agent that runs with permissions.
 *  - Starting needs a person (`human()` in the route, desktop grant through
 *    HUMAN_ROUTES) — the plan is shown first (`brief/fix-plan`, a read).
 *  - A project with uncommitted changes, or that is not a git repository, is
 *    SKIPPED (reported, never touched). Otherwise the engine itself creates
 *    the branch (`fix/advisory-<id>`, or `fix/advisories-<date>`) before the
 *    agent starts, so "never commit on main" holds by construction: the agent
 *    begins already on its branch.
 *  - One agent per project, started independently: one project failing (or
 *    refusing to start) does not stop the others. Each gets a spend ceiling and
 *    a deadline from the work ledger's supervisor, and shows in the Tasks panel
 *    like any background agent. They run auto-approve and unattended with the
 *    inbox (`fixAgentOptions`), never full autonomy: the Sentinel and shell
 *    confinement apply exactly as in a chat, and what they stop waits for the
 *    person instead of proceeding. The prompt also forbids global installs, but
 *    that is not what enforces it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Push, open a PR, merge, or touch a project
 * that is not in the brief. Non-advisory items (uncommitted changes, stale
 * branches) get "Review", not a fix.
 *
 * @module brief/fix
 */

import path from 'node:path';
import type { BriefAdvisory, BriefItem } from './core.js';
import type { Runner } from './collect.js';
import type { SpawnBackgroundAgentOptions } from '../background/index.js';

export interface FixTarget extends BriefAdvisory { /** the item keys this target came from */ itemKey: string }

export interface FixProject {
  project: string;
  name: string;
  /** The branch the work will be committed on. */
  branch: string;
  targets: FixTarget[];
  /** Why this project will not be touched (checked by {@link vetProjects}). */
  blocked?: string;
}

export interface FixPlan { projects: FixProject[]; skipped: string[] }

export const MAX_FIX_PROJECTS = 8;
export const DEFAULT_FIX_BUDGET_USD = 2;
export const FIX_DEADLINE_MS = 30 * 60 * 1000;

const baseName = (p: string): string => path.basename(p.replace(/[\\/]+$/, '')) || p;
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3 };

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

/** A branch-safe slug for an advisory id or date. */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

/**
 * The plan for the chosen item keys. Advisory items only; anything else (or a
 * key not in the brief) is listed in `skipped`, so the confirmation can say so.
 */
export function planFix(items: BriefItem[], keys: string[], now = Date.now()): FixPlan {
  const byKey = new Map(items.map(i => [i.key, i]));
  const byProject = new Map<string, FixProject>();
  const skipped: string[] = [];
  for (const key of [...new Set(keys)]) {
    const it = byKey.get(key);
    const adv = it && advisoryOf(it);
    if (!it || !adv || !it.project) { skipped.push(it ? `${it.title.slice(0, 80)} is not a dependency advisory` : `${key.slice(0, 60)} is not in the latest brief`); continue; }
    const p = path.resolve(it.project);
    const entry = byProject.get(p) ?? { project: p, name: baseName(p), branch: '', targets: [] };
    if (!entry.targets.some(t => t.id === adv.id && t.pkg === adv.pkg)) entry.targets.push({ ...adv, itemKey: key });
    byProject.set(p, entry);
  }
  const date = new Date(now).toISOString().slice(0, 10);
  const projects = [...byProject.values()].map(p => {
    p.targets.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.pkg.localeCompare(b.pkg));
    p.branch = p.targets.length === 1 ? `fix/advisory-${slug(p.targets[0]!.id)}` : `fix/advisories-${date}`;
    return p;
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (projects.length > MAX_FIX_PROJECTS) {
    skipped.push(`${projects.length - MAX_FIX_PROJECTS} more project(s) beyond the limit of ${MAX_FIX_PROJECTS} per run: ${projects.slice(MAX_FIX_PROJECTS).map(p => p.name).join(', ')}`);
    projects.length = MAX_FIX_PROJECTS;
  }
  return { projects, skipped };
}

/** Mark the projects that must not be touched: not a repository, uncommitted work, a branch that cannot be told. Read-only git. */
export async function vetProjects(plan: FixPlan, run: Runner): Promise<FixPlan> {
  for (const p of plan.projects) {
    const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], p.project);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') { p.blocked = 'not a git repository, so the fix could not be kept on its own branch'; continue; }
    const status = await run('git', ['status', '--porcelain=v1'], p.project);
    if (status.code !== 0) { p.blocked = 'git status failed'; continue; }
    const dirty = status.stdout.split('\n').filter(l => l.trim()).length;
    if (dirty > 0) p.blocked = `${dirty} uncommitted change${dirty === 1 ? '' : 's'} — commit or stash them first`;
  }
  return plan;
}

/** What one project's agent is told. Built only from the engine's own findings. */
export function fixPrompt(p: FixProject): string {
  const list = p.targets.map(t => `- ${t.pkg}: ${t.id} (${t.severity}) — ${t.title}. ${t.fix ? `Patched in ${t.fix}.` : 'No patched version is recorded: run DependencyAudit to find the smallest fixed one.'}`).join('\n');
  return [
    `Fix these dependency advisories in this project (${p.name}). You are on the branch ${p.branch}, created for this work; the working tree was clean when you started.`,
    list,
    'Do exactly this:',
    '1. Run DependencyAudit first and confirm each advisory is really present in this project (several lockfiles may list it).',
    '2. Upgrade each package to the patched version (or the smallest fixed one), with the project\'s own package manager and lockfile, inside this folder only. No global installs, no `-g`, no changes outside this project.',
    '3. Run the project\'s tests and checks (RunChecks, or the project\'s own test script). If they fail because of the upgrade, fix what the upgrade broke if it is small; otherwise revert that package and say so.',
    '4. Commit on this branch with a message naming the advisories. Never commit to main/master/the default branch, never push, never open a pull request.',
    '5. Finish with a short per-package result: upgraded to what, tests passed or failed, commit id, or why it was left alone. If anything could not be done, say so plainly.',
  ].join('\n');
}

/**
 * How a fix agent runs: the ordinary auto-approve mode, unattended with the
 * approve-later inbox (L4) — NOT `permissions: 'full'`, and never full
 * autonomy. Edits and the project's own commands go ahead; anything the guards
 * stop (a Sentinel escalation, a shell-confinement request: a write outside the
 * project, a download, a global install) is parked in "Waiting for you" when the
 * inbox can replay it and otherwise refused and reported — never approved on the
 * agent's behalf. The Sentinel is pinned to `ask` here so a person's own
 * `sentinel.onEscalate: proceed` cannot turn an unattended run into one that
 * proceeds unasked.
 */
export function fixAgentOptions(base: SpawnBackgroundAgentOptions, cwd: string, label: string): SpawnBackgroundAgentOptions {
  return {
    ...base,
    permissions: 'inherit',
    autoApprove: true,
    autonomy: 'L4',
    cwd,
    parkFrom: { origin: 'background', label },
    settings: { ...base.settings, sentinel: { ...base.settings?.sentinel, onEscalate: 'ask' } },
  };
}

export interface FixStarted { project: string; name: string; branch: string; status: 'started' | 'skipped'; agentId?: string; reason?: string }

export interface FixDeps {
  run: Runner;
  /** Starts one background agent; returns its id. */
  spawn: (args: { description: string; prompt: string }, cwd: string) => string;
  /** Sets the supervisor's ceiling for a started agent. */
  police?: (agentId: string) => void;
}

/**
 * Create each project's branch, then start its agent. Independent: a failure
 * in one project is recorded and the next still starts. Returns one row each.
 */
export async function startFix(plan: FixPlan, deps: FixDeps): Promise<FixStarted[]> {
  const out: FixStarted[] = [];
  for (const p of plan.projects) {
    const row = { project: p.project, name: p.name, branch: p.branch };
    if (p.blocked) { out.push({ ...row, status: 'skipped', reason: p.blocked }); continue; }
    try {
      // The engine, not the agent, creates the branch: the agent can only ever start on it.
      let branch = p.branch;
      let made = await deps.run('git', ['switch', '-c', branch], p.project);
      for (let n = 2; made.code !== 0 && n <= 5 && /already exists/.test(made.stderr); n++) {
        branch = `${p.branch}-${n}`;
        made = await deps.run('git', ['switch', '-c', branch], p.project);
      }
      if (made.code !== 0) { out.push({ ...row, status: 'skipped', reason: `could not create the branch: ${made.stderr.trim().slice(0, 120)}` }); continue; }
      p.branch = branch;
      const agentId = deps.spawn({ description: `Fix ${p.targets.length === 1 ? p.targets[0]!.id : `${p.targets.length} advisories`} in ${p.name}`, prompt: fixPrompt(p) }, p.project);
      deps.police?.(agentId);
      out.push({ ...row, branch, status: 'started', agentId });
    } catch (err) {
      out.push({ ...row, status: 'skipped', reason: (err as Error).message.slice(0, 160) });
    }
  }
  return out;
}
