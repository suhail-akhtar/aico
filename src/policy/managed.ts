/**
 * The managed policy file: what an organisation may lock, and how it is read.
 *
 * AICO is a single-user local engine, so every setting a person has can be
 * changed by that person (and, through the file tools, by the agent). An
 * organisation that deploys it needs a layer *above* the user that the user
 * cannot edit and that can only take away: a machine-wide JSON file placed by
 * MDM/GPO/Intune/config management (ADR 0035).
 *
 * This module is the data half — location, schema, validation, loading. The
 * decisions made from it (may this model run? this tool? this URL?) live in
 * `enforce.ts`. It imports nothing that imports settings, providers or the
 * agent, so every seam can call it without a cycle.
 *
 * Shapes that follow from what it is for:
 *
 * - **Restrict only.** No field means "allow more than the user chose". The
 *   policy is applied after the user and project layers merge and can only
 *   clamp what they produced. It carries no credential, so it is safe to read,
 *   print, and ship to clients.
 * - **Layers, not a merged blob.** `AICO_POLICY_FILE` (for tests and for
 *   trying a policy) is read *in addition to* the system file and every check
 *   asks every layer, so the override can add restrictions but never remove
 *   one: a user who sets the variable gains nothing. A merged object would
 *   need an intersection of glob lists, which has no clean form.
 * - **Fail closed, per key, and say so.** An unreadable file is a lockdown
 *   (no model or tool call). An invalid value takes that key's most
 *   restrictive value. Unknown keys are reported and ignored: a newer policy
 *   on an older AICO must warn, not brick the machine (`minAicoVersion` is
 *   how an organisation forces the upgrade). Never silently ignored.
 * - **Honest about its own strength.** AICO cannot make the file read-only;
 *   the operating system does. Each source reports whether the current user
 *   could edit it, and the route shows that as "not a lock".
 *
 * Deliberately not here: fetching a policy from a server, signatures, per-user
 * policies (SSO/SCIM/RBAC are not built — ADR 0035).
 *
 * @module policy/managed
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AUTONOMY_LEVELS, type AutonomyLevel } from '../autonomy/levels.js';

/** Gates an organisation can require. `checks` and `security` are the completion gate; the others own their own switch. */
export const GATE_IDS = ['checks', 'security', 'verification', 'commit', 'supply-chain', 'change-scan'] as const;
export type GateId = (typeof GATE_IDS)[number];

export type ExtensionMode = 'any' | 'forbid' | 'allow-list';
/** Adding MCP servers / plugins / custom tools. */
export interface ExtensionRule { mode: ExtensionMode; allow?: string[] }

export interface NetworkRule {
  /** `off`: no restriction. */
  mode: 'off' | 'allow-list' | 'deny-list';
  domains: string[];
  /** Local dev servers are reachable in allow-list mode unless this is false. Default true. */
  allowLoopback?: boolean;
}

/**
 * Connections to a forge or tracker (ADR 0039). Restrict-only like every key here: `allow-list`
 * names the providers and/or hosts that may be connected (a list left out means "any" for that
 * dimension), `forbid` removes connections, and `maxLanding: 'local'` stops projects from
 * switching to pull-request mode (the engine would push).
 */
export interface ConnectionsRule {
  mode: 'any' | 'forbid' | 'allow-list';
  providers?: string[];
  hosts?: string[];
  maxLanding?: 'local' | 'pr';
}

export interface ManagedPolicy {
  version?: number;
  /** Shown with every block. */
  message?: string;
  contact?: string;
  minAicoVersion?: string;
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  localOnly?: boolean;
  deniedTools?: string[];
  maxAutonomyLevel?: AutonomyLevel;
  requiredGates?: GateId[];
  mcp?: ExtensionRule;
  plugins?: ExtensionRule;
  customTools?: ExtensionRule;
  connections?: ConnectionsRule;
  network?: NetworkRule;
  budget?: { perSessionUsd?: number; perDayUsd?: number };
  sentinelRequired?: boolean;
  telemetry?: 'off';
  audit?: { user?: 'username' | 'hash' | 'omit'; host?: 'hostname' | 'hash' | 'omit'; tenant?: string };
}

export interface PolicyProblem {
  level: 'error' | 'warning';
  /** The key (dotted) the problem is about, when there is one. */
  key?: string;
  message: string;
}

export interface PolicyLayer {
  origin: 'system' | 'override';
  path: string;
  policy: ManagedPolicy;
  /** The file was unreadable or not a JSON object: nothing may run. */
  lockdown: boolean;
}

export interface PolicySource {
  origin: 'system' | 'override';
  path: string;
  exists: boolean;
  hash?: string;
  /** Why this file is not a real lock (the user could edit it), when that is so. */
  weakness?: string;
  error?: string;
}

export interface LoadedPolicy {
  /** At least one policy file exists. */
  active: boolean;
  /** Some layer is unreadable: model and tool calls are refused. */
  lockdown: boolean;
  layers: PolicyLayer[];
  sources: PolicySource[];
  problems: PolicyProblem[];
  /** Short hash of the effective policy files' bytes; changes when the policy does. */
  hash: string;
}

const KNOWN_KEYS = new Set([
  'version', 'message', 'contact', 'minAicoVersion', 'allowedProviders', 'deniedProviders', 'allowedModels',
  'deniedModels', 'localOnly', 'deniedTools', 'maxAutonomyLevel', 'requiredGates', 'mcp', 'plugins',
  'customTools', 'connections', 'network', 'budget', 'sentinelRequired', 'telemetry', 'audit',
  // Free-form notes for the people who maintain the file; never read.
  '$schema', '_comment', 'comment',
]);

/** The only schema version this engine understands. */
export const POLICY_VERSION = 1;

// ── location ────────────────────────────────────────────────────────

/** Where the machine-wide policy lives on this OS. */
export function systemPolicyPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.win32.join(env.ProgramData?.trim() || 'C:\\ProgramData', 'AICO', 'policy.json');
  if (platform === 'darwin') return '/Library/Application Support/AICO/policy.json';
  return '/etc/aico/policy.json';
}

// ── validation ──────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > 500) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim() || item.length > 200) return undefined;
    out.push(item.trim());
  }
  return out;
}

const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max).replace(/[\u0000-\u001f\u007f]/g, ' ') : undefined;

/** Extra keys inside a nested object: reported, never trusted. */
function warnUnknown(obj: Record<string, unknown>, known: string[], where: string, problems: PolicyProblem[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) problems.push({ level: 'warning', key: `${where}.${k}`, message: `"${where}.${k}" is not a key this AICO understands; ignored.` });
  }
}

function extension(v: unknown, key: string, problems: PolicyProblem[]): ExtensionRule {
  if (!isObj(v)) {
    problems.push({ level: 'error', key, message: `"${key}" must be an object like { "mode": "forbid" }; using the most restrictive value (forbid).` });
    return { mode: 'forbid' };
  }
  warnUnknown(v, ['mode', 'allow'], key, problems);
  const mode = v.mode;
  if (mode !== 'any' && mode !== 'forbid' && mode !== 'allow-list') {
    problems.push({ level: 'error', key: `${key}.mode`, message: `"${key}.mode" must be "any", "forbid" or "allow-list"; using "forbid".` });
    return { mode: 'forbid' };
  }
  if (mode === 'allow-list') {
    const allow = strList(v.allow);
    if (!allow) {
      problems.push({ level: 'error', key: `${key}.allow`, message: `"${key}.allow" must be a list of names; allowing none.` });
      return { mode, allow: [] };
    }
    return { mode, allow };
  }
  return { mode };
}

/** Validate one parsed policy document. Invalid values become their most restrictive form. */
export function validatePolicy(raw: Record<string, unknown>): { policy: ManagedPolicy; problems: PolicyProblem[] } {
  const problems: PolicyProblem[] = [];
  const policy: ManagedPolicy = {};
  const bad = (key: string, why: string, using: string): void => {
    problems.push({ level: 'error', key, message: `"${key}" ${why}; using the most restrictive value (${using}).` });
  };

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) problems.push({ level: 'warning', key, message: `"${key}" is not a key this AICO understands; ignored. Update AICO, or set minAicoVersion in the policy to require it.` });
  }
  if (raw.version !== undefined) {
    if (raw.version !== POLICY_VERSION) {
      problems.push({ level: 'warning', key: 'version', message: `policy version ${JSON.stringify(raw.version)} is not the version this AICO reads (${POLICY_VERSION}); known keys still apply.` });
    }
    policy.version = typeof raw.version === 'number' ? raw.version : POLICY_VERSION;
  }

  if (raw.message !== undefined) policy.message = text(raw.message, 400) ?? '';
  if (raw.contact !== undefined) policy.contact = text(raw.contact, 200) ?? '';
  if (!policy.message) delete policy.message;
  if (!policy.contact) delete policy.contact;

  if (raw.minAicoVersion !== undefined) {
    if (typeof raw.minAicoVersion === 'string' && /^\d+\.\d+\.\d+$/.test(raw.minAicoVersion.trim())) policy.minAicoVersion = raw.minAicoVersion.trim();
    else { bad('minAicoVersion', 'must look like "0.47.0"', 'no AICO version is new enough'); policy.minAicoVersion = '999.999.999'; }
  }

  for (const key of ['allowedProviders', 'allowedModels'] as const) {
    if (raw[key] === undefined) continue;
    const list = strList(raw[key]);
    if (list) policy[key] = list; else { bad(key, 'must be a list of names or patterns', 'allow none'); policy[key] = []; }
  }
  for (const key of ['deniedProviders', 'deniedModels', 'deniedTools'] as const) {
    if (raw[key] === undefined) continue;
    const list = strList(raw[key]);
    if (list) policy[key] = list; else { bad(key, 'must be a list of names or patterns', 'deny all'); policy[key] = ['*']; }
  }

  for (const key of ['localOnly', 'sentinelRequired'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') policy[key] = raw[key] as boolean; else { bad(key, 'must be true or false', 'true'); policy[key] = true; }
  }

  if (raw.maxAutonomyLevel !== undefined) {
    const level = typeof raw.maxAutonomyLevel === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(raw.maxAutonomyLevel)
      ? raw.maxAutonomyLevel as AutonomyLevel : undefined;
    if (level) policy.maxAutonomyLevel = level; else { bad('maxAutonomyLevel', 'must be one of L0, L1, L2, L3, L4', 'L0'); policy.maxAutonomyLevel = 'L0'; }
  }

  if (raw.requiredGates !== undefined) {
    const list = strList(raw.requiredGates);
    if (!list) { bad('requiredGates', 'must be a list of gate names', 'every gate required'); policy.requiredGates = [...GATE_IDS]; }
    else {
      const known = list.filter((g): g is GateId => (GATE_IDS as readonly string[]).includes(g));
      for (const g of list) if (!(GATE_IDS as readonly string[]).includes(g)) problems.push({ level: 'warning', key: 'requiredGates', message: `gate "${g}" is not one this AICO has (${GATE_IDS.join(', ')}); ignored.` });
      policy.requiredGates = known;
    }
  }

  for (const key of ['mcp', 'plugins', 'customTools'] as const) {
    if (raw[key] !== undefined) policy[key] = extension(raw[key], key, problems);
  }

  if (raw.connections !== undefined) {
    const c = raw.connections;
    if (!isObj(c)) { bad('connections', 'must be an object like { "mode": "forbid" }', 'forbid'); policy.connections = { mode: 'forbid' }; }
    else {
      warnUnknown(c, ['mode', 'providers', 'hosts', 'maxLanding'], 'connections', problems);
      const mode = c.mode === 'any' || c.mode === 'forbid' || c.mode === 'allow-list' ? c.mode : undefined;
      if (!mode) { bad('connections.mode', 'must be "any", "forbid" or "allow-list"', 'forbid'); policy.connections = { mode: 'forbid' }; }
      else {
        const rule: ConnectionsRule = { mode };
        for (const k of ['providers', 'hosts'] as const) {
          if (c[k] === undefined) continue;
          const list = strList(c[k]);
          if (list) rule[k] = list; else { bad(`connections.${k}`, 'must be a list of names', 'allow none'); rule[k] = []; }
        }
        if (mode === 'allow-list' && rule.providers === undefined && rule.hosts === undefined) {
          problems.push({ level: 'error', key: 'connections', message: '"connections" is an allow-list with no "providers" or "hosts"; allowing none.' });
          rule.providers = [];
        }
        if (c.maxLanding !== undefined) {
          if (c.maxLanding === 'local' || c.maxLanding === 'pr') rule.maxLanding = c.maxLanding;
          else { bad('connections.maxLanding', 'must be "local" or "pr"', 'local'); rule.maxLanding = 'local'; }
        }
        policy.connections = rule;
      }
    }
  }

  if (raw.network !== undefined) {
    const n = raw.network;
    if (!isObj(n)) { bad('network', 'must be an object', 'allow-list with no domains'); policy.network = { mode: 'allow-list', domains: [], allowLoopback: false }; }
    else {
      warnUnknown(n, ['mode', 'domains', 'allowLoopback'], 'network', problems);
      const mode = n.mode === 'off' || n.mode === 'allow-list' || n.mode === 'deny-list' ? n.mode : undefined;
      const domains = strList(n.domains);
      if (!mode) { bad('network.mode', 'must be "off", "allow-list" or "deny-list"', 'allow-list with no domains'); policy.network = { mode: 'allow-list', domains: [], allowLoopback: false }; }
      else if (!domains && mode !== 'off') {
        bad('network.domains', 'must be a list of domains', mode === 'allow-list' ? 'allow none' : 'deny all');
        policy.network = mode === 'allow-list' ? { mode, domains: [], allowLoopback: false } : { mode, domains: ['*'] };
      } else {
        policy.network = {
          mode, domains: domains ?? [],
          ...(typeof n.allowLoopback === 'boolean' ? { allowLoopback: n.allowLoopback } : {}),
        };
      }
    }
  }

  if (raw.budget !== undefined) {
    const b = raw.budget;
    if (!isObj(b)) { bad('budget', 'must be an object', '$0.01 per session and per day'); policy.budget = { perSessionUsd: 0.01, perDayUsd: 0.01 }; }
    else {
      warnUnknown(b, ['perSessionUsd', 'perDayUsd'], 'budget', problems);
      const out: { perSessionUsd?: number; perDayUsd?: number } = {};
      for (const k of ['perSessionUsd', 'perDayUsd'] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) > 0) out[k] = b[k] as number;
        else { bad(`budget.${k}`, 'must be a number above 0', '$0.01'); out[k] = 0.01; }
      }
      policy.budget = out;
    }
  }

  if (raw.telemetry !== undefined) {
    if (raw.telemetry === 'off') policy.telemetry = 'off';
    else { bad('telemetry', 'must be "off"', 'off'); policy.telemetry = 'off'; }
  }

  if (raw.audit !== undefined) {
    const a = raw.audit;
    if (!isObj(a)) problems.push({ level: 'warning', key: 'audit', message: '"audit" must be an object; ignored.' });
    else {
      warnUnknown(a, ['user', 'host', 'tenant'], 'audit', problems);
      const audit: NonNullable<ManagedPolicy['audit']> = {};
      if (a.user === 'username' || a.user === 'hash' || a.user === 'omit') audit.user = a.user;
      else if (a.user !== undefined) problems.push({ level: 'warning', key: 'audit.user', message: '"audit.user" must be "username", "hash" or "omit"; using "hash".' }), audit.user = 'hash';
      if (a.host === 'hostname' || a.host === 'hash' || a.host === 'omit') audit.host = a.host;
      else if (a.host !== undefined) problems.push({ level: 'warning', key: 'audit.host', message: '"audit.host" must be "hostname", "hash" or "omit"; using "hash".' }), audit.host = 'hash';
      const tenant = text(a.tenant, 100);
      if (tenant) audit.tenant = tenant;
      policy.audit = audit;
    }
  }
  return { policy, problems };
}

/** The layer an unreadable file stands for: every key at its most restrictive value. */
function lockdownPolicy(): ManagedPolicy {
  return {
    allowedProviders: [], allowedModels: [], deniedTools: ['*'], localOnly: true, maxAutonomyLevel: 'L0',
    requiredGates: [...GATE_IDS], mcp: { mode: 'forbid' }, plugins: { mode: 'forbid' }, customTools: { mode: 'forbid' }, connections: { mode: 'forbid' },
    network: { mode: 'allow-list', domains: [], allowLoopback: false }, sentinelRequired: true, telemetry: 'off',
  };
}

// ── loading ─────────────────────────────────────────────────────────

/**
 * Whether the current user could edit this file — in which case it is not a lock.
 *
 * Asked of the operating system by opening the file for writing (nothing is
 * written, the file is not truncated), not by looking at mode bits or the
 * read-only attribute: `access(W_OK)` on Windows ignores ACLs, and a policy
 * correctly deployed with a read-only ACL for Users would be reported as weak
 * forever. A sharing violation or any other error counts as "not writable",
 * which can only under-report — it never invents a weakness.
 */
function weaknessOf(file: string): string | undefined {
  try {
    fs.closeSync(fs.openSync(file, fs.constants.O_RDWR));
    return 'the current user can write to this file';
  } catch { /* not writable by us: good */ }
  if (process.platform !== 'win32') {
    try { if (fs.statSync(file).mode & 0o022) return 'writable by group or others'; } catch { /* gone */ }
  }
  return undefined;
}

function readLayer(file: string, origin: 'system' | 'override', problems: PolicyProblem[]): { layer?: PolicyLayer; source: PolicySource; bytes?: string } {
  const source: PolicySource = { origin, path: file, exists: false };
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (origin === 'override') problems.push({ level: 'warning', message: `AICO_POLICY_FILE (${file}) does not exist; ignored (it could only add restrictions).` });
      return { source };
    }
    // Exists but cannot be read: fail closed.
    source.exists = true;
    source.error = `cannot be read (${code ?? 'error'})`;
    problems.push({ level: 'error', message: `The policy file ${file} ${source.error}; AICO is locked down until it is fixed.` });
    return { source, layer: { origin, path: file, policy: lockdownPolicy(), lockdown: true } };
  }
  source.exists = true;
  source.hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
  const weakness = weaknessOf(file);
  if (weakness) source.weakness = weakness;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (err) {
    source.error = `is not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : 'parse error'})`;
    problems.push({ level: 'error', message: `The policy file ${file} ${source.error}; AICO is locked down until it is fixed.` });
    return { source, bytes: body, layer: { origin, path: file, policy: lockdownPolicy(), lockdown: true } };
  }
  if (!isObj(parsed)) {
    source.error = 'is not a JSON object';
    problems.push({ level: 'error', message: `The policy file ${file} ${source.error}; AICO is locked down until it is fixed.` });
    return { source, bytes: body, layer: { origin, path: file, policy: lockdownPolicy(), lockdown: true } };
  }
  const { policy, problems: found } = validatePolicy(parsed);
  problems.push(...found);
  return { source, bytes: body, layer: { origin, path: file, policy, lockdown: false } };
}

/** Read the policy files now (no cache). `env`/`platform` are injectable for tests. */
export function readManagedPolicy(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LoadedPolicy {
  const files: Array<[string, 'system' | 'override']> = [[systemPolicyPath(env, platform), 'system']];
  const extra = env.AICO_POLICY_FILE?.trim();
  if (extra && path.resolve(extra) !== path.resolve(files[0]![0])) files.push([path.resolve(extra), 'override']);
  return readManagedPolicyFrom(files);
}

/** Read exactly these files as policy layers. The seam tests use to prove layering without writing a system path. */
export function readManagedPolicyFrom(files: ReadonlyArray<readonly [string, 'system' | 'override']>): LoadedPolicy {
  const problems: PolicyProblem[] = [];
  const layers: PolicyLayer[] = [];
  const sources: PolicySource[] = [];
  const hasher = crypto.createHash('sha256');
  for (const [file, origin] of files) {
    const read = readLayer(file, origin, problems);
    sources.push(read.source);
    if (read.layer) layers.push(read.layer);
    if (read.source.exists) hasher.update(`${origin}:${read.source.hash ?? read.source.error ?? ''};`);
  }
  return {
    active: layers.length > 0,
    lockdown: layers.some(l => l.lockdown),
    layers, sources, problems,
    hash: layers.length ? hasher.digest('hex').slice(0, 16) : '',
  };
}

const NONE: LoadedPolicy = { active: false, lockdown: false, layers: [], sources: [], problems: [], hash: '' };
let cache: { env: string; state: string; at: number; value: LoadedPolicy } | undefined;
/** A policy file is re-checked at most this often; editing it takes effect within a second. */
const RECHECK_MS = 1000;

function stamp(file: string): string {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
}

/**
 * The effective policy for this process. Cheap enough to call on every tool
 * call: it stats the (at most two) files and re-reads only when one changed.
 */
export function managedPolicy(): LoadedPolicy {
  const system = systemPolicyPath(process.env);
  const extra = process.env.AICO_POLICY_FILE?.trim();
  const envKey = `${system}|${extra ?? ''}`;
  const now = Date.now();
  if (cache && cache.env === envKey && now - cache.at < RECHECK_MS) return cache.value;
  const state = `${stamp(system)}|${extra ? stamp(path.resolve(extra)) : ''}`;
  if (cache && cache.env === envKey && cache.state === state) { cache.at = now; return cache.value; }
  let value: LoadedPolicy;
  try {
    value = readManagedPolicy();
  } catch (err) {
    // Reading must never throw into the engine; if it somehow does, that is a lockdown, not "no policy".
    value = {
      ...NONE, active: true, lockdown: true,
      layers: [{ origin: 'system', path: system, policy: lockdownPolicy(), lockdown: true }],
      problems: [{ level: 'error', message: `The policy could not be evaluated (${err instanceof Error ? err.message : String(err)}); AICO is locked down.` }],
      hash: 'error',
    };
  }
  cache = { env: envKey, state, at: now, value };
  return value;
}

/** Forget the cached policy (tests; after writing a policy file). */
export function resetManagedPolicyCache(): void { cache = undefined; }

// ── small shared helpers ────────────────────────────────────────────

/** `*` and `?` globs, case-insensitive, matching the whole string (`/` is an ordinary character). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(value);
}

export const anyGlob = (patterns: readonly string[] | undefined, value: string): boolean =>
  Boolean(patterns?.some(p => globMatch(p, value)));

/** The running engine's version, or `unknown` when bundled without a package.json beside it. */
export function engineVersion(): string {
  try { return (createRequire(import.meta.url)('../package.json') as { version: string }).version; } catch { return 'unknown'; }
}

