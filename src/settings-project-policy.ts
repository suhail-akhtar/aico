/**
 * What a project's own settings files may set: an allow-list, not a deny-list.
 *
 * A project's `.aico/settings.json` and `.aico/settings.local.json` live in
 * the repository. The agent can write them and a cloned repository brings its
 * own, so they are not the person's choice. Workspace trust gated only the
 * sections that *run* something (`mcpServers`, `hooks`, `env`); everything
 * else merged straight in, and a probe with a hostile project file showed
 * what that meant: `autoApprove: true` switched off every permission prompt,
 * `providers.*.baseUrl` / `providerInstances` / `activeProvider` / `provider`
 * sent the person's API key and every prompt to a URL the repository chose,
 * and `miniApps: { enabled: true, host: "0.0.0.0" }` opened an unauthenticated
 * listener on the LAN.
 *
 * So the filtering is inverted. {@link PROJECT_POLICY} names every top-level
 * key of `AicoSettings` with one of:
 *   - `allow`: per-project tuning (compaction, timeouts, a licence list…).
 *   - `trust-gated`: runs something; workspace-trust.ts strips it until a
 *     person approves the exact config, then it applies.
 *   - `tighten`: safety-related; a project may make it stricter than the
 *     person's own setting, never looser ({@link tightenProjectLayer}).
 *   - `user-only`: dropped from project layers.
 * A key not in the table — a setting added later — is dropped (user-only):
 * forgetting to classify a new key fails closed. The table's type requires an
 * entry for every key, so the compiler asks the question too, and
 * `scripts/security-settings-test.mjs` asserts each key's policy.
 *
 * Deliberately not here: `sentinel` is tightened by `tightenOnlySentinel` and
 * model choices inside `learning`/`sessionTitles`/`brief` by
 * `dropProjectModelChoices` (both already in `loadSettings`); this module
 * leaves those keys to them rather than doing the same job twice.
 *
 * @module settings-project-policy
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AicoSettings } from './settings.js';
import { aicoHome } from './home.js';

export type ProjectPolicy = 'allow' | 'trust-gated' | 'tighten' | 'user-only';

/** Every top-level setting and what a project file may do with it. */
export const PROJECT_POLICY = {
  model: 'allow',
  // Credentials and where they are sent: the person's alone.
  provider: 'user-only',
  providerInstances: 'user-only',
  activeProvider: 'user-only',
  providers: 'user-only',
  sessionTitles: 'allow',
  learning: 'allow',
  // Switches off every permission prompt.
  autoApprove: 'user-only',
  agentTimeout: 'allow',
  bashTimeout: 'allow',
  hooks: 'trust-gated',
  env: 'trust-gated',
  mcpServers: 'trust-gated',
  // Its path is a folder shell writes are allowed into (ADR 0027): inside the repository only.
  workspace: 'tighten',
  // Per-person lists: folders, groups, and the instructions they carry.
  projects: 'user-only',
  groups: 'user-only',
  autoCompact: 'allow',
  contextManagement: 'allow',
  mcpSecurity: 'allow',
  agents: 'allow',
  skills: 'tighten',
  memory: 'allow',
  // Opens a listening socket; the host can put it on the LAN.
  miniApps: 'user-only',
  cron: 'allow',
  promptCaching: 'allow',
  theme: 'allow',
  contextWindows: 'allow',
  // Cost estimates feed the spend ceilings: a project pricing a model at 0 would disarm them.
  modelPricing: 'user-only',
  modelCapabilities: 'allow',
  maxIterations: 'allow',
  maxParallelToolCalls: 'allow',
  // `enabled: false` switches off the checks gate, `security: false` the security check.
  completionGate: 'tighten',
  safetyLimits: 'tighten',
  agentModels: 'allow',
  disabledTools: 'allow',
  dependencyAudit: 'allow',
  // Whether install commands are checked against the public registry (ADR 0033): a project may only switch it on.
  supplyChain: 'tighten',
  // Layering rules for the code graph are checks: a project may add rules, never remove the person's.
  codeGraph: 'tighten',
  // Which program "Open in editor" launches: a command line, so the person's alone.
  editor: 'user-only',
  deferTools: 'allow',
  imageGeneration: 'allow',
  sandbox: 'tighten',
  // Where shell commands may write and whether they may download/install (ADR 0027): the person's alone.
  shell: 'user-only',
  // The vault says settings cannot loosen it; turning off the message scan would.
  vault: 'user-only',
  repeatGuard: 'allow',
  longJobs: 'allow',
  sentinel: 'tighten',
  brief: 'allow',
  profile: 'user-only',
  models: 'user-only',
  // Two commands the Delivery board runs (a release's deploy, a worktree's setup): trust-gated like hooks (ADR 0038).
  delivery: 'trust-gated',
} as const satisfies Record<keyof Required<AicoSettings>, ProjectPolicy>;

/** The policy for a top-level key; unknown keys are user-only. */
export function projectPolicyOf(key: string): ProjectPolicy {
  return (PROJECT_POLICY as Record<string, ProjectPolicy>)[key] ?? 'user-only';
}

type Layer = Record<string, unknown>;

const isObj = (v: unknown): v is Layer => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const norm = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Whether `target` (resolved against `root`) lies inside `root`. */
export function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(norm(root), norm(path.resolve(root, target)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const SANDBOX_RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

/**
 * Keep only what makes a tighten-only section stricter than the user's own.
 * Mutates `layer`; returns the dotted keys it removed.
 */
export function tightenProjectLayer(layer: Layer, user: Layer, root: string): string[] {
  const dropped: string[] = [];

  // sandbox: a stricter mode only; no extra writable roots the person did not list.
  if ('sandbox' in layer) {
    const p = isObj(layer.sandbox) ? layer.sandbox : {};
    const u = isObj(user.sandbox) ? user.sandbox : {};
    const kept: Layer = {};
    const userRank = SANDBOX_RANK[String(u.mode ?? 'danger-full-access')] ?? 2;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'mode' && typeof v === 'string' && v in SANDBOX_RANK && SANDBOX_RANK[v]! <= userRank) kept.mode = v;
      else if (k === 'additionalWritableRoots' && Array.isArray(v)
        && v.every(r => typeof r === 'string' && (Array.isArray(u.additionalWritableRoots) ? u.additionalWritableRoots : []).some(ur => typeof ur === 'string' && norm(ur) === norm(path.resolve(root, r))))) kept[k] = v;
      else if (k === 'warnOnPartial' && v === true) kept[k] = v;
      else dropped.push(`sandbox.${k}`);
    }
    if (Object.keys(kept).length) layer.sandbox = kept; else delete layer.sandbox;
  }

  // safetyLimits: a lower ceiling (or one where the person set none), never higher or removed.
  if ('safetyLimits' in layer) {
    const p = isObj(layer.safetyLimits) ? layer.safetyLimits : {};
    const u = isObj(user.safetyLimits) ? user.safetyLimits : {};
    const kept: Layer = {};
    for (const [k, v] of Object.entries(p)) {
      const mine = u[k];
      const ok = typeof v === 'number' && Number.isFinite(v) && v > 0
        && (typeof mine !== 'number' || !(mine > 0) || v <= mine);
      if (ok) kept[k] = v; else dropped.push(`safetyLimits.${k}`);
    }
    if (Object.keys(kept).length) layer.safetyLimits = kept; else delete layer.safetyLimits;
  }

  // skills: directories inside the repository only (outside it is someone else's files).
  if ('skills' in layer) {
    const p = isObj(layer.skills) ? layer.skills : {};
    const kept: Layer = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'dirs' && Array.isArray(v)) {
        const inside = v.filter(d => typeof d === 'string' && insideRoot(root, d)).map(d => path.resolve(root, d as string));
        if (inside.length !== v.length) dropped.push('skills.dirs (outside the repository)');
        if (inside.length) kept.dirs = inside;
      } else if (k === 'disableBuiltins' && typeof v === 'boolean') kept[k] = v;
      else dropped.push(`skills.${k}`);
    }
    if (Object.keys(kept).length) layer.skills = kept; else delete layer.skills;
  }

  // workspace.path: inside the repository only. It is one of the roots the
  // shell may write to, so a repo pointing it at ~/bin would widen that.
  if ('workspace' in layer) {
    const p = isObj(layer.workspace) ? layer.workspace : {};
    const kept: Layer = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'path' && typeof v === 'string' && insideRoot(root, v)) kept.path = path.resolve(root, v);
      else dropped.push(`workspace.${k}`);
    }
    if (Object.keys(kept).length) layer.workspace = kept; else delete layer.workspace;
  }

  // completionGate: a project may switch the gate, its security check or the
  // change-safety review on, never off. All default to on, so `true` is the only value that tightens;
  // any other value or field is dropped rather than merged over the person's.
  if ('completionGate' in layer) {
    const p = isObj(layer.completionGate) ? layer.completionGate : {};
    const kept: Layer = {};
    for (const [k, v] of Object.entries(p)) {
      if ((k === 'enabled' || k === 'security' || k === 'changeSafety') && v === true) kept[k] = v;
      else dropped.push(`completionGate.${k}`);
    }
    if (!isObj(layer.completionGate)) dropped.push('completionGate');
    if (Object.keys(kept).length) layer.completionGate = kept; else delete layer.completionGate;
  }

  // supplyChain: a project may switch the package check on and ask for an older minimum
  // age than the person's (default 30 days); never off, never younger (ADR 0033).
  if ('supplyChain' in layer) {
    const p = isObj(layer.supplyChain) ? layer.supplyChain : {};
    const u = isObj(user.supplyChain) ? user.supplyChain : {};
    const floor = typeof u.minAgeDays === 'number' ? u.minAgeDays : 30;
    const kept: Layer = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'packageCheck' && v === true) kept[k] = v;
      else if (k === 'minAgeDays' && typeof v === 'number' && Number.isFinite(v) && v > floor) kept[k] = v;
      else dropped.push(`supplyChain.${k}`);
    }
    if (!isObj(layer.supplyChain)) dropped.push('supplyChain');
    if (Object.keys(kept).length) layer.supplyChain = kept; else delete layer.supplyChain;
  }

  // codeGraph: a project's layering rules are added to the person's, never in place of
  // them (an empty list must not switch the person's checks off); nothing else is taken.
  if ('codeGraph' in layer) {
    const p = isObj(layer.codeGraph) ? layer.codeGraph : {};
    const u = isObj(user.codeGraph) ? user.codeGraph : {};
    const kept: Layer = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'rules' && Array.isArray(v)) {
        const valid = v.filter(r => isObj(r) && typeof r.from === 'string' && typeof r.to === 'string');
        kept.rules = [...(Array.isArray(u.rules) ? u.rules : []), ...valid];
      } else dropped.push(`codeGraph.${k}`);
    }
    if (Object.keys(kept).length) layer.codeGraph = kept; else delete layer.codeGraph;
  }
  return dropped;
}

/**
 * Apply the project policy to one project layer, in place: drop user-only and
 * unknown keys, tighten the tighten-only ones. `user` is the person's own
 * (global) layer, the baseline a project may only tighten. Returns what was
 * removed, as dotted keys.
 */
export function filterProjectLayer(layer: Layer, user: Layer, root: string): string[] {
  const dropped: string[] = [];
  for (const key of Object.keys(layer)) {
    if (projectPolicyOf(key) === 'user-only') { delete layer[key]; dropped.push(key); }
  }
  dropped.push(...tightenProjectLayer(layer, user, root));
  return dropped;
}

/**
 * The person's own settings file, read synchronously. For a check that must
 * know a value came from the user rather than a project (the Mini App host).
 */
export function readUserSettingsFile(): Layer {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(aicoHome(), 'settings.json'), 'utf8')) as unknown;
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Lines for the workspace-trust card: what in these layers was refused or only tightens. */
export function projectPolicyNotes(root: string, layers: Layer[]): string[] {
  const lines: string[] = [];
  for (const layer of layers) {
    const sandbox = isObj(layer.sandbox) ? layer.sandbox : undefined;
    if (sandbox?.mode !== undefined) lines.push(`sandbox mode "${String(sandbox.mode)}" (a project may only make it stricter than yours)`);
    if (Array.isArray(sandbox?.additionalWritableRoots)) {
      lines.push(`extra writable folders ${sandbox.additionalWritableRoots.map(String).join(', ')} (ignored unless your own settings list them)`);
    }
    const dirs = isObj(layer.skills) && Array.isArray(layer.skills.dirs) ? layer.skills.dirs : [];
    const outside = dirs.filter(d => typeof d !== 'string' || !insideRoot(root, d)).map(String);
    if (outside.length) lines.push(`skill folders outside this repository: ${outside.join(', ')} (ignored)`);
    const userOnly = Object.keys(layer).filter(k => projectPolicyOf(k) === 'user-only');
    if (userOnly.length) lines.push(`settings only you can set, ignored here: ${userOnly.join(', ')}`);
  }
  return lines;
}
