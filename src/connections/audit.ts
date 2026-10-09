/**
 * Recording what a connection did, in the audit log (ADR 0039 section 6, ADR 0035).
 *
 * Every remote write, push, PR open/merge, sync and policy denial is a line in
 * `audit/events.jsonl` with the connection, the operation, the target as host and path
 * WITHOUT its query string, the item or PR id and the outcome. The record type has no
 * field for a body, a title, a comment or a token, so none can leak by mistake; the
 * target is also reduced here (query and fragment dropped, userinfo dropped) because a
 * URL carrying an access token in its query is exactly the accident this guards.
 *
 * Best effort and silent on failure, like the rest of the audit log.
 *
 * @module connections/audit
 */

import { appendOwnAuditEvent, type ConnectionAuditEvent } from '../audit/log.js';
import { sinkRedactText } from '../vault/sink.js';

/** `https://api.github.com/repos/o/r/pulls?per_page=100` becomes `api.github.com/repos/o/r/pulls`. */
export function auditTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.slice(0, 200);
  } catch {
    return url.split(/[?#]/)[0]!.replace(/^[a-z]+:\/\/[^@/]*@/i, '').slice(0, 200);
  }
}

export interface ConnectionAuditInput {
  action: string;
  connection: string;
  provider: string;
  target?: string;
  ref?: string;
  outcome?: 'ok' | 'error' | 'denied';
  detail?: string;
  project?: string;
}

export function auditConnection(i: ConnectionAuditInput): void {
  const event: ConnectionAuditEvent = {
    at: Date.now(), kind: 'connection', action: i.action, connection: i.connection, provider: i.provider,
    outcome: i.outcome ?? 'ok',
    ...(i.target ? { target: auditTarget(i.target) } : {}),
    ...(i.ref ? { ref: sinkRedactText(i.ref).slice(0, 120) } : {}),
    ...(i.detail ? { detail: sinkRedactText(i.detail).slice(0, 200) } : {}),
    ...(i.project ? { project: i.project } : {}),
  };
  appendOwnAuditEvent(event);
}
