/**
 * Who and where an audit record came from, as the organisation wants it said.
 *
 * AICO has no accounts. The only identities it can truthfully report are the
 * operating-system user and the machine, so that is what the export carries:
 * the OS username (or a hash of it, or nothing) and a host identifier that is
 * a hash of the hostname by default — a SIEM can correlate on it without the
 * file revealing the machine's name to whoever reads the export.
 *
 * The *policy* decides (`audit.user`, `audit.host`, `audit.tenant` in the
 * managed policy), because identity belongs to IT and not to the person being
 * audited. Without a policy the CLI flags choose; with one, the flags are
 * ignored. This is a label for correlation, not authentication: nothing here
 * proves who was at the keyboard (ADR 0035 — SSO/SCIM are not built).
 *
 * @module audit/identity
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { managedPolicy, type LoadedPolicy } from '../policy/managed.js';

export interface AuditIdentity { user?: string; host?: string; tenant?: string }

const hash = (kind: string, value: string): string =>
  crypto.createHash('sha256').update(`aico-${kind}:${value}`).digest('hex').slice(0, 16);

function osUser(): string {
  try { return os.userInfo().username; } catch { return process.env.USERNAME || process.env.USER || 'unknown'; }
}

/**
 * `overrides` are the CLI's `--user` / `--host` values; they apply only when no
 * policy states how identity is reported.
 */
export function resolveIdentity(
  overrides: { user?: string; host?: string } = {},
  lp: LoadedPolicy = managedPolicy(),
): AuditIdentity {
  const set = lp.layers.map(l => l.policy.audit).find((a): a is NonNullable<typeof a> => Boolean(a));
  const out: AuditIdentity = {};

  const userMode = set?.user ?? (overrides.user ? undefined : 'username');
  if (set?.user === undefined && overrides.user) out.user = overrides.user.slice(0, 100);
  else if (userMode === 'username') out.user = osUser();
  else if (userMode === 'hash') out.user = hash('user', osUser());

  const hostMode = set?.host ?? (overrides.host ? undefined : 'hash');
  if (set?.host === undefined && overrides.host) out.host = overrides.host.slice(0, 100);
  else if (hostMode === 'hostname') out.host = os.hostname();
  else if (hostMode === 'hash') out.host = hash('host', os.hostname());

  if (set?.tenant) out.tenant = set.tenant;
  return out;
}
