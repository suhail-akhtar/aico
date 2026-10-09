/**
 * Decisions made from the managed policy (ADR 0035): may this model run, this
 * tool, this URL, this extension? What does the policy do to the merged
 * settings? Which settings should a client show as locked?
 *
 * Every function here is *pure over a `LoadedPolicy`* (defaulting to the
 * process's), returns a decision with the rule that decided it, and can only
 * say no — "guards may only deny" (ADR 0002). Nothing here grants a tool, a
 * model or a permission the user's own settings did not.
 *
 * The decisions are called from four seams, each of which already existed:
 * `loadSettings` (clamp), `selectProvider` (model/provider), the tool pipeline
 * (a `managed-policy` guard) and `runAgent` (run gate, autonomy ceiling). They
 * live here, once, so the same rule cannot be worded or implemented twice.
 *
 * Every layer is asked (`lp.layers`): the system file and, if set,
 * `AICO_POLICY_FILE`. A decision is "no" if *any* layer says no, which is what
 * keeps the override from ever loosening the system policy.
 *
 * Deliberately not here: shell reach. `network` governs the URL-carrying tools
 * AICO itself offers; `Bash` can run `curl`. That limit is stated in the ADR
 * and the GUIDE rather than faked with a command parser.
 *
 * @module policy/enforce
 */

import type { AicoSettings } from '../settings.js';
import type { GuardStage } from '../tools/pipeline.js';
import { levelRank, minLevel, parseLevel, type AutonomyLevel } from '../autonomy/levels.js';
import {
  GATE_IDS, anyGlob, globMatch, managedPolicy, type ConnectionsRule, type ExtensionRule, type GateId, type LoadedPolicy, type ManagedPolicy,
} from './managed.js';

export type Decision = { ok: true } | { ok: false; rule: string; message: string };
const OK: Decision = { ok: true };

/** Thrown where a refusal cannot be returned as a value (model selection, adding an MCP server). */
export class PolicyError extends Error {
  readonly code = 'AICO_POLICY';
  constructor(message: string, readonly rule: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

// ── wording ─────────────────────────────────────────────────────────

const firstOf = (lp: LoadedPolicy, key: 'message' | 'contact'): string | undefined =>
  lp.layers.map(l => l.policy[key]).find((v): v is string => typeof v === 'string' && v.length > 0);

/** "<what> is blocked by your organisation's AICO policy (<rule>). <message> Contact: <contact>." */
export function blocked(lp: LoadedPolicy, what: string, rule: string): Decision {
  const message = firstOf(lp, 'message');
  const contact = firstOf(lp, 'contact');
  return {
    ok: false,
    rule,
    message: `${what} is blocked by your organisation's AICO policy (${rule}).`
      + `${message ? ` ${message}` : ''}${contact ? ` Contact: ${contact}.` : ''}`
      + ' You cannot change this in settings.',
  };
}

const lockdownDecision = (lp: LoadedPolicy, what: string): Decision => {
  const bad = lp.sources.find(s => s.error);
  const d = blocked(lp, what, 'policy-file-unreadable');
  return d.ok ? d : { ...d, message: `${d.message} The policy file${bad ? ` ${bad.path}` : ''} could not be read, so AICO is locked down until IT fixes it.` };
};

export const policyActive = (lp: LoadedPolicy = managedPolicy()): boolean => lp.active;

// ── models and providers ────────────────────────────────────────────

export interface ModelRoute {
  model: string;
  /** Provider family: anthropic, openai, ollama, openrouter… */
  providerType?: string;
  /** The configured instance's id, when one serves it. */
  instanceId?: string;
  /** Served on this machine (loopback endpoint); undefined means the caller cannot tell. */
  local?: boolean;
}

/** `anthropic/claude-x` is also tested as `claude-x`, so `claude-*` covers a routed id. */
function modelNames(model: string): string[] {
  const names = [model];
  const cut = model.indexOf('/');
  if (cut > 0 && cut < model.length - 1) names.push(model.slice(cut + 1));
  return names;
}

const CLOUD_TAG = /(?:[-:]cloud)$/i;

export function modelDecision(route: ModelRoute, lp: LoadedPolicy = managedPolicy()): Decision {
  if (!lp.active) return OK;
  if (lockdown(lp)) return lockdownDecision(lp, `Calling ${route.model || 'a model'}`);
  const providers = [route.providerType, route.instanceId].filter((p): p is string => Boolean(p));
  const models = modelNames(route.model);
  for (const { policy: p } of lp.layers) {
    if (p.deniedProviders && providers.some(n => anyGlob(p.deniedProviders, n))) {
      return blocked(lp, `The provider ${providers[0] ?? 'for this model'}`, 'deniedProviders');
    }
    if (p.allowedProviders && !providers.some(n => anyGlob(p.allowedProviders, n))) {
      return blocked(lp, `The provider ${providers[0] ?? 'for this model'}`, 'allowedProviders');
    }
    if (p.deniedModels && models.some(n => anyGlob(p.deniedModels, n))) return blocked(lp, `The model ${route.model}`, 'deniedModels');
    if (p.allowedModels && !models.some(n => anyGlob(p.allowedModels, n))) return blocked(lp, `The model ${route.model}`, 'allowedModels');
    if (p.localOnly && (route.local !== true || CLOUD_TAG.test(route.model.trim()))) {
      return blocked(lp, `The model ${route.model} (it is not served on this machine)`, 'localOnly');
    }
  }
  return OK;
}

/**
 * Whether a provider may be contacted at all, before any model is named — the
 * settings screen's "test connection" sends a key to it. Provider lists only;
 * `localOnly` is judged where the endpoint is known (`modelDecision`).
 */
export function providerDecision(providerType: string, lp: LoadedPolicy = managedPolicy()): Decision {
  if (!lp.active) return OK;
  if (lockdown(lp)) return lockdownDecision(lp, `Contacting ${providerType}`);
  for (const { policy: p } of lp.layers) {
    if (p.deniedProviders && anyGlob(p.deniedProviders, providerType)) return blocked(lp, `The provider ${providerType}`, 'deniedProviders');
    if (p.allowedProviders && !anyGlob(p.allowedProviders, providerType)) return blocked(lp, `The provider ${providerType}`, 'allowedProviders');
    if (p.localOnly && providerType !== 'ollama') return blocked(lp, `The provider ${providerType} (it is not served on this machine)`, 'localOnly');
  }
  return OK;
}

/** Throws a {@link PolicyError} naming the rule and the contact. */
export function assertModelAllowed(route: ModelRoute, lp: LoadedPolicy = managedPolicy()): void {
  const d = modelDecision(route, lp);
  if (!d.ok) throw new PolicyError(d.message, d.rule);
}

// ── tools ───────────────────────────────────────────────────────────

const lockdown = (lp: LoadedPolicy): boolean => lp.lockdown;

export function toolDecision(name: string, lp: LoadedPolicy = managedPolicy()): Decision {
  if (!lp.active) return OK;
  if (lockdown(lp)) return lockdownDecision(lp, `The ${name} tool`);
  for (const { policy: p } of lp.layers) {
    if (p.deniedTools && anyGlob(p.deniedTools, name)) return blocked(lp, `The ${name} tool`, 'deniedTools');
  }
  return OK;
}

/** Whether a tool may be *offered* to a model at all (so it is not even in the schema). */
export const policyAllowsTool = (name: string): boolean => toolDecision(name).ok;

// ── network ─────────────────────────────────────────────────────────

const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

/** `example.com` covers itself and subdomains; `*.example.com` subdomains only; anything else is a glob. */
export function hostMatches(entry: string, host: string): boolean {
  const e = entry.trim().toLowerCase();
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!e) return false;
  if (e.includes('*') || e.includes('?')) return globMatch(e, h);
  return h === e || h.endsWith(`.${e}`);
}

export function urlDecision(raw: string, lp: LoadedPolicy = managedPolicy()): Decision {
  if (!lp.active) return OK;
  let url: URL;
  try { url = new URL(raw); } catch { return OK; /* not a URL: not a network call */ }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return OK;
  if (lockdown(lp)) return lockdownDecision(lp, `Fetching ${url.host}`);
  const host = url.hostname.toLowerCase();
  for (const { policy: p } of lp.layers) {
    const n = p.network;
    if (!n || n.mode === 'off') continue;
    const listed = n.domains.some(d => hostMatches(d, host));
    if (n.mode === 'deny-list' && listed) return blocked(lp, `Reaching ${host}`, 'network.deny-list');
    if (n.mode === 'allow-list' && !listed && !(LOOPBACK_HOST.test(host) && n.allowLoopback !== false)) {
      return blocked(lp, `Reaching ${host}`, 'network.allow-list');
    }
  }
  return OK;
}

/** http(s) URLs in a call's arguments (two levels deep), for the network check. */
export function urlsIn(args: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 20) return out;
  if (typeof args === 'string') {
    if (/^https?:\/\/\S+$/i.test(args.trim())) out.push(args.trim());
  } else if (depth < 3 && Array.isArray(args)) {
    for (const v of args) urlsIn(v, depth + 1, out);
  } else if (depth < 3 && args && typeof args === 'object') {
    for (const v of Object.values(args as Record<string, unknown>)) urlsIn(v, depth + 1, out);
  }
  return out;
}

// ── extension points (MCP servers, plugins, custom tools) ───────────

type ExtensionKind = 'mcp' | 'plugins' | 'customTools';
const KIND_LABEL: Record<ExtensionKind, string> = { mcp: 'MCP servers', plugins: 'plugins', customTools: 'custom tools' };

export function extensionDecision(kind: ExtensionKind, name: string, lp: LoadedPolicy = managedPolicy()): Decision {
  if (!lp.active) return OK;
  if (lockdown(lp)) return lockdownDecision(lp, `Adding ${KIND_LABEL[kind]}`);
  for (const layer of lp.layers) {
    const rule: ExtensionRule | undefined = layer.policy[kind];
    if (!rule || rule.mode === 'any') continue;
    if (rule.mode === 'forbid') return blocked(lp, `Adding the ${KIND_LABEL[kind].replace(/s$/, '')} "${name}"`, `${kind}.forbid`);
    if (!anyGlob(rule.allow, name)) return blocked(lp, `Adding the ${KIND_LABEL[kind].replace(/s$/, '')} "${name}" (it is not on the approved list)`, `${kind}.allow-list`);
  }
  return OK;
}

export function assertExtensionAllowed(kind: ExtensionKind, name: string, lp: LoadedPolicy = managedPolicy()): void {
  const d = extensionDecision(kind, name, lp);
  if (!d.ok) throw new PolicyError(d.message, d.rule);
}

// ── connections (ADR 0039) ──────────────────────────────────────────

export interface ConnectionFacts {
  provider?: string;
  host?: string;
  /** The landing mode a mapping asks for. */
  landing?: 'local' | 'pr';
  /** The connection runs on an agent-built connector pack. */
  pack?: boolean;
}

/**
 * May this provider, host and landing mode be used for a connection? Asked at create/map, again
 * before every adapter request (the second line: a policy that appears after a connection was
 * made stops it) and at landing. A "no" from any layer is final.
 */
export function connectionDecision(f: ConnectionFacts, lp: LoadedPolicy = managedPolicy()): Decision {
  if (!lp.active) return OK;
  const label = f.host ? `The connection to ${f.host}` : f.provider ? `A ${f.provider} connection` : 'Connecting to a forge or tracker';
  if (lockdown(lp)) return lockdownDecision(lp, label);
  for (const layer of lp.layers) {
    const rule: ConnectionsRule | undefined = layer.policy.connections;
    if (!rule) continue;
    if (rule.mode === 'forbid') return blocked(lp, label, 'connections.forbid');
    if (rule.mode === 'allow-list') {
      if (f.provider !== undefined && rule.providers !== undefined && !rule.providers.some(p => globMatch(p, f.provider!))) {
        return blocked(lp, `${label} (${f.provider} is not on the approved list)`, 'connections.allow-list.providers');
      }
      if (f.host !== undefined && rule.hosts !== undefined && !rule.hosts.some(h => hostMatches(h, f.host!))) {
        return blocked(lp, `${label} (${f.host} is not on the approved list)`, 'connections.allow-list.hosts');
      }
    }
    if (f.pack && rule.packs === 'forbid') return blocked(lp, `${label} (connector packs are not allowed)`, 'connections.packs');
    if (f.landing === 'pr' && rule.maxLanding === 'local') {
      return blocked(lp, 'Pull-request mode (AICO pushing a branch and opening a pull request)', 'connections.maxLanding');
    }
  }
  return OK;
}

// ── gates, autonomy, version, budget ────────────────────────────────

export function isGateRequired(id: GateId, lp: LoadedPolicy = managedPolicy()): boolean {
  if (!lp.active) return false;
  if (lp.lockdown) return true;
  return lp.layers.some(l => l.policy.requiredGates?.includes(id));
}

/** The lowest autonomy level any layer allows, or undefined when none limits it. */
export function policyCeiling(lp: LoadedPolicy = managedPolicy()): AutonomyLevel | undefined {
  if (!lp.active) return undefined;
  return minLevel(...lp.layers.map(l => l.policy.maxAutonomyLevel), lp.lockdown ? 'L0' : undefined);
}

/**
 * An agent's own `autonomy` ceiling, lowered to the policy's when that is
 * lower. Returned as the value `runAgent` already feeds to
 * `applyAutonomyCeiling`, so the organisation's limit rides the existing
 * mechanism rather than a second one: plan mode at L0, asking at L1/L2, no
 * parking above the cap. An unparseable agent ceiling is replaced, not kept.
 */
export function withPolicyCeiling(agentCeiling: unknown, lp: LoadedPolicy = managedPolicy()): unknown {
  const cap = policyCeiling(lp);
  if (!cap) return agentCeiling;
  const own = parseLevel(agentCeiling);
  return own && levelRank(own) <= levelRank(cap) ? agentCeiling : cap;
}

/** `a` is older than `b` (both x.y.z). */
function older(a: string, b: string): boolean {
  const l = a.split('.').map(Number);
  const r = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (l[i] ?? 0) - (r[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** Why a run may not start at all (lockdown, an engine older than the policy requires), or undefined. */
export function runRefusal(version: string, lp: LoadedPolicy = managedPolicy()): string | undefined {
  if (!lp.active) return undefined;
  if (lp.lockdown) {
    const d = lockdownDecision(lp, 'Running the agent');
    return d.ok ? undefined : d.message;
  }
  for (const { policy: p } of lp.layers) {
    if (p.minAicoVersion && (version === 'unknown' || older(version, p.minAicoVersion))) {
      const d = blocked(lp, `This AICO (${version})`, 'minAicoVersion');
      return d.ok ? undefined : `${d.message} Your organisation requires AICO ${p.minAicoVersion} or newer; update and try again.`;
    }
  }
  return undefined;
}

/** The smallest per-day cap any layer sets. */
export function dayBudgetCap(lp: LoadedPolicy = managedPolicy()): number | undefined {
  const caps = lp.layers.map(l => l.policy.budget?.perDayUsd).filter((n): n is number => typeof n === 'number');
  return caps.length ? Math.min(...caps) : undefined;
}

export function dayBudgetRefusal(spentTodayUsd: number, lp: LoadedPolicy = managedPolicy()): string | undefined {
  const cap = dayBudgetCap(lp);
  if (cap === undefined || spentTodayUsd < cap) return undefined;
  const d = blocked(lp, `More model use today ($${spentTodayUsd.toFixed(2)} estimated of a $${cap} daily cap)`, 'budget.perDayUsd');
  return d.ok ? undefined : d.message;
}

/**
 * "Full autonomy" lets the safety reviewer's doubts proceed unasked. An
 * organisation that requires the reviewer, or caps autonomy below L3, does not
 * get that, whatever a client sends for this run.
 */
export function forbidsFullAutonomy(lp: LoadedPolicy = managedPolicy()): boolean {
  if (!lp.active) return false;
  const ceiling = policyCeiling(lp);
  return lp.lockdown || lp.layers.some(l => l.policy.sentinelRequired) || (ceiling !== undefined && levelRank(ceiling) < 3);
}

export const telemetryOff = (lp: LoadedPolicy = managedPolicy()): boolean => lp.layers.some(l => l.policy.telemetry === 'off');

// ── the tool-pipeline guard ─────────────────────────────────────────

/** Plugin tools of the desktop host: the agent-facing way to install or switch a plugin. */
const PLUGIN_TOOL = /(?:^|__)ide_plugin_(save|set_enabled)$/;

/**
 * The `managed-policy` guard. Deny or abstain only (ADR 0002), and registered
 * before the permission stage so nobody is asked to approve what the
 * organisation has forbidden. The tool-name list is also applied where tools
 * are offered (`policyAllowsTool`); this is the second line, for a name the
 * model learned anyway.
 */
export function createPolicyGuard(): GuardStage {
  return (ctx) => {
    const lp = managedPolicy();
    if (!lp.active) return { kind: 'abstain' };
    const tool = toolDecision(ctx.name, lp);
    if (!tool.ok) return { kind: 'deny', reason: tool.message };
    const plugin = PLUGIN_TOOL.exec(ctx.name);
    if (plugin) {
      const target = String((ctx.arguments as { id?: unknown; name?: unknown }).id ?? (ctx.arguments as { name?: unknown }).name ?? '');
      const d = extensionDecision('plugins', target, lp);
      if (!d.ok) return { kind: 'deny', reason: d.message };
    }
    for (const url of urlsIn(ctx.arguments)) {
      const d = urlDecision(url, lp);
      if (!d.ok) return { kind: 'deny', reason: d.message };
    }
    return { kind: 'abstain' };
  };
}

// ── settings: clamp and lock list ───────────────────────────────────

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const hasGlob = (s: string): boolean => /[*?]/.test(s);

/** The MCP server names the policy would let stand. */
function mcpAdmits(lp: LoadedPolicy, name: string): boolean {
  return extensionDecision('mcp', name, lp).ok;
}

/**
 * Clamp merged settings to the policy, in place; returns one line per change
 * (for the one-time notice on stderr). Only ever tightens: a value already
 * stricter than the policy is left alone.
 */
export function applyManagedPolicy(settings: AicoSettings, lp: LoadedPolicy = managedPolicy()): string[] {
  if (!lp.active) return [];
  const notes: string[] = [];
  const s = settings as Record<string, unknown>;
  const layers: ManagedPolicy[] = lp.layers.map(l => l.policy);

  // Tools: exact names go into disabledTools too, so every reader of that
  // list (Knowledge, Investigate, Checkpoint, watchers) agrees; patterns are
  // applied where tools are offered and by the guard.
  const denied = [...new Set(layers.flatMap(p => p.deniedTools ?? []).filter(t => !hasGlob(t)))];
  if (denied.length) {
    const now = Array.isArray(settings.disabledTools) ? settings.disabledTools : [];
    const add = denied.filter(t => !now.includes(t));
    if (add.length) { settings.disabledTools = [...now, ...add]; notes.push(`tools switched off: ${add.join(', ')}`); }
  }

  if (layers.some(p => p.localOnly) || lp.lockdown) {
    const models = obj(settings.models);
    if (models.localOnlyPersonal !== true) { s.models = { ...models, localOnlyPersonal: true }; notes.push('your data is kept on this machine (models.localOnlyPersonal)'); }
  }

  const ceiling = policyCeiling(lp);
  if (ceiling && levelRank(ceiling) < 3 && settings.autoApprove) {
    settings.autoApprove = false;
    notes.push(`auto-approve is off (the highest autonomy allowed is ${ceiling})`);
  }

  const gate = obj(settings.completionGate);
  const need = (id: GateId): boolean => isGateRequired(id, lp);
  if ((need('checks') || need('verification') || need('commit') || need('security') || need('change-scan')) && gate.enabled === false) {
    s.completionGate = { ...gate, enabled: true };
    notes.push('the completion gate is required and stays on');
  }
  if (need('security') && obj(s.completionGate).security === false) {
    s.completionGate = { ...obj(s.completionGate), security: true };
    notes.push('the security check is required and stays on');
  }

  // The gates that own their own switch (ADR 0033): the change-safety review
  // and the package check. Their defaults are on; only an explicit false is undone.
  if (need('change-scan') && obj(s.completionGate).changeSafety === false) {
    s.completionGate = { ...obj(s.completionGate), changeSafety: true };
    notes.push('the change-safety review is required and stays on');
  }
  if (need('supply-chain') && obj(s.supplyChain).packageCheck === false) {
    s.supplyChain = { ...obj(s.supplyChain), packageCheck: true };
    notes.push('the package check is required and stays on');
  }

  if (s.mcpServers && typeof s.mcpServers === 'object') {
    const kept: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [name, cfg] of Object.entries(s.mcpServers as Record<string, unknown>)) {
      if (mcpAdmits(lp, name)) kept[name] = cfg; else dropped.push(name);
    }
    if (dropped.length) { s.mcpServers = kept; notes.push(`MCP servers not allowed here: ${dropped.join(', ')}`); }
  }

  const perSession = layers.map(p => p.budget?.perSessionUsd).filter((n): n is number => typeof n === 'number');
  if (perSession.length) {
    const cap = Math.min(...perSession);
    const limits = obj(settings.safetyLimits);
    const own = typeof limits.maxCostPerSession === 'number' && limits.maxCostPerSession > 0 ? limits.maxCostPerSession : undefined;
    if (own === undefined || own > cap) { s.safetyLimits = { ...limits, maxCostPerSession: cap }; notes.push(`spend per session is capped at $${cap}`); }
  }

  if (layers.some(p => p.sentinelRequired) || lp.lockdown) {
    const sen = { ...obj(settings.sentinel) };
    let changed = false;
    if (sen.mode === 'off') { sen.mode = 'auto'; changed = true; }
    if (sen.onEscalate === 'proceed') { sen.onEscalate = 'ask'; changed = true; }
    if (sen.agents) {
      const agents = { ...obj(sen.agents) };
      for (const [k, v] of Object.entries(agents)) if (v === 'off') { delete agents[k]; changed = true; }
      sen.agents = agents;
    }
    if (changed) { s.sentinel = sen; notes.push('the safety reviewer is required and stays on'); }
  }
  return notes;
}

export interface LockedSetting {
  /** Dotted settings path the client binds a control to. */
  path: string;
  /** `fixed`: the policy decides the value. `bounded`/`restricted`: editable within the policy. */
  kind: 'fixed' | 'bounded' | 'restricted';
  reason: string;
  /** The value a fixed setting is held at. */
  value?: unknown;
}

/** What a client should show as managed. No secrets: it describes rules, never credentials. */
export function lockedSettings(lp: LoadedPolicy = managedPolicy()): LockedSetting[] {
  if (!lp.active) return [];
  const out: LockedSetting[] = [];
  const layers = lp.layers.map(l => l.policy);
  const add = (l: LockedSetting): void => { if (!out.some(o => o.path === l.path)) out.push(l); };
  if (layers.some(p => p.localOnly) || lp.lockdown) add({ path: 'models.localOnlyPersonal', kind: 'fixed', value: true, reason: 'Your organisation requires models that run on this machine.' });
  const ceiling = policyCeiling(lp);
  if (ceiling && levelRank(ceiling) < 3) add({ path: 'autoApprove', kind: 'fixed', value: false, reason: `Your organisation limits autonomy to ${ceiling}, so tool calls are not approved automatically.` });
  for (const id of ['checks', 'verification', 'commit'] as const) {
    if (isGateRequired(id, lp)) add({ path: 'completionGate.enabled', kind: 'fixed', value: true, reason: `Your organisation requires the ${id} gate.` });
  }
  if (isGateRequired('security', lp)) {
    add({ path: 'completionGate.enabled', kind: 'fixed', value: true, reason: 'Your organisation requires the security gate.' });
    add({ path: 'completionGate.security', kind: 'fixed', value: true, reason: 'Your organisation requires the security check.' });
  }
  if (layers.some(p => p.sentinelRequired) || lp.lockdown) {
    add({ path: 'sentinel.mode', kind: 'restricted', reason: 'Your organisation requires the safety reviewer; it cannot be turned off.' });
    add({ path: 'sentinel.onEscalate', kind: 'restricted', reason: 'Your organisation requires a person to decide when the safety reviewer is unsure.' });
  }
  if (isGateRequired('change-scan', lp)) {
    add({ path: 'completionGate.enabled', kind: 'fixed', value: true, reason: 'Your organisation requires the change-safety review.' });
    add({ path: 'completionGate.changeSafety', kind: 'fixed', value: true, reason: 'Your organisation requires the change-safety review.' });
  }
  if (isGateRequired('supply-chain', lp)) add({ path: 'supplyChain.packageCheck', kind: 'fixed', value: true, reason: 'Your organisation requires the package check before installs.' });
  const caps = layers.map(p => p.budget?.perSessionUsd).filter((n): n is number => typeof n === 'number');
  if (caps.length) add({ path: 'safetyLimits.maxCostPerSession', kind: 'bounded', value: Math.min(...caps), reason: `Your organisation caps spend per session at $${Math.min(...caps)}.` });
  if (layers.some(p => p.deniedTools?.length)) add({ path: 'disabledTools', kind: 'restricted', reason: 'Your organisation has switched some tools off; you can switch off more, not fewer.' });
  if (layers.some(p => p.allowedProviders || p.deniedProviders || p.allowedModels || p.deniedModels || p.localOnly) || lp.lockdown) {
    for (const path of ['model', 'provider', 'activeProvider', 'providerInstances']) add({ path, kind: 'restricted', reason: 'Your organisation limits which providers and models may be used.' });
  }
  if (layers.some(p => p.mcp && p.mcp.mode !== 'any') || lp.lockdown) add({ path: 'mcpServers', kind: 'restricted', reason: 'Your organisation limits which MCP servers may be added.' });
  return out;
}

/** A path is locked if the policy names it or one of its ancestors (`sentinel` covers `sentinel.mode`). */
export function lockFor(path: string, locked: readonly LockedSetting[]): LockedSetting | undefined {
  return locked.find(l => path === l.path || path.startsWith(`${l.path}.`) || l.path.startsWith(`${path}.`));
}

/** The public, secret-free view the settings screen and `aico policy` show. */
export function publicPolicy(lp: LoadedPolicy = managedPolicy()): {
  managed: boolean; lockdown: boolean; hash: string; message?: string; contact?: string;
  sources: Array<{ origin: string; path: string; exists: boolean; weakness?: string; error?: string }>;
  problems: Array<{ level: string; key?: string; message: string }>;
  locked: LockedSetting[]; rules: string[];
} {
  const message = firstOf(lp, 'message');
  const contact = firstOf(lp, 'contact');
  return {
    managed: lp.active, lockdown: lp.lockdown, hash: lp.hash,
    ...(message ? { message } : {}), ...(contact ? { contact } : {}),
    sources: lp.sources.filter(s => s.exists).map(s => ({
      origin: s.origin, path: s.path, exists: s.exists,
      ...(s.weakness ? { weakness: s.weakness } : {}), ...(s.error ? { error: s.error } : {}),
    })),
    problems: lp.problems,
    locked: lockedSettings(lp),
    rules: describeRules(lp),
  };
}

/** One plain-English line per rule in force, for a status screen. */
export function describeRules(lp: LoadedPolicy = managedPolicy()): string[] {
  const lines: string[] = [];
  for (const { policy: p } of lp.layers) {
    if (p.allowedProviders) lines.push(`Providers allowed: ${p.allowedProviders.join(', ') || 'none'}`);
    if (p.deniedProviders?.length) lines.push(`Providers blocked: ${p.deniedProviders.join(', ')}`);
    if (p.allowedModels) lines.push(`Models allowed: ${p.allowedModels.join(', ') || 'none'}`);
    if (p.deniedModels?.length) lines.push(`Models blocked: ${p.deniedModels.join(', ')}`);
    if (p.localOnly) lines.push('Only models that run on this machine');
    if (p.deniedTools?.length) lines.push(`Tools blocked: ${p.deniedTools.join(', ')}`);
    if (p.maxAutonomyLevel) lines.push(`Highest autonomy: ${p.maxAutonomyLevel}`);
    if (p.requiredGates?.length) lines.push(`Gates always on: ${p.requiredGates.join(', ')}`);
    for (const k of ['mcp', 'plugins', 'customTools'] as const) {
      const r = p[k];
      if (r && r.mode !== 'any') lines.push(`${KIND_LABEL[k]}: ${r.mode === 'forbid' ? 'cannot be added' : `only ${r.allow?.join(', ') || 'none'}`}`);
    }
    if (p.connections && p.connections.mode !== 'any') {
      const c = p.connections;
      lines.push(c.mode === 'forbid' ? 'Connections to forges and trackers: not allowed'
        : `Connections only to ${[c.providers?.length ? `providers ${c.providers.join(', ')}` : '', c.hosts?.length ? `hosts ${c.hosts.join(', ')}` : ''].filter(Boolean).join(' on ') || 'nothing'}`);
    }
    if (p.connections?.maxLanding === 'local') lines.push('Delivery lands changes locally only (no pull-request mode)');
    if (p.connections?.packs === 'forbid') lines.push('Agent-built connector packs: not allowed');
    if (p.network && p.network.mode !== 'off') lines.push(`Network ${p.network.mode}: ${p.network.domains.join(', ') || 'none'}`);
    if (p.budget?.perSessionUsd !== undefined) lines.push(`Spend per session: $${p.budget.perSessionUsd}`);
    if (p.budget?.perDayUsd !== undefined) lines.push(`Spend per day: $${p.budget.perDayUsd}`);
    if (p.sentinelRequired) lines.push('Safety reviewer required');
    if (p.telemetry === 'off') lines.push('No outbound calls other than your task (update check off)');
    if (p.minAicoVersion) lines.push(`Minimum AICO version: ${p.minAicoVersion}`);
  }
  return lines;
}

export { GATE_IDS };
