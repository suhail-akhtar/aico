/**
 * The approve-later inbox ("Waiting for you", design §8.3, ADR 0011).
 *
 * An unattended (L4) run that reaches a call needing a person does not run
 * it and does not simply refuse it: it **parks** it here — the exact call,
 * the preview a person would have seen, and three hashes — and carries on
 * with everything else. Later a person approves or denies from the inbox.
 *
 * Approving runs **exactly that call, once**, and only if nothing it was
 * judged on has moved:
 *
 *  - `argsHash` — the stored arguments are re-hashed; a call edited on disk
 *    is refused.
 *  - `contextHash` — the tool's definition file (and its preview tool's), the
 *    directory and the scope. A tool edited after parking is refused: the
 *    person approved what the old definition would have done.
 *  - `previewHash` — the preview is run again first; different output is
 *    refused as **diverged** (the Atlantis rule: the plan you approved is not
 *    the plan that would run) and the new preview is shown, so the person can
 *    ask for a fresh proposal.
 *  - `agentName` — a call parked by a named agent's run is replayed only
 *    while that agent still holds a current certificate (Phase 4, ADR 0012):
 *    its run was allowed at L4 because of that certificate.
 *
 * Then it executes through a small pipeline whose guards re-validate the
 * arguments and spend a single-use grant bound to `argsHash` — a second
 * dispatch, or one with any other arguments, is denied. The outcome is
 * recorded, a notification raised, and — when the call came from a chat —
 * delivered into that session through the watchers' wake path as a
 * follow-up (never a steer): it waits in the session's queue for the next
 * turn.
 *
 * Who may approve is not decided here. The server route asks the decision
 * gate for a person (`checkHuman`: the desktop window's one-time grant, the
 * web UI key or a live client nonce); the API token alone — which the model
 * may have — is refused. A *deny* needs no proof: refusing is always safe.
 *
 * **Storage.** Append-only JSONL in `aicoHome()/inbox/actions.jsonl`: a
 * `park` event carries the action, every later change is a `status` event
 * with when, how and why. The file is the audit trail as well as the state,
 * so nothing is ever rewritten. Read fresh on every call (it is small, and a
 * terminal and a server may share it). Arguments are stored only if the
 * redactor leaves them unchanged: a call that carries a secret *value* is not
 * parked, because the stored call could then not be replayed exactly and the
 * file would hold the secret — secrets belong in the tool's `{{secret:…}}`.
 *
 * Deliberately not here: the work ledger's `approval` kind the design names.
 * The ledger reconciles every non-process record to `lost` on restart and
 * streams its rows to every client; a parked call must survive restarts and
 * holds the full call. ADR 0011 records the choice. Only custom tools park —
 * they are the tools with effect classes and previews; built-ins at L4 run as
 * at L3, and the ops tools keep the credential broker's own approvals.
 *
 * @module autonomy/inbox
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pushNotification } from '../background/notifications.js';
import { aicoHome } from '../home.js';
import { ToolPipeline } from '../tools/pipeline.js';
import { sinkRedact, sinkRedactText } from '../vault/sink.js';
import { wakeDelivery } from '../work/watchers.js';
import { describeCall, validateArgs, type Effect } from '../custom-tools/format.js';
import { runPreview, type ParkRequest } from '../custom-tools/policy.js';
import { runCustomTool } from '../custom-tools/runner.js';
import { loadCustomTools, usableTools, type LoadedTool } from '../custom-tools/store.js';

/** How long a parked call waits before it expires. A night and a working day. */
export const DEFAULT_PARK_TTL_MS = 24 * 60 * 60 * 1000;
/** Pending actions per store, so a looping run cannot fill the disk. */
const MAX_PENDING = 200;
/** Result text kept on the record and delivered to the session. */
const OUTCOME_CHARS = 4000;

export type ActionStatus = 'pending' | 'approved' | 'executed' | 'failed' | 'diverged' | 'denied' | 'expired';
export type ActionOrigin = 'chat' | 'cron' | 'background' | 'remote';

export interface PendingAction {
  id: string;
  status: ActionStatus;
  createdAt: number;
  expiresAt: number;
  origin: ActionOrigin;
  /** The job or chat it came from, for the list. */
  label?: string;
  sessionId?: string;
  agentId: string;
  /** The named agent whose run parked it, and its model: replay needs its certificate to still hold. */
  agentName?: string;
  agentModel?: string;
  cwd: string;
  tool: string;
  effect: Effect;
  /** Why it needed a person ("destructive — a person approves every call"). */
  why: string;
  /** The exact rendered argv or request, secrets by name. */
  call: string;
  args: Record<string, unknown>;
  argsHash: string;
  preview?: string;
  previewHash?: string;
  contextHash: string;
  decidedAt?: number;
  /** Which human channel decided (`host`, `ui-key`, `client`, `tty`) or `expiry`. */
  decidedVia?: string;
  /** The result excerpt, or why it did not run. */
  outcome?: string;
  /** On divergence: what the preview says now. */
  newPreview?: string;
}

type InboxEvent =
  | { t: 'park'; at: number; action: PendingAction }
  | { t: 'status'; at: number; id: string; status: ActionStatus; via?: string; outcome?: string; newPreview?: string };

export function inboxFile(): string {
  return path.join(aicoHome(), 'inbox', 'actions.jsonl');
}

function append(event: InboxEvent): void {
  fs.mkdirSync(path.dirname(inboxFile()), { recursive: true });
  fs.appendFileSync(inboxFile(), `${JSON.stringify(event)}\n`, 'utf8');
}

function readAll(): Map<string, PendingAction> {
  const out = new Map<string, PendingAction>();
  let text = '';
  try { text = fs.readFileSync(inboxFile(), 'utf8'); } catch { return out; /* no inbox yet: nothing parked */ }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev: InboxEvent;
    try { ev = JSON.parse(line) as InboxEvent; } catch { continue; /* a torn last line from a crash mid-append */ }
    if (ev.t === 'park' && ev.action?.id) out.set(ev.action.id, { ...ev.action });
    else if (ev.t === 'status') {
      const a = out.get(ev.id);
      if (!a) continue;
      a.status = ev.status;
      if (ev.status === 'approved' || ev.status === 'denied' || ev.status === 'expired') { a.decidedAt = ev.at; if (ev.via) a.decidedVia = ev.via; }
      if (ev.outcome !== undefined) a.outcome = ev.outcome;
      if (ev.newPreview !== undefined) a.newPreview = ev.newPreview;
    }
  }
  return out;
}

function setStatus(a: PendingAction, status: ActionStatus, extra: { via?: string; outcome?: string; newPreview?: string } = {}): PendingAction {
  const at = Date.now();
  const outcome = extra.outcome === undefined ? undefined : sinkRedactText(extra.outcome).slice(0, OUTCOME_CHARS);
  append({ t: 'status', at, id: a.id, status, ...(extra.via ? { via: extra.via } : {}), ...(outcome !== undefined ? { outcome } : {}), ...(extra.newPreview ? { newPreview: extra.newPreview } : {}) });
  a.status = status;
  if (status === 'approved' || status === 'denied' || status === 'expired') { a.decidedAt = at; if (extra.via) a.decidedVia = extra.via; }
  if (outcome !== undefined) a.outcome = outcome;
  if (extra.newPreview) a.newPreview = extra.newPreview;
  return a;
}

// ── hashes ───────────────────────────────────────────────────────────

/** JSON with sorted keys, so the same arguments always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export function hashArgs(args: Record<string, unknown>): string {
  return sha(canonical(args));
}

/** What the approval is bound to besides the call: the definitions, where, and from which store. */
export function contextHashFor(tool: Pick<LoadedTool, 'name' | 'sha256' | 'scope'>, previewTool: Pick<LoadedTool, 'sha256'> | undefined, cwd: string): string {
  const dir = path.resolve(cwd);
  return sha(canonical({
    tool: tool.name, def: tool.sha256, scope: tool.scope, preview: previewTool?.sha256 ?? null,
    cwd: process.platform === 'win32' ? dir.toLowerCase() : dir,
  }));
}

// ── parking ──────────────────────────────────────────────────────────

export interface ParkInput extends ParkRequest {
  cwd: string;
  agentId: string;
  sessionId?: string;
  origin: ActionOrigin;
  label?: string;
  ttlMs?: number;
  agentName?: string;
  agentModel?: string;
}

/** Record one call for a person. Refuses (never throws) when it cannot be stored faithfully. */
export function parkAction(input: ParkInput): { id: string; action: PendingAction } | { error: string } {
  const args = input.args ?? {};
  if (canonical(sinkRedact(args)) !== canonical(args)) {
    return { error: 'its arguments carry a secret value, which the inbox will not store. Put the secret in the tool definition as a {{secret:name}} reference.' };
  }
  const all = readAll();
  if ([...all.values()].filter(a => a.status === 'pending').length >= MAX_PENDING) {
    return { error: `the inbox already holds ${MAX_PENDING} actions waiting for a person — ask them to clear it.` };
  }
  const now = Date.now();
  const action: PendingAction = {
    id: `act-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    status: 'pending',
    createdAt: now,
    expiresAt: now + (input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_PARK_TTL_MS),
    origin: input.origin,
    ...(input.label ? { label: input.label.slice(0, 200) } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    agentId: input.agentId,
    ...(input.agentName ? { agentName: input.agentName, ...(input.agentModel ? { agentModel: input.agentModel } : {}) } : {}),
    cwd: path.resolve(input.cwd),
    tool: input.tool.name,
    effect: input.tool.def.effect,
    why: input.why,
    call: sinkRedactText(describeCall(input.tool.def, args)),
    args,
    argsHash: hashArgs(args),
    ...(input.preview ? { preview: input.preview.text, previewHash: input.preview.hash } : {}),
    contextHash: contextHashFor(input.tool, input.previewTool, input.cwd),
  };
  append({ t: 'park', at: now, action });
  pushNotification({
    title: `Waiting for you: ${action.tool}`,
    body: `${action.label ?? action.origin} — ${action.why}. Approve or deny it in the inbox.`,
    level: 'warning',
    sourceId: `inbox:${action.id}`,
  });
  return { id: action.id, action };
}

// ── reading ──────────────────────────────────────────────────────────

/** Mark overdue pending actions expired (and tell their sessions). Returns how many. */
export function expireDue(now = Date.now()): number {
  let n = 0;
  for (const a of readAll().values()) {
    if (a.status !== 'pending' || a.expiresAt > now) continue;
    setStatus(a, 'expired', { via: 'expiry', outcome: 'Nobody approved it in time; it did not run.' });
    deliver(a);
    n++;
  }
  return n;
}

/** Pending first (oldest first), then the most recent decisions. */
export function listActions(opts: { status?: 'pending' | 'all'; limit?: number } = {}): PendingAction[] {
  expireDue();
  const all = [...readAll().values()];
  const pending = all.filter(a => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  if (opts.status === 'pending') return pending;
  const decided = all.filter(a => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
  return [...pending, ...decided].slice(0, Math.max(1, opts.limit ?? 100));
}

export function getAction(id: string): PendingAction | undefined {
  return readAll().get(id);
}

// ── deciding ─────────────────────────────────────────────────────────

export interface DecisionResult { ok: boolean; message: string; action?: PendingAction }

/** Calls being approved right now in this process: a double click must not run twice. */
const inFlight = new Set<string>();

/** The action if it can still be decided, else why not. */
function open(id: string): { action: PendingAction } | { refused: DecisionResult } {
  const a = getAction(id);
  if (!a) return { refused: { ok: false, message: `No parked action ${id}.` } };
  if (inFlight.has(id)) return { refused: { ok: false, message: 'That action is being approved already.', action: a } };
  if (a.status !== 'pending') return { refused: { ok: false, message: `That action was already ${a.status}.`, action: a } };
  if (a.expiresAt <= Date.now()) {
    setStatus(a, 'expired', { via: 'expiry', outcome: 'Nobody approved it in time; it did not run.' });
    deliver(a);
    return { refused: { ok: false, message: 'That action expired before it was approved; it did not run.', action: a } };
  }
  return { action: a };
}

/** A person said no. `via` names the channel; no proof is needed to refuse. */
export function denyAction(id: string, via: string, note?: string): DecisionResult {
  const got = open(id);
  if ('refused' in got) return got.refused;
  const a = setStatus(got.action, 'denied', { via, outcome: note?.trim() ? `Denied: ${note.trim().slice(0, 500)}` : 'Denied by the person.' });
  deliver(a);
  return { ok: true, message: `Denied; ${a.tool} did not run.`, action: a };
}

/**
 * A person said yes: run exactly the parked call, once, if nothing moved.
 * The caller has already proved a person (decision gate); `via` records how.
 */
export async function approveAction(id: string, via: string, opts: { signal?: AbortSignal } = {}): Promise<DecisionResult> {
  const got = open(id);
  if ('refused' in got) return got.refused;
  const a = got.action;
  inFlight.add(id);
  try {
    // Recorded before anything runs: the approval is the audit fact, and a
    // crash mid-run must not leave the action approvable a second time.
    setStatus(a, 'approved', { via });
    const finish = (status: ActionStatus, outcome: string, newPreview?: string): DecisionResult => {
      setStatus(a, status, { outcome, ...(newPreview ? { newPreview } : {}) });
      deliver(a);
      return { ok: status === 'executed', message: outcome, action: a };
    };

    // A call parked by a named agent's unattended run: that run was allowed
    // only because the agent was certified; if it has changed since, the
    // approval would be for an agent nobody verified (design §6.4).
    if (a.agentName) {
      const { isCertified } = await import('../evals/certificate.js');
      const cert = await isCertified(a.agentName, { cwd: a.cwd, model: a.agentModel ?? '' });
      if (!cert.ok) return finish('diverged', `The agent ${a.agentName} that parked this call is ${cert.reason}, so the call was not run. Certify it again, then ask for a fresh proposal.`);
    }

    const tools = usableTools(await loadCustomTools(a.cwd));
    const tool = tools.get(a.tool);
    if (!tool) return finish('failed', `${a.tool} is no longer an enabled tool here, so it was not run.`);
    const previewName = tool.def.preview?.tool;
    if (contextHashFor(tool, previewName ? tools.get(previewName) : undefined, a.cwd) !== a.contextHash) {
      return finish('diverged', `${a.tool}'s definition (or its preview's) changed after the call was parked, so the approval no longer covers what would run. It was not run; ask for a fresh proposal.`);
    }
    if (hashArgs(a.args) !== a.argsHash) return finish('diverged', 'The stored call does not match what was parked, so it was not run.');
    const problems = validateArgs(tool.def.input_schema, a.args);
    if (problems.length) return finish('failed', `The arguments are no longer valid for ${a.tool}: ${problems.join(' ')} It was not run.`);

    if (tool.def.preview) {
      const now = await runPreview(tool.def, a.args, { tools, cwd: a.cwd, ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!now || now.hash !== a.previewHash) {
        return finish('diverged', `The preview changed since the call was parked (the state it would act on moved), so ${a.tool} was not run. Read the new preview and ask for a fresh proposal.`, now?.text);
      }
    }

    // Exactly once, exactly these arguments: a grant bound to the hash, spent
    // by the first dispatch that matches it.
    let grant: string | undefined = a.argsHash;
    const pipeline = new ToolPipeline();
    pipeline.onGuard('inbox:args', (ctx) => {
      const p = validateArgs(tool.def.input_schema, ctx.arguments ?? {});
      return p.length ? { kind: 'deny', reason: p.join(' ') } : { kind: 'abstain' };
    });
    pipeline.onGuard('inbox:grant', (ctx) => {
      if (ctx.name === a.tool && grant && hashArgs(ctx.arguments ?? {}) === grant) { grant = undefined; return { kind: 'abstain' }; }
      return { kind: 'deny', reason: 'No approval covers this call (each approval runs one exact call, once).' };
    });
    const result = await pipeline.execute(
      { callId: `inbox-${a.id}`, name: a.tool, arguments: JSON.parse(JSON.stringify(a.args)) as Record<string, unknown>, agentId: `inbox:${a.id}`, state: new Map(), ...(opts.signal ? { signal: opts.signal } : {}) },
      (ctx) => runCustomTool(tool.def, ctx.arguments, { cwd: a.cwd, ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(opts.signal ? { signal: opts.signal } : {}) }),
    );
    const text = typeof result.outcome.result === 'string' ? result.outcome.result : JSON.stringify(result.outcome.result);
    return result.outcome.isError
      ? finish('failed', `${a.tool} ran after approval and failed: ${text}`)
      : finish('executed', `${a.tool} ran after approval: ${text}`);
  } catch (err) {
    setStatus(a, 'failed', { outcome: `Approval could not complete: ${(err as Error).message}` });
    deliver(a);
    return { ok: false, message: a.outcome ?? 'failed', action: a };
  } finally {
    inFlight.delete(id);
  }
}

// ── telling someone ──────────────────────────────────────────────────

/** The message a session (and the tray) gets once an action is settled. */
export function outcomeMessage(a: PendingAction): string {
  const head = {
    executed: `A person approved the parked call ${a.tool} (inbox ${a.id}) and it ran.`,
    failed: `A person approved the parked call ${a.tool} (inbox ${a.id}); it did not complete.`,
    diverged: `The parked call ${a.tool} (inbox ${a.id}) was approved but refused as diverged: what it was judged on changed. It did not run.`,
    denied: `A person denied the parked call ${a.tool} (inbox ${a.id}). It did not run; do not try to do the same thing another way.`,
    expired: `The parked call ${a.tool} (inbox ${a.id}) expired without a decision. It did not run.`,
    approved: `A person approved the parked call ${a.tool} (inbox ${a.id}).`,
    pending: `The call ${a.tool} is waiting in the inbox (${a.id}).`,
  }[a.status];
  return [head, a.outcome && a.outcome !== head ? a.outcome : '', a.newPreview ? `New preview:\n${a.newPreview}` : ''].filter(Boolean).join('\n\n');
}

/**
 * Into the session the call came from (a follow-up in its queue, read on its
 * next turn — the watcher path), and always to the tray: a session that is
 * not open in this process still leaves the result on the record.
 */
function deliver(a: PendingAction): void {
  const message = outcomeMessage(a);
  if (a.sessionId) {
    try { wakeDelivery()?.followup(a.sessionId, `[Inbox] ${message}`); } catch { /* best effort: the record and the tray below still carry it */ }
  }
  pushNotification({
    title: `${a.tool}: ${a.status}`,
    body: message.slice(0, 400),
    level: a.status === 'executed' ? 'success' : a.status === 'denied' || a.status === 'expired' ? 'info' : 'warning',
    sourceId: `inbox:${a.id}`,
  });
}

/** Tests: forget in-flight approvals. The store itself lives under AICO_HOME. */
export function resetInboxForTest(): void {
  inFlight.clear();
}
