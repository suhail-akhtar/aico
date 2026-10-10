/**
 * AICO's own audit events: the few facts that had no durable record anywhere.
 *
 * A session log says what a model did; the vault's trail says which credential
 * was used; the inbox says who answered a parked call. Nothing recorded
 * *settings changing* or *the managed policy appearing, changing or
 * disappearing* — and those are the first things an auditor asks about. They
 * go here, append-only, in `aicoHome()/audit/events.jsonl`.
 *
 * What is recorded: a settings **key path** and what happened to it (set,
 * unset), plus a short hash of the new value so "changed to the same value"
 * and "changed" can be told apart — never the value. For the credential roots
 * (`providers`, `env`, …) not even the hash. A policy event carries the file
 * hash, its path, and how many problems it had.
 *
 * Best effort and silent on failure, like `vault/audit.ts`: losing an audit
 * line must not break the settings write it describes. Integrity is not
 * claimed — a same-user process can edit the file; ship the export off the
 * machine (ADR 0035).
 *
 * @module audit/log
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';
import type { LoadedPolicy } from '../policy/managed.js';

export type OwnAuditEvent =
  | { at: number; kind: 'settings.change'; action: 'set' | 'unset'; key: string; valueHash?: string }
  | ConnectionAuditEvent
  | DeliveryAuditEvent
  | { at: number; kind: 'policy.load'; active: boolean; hash: string; paths: string[]; problems: number; lockdown: boolean; weak: boolean };

/**
 * A connection event (ADR 0039): which connection, which operation, against which host and path
 * WITHOUT a query, the item or PR id, the outcome. Never a body, a title, a comment or a token.
 */
export interface ConnectionAuditEvent {
  at: number;
  kind: 'connection';
  /** create, test, map, use, write, push, pr.open, pr.merge, sync, policy.deny, credential, remove. */
  action: string;
  connection: string;
  provider: string;
  /** Host + path, no query string. */
  target?: string;
  /** Item or PR id, branch name. */
  ref?: string;
  outcome: 'ok' | 'error' | 'denied';
  detail?: string;
  project?: string;
}

/**
 * A Delivery board decision (ADR 0038, "Autonomy levels"): the board changed what it may do on its own,
 * or it acted without a person. Records who or what decided and why (the level, the risk and the
 * evidence line), never a task's body or a diff. `project` is the board's folder.
 */
export interface DeliveryAuditEvent {
  at: number;
  kind: 'delivery';
  /** autonomy.set, auto-land, auto-start, auto-promote, auto-pause, collision.resolve. */
  action: string;
  project: string;
  task?: string;
  autonomy?: string;
  /** Who decided: `person`, or `engine:<level>` for the board's own rule. */
  decidedBy: string;
  outcome: 'ok' | 'error' | 'denied';
  detail?: string;
}

export function auditEventsFile(): string {
  return path.join(aicoHome(), 'audit', 'events.jsonl');
}

/** Settings roots whose values are credentials: only the key path is recorded. */
const CREDENTIAL_ROOTS = new Set(['providers', 'providerInstances', 'env', 'mcpServers', 'hooks']);

export function appendOwnAuditEvent(event: OwnAuditEvent): void {
  try {
    const file = auditEventsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* best effort: an audit line must not break the write it records */ }
}

/** Record a settings write. `dotted` is a key or a dotted path; `value === undefined | null` means removed. */
export function recordSettingsChange(dotted: string, value: unknown): void {
  const root = dotted.split('.')[0] ?? '';
  const removed = value === undefined || value === null;
  const credential = CREDENTIAL_ROOTS.has(root);
  let valueHash: string | undefined;
  if (!removed && !credential) {
    try { valueHash = crypto.createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex').slice(0, 12); } catch { /* unhashable: omit */ }
  }
  appendOwnAuditEvent({
    at: Date.now(), kind: 'settings.change', action: removed ? 'unset' : 'set', key: dotted.slice(0, 200),
    ...(valueHash ? { valueHash } : {}),
  });
}

/** Every own event, oldest first. */
export function readOwnAuditEvents(): OwnAuditEvent[] {
  let body = '';
  try { body = fs.readFileSync(auditEventsFile(), 'utf8'); } catch { return []; }
  const out: OwnAuditEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as OwnAuditEvent); } catch { /* a torn last line */ }
  }
  return out;
}

let lastPolicyHash: string | undefined;

/**
 * Note the policy in force when it differs from the last one recorded —
 * including its disappearance, which is the event that matters most. Once per
 * process per change; the first call reads the last recorded hash from disk.
 */
export function recordPolicyLoad(lp: LoadedPolicy): void {
  try {
    if (lastPolicyHash === undefined) {
      const last = [...readOwnAuditEvents()].reverse().find(e => e.kind === 'policy.load');
      lastPolicyHash = last && last.kind === 'policy.load' ? last.hash : '';
    }
    if (lp.hash === lastPolicyHash) return;
    lastPolicyHash = lp.hash;
    appendOwnAuditEvent({
      at: Date.now(), kind: 'policy.load', active: lp.active, hash: lp.hash,
      paths: lp.sources.filter(s => s.exists).map(s => s.path), problems: lp.problems.length,
      lockdown: lp.lockdown, weak: lp.sources.some(s => Boolean(s.weakness)),
    });
  } catch { /* best effort */ }
}

/** Tests: forget what this process last recorded. */
export function resetAuditLogMemory(): void { lastPolicyHash = undefined; }
