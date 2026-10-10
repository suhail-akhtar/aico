/**
 * What this engine remembers about the organisation it is enrolled with
 * (AICO Control, ADR 0040) — and the one synchronous read the policy layer needs.
 *
 * `managedPolicy()` runs on every tool call and must not wait on a network or a
 * vault, so the engine keeps the last policy it was served in a small JSON
 * file (`<AICO_HOME>/control/state.json`, mode 0600) and reads that. The
 * tokens are NOT in it: they live in the credential vault (`client.ts`), so
 * this file holds nothing that can be replayed against the server — only the
 * organisation's name, the person's email and role, and the policy layers.
 *
 * Offline grace: the policy keeps applying while the server is unreachable.
 * Once `graceHours` pass without a successful contact, a deny layer is added
 * (model calls refused until it reconnects). `0` disables the limit. That is a
 * *restriction* the organisation asked for in its own settings, so it fits the
 * deny-only rule; the alternative — keep running unmanaged for ever once the
 * network is cut — would make the control layer trivially removable.
 *
 * Deliberately not here: any network call, any vault access, any import of the
 * policy modules (`policy/managed.ts` imports THIS file; the cycle is avoided
 * by returning plain documents that managed.ts validates itself).
 *
 * @module control/state
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';

export interface ControlLayerDoc { scope: string; scopeId?: string; name: string; policy: Record<string, unknown> }

export interface ControlState {
  /** Server base URL, no trailing slash. */
  url: string;
  tenant: { slug: string; name: string };
  user: { email: string; name?: string };
  role: string;
  team?: string;
  deviceId: string;
  /** Vault credential holding the access and refresh tokens. */
  credential: string;
  enrolledAt: number;
  /** The last policy served. Absent until the first fetch succeeds. */
  policy?: {
    layers: ControlLayerDoc[];
    hash: string;
    issuedAt: string;
    graceHours: number;
    pollSeconds: number;
    lease?: { blocked: boolean; reason?: string; resetsAt?: string; limits: Array<{ scope: string; period: string; limitUsd: number; spentUsd: number }> };
  };
  /** Last time the server answered (any endpoint). Grace is counted from here. */
  lastContactAt?: number;
  lastSyncAt?: number;
  lastError?: string;
  /** `auditSince`: newest record time (ms) already uploaded; `idsAtCursor`: the uploaded records with exactly that time. */
  cursors: { auditSince: number; idsAtCursor?: string[] };
}

export function controlDir(): string { return path.join(aicoHome(), 'control'); }
export function controlStatePath(): string { return path.join(controlDir(), 'state.json'); }

let memo: { stamp: string; value: ControlState | undefined } | undefined;

function stampOf(file: string): string {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
}

export function readControlState(): ControlState | undefined {
  const file = controlStatePath();
  const stamp = `${file}|${stampOf(file)}`;
  if (memo && memo.stamp === stamp) return memo.value;
  let value: ControlState | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ControlState;
    if (parsed && typeof parsed.url === 'string' && typeof parsed.deviceId === 'string' && parsed.cursors) value = parsed;
  } catch { /* absent or unreadable: not enrolled */ }
  memo = { stamp, value };
  return value;
}

export function writeControlState(state: ControlState): void {
  const file = controlStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  memo = undefined;
}

export function clearControlState(): void {
  try { fs.rmSync(controlStatePath(), { force: true }); } catch { /* best effort */ }
  memo = undefined;
}

export function resetControlStateCache(): void { memo = undefined; }

// ── the view the policy module consumes ─────────────────────────────

export interface ControlSnapshot {
  url: string;
  org: string;
  user: string;
  role: string;
  team?: string;
  docs: ControlLayerDoc[];
  /** Short hash of the served layers (and the grace state); changes when either does. */
  hash: string;
  graceExpired: boolean;
  lastContactAt?: number;
}

const HOUR = 3_600_000;

/** Whether the last contact is older than the organisation's offline allowance. */
export function graceExpired(s: ControlState, now = Date.now()): boolean {
  const hours = s.policy?.graceHours ?? 0;
  if (!hours) return false;
  const last = s.lastContactAt ?? s.enrolledAt;
  return now - last > hours * HOUR;
}

/**
 * The organisation's layers for `managedPolicy()`, or undefined when this
 * engine is not enrolled. When the offline allowance has run out, one more
 * deny layer is appended. Synchronous and cheap (one `stat` per call).
 */
export function controlSnapshot(now = Date.now()): ControlSnapshot | undefined {
  const s = readControlState();
  if (!s) return undefined;
  const docs: ControlLayerDoc[] = [...(s.policy?.layers ?? [])];
  const expired = graceExpired(s, now);
  if (expired) {
    docs.push({
      scope: 'lease', name: 'Offline allowance used up',
      policy: { allowedModels: [], allowedProviders: [], message: `AICO could not reach ${s.tenant.name} for more than ${s.policy?.graceHours} hours. Connect to the network to continue.` },
    });
  }
  return {
    url: s.url, org: s.tenant.name, user: s.user.email, role: s.role, ...(s.team ? { team: s.team } : {}), docs,
    hash: crypto.createHash('sha256').update(`${s.policy?.hash ?? ''}|${expired ? 'expired' : 'ok'}|${s.tenant.slug}`).digest('hex').slice(0, 16),
    graceExpired: expired, ...(s.lastContactAt ? { lastContactAt: s.lastContactAt } : {}),
  };
}

/** A string that changes when the snapshot could: for the policy cache's staleness check. */
export function controlStamp(now = Date.now()): string {
  const s = readControlState();
  return s ? `${stampOf(controlStatePath())}:${graceExpired(s, now) ? 1 : 0}` : '-';
}
