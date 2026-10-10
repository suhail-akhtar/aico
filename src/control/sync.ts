/**
 * Keeping the engine and the organisation server in step (ADR 0040): pull the
 * policy, push audit and usage in batches.
 *
 * Properties that matter, and the failure each answers:
 *  - **The last good policy keeps applying when the server is away.** A sync
 *    that fails changes nothing except `lastError`; the offline allowance
 *    (state.ts) is what eventually restricts. A network blip must never turn
 *    the organisation's rules off, or a developer's laptop on a train would be
 *    the way around them.
 *  - **Pushes are at-least-once and the server de-duplicates by record id**, so a
 *    retry after a timeout cannot double count spend or duplicate audit. The
 *    cursor advances only after the server accepted the batch.
 *  - **Retries are bounded and polite.** Network errors, 429 and 5xx are
 *    retried with backoff (honouring Retry-After); anything else is reported,
 *    not hammered. The background loop is jittered so a fleet restarted at 9am
 *    does not hit the server in the same second.
 *  - **Nothing here widens anything.** The result of a sync is a new set of
 *    restrict-only layers (or none).
 *
 * What is sent is the `aico.audit/1` stream the audit export already builds
 * (redacted, no prompts, no file bodies, no tool results — ADR 0035) and the
 * token/cost facts of finished turns. Nothing else leaves the machine.
 *
 * Deliberately not here: enrolment (client.ts), the schedule of a CLI run.
 *
 * @module control/sync
 */

import { collectAudit, type AuditRecord } from '../audit/export.js';
import { managedPolicy, resetManagedPolicyCache } from '../policy/managed.js';
import { recordPolicyLoad } from '../audit/log.js';
import { ControlError, authedCall } from './client.js';
import { readControlState, writeControlState, type ControlLayerDoc, type ControlState } from './state.js';

const BATCH = 500;
const MAX_BATCHES_PER_SYNC = 6;

export interface SyncResult {
  ok: boolean;
  skipped?: 'not-enrolled';
  policyChanged?: boolean;
  auditPushed: number;
  usagePushed: number;
  /** The server revoked this device during the sync; the engine is now unmanaged. */
  revoked?: boolean;
  error?: string;
}

export interface SyncOptions {
  /** Skip the audit and usage push (policy only). */
  pull?: boolean;
  /** Injectable for tests so backoff does not take real seconds. */
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function retrying<T>(fn: () => Promise<T>, o: SyncOptions): Promise<T> {
  const tries = o.retries ?? 3;
  const sleep = o.sleep ?? realSleep;
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const retryable = e instanceof ControlError && (e.code === 'network' || e.code === 'unavailable');
      if (!retryable || i >= tries - 1) throw e;
      await sleep(Math.min((e as ControlError).retryAfterMs ?? 500 * 2 ** i, 30_000));
    }
  }
}

function patchState(mutate: (s: ControlState) => ControlState): void {
  const s = readControlState();
  if (s) writeControlState(mutate(s));
}

/** The shape the server serves, reduced to what the engine keeps. */
function policyFrom(data: Record<string, unknown>): NonNullable<ControlState['policy']> | undefined {
  if (data.schema !== 'aico.control.policy/1' || !Array.isArray(data.layers)) return undefined;
  const layers: ControlLayerDoc[] = [];
  for (const l of data.layers as Array<Record<string, unknown>>) {
    if (l && typeof l === 'object' && l.policy && typeof l.policy === 'object') {
      layers.push({ scope: String(l.scope ?? 'policy'), ...(l.scopeId ? { scopeId: String(l.scopeId) } : {}), name: String(l.name ?? l.scope ?? 'policy').slice(0, 100), policy: l.policy as Record<string, unknown> });
    }
  }
  return {
    layers, hash: String(data.hash ?? ''), issuedAt: String(data.issuedAt ?? ''), graceHours: Number(data.graceHours) || 0, pollSeconds: Math.max(30, Number(data.pollSeconds) || 300),
    ...(data.lease && typeof data.lease === 'object' ? { lease: data.lease as NonNullable<ControlState['policy']>['lease'] } : {}),
  };
}

export async function pullPolicy(o: SyncOptions = {}): Promise<{ changed: boolean }> {
  const r = await retrying(() => authedCall('/v1/engine/policy'), o);
  if (r.status !== 200) throw new ControlError(String(r.data.message ?? `The server answered ${r.status}.`), 'refused', r.status);
  const policy = policyFrom(r.data);
  if (!policy) throw new ControlError('The server sent a policy this AICO does not understand. Update AICO.', 'bad-reply');
  let changed = false;
  patchState(s => {
    changed = s.policy?.hash !== policy.hash;
    const team = (r.data.team as { name?: string } | undefined)?.name;
    const { team: _oldTeam, ...rest } = s;
    void _oldTeam;
    return { ...rest, ...(team ? { team } : {}), role: String(r.data.role ?? s.role), policy, lastContactAt: Date.now(), lastSyncAt: Date.now() };
  });
  resetManagedPolicyCache();
  recordPolicyLoad(managedPolicy());
  return { changed };
}

function usageEvents(records: readonly AuditRecord[]): Array<Record<string, unknown>> {
  return records.filter(r => r.kind === 'turn.end').map(r => ({
    id: r.id, at: r.time, model: r.model ?? '', inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, costUsd: r.costUsd ?? 0,
    ...(r.project ? { project: r.project } : {}),
  }));
}

export async function pushNew(o: SyncOptions = {}): Promise<{ audit: number; usage: number }> {
  let audit = 0;
  let usage = 0;
  for (let b = 0; b < MAX_BATCHES_PER_SYNC; b++) {
    const state = readControlState();
    if (!state) break;
    const seen = new Set(state.cursors.idsAtCursor ?? []);
    const since = state.cursors.auditSince;
    // The sign-in's own vault traffic (create/use of the `control-*` credential happens on every sync) is not
    // reported: it would make every sync produce records that the next sync has to upload.
    const fresh = (await collectAudit({ since }))
      .filter(r => !(seen.has(r.id) && Date.parse(r.time) === since))
      .filter(r => !(r.kind === 'credential' && r.credential?.startsWith('control-')));
    if (!fresh.length) break;
    const batch = fresh.slice(0, BATCH);
    const a = await retrying(() => authedCall('/v1/engine/audit', { method: 'POST', body: { records: batch } }), o);
    if (a.status !== 200) throw new ControlError(String(a.data.message ?? `Audit upload refused (${a.status}).`), 'refused', a.status);
    const events = usageEvents(batch);
    if (events.length) {
      const u = await retrying(() => authedCall('/v1/engine/usage', { method: 'POST', body: { events } }), o);
      if (u.status !== 200) throw new ControlError(String(u.data.message ?? `Usage upload refused (${u.status}).`), 'refused', u.status);
      usage += events.length;
    }
    audit += batch.length;
    // The cursor is a time plus the ids already sent at that exact millisecond, so an idle sync sends nothing
    // and records sharing a millisecond are neither lost nor re-sent.
    const times = batch.map(r => Date.parse(r.time)).filter(Number.isFinite);
    const lastMs = times.length ? Math.max(...times, since) : since;
    const atLast = batch.filter(r => Date.parse(r.time) === lastMs).map(r => r.id);
    patchState(s => ({ ...s, cursors: { auditSince: lastMs, idsAtCursor: lastMs === since ? [...seen, ...atLast] : atLast }, lastContactAt: Date.now() }));
    if (fresh.length <= BATCH) break;
  }
  return { audit, usage };
}

export async function syncOnce(o: SyncOptions = {}): Promise<SyncResult> {
  if (!readControlState()) return { ok: true, skipped: 'not-enrolled', auditPushed: 0, usagePushed: 0 };
  try {
    const { changed } = await pullPolicy(o);
    const pushed = o.pull ? { audit: 0, usage: 0 } : await pushNew(o);
    // Pushing may have learned that spend crossed a limit; one more cheap pull makes the block take effect now.
    const again = pushed.usage > 0 ? await pullPolicy(o) : { changed: false };
    patchState(s => { const { lastError: _e, ...rest } = s; void _e; return rest; });
    return { ok: true, policyChanged: changed || again.changed, auditPushed: pushed.audit, usagePushed: pushed.usage };
  } catch (e) {
    const err = e instanceof ControlError ? e : new ControlError(e instanceof Error ? e.message : 'sync failed', 'unknown');
    if (err.code !== 'revoked') patchState(s => ({ ...s, lastError: err.message.slice(0, 300) }));
    resetManagedPolicyCache();
    return { ok: false, auditPushed: 0, usagePushed: 0, error: err.message, ...(err.code === 'revoked' ? { revoked: true } : {}) };
  }
}

// ── the background loop ─────────────────────────────────────────────

/**
 * Start syncing in the background (the engine server calls this once). Returns
 * a stop function. It does nothing while the engine is not enrolled and
 * notices an enrolment made later by `aico control login`.
 */
export function startControlSync(o: { initialDelayMs?: number } = {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const next = (): number => {
    const base = (readControlState()?.policy?.pollSeconds ?? 300) * 1000;
    return base * (0.85 + Math.random() * 0.3);
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try { await syncOnce(); } catch { /* syncOnce reports instead of throwing */ }
    if (!stopped) { timer = setTimeout(() => void tick(), next()); timer.unref?.(); }
  };
  timer = setTimeout(() => void tick(), o.initialDelayMs ?? 4000);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
