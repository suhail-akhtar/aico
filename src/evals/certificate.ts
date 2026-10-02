/**
 * Agent certificates: what one is bound to, where it is kept, and what it
 * says about the agent as it is now (design §6.4).
 *
 * WHY A HASH OF EVERYTHING. A certificate says "this agent, run on this
 * model, passed these tests". If any part of that moves — the agent file,
 * a skill it preloads, a custom tool definition it may call, the pinned
 * description of an MCP tool it may call, the model, or the tests themselves
 * — the evidence is about something else. So the certificate records a
 * sha256 over all of them, and the status compares that with a hash taken
 * now: a match is `certified` (or `failed`, if the run did not pass); a
 * mismatch is `changed` when an older version was certified, else
 * `uncertified`. Re-certifying is one command.
 *
 * WHAT THE STATUS GATES. Only unattended (L4) runs (design §4.2, Q4): cron,
 * background and mcp-serve work, and the inbox replay of a call such a run
 * parked. `agent.ts` asks `isCertified` before a named agent's run is allowed
 * to stay at L4; without a current certificate it runs at L3 — which, with
 * nobody there, refuses what it would have parked — and says why.
 * Interactive use (L1–L3) is never gated.
 *
 * THE STORE. `aicoHome()/evals/agents/<name>/certificates/<hash>.json`, one
 * file per hash, each holding the results it was issued on (per-trial
 * verdicts, clipped replies, tool-call lists, cost). The newest file decides
 * "changed" versus "uncertified". It is a file in the user's store — a
 * process running as the user could write one; the same honest limit as the
 * skill review and tool enable records: the gate makes certification the
 * normal path, it is not a sandbox.
 *
 * Deliberately no agent loop here (it is imported by `agent.ts` and the
 * inbox); running a certification is `evals/certify.ts`.
 *
 * @module evals/certificate
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { aicoHome } from '../home.js';
import { BUILTIN_AGENT_FILES } from '../agents/builtin.js';
import { agentFilePath, getAgentSpec } from '../agents/registry.js';
import type { AgentSpec } from '../agents/types.js';
import { treeHash } from '../skills/provenance.js';
import { skillRegistry } from '../skills/registry.js';
import { loadCustomTools } from '../custom-tools/store.js';
import { pinsPath } from '../mcp/pins.js';
import { SAFETY_PACK_VERSION } from './safety-pack.js';
import { loadGoldenTasks } from './tasks.js';
import type { TaskReport } from './types.js';

export type CertificationStatus = 'uncertified' | 'certified' | 'changed' | 'failed';

export const STATUS_LABEL: Record<CertificationStatus, string> = {
  uncertified: 'uncertified',
  certified: 'certified',
  changed: 'changed since certification',
  failed: 'failed certification',
};

/** What the hash covers, part by part, so a "changed" status can say what changed. */
export interface DependencyParts {
  agent: string;
  skills: Record<string, string>;
  tools: Record<string, string>;
  mcp: Record<string, string>;
  model: string;
  evals: string;
  pack: string;
}

export interface Certificate {
  version: 1;
  agent: string;
  hash: string;
  parts: DependencyParts;
  model: string;
  judgeModel?: string;
  /** Trials per task (k). */
  runs: number;
  passed: boolean;
  /** Why it did not pass; empty when it passed. */
  reasons: string[];
  /** Passes that tested less than they could (a probe the agent never engaged with). */
  notes?: string[];
  lint: { errors: string[]; warnings: string[] };
  tasks: TaskReport[];
  threshold: number;
  /** Probes that did not apply to this agent, with why. */
  skipped: string[];
  estimateUsd: number;
  budgetUsd: number;
  costUsd: number;
  overBudget: boolean;
  at: string;
  aicoVersion: string;
}

const sha = (text: string | Buffer): string => crypto.createHash('sha256').update(text).digest('hex');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The bytes the agent was read from. */
function agentText(spec: AgentSpec, cwd: string): string {
  if (spec.source === 'builtin') return BUILTIN_AGENT_FILES[spec.name] ?? '';
  const file = agentFilePath(spec, cwd);
  try { return file ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; /* deleted since it was listed: hashes as empty, so nothing matches */ }
}

/** MCP servers an agent may reach: its `mcpServers`, servers named in `tools`, or all when unrestricted. */
function mcpServersOf(spec: AgentSpec, pinned: string[]): string[] {
  const named = new Set(spec.mcpServers ?? []);
  for (const t of spec.tools ?? []) {
    if (t.startsWith('mcp__')) named.add(t.slice(5).split('__')[0]!);
    else if (t.startsWith('mcp:')) named.add(t.slice(4).split(':')[0]!);
    else if (t === 'MCP') pinned.forEach(s => named.add(s));
  }
  if (!spec.tools?.length && !spec.mcpServers?.length) pinned.forEach(s => named.add(s));
  return [...named].filter(Boolean).sort();
}

function readPins(): Record<string, Record<string, { hash?: string }>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(pinsPath(), 'utf8')) as { servers?: Record<string, Record<string, { hash?: string }>> };
    return parsed.servers ?? {};
  } catch { return {}; /* no pins yet: no MCP tool has been seen */ }
}

/** The dependency hash for an agent as it is now, on `model`. */
export async function dependencyHash(spec: AgentSpec, o: { cwd: string; model: string }): Promise<{ hash: string; parts: DependencyParts }> {
  const skills: Record<string, string> = {};
  for (const name of [...(spec.skills ?? [])].sort()) {
    const skill = skillRegistry.lookup(name);
    skills[name] = !skill ? 'missing' : skill.dir ? treeHash(skill.dir) : sha(skill.promptTemplate ?? '');
  }

  const deny = new Set(spec.disallowedTools ?? []);
  const allow = spec.tools?.length ? new Set(spec.tools.map(t => t.startsWith('custom:') ? t.slice(7) : t)) : undefined;
  const tools: Record<string, string> = {};
  for (const t of await loadCustomTools(o.cwd).catch(() => [])) {
    if (deny.has(t.name) || deny.has(`custom:${t.name}`)) continue;
    if (allow && !allow.has(t.name)) continue;
    // Enabled-ness is part of it: enabling a draft hands the agent a new tool.
    tools[t.name] = `${t.sha256}:${t.status}`;
  }

  const pins = readPins();
  const mcp: Record<string, string> = {};
  for (const server of mcpServersOf(spec, Object.keys(pins))) {
    const tools = pins[server] ?? {};
    mcp[server] = sha(canonical(Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, v.hash ?? '']))));
  }

  const golden = loadGoldenTasks(spec, o.cwd);
  const parts: DependencyParts = {
    agent: sha(agentText(spec, o.cwd)),
    skills, tools, mcp,
    model: o.model.trim().toLowerCase(),
    evals: sha(golden.text),
    pack: SAFETY_PACK_VERSION,
  };
  return { hash: `sha256:${sha(canonical(parts))}`, parts };
}

// ── the store ────────────────────────────────────────────────────────────

export function certificatesDir(name: string): string {
  return path.join(aicoHome(), 'evals', 'agents', name.replace(/[^a-z0-9_-]/gi, '_'), 'certificates');
}

function fileFor(name: string, hash: string): string {
  return path.join(certificatesDir(name), `${hash.replace(/^sha256:/, '').slice(0, 32)}.json`);
}

export function writeCertificate(cert: Certificate): string {
  const file = fileFor(cert.agent, cert.hash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cert, null, 2)}\n`, 'utf8');
  return file;
}

/** Every certificate on record for an agent, newest first. */
export function listCertificates(name: string): Certificate[] {
  const dir = certificatesDir(name);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const out: Certificate[] = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Certificate;
      if (c?.version === 1 && c.agent === name && typeof c.hash === 'string') out.push(c);
    } catch { /* a torn or foreign file is not a certificate */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export interface StatusReport {
  status: CertificationStatus;
  hash: string;
  model: string;
  /** The certificate for this exact hash, if any; else the newest on record. */
  certificate?: Pick<Certificate, 'hash' | 'passed' | 'at' | 'runs' | 'model' | 'costUsd' | 'reasons'>;
  /** For `changed`: which parts differ from the certified version. */
  changedParts?: string[];
  /** One line for a person. */
  text: string;
}

function brief(c: Certificate): StatusReport['certificate'] {
  return { hash: c.hash, passed: c.passed, at: c.at, runs: c.runs, model: c.model, costUsd: c.costUsd, reasons: c.reasons.slice(0, 5) };
}

function diffParts(a: DependencyParts, b: DependencyParts): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as Array<keyof DependencyParts>) {
    if (canonical(a[k]) !== canonical(b[k])) out.push(k === 'evals' ? 'golden tasks' : k === 'pack' ? 'safety pack' : k);
  }
  return out;
}

/** The status of an agent spec as it is now, on `model`. */
export async function statusOfSpec(spec: AgentSpec, o: { cwd: string; model: string }): Promise<StatusReport> {
  const now = await dependencyHash(spec, o);
  const all = listCertificates(spec.name);
  const exact = all.find(c => c.hash === now.hash);
  const model = now.parts.model;
  if (exact) {
    return exact.passed
      ? { status: 'certified', hash: now.hash, model, certificate: brief(exact), text: `certified on ${model} (${exact.at.slice(0, 10)}, k=${exact.runs})` }
      : { status: 'failed', hash: now.hash, model, certificate: brief(exact), text: `failed certification on ${model}: ${exact.reasons[0] ?? 'see the report'}` };
  }
  const passedBefore = all.find(c => c.passed);
  if (passedBefore) {
    const changedParts = diffParts(passedBefore.parts, now.parts);
    return {
      status: 'changed', hash: now.hash, model, certificate: brief(passedBefore), changedParts,
      text: `changed since certification (${changedParts.join(', ') || 'its dependencies'}) — certify again`,
    };
  }
  return { status: 'uncertified', hash: now.hash, model, text: `not certified on ${model}` };
}

/** The status of a named agent. Undefined when there is no such agent. */
export async function certificationStatus(name: string, o: { cwd: string; model: string }): Promise<StatusReport | undefined> {
  const spec = await getAgentSpec(name, o.cwd);
  if (!spec) return undefined;
  return statusOfSpec(spec, { cwd: o.cwd, model: spec.model || o.model });
}

/**
 * The L4 gate's question: may this agent run unattended now? Never throws —
 * an error reading the store is "no", with the reason.
 */
export async function isCertified(name: string, o: { cwd: string; model: string }): Promise<{ ok: boolean; status: CertificationStatus; reason: string }> {
  try {
    // The model the run is actually on, not the one the agent file names: a
    // certificate is for the model that will answer.
    const spec = await getAgentSpec(name, o.cwd);
    if (!spec) return { ok: false, status: 'uncertified', reason: `there is no agent called "${name}"` };
    const s = await statusOfSpec(spec, o);
    return { ok: s.status === 'certified', status: s.status, reason: s.text };
  } catch (err) {
    return { ok: false, status: 'uncertified', reason: `its certificate could not be checked (${(err as Error).message})` };
  }
}
