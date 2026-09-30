/**
 * The vault's audit trail: who used which credential, for what, and whether
 * it was allowed.
 *
 * Append-only JSONL beside the vault. Each entry is built from a fixed set of
 * fields — never from a record or a request body — so there is no path by
 * which a secret field can be copied in by accident. Free-text fields
 * (purpose, target, reason) are length-bounded and passed through the active
 * redactor anyway, because a purpose is written by the model and the model
 * may quote something it should not have.
 *
 * Integrity is not claimed: a same-user process can edit this file. It is a
 * record for the owner, not evidence against an attacker.
 *
 * @module vault/audit
 */

import fs from 'node:fs';
import path from 'node:path';
import { sinkRedactText } from './sink.js';

export type AuditAction =
  | 'use' | 'create' | 'reveal' | 'update' | 'delete' | 'policy-change' | 'rotate'
  | 'request' | 'quarantine' | 'lock' | 'unlock' | 'export' | 'import' | 'grant';

export type AuditOutcome = 'ok' | 'denied' | 'declined' | 'error' | 'timeout';

export interface AuditEntry {
  at: number;
  action: AuditAction;
  outcome: AuditOutcome;
  credentialId?: string;
  name?: string;
  tool?: string;
  target?: string;
  purpose?: string;
  sessionId?: string;
  actor?: string;
  reason?: string;
}

const MAX_FIELD = 300;

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return sinkRedactText(String(value)).replace(/[\r\n]+/g, ' ').slice(0, MAX_FIELD);
}

export class AuditLog {
  constructor(private readonly file: string) {}

  get path(): string { return this.file; }

  /** Append one entry. Failure to audit is swallowed: it must not break the use it records. */
  append(entry: Omit<AuditEntry, 'at'> & { at?: number }): void {
    const line: AuditEntry = {
      at: entry.at ?? Date.now(),
      action: entry.action,
      outcome: entry.outcome,
      ...(entry.credentialId ? { credentialId: entry.credentialId } : {}),
      ...(entry.name ? { name: clean(entry.name)! } : {}),
      ...(entry.tool ? { tool: clean(entry.tool)! } : {}),
      ...(entry.target ? { target: clean(entry.target)! } : {}),
      ...(entry.purpose ? { purpose: clean(entry.purpose)! } : {}),
      ...(entry.sessionId ? { sessionId: clean(entry.sessionId)! } : {}),
      ...(entry.actor ? { actor: clean(entry.actor)! } : {}),
      ...(entry.reason ? { reason: clean(entry.reason)! } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* see above */ }
  }

  /** Most recent first. */
  read(filter: { credentialId?: string; name?: string; limit?: number } = {}): AuditEntry[] {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out: AuditEntry[] = [];
    const lines = text.split('\n');
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 5000);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (filter.credentialId && e.credentialId !== filter.credentialId) continue;
        if (filter.name && e.name !== filter.name) continue;
        out.push(e);
      } catch { /* a torn last line from a crash */ }
    }
    return out;
  }
}
