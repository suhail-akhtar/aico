/**
 * The audit stream: one flat, versioned, redacted record per thing that
 * happened, built from the durable records AICO already keeps (ADR 0035).
 *
 * Nothing here is new telemetry. It reads, never writes:
 *   - session event logs  → `tool.call`, `turn.end`, `subagent`
 *   - the approve-later inbox → `approval`
 *   - the vault's audit trail → `credential` (reference names, never values)
 *   - the work ledger and long-job journals → `work`, `longjob`
 *   - `audit/events.jsonl` → `settings.change`, `policy.load`
 *
 * **What it deliberately cannot contain.** The record type has no field for a
 * file body, a prompt, an assistant message or a tool result, so there is
 * nothing to leak by mistake: a `Write` is exported as its path, a `Bash` as
 * its command line (redacted, cut at 200 characters), a fetch as host + path
 * with no query string. Every string still goes through `auditText`.
 *
 * Stable means: `schema` is `aico.audit/1`; fields are only ever added; `id`
 * is derived from the source record so exporting twice and loading both into a
 * SIEM de-duplicates.
 *
 * Reads files that may be large and may end in a torn line (a crash mid-write):
 * a line that does not parse is skipped, a file that cannot be read is skipped.
 * An audit export that fails because one log is damaged would fail exactly when
 * someone needs it.
 *
 * @module audit/export
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import type { AicoSettings } from '../settings.js';
import { engineVersion } from '../policy/managed.js';
import { costFor } from '../tokens.js';
import { auditText, callTarget } from './redact.js';
import { resolveIdentity } from './identity.js';
import { readOwnAuditEvents } from './log.js';
import { inboxFile } from '../autonomy/inbox.js';
import { readWorkLog } from '../work/store.js';
import { listJobs } from '../longjob/index.js';

export const AUDIT_SCHEMA = 'aico.audit/1';

export type AuditKind = 'tool.call' | 'turn.end' | 'subagent' | 'approval' | 'credential' | 'settings.change' | 'policy.load' | 'work' | 'longjob' | 'connection';
export type AuditOutcome = 'ok' | 'error' | 'denied' | 'escalated' | 'aborted' | 'declined' | 'expired' | 'timeout';

export interface AuditRecord {
  schema: typeof AUDIT_SCHEMA;
  id: string;
  /** ISO-8601, UTC. */
  time: string;
  kind: AuditKind;
  action: string;
  outcome: AuditOutcome;
  decision?: 'allow' | 'deny' | 'escalated';
  decidedBy?: string;
  stage?: string;
  user?: string;
  host?: string;
  tenant?: string;
  aicoVersion: string;
  project?: string;
  sessionId?: string;
  turn?: number;
  callId?: string;
  tool?: string;
  target?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Estimated from token counts and the price table; not an invoice. */
  costUsd?: number;
  durationMs?: number;
  reason?: string;
  /** A vault reference name. Never a value. */
  credential?: string;
}

/** Column order for CSV, and the order of extension keys in CEF. */
export const AUDIT_COLUMNS: ReadonlyArray<keyof AuditRecord> = [
  'schema', 'id', 'time', 'kind', 'action', 'outcome', 'decision', 'decidedBy', 'stage', 'user', 'host', 'tenant',
  'aicoVersion', 'project', 'sessionId', 'turn', 'callId', 'tool', 'target', 'model', 'inputTokens', 'outputTokens',
  'costUsd', 'durationMs', 'reason', 'credential',
];

export interface ExportOptions {
  /** Epoch ms, inclusive. */
  since?: number;
  /** Epoch ms, exclusive. */
  until?: number;
  /** A project folder; only its sessions (and what those sessions caused) are exported. */
  project?: string;
  /** For cost estimates (custom prices). */
  settings?: AicoSettings;
  /** `--user` / `--host` labels, honoured only when no managed policy states identity. */
  identity?: { user?: string; host?: string };
  /** Only these kinds (the other sources are not even read). */
  kinds?: AuditKind[];
}

const norm = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * `2026-10-01`, `2026-10-01T09:00`, or epoch ms. A date alone means the start
 * of that UTC day — or, as `until`, the end of it, so `--until 2026-10-08`
 * includes the 8th. Undefined for text that is not a date.
 */
export function parseWhen(text: string | undefined, end = false): number | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (/^\d{10,}$/.test(t)) return Number(t);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t);
  const ms = Date.parse(dateOnly ? `${t}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`);
  if (!Number.isFinite(ms)) return undefined;
  return dateOnly && end ? ms + 86_400_000 : ms;
}

const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const iso = (ms: number): string => new Date(ms).toISOString();

function readLines(file: string): string[] {
  try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}
function parseJson<T>(line: string): T | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as T; } catch { return undefined; /* torn or foreign line */ }
}

// ── session logs ────────────────────────────────────────────────────

interface RawEvent { seq?: number; type?: string; timestamp?: number; data?: Record<string, unknown> }
interface Pending {
  at: number; turn: number; name: string; args: unknown; model: string;
  decision?: { decision?: string; by?: string; stage?: string; reason?: string };
}

type Base = Omit<AuditRecord, 'schema' | 'id' | 'time' | 'kind' | 'action' | 'outcome'>;

function turnOutcome(kind: string | undefined): AuditOutcome {
  switch (kind) {
    case 'completed': return 'ok';
    case 'aborted': return 'aborted';
    case 'blocked': return 'denied';
    default: return 'error';
  }
}

/** Every session event log under the store, with its project and id. */
function sessionFiles(): string[] {
  const root = path.join(aicoHome(), 'projects');
  const out: string[] = [];
  let projects: string[] = [];
  try { projects = fs.readdirSync(root); } catch { return out; }
  for (const p of projects) {
    const dir = path.join(root, p, 'sessions');
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.events.jsonl')) out.push(path.join(dir, n));
  }
  return out;
}

function fromSession(file: string, o: ExportOptions, emit: (r: never) => void): { cwd?: string; id?: string } {
  // Events are appended, so a file untouched since `since` has nothing in range.
  if (o.since !== undefined) { try { if (fs.statSync(file).mtimeMs < o.since) return {}; } catch { return {}; } }
  const lines = readLines(file);
  const header = parseJson<{ type?: string; id?: string; cwd?: string }>(lines[0] ?? '');
  const cwd = header?.type === '__header__' ? header.cwd : undefined;
  const sessionId = header?.type === '__header__' ? header.id : path.basename(file).replace(/\.events\.jsonl$/, '');
  if (o.project && (!cwd || norm(cwd) !== norm(o.project))) return { ...(cwd ? { cwd } : {}), ...(sessionId ? { id: sessionId } : {}) };

  const inRange = (t: number): boolean => (o.since === undefined || t >= o.since) && (o.until === undefined || t < o.until);
  const base = (): Base => ({ ...(cwd ? { project: auditText(cwd, 200) } : {}), ...(sessionId ? { sessionId } : {}) } as Base);
  let model = '';
  const calls = new Map<string, Pending>();
  const early = new Map<string, Pending['decision']>();
  const turns = new Map<number, { input: number; output: number; cached: number; model: string; startedAt?: number }>();

  const emitCall = (callId: string, p: Pending, result: { at: number; isError: boolean } | undefined): void => {
    if (!inRange(p.at)) return;
    const d = p.decision;
    let outcome: AuditOutcome;
    let decision: AuditRecord['decision'] | undefined;
    let decidedBy: string | undefined;
    if (d?.decision === 'denied') {
      outcome = 'denied'; decision = 'deny';
      decidedBy = d.by === 'person' ? 'person' : d.stage ? `guard:${d.stage}` : 'policy';
    } else if (!result) {
      outcome = 'aborted';
    } else {
      outcome = result.isError ? 'error' : 'ok';
      if (d?.decision === 'approved') { decision = 'allow'; decidedBy = 'person'; }
      else if (!result.isError) { decision = 'allow'; decidedBy = 'auto'; }
    }
    emit({
      key: `${sessionId}|${callId}|call`, time: iso(p.at), kind: 'tool.call', action: p.name, outcome,
      ...(decision ? { decision } : {}), ...(decidedBy ? { decidedBy } : {}),
      ...(d?.stage ? { stage: auditText(d.stage, 60) } : {}),
      tool: auditText(p.name, 80), ...(callTarget(p.name, p.args) ? { target: callTarget(p.name, p.args) } : {}),
      ...base(), turn: p.turn, callId: auditText(callId, 80), ...(p.model ? { model: auditText(p.model, 100) } : {}),
      ...(result ? { durationMs: Math.max(0, result.at - p.at) } : {}),
      ...(d?.reason ? { reason: auditText(d.reason, 300) } : {}),
    } as never);
  };

  const spawns = new Map<string, { at: number; agentType: string; description: string; model: string; depth: number }>();
  for (let i = 1; i < lines.length; i++) {
    const ev = parseJson<RawEvent>(lines[i]!);
    if (!ev || typeof ev.type !== 'string' || !ev.data || typeof ev.timestamp !== 'number') continue;
    const d = ev.data;
    const at = ev.timestamp;
    switch (ev.type) {
      case 'request/header': {
        const m = (d.header as { model?: unknown } | undefined)?.model;
        if (typeof m === 'string') model = m;
        break;
      }
      case 'session/model': if (typeof d.model === 'string') model = d.model; break;
      case 'turn/start': turns.set(Number(d.turn), { input: 0, output: 0, cached: 0, model, startedAt: at }); break;
      case 'assistant/message': {
        const t = turns.get(Number(d.turn)) ?? { input: 0, output: 0, cached: 0, model };
        const u = d.usage as { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined;
        if (u) { t.input += u.inputTokens ?? 0; t.output += u.outputTokens ?? 0; t.cached += u.cachedTokens ?? 0; }
        t.model = model || t.model;
        turns.set(Number(d.turn), t);
        break;
      }
      case 'tool/call': {
        let args: unknown;
        try { args = JSON.parse(String(d.arguments ?? '{}')); } catch { args = undefined; }
        const callId = String(d.callId);
        calls.set(callId, { at, turn: Number(d.turn), name: String(d.name), args, model, ...(early.has(callId) ? { decision: early.get(callId)! } : {}) });
        break;
      }
      case 'tool/decision': {
        const callId = String(d.callId);
        const dec = { decision: String(d.decision), by: String(d.by ?? ''), ...(typeof d.stage === 'string' ? { stage: d.stage } : {}), ...(typeof d.reason === 'string' ? { reason: d.reason } : {}) };
        const p = calls.get(callId);
        if (p) p.decision = dec; else early.set(callId, dec);
        break;
      }
      case 'tool/result': {
        const callId = String(d.callId);
        const p = calls.get(callId);
        if (p) { emitCall(callId, p, { at, isError: d.isError === true }); calls.delete(callId); }
        break;
      }
      case 'agent/spawn':
        spawns.set(String(d.agentId), { at, agentType: String(d.agentType), description: String(d.description ?? ''), model: String(d.model ?? ''), depth: Number(d.depth ?? 1) });
        break;
      case 'agent/done': {
        const s = spawns.get(String(d.agentId));
        if (s && inRange(s.at)) {
          emit({
            key: `${sessionId}|${String(d.agentId)}|sub`, time: iso(s.at), kind: 'subagent', action: auditText(s.agentType, 60),
            outcome: d.status === 'completed' ? 'ok' : d.status === 'cancelled' ? 'aborted' : 'error',
            ...base(), model: auditText(s.model, 100), inputTokens: Number(d.inputTokens ?? 0), outputTokens: Number(d.outputTokens ?? 0),
            durationMs: Number(d.ms ?? 0), reason: auditText(`${s.description}${d.error ? ` — ${String(d.error)}` : ''}`, 300),
          } as never);
        }
        spawns.delete(String(d.agentId));
        break;
      }
      case 'turn/end': {
        const turn = Number(d.turn);
        const t = turns.get(turn);
        const reason = d.reason as { kind?: string; message?: string; cause?: string; code?: string } | undefined;
        const started = t?.startedAt ?? at;
        if (inRange(started)) {
          const m = t?.model || model;
          emit({
            key: `${sessionId}|turn${turn}|end`, time: iso(started), kind: 'turn.end', action: 'turn', outcome: turnOutcome(reason?.kind),
            ...base(), turn, ...(m ? { model: auditText(m, 100) } : {}),
            inputTokens: t?.input ?? 0, outputTokens: t?.output ?? 0,
            costUsd: m && t ? round(costFor(m, { inputTokens: t.input, outputTokens: t.output, cachedTokens: t.cached }, o.settings)) : 0,
            durationMs: Math.max(0, at - started),
            ...(reason && reason.kind !== 'completed' ? { reason: auditText(`${reason.kind}${reason.message ? `: ${reason.message}` : ''}${reason.cause ? `: ${reason.cause}` : ''}`, 300) } : {}),
          } as never);
        }
        turns.delete(turn);
        break;
      }
      default: break;
    }
  }
  // A call with no result, or a turn that never closed: the process died. Say so.
  for (const [callId, p] of calls) emitCall(callId, p, undefined);
  for (const [turn, t] of turns) {
    if (t.startedAt === undefined || !inRange(t.startedAt)) continue;
    const m = t.model || model;
    emit({
      key: `${sessionId}|turn${turn}|end`, time: iso(t.startedAt), kind: 'turn.end', action: 'turn', outcome: 'aborted', ...base(), turn,
      ...(m ? { model: auditText(m, 100) } : {}), inputTokens: t.input, outputTokens: t.output,
      costUsd: m ? round(costFor(m, { inputTokens: t.input, outputTokens: t.output, cachedTokens: t.cached }, o.settings)) : 0,
      reason: 'the turn never recorded an end (the process stopped)',
    } as never);
  }
  return { ...(cwd ? { cwd } : {}), ...(sessionId ? { id: sessionId } : {}) };
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

// ── the other sources ───────────────────────────────────────────────

function fromInbox(o: ExportOptions, sessions: Set<string> | undefined, emit: (r: never) => void): void {
  type Action = { id: string; tool: string; effect?: string; origin?: string; why?: string; call?: string; sessionId?: string; cwd?: string; createdAt: number; agentName?: string };
  const parked = new Map<string, Action>();
  const inRange = (t: number): boolean => (o.since === undefined || t >= o.since) && (o.until === undefined || t < o.until);
  for (const line of readLines(inboxFile())) {
    const ev = parseJson<{ t?: string; at?: number; action?: Action; id?: string; status?: string; via?: string }>(line);
    if (!ev) continue;
    if (ev.t === 'park' && ev.action?.id) parked.set(ev.action.id, ev.action);
    const a = ev.t === 'park' ? ev.action : ev.t === 'status' && ev.id ? parked.get(ev.id) : undefined;
    if (!a || typeof ev.at !== 'number' || !inRange(ev.at)) continue;
    if (o.project && !(a.cwd && norm(a.cwd) === norm(o.project)) && !(a.sessionId && sessions?.has(a.sessionId))) continue;
    const status = ev.t === 'park' ? 'pending' : String(ev.status);
    const decidedBy = ev.t === 'status' ? (ev.via === 'expiry' ? 'system' : ev.via ? `person:${auditText(ev.via, 20)}` : undefined) : undefined;
    const outcome: AuditOutcome = status === 'pending' ? 'escalated' : status === 'denied' ? 'denied' : status === 'expired' ? 'expired' : status === 'failed' || status === 'diverged' ? 'error' : 'ok';
    emit({
      schema: AUDIT_SCHEMA, id: sha(`inbox|${a.id}|${ev.t}|${status}|${ev.at}`), time: iso(ev.at), kind: 'approval',
      action: ev.t === 'park' ? 'park' : status, outcome,
      decision: status === 'pending' ? 'escalated' : status === 'denied' || status === 'expired' ? 'deny' : 'allow',
      ...(decidedBy ? { decidedBy } : {}), tool: auditText(a.tool, 80), ...(a.call ? { target: auditText(a.call, 200) } : {}),
      ...(a.cwd ? { project: auditText(a.cwd, 200) } : {}), ...(a.sessionId ? { sessionId: a.sessionId } : {}),
      ...(a.why ? { reason: auditText(`${a.origin ?? ''} ${a.effect ?? ''}: ${a.why}`, 300) } : {}),
    } as never);
  }
}

function fromVault(o: ExportOptions, sessions: Set<string> | undefined, emit: (r: never) => void): void {
  const inRange = (t: number): boolean => (o.since === undefined || t >= o.since) && (o.until === undefined || t < o.until);
  const file = path.join(aicoHome(), 'vault', 'audit.jsonl');
  for (const line of readLines(file)) {
    const e = parseJson<{ at?: number; action?: string; outcome?: string; name?: string; tool?: string; target?: string; purpose?: string; sessionId?: string; actor?: string; reason?: string }>(line);
    if (!e || typeof e.at !== 'number' || !e.action || !inRange(e.at)) continue;
    if (o.project && !(e.sessionId && sessions?.has(e.sessionId))) continue;
    const outcome: AuditOutcome = e.outcome === 'ok' ? 'ok' : e.outcome === 'denied' ? 'denied' : e.outcome === 'declined' ? 'declined' : e.outcome === 'timeout' ? 'timeout' : 'error';
    emit({
      schema: AUDIT_SCHEMA, id: sha(`vault|${e.at}|${e.action}|${e.name ?? ''}|${e.sessionId ?? ''}|${e.target ?? ''}`), time: iso(e.at),
      kind: 'credential', action: auditText(e.action, 40), outcome,
      ...(e.name ? { credential: auditText(e.name, 100) } : {}), ...(e.tool ? { tool: auditText(e.tool, 80) } : {}),
      ...(e.target ? { target: auditText(e.target, 200) } : {}), ...(e.sessionId ? { sessionId: auditText(e.sessionId, 100) } : {}),
      ...(e.actor ? { decidedBy: auditText(e.actor, 60) } : {}),
      ...(e.purpose || e.reason ? { reason: auditText([e.purpose, e.reason].filter(Boolean).join(' — '), 300) } : {}),
    } as never);
  }
}

async function fromWork(o: ExportOptions, sessions: Set<string> | undefined, emit: (r: never) => void): Promise<void> {
  const inRange = (t: number): boolean => (o.since === undefined || t >= o.since) && (o.until === undefined || t < o.until);
  let records: Awaited<ReturnType<typeof readWorkLog>>['records'] = [];
  try { records = (await readWorkLog()).records; } catch { return; }
  for (const r of records) {
    if (!inRange(r.startedAt)) continue;
    if (o.project && !(r.sessionId && sessions?.has(r.sessionId))) continue;
    const outcome: AuditOutcome = r.state === 'done' ? 'ok' : r.state === 'failed' ? 'error' : r.state === 'cancelled' ? 'aborted' : r.state === 'running' || r.state === 'queued' || r.state === 'blocked' ? 'ok' : 'error';
    emit({
      schema: AUDIT_SCHEMA, id: sha(`work|${r.id}`), time: iso(r.startedAt), kind: 'work', action: auditText(r.kind, 40), outcome,
      decidedBy: auditText(r.origin, 20), ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.resume?.model ? { model: auditText(r.resume.model, 100) } : {}), ...(r.cost ? { costUsd: round(r.cost.usd), inputTokens: r.cost.tokens } : {}),
      ...(r.endedAt ? { durationMs: Math.max(0, r.endedAt - r.startedAt) } : {}),
      reason: auditText(`${r.state}: ${r.title}${r.error ? ` — ${r.error}` : ''}`, 300), callId: auditText(r.id, 80),
    } as never);
  }
}

function fromLongJobs(o: ExportOptions, emit: (r: never) => void): void {
  const inRange = (t: number): boolean => (o.since === undefined || t >= o.since) && (o.until === undefined || t < o.until);
  let jobs: ReturnType<typeof listJobs> = [];
  try { jobs = listJobs(); } catch { return; }
  for (const j of jobs) {
    if (o.project && norm(j.cwd) !== norm(o.project)) continue;
    const common = { project: auditText(j.cwd, 200), sessionId: j.sessionId, callId: j.id, tool: 'LongJob' };
    if (inRange(j.createdAt)) {
      emit({ schema: AUDIT_SCHEMA, id: sha(`job|${j.id}|proposed`), time: iso(j.createdAt), kind: 'longjob', action: 'proposed', outcome: 'escalated', decision: 'escalated', ...common, reason: auditText(`${j.title} (est. ${j.estimateHours} h)`, 300) } as never);
    }
    if (j.decidedAt && inRange(j.decidedAt)) {
      emit({ schema: AUDIT_SCHEMA, id: sha(`job|${j.id}|decided`), time: iso(j.decidedAt), kind: 'longjob', action: j.status === 'declined' ? 'declined' : 'approved', outcome: j.status === 'declined' ? 'declined' : 'ok', decision: j.status === 'declined' ? 'deny' : 'allow', decidedBy: j.decidedVia ? `person:${auditText(j.decidedVia, 20)}` : 'person', ...common, costUsd: round(j.spentUsd), reason: auditText(`${j.title}: now ${j.status}${j.note ? ` — ${j.note}` : ''}`, 300) } as never);
    }
  }
}

function fromOwn(o: ExportOptions, emit: (r: never) => void): void {
  if (o.project) return;
  const inRange = (t: number): boolean => (o.since === undefined || t >= o.since) && (o.until === undefined || t < o.until);
  for (const e of readOwnAuditEvents()) {
    if (typeof e.at !== 'number' || !inRange(e.at)) continue;
    if (e.kind === 'settings.change') {
      emit({ schema: AUDIT_SCHEMA, id: sha(`own|${e.at}|${e.key}|${e.action}`), time: iso(e.at), kind: 'settings.change', action: e.action, outcome: 'ok', target: auditText(e.key, 200), ...(e.valueHash ? { reason: `value hash ${e.valueHash}` } : {}) } as never);
    } else if (e.kind === 'connection') {
      // The key carries host + path without a query; titles, bodies and tokens never reach this record (audit/log.ts).
      emit({
        schema: AUDIT_SCHEMA, id: sha(`own|${e.at}|conn|${e.connection}|${e.action}|${e.ref ?? ''}|${e.target ?? ''}`), time: iso(e.at), kind: 'connection',
        action: auditText(e.action, 40), outcome: e.outcome, ...(e.outcome === 'denied' ? { decision: 'deny' } : e.outcome === 'ok' ? { decision: 'allow' } : {}),
        tool: auditText(`${e.provider}:${e.connection}`, 80), ...(e.target ? { target: auditText(e.target, 200) } : {}),
        ...(e.detail || e.ref ? { reason: auditText([e.ref, e.detail].filter(Boolean).join(' - '), 300) } : {}),
        ...(e.project ? { project: e.project } : {}),
      } as never);
    } else if (e.kind === 'policy.load') {
      emit({
        schema: AUDIT_SCHEMA, id: sha(`own|${e.at}|policy|${e.hash}`), time: iso(e.at), kind: 'policy.load', action: e.active ? 'loaded' : 'removed',
        outcome: e.lockdown ? 'error' : 'ok', target: auditText(e.paths.join('; '), 200),
        reason: auditText(`policy ${e.hash || 'none'}; ${e.problems} problem(s)${e.lockdown ? '; LOCKDOWN' : ''}${e.weak ? '; file is writable by the user (not a lock)' : ''}`, 300),
      } as never);
    }
  }
}

// ── the entry point ─────────────────────────────────────────────────

/** Collect the stream, oldest first. Never throws on a damaged source; skips it. */
export async function collectAudit(o: ExportOptions = {}): Promise<AuditRecord[]> {
  const identity = resolveIdentity(o.identity ?? {});
  const version = engineVersion();
  const out: AuditRecord[] = [];
  const stamp = (r: Partial<AuditRecord> & { key?: string }): AuditRecord => {
    const { key, ...rest } = r;
    return {
      schema: AUDIT_SCHEMA, id: r.id ?? sha(key ?? JSON.stringify(rest)), ...rest,
      ...(identity.user ? { user: identity.user } : {}), ...(identity.host ? { host: identity.host } : {}),
      ...(identity.tenant ? { tenant: identity.tenant } : {}), aicoVersion: version,
    } as AuditRecord;
  };
  const want = (k: AuditKind): boolean => !o.kinds || o.kinds.includes(k);
  const push = (r: never): void => {
    const rec = stamp(r as Partial<AuditRecord>);
    if (want(rec.kind)) out.push(rec);
  };

  const sessions = new Set<string>();
  for (const file of sessionFiles()) {
    try {
      const info = fromSession(file, o, push);
      if (info.id && (!o.project || (info.cwd && norm(info.cwd) === norm(o.project)))) sessions.add(info.id);
    } catch { /* one damaged log must not fail the export */ }
  }
  const scope = o.project ? sessions : undefined;
  for (const [kind, step] of [
    ['approval', () => fromInbox(o, scope, push)],
    ['credential', () => fromVault(o, scope, push)],
    ['longjob', () => fromLongJobs(o, push)],
    ['settings.change', () => fromOwn(o, push)],
  ] as Array<[AuditKind, () => void]>) {
    if (!want(kind) && !(kind === 'settings.change' && (want('policy.load') || want('connection')))) continue;
    try { step(); } catch { /* skip a damaged source */ }
  }
  if (want('work')) { try { await fromWork(o, scope, push); } catch { /* skip */ } }

  out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // De-duplicate on id (a source read twice, e.g. a session log copied into two stores).
  const seen = new Set<string>();
  return out.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
