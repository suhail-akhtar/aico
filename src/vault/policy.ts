/**
 * Whether a credential may be used here, by this, now — and whether a human
 * has to say yes first.
 *
 * Scope is the main protection, approval the second. A credential bound to
 * `ssh://10.0.0.5` can be resolved by a trusted SSH tool connecting to
 * 10.0.0.5 and by nothing else, however the model phrases the request —
 * because the consumer declares the target and the consumer is trusted code,
 * not the model. Approval covers what scope cannot: a shell command's target
 * is whatever the command says, so shell use is every-use unless the owner
 * explicitly chose otherwise.
 *
 * Self-hosted servers are the common case this has to be friendly to: plain
 * http on a LAN address and self-signed certificates. Both are allowed, but
 * only when written down — http must appear as an explicit `http://` origin
 * (or the credential is bound by host to a private address), and a
 * self-signed certificate is accepted only where `allowSelfSigned` is set.
 * Neither is ever inferred.
 *
 * Session grants, the rate limiter and expiry live in memory. A restart
 * forgets session approvals, which is the safe direction to forget in.
 *
 * @module vault/policy
 */

import net from 'node:net';
import type { ApprovalMode, CredentialMeta, Policy, UseContext } from './types.js';

/** Tools whose target is whatever the command says. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Terminal', 'shell']);

// ── hosts ────────────────────────────────────────────────────────────

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (!base || !Number.isInteger(bits)) return false;
  if (net.isIPv4(ip) && net.isIPv4(base)) {
    if (bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
  }
  if (net.isIPv6(ip) && net.isIPv6(base)) {
    const expand = (a: string): bigint => {
      const [head, tail = ''] = a.split('::');
      const h = head ? head.split(':') : [];
      const t = tail ? tail.split(':') : [];
      const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
      return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
    };
    if (bits < 0 || bits > 128) return false;
    const shift = BigInt(128 - bits);
    return (expand(ip) >> shift) === (expand(base) >> shift);
  }
  return false;
}

/**
 * Loopback, RFC 1918, link-local, unique-local, and the names that are local
 * by convention. Used only to decide whether plain http needs an extra opt-in.
 */
export function isPrivateHost(rawHost: string): boolean {
  const host = normalizeHost(rawHost);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan')
    || host.endsWith('.home.arpa') || host.endsWith('.internal')) return true;
  if (net.isIPv4(host)) {
    return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10']
      .some(c => inCidr(host, c));
  }
  if (net.isIPv6(host)) return host === '::1' || inCidr(host, 'fc00::/7') || inCidr(host, 'fe80::/10');
  return false;
}

/** Split `host[:port]`, understanding `[v6]:port`. */
function splitHostPort(value: string): { host: string; port?: number } {
  const v = value.trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(v);
  if (v6) return { host: v6[1]!.toLowerCase(), ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  if (net.isIPv6(v)) return { host: v.toLowerCase() };
  const m = /^(.*?)(?::(\d+))?$/.exec(v)!;
  return { host: normalizeHost(m[1]!), ...(m[2] ? { port: Number(m[2]) } : {}) };
}

/**
 * Does a host pattern admit this host (and port)?
 *
 * `*` any host; `*.example.com` any subdomain (not the apex — write both if
 * both are meant); `10.0.0.0/24` a CIDR range; anything else exact,
 * case-insensitive. A `:port` on the pattern must match the use's port.
 */
export function hostMatches(pattern: string, rawHost: string, port?: number): boolean {
  const p = splitHostPort(pattern);
  const host = normalizeHost(rawHost);
  if (p.port !== undefined && p.port !== port) return false;
  if (p.host === '*') return true;
  if (p.host.includes('/')) return inCidr(host, p.host);
  if (p.host.startsWith('*.')) {
    const suffix = p.host.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length && !net.isIP(host);
  }
  return p.host === host;
}

// ── origins ──────────────────────────────────────────────────────────

export interface ParsedOrigin { scheme: string; host: string; port: number }

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ssh: 22, ftp: 21, winrm: 5985, ldap: 389, ldaps: 636 };

/** Parse `scheme://host[:port][/…]`. Userinfo is refused: it is how look-alike origins are built. */
export function parseOrigin(value: string): ParsedOrigin | undefined {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(value.trim());
  if (!m) return undefined;
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  if (authority.includes('@')) return undefined;
  const hp = splitHostPort(authority);
  if (!hp.host) return undefined;
  const port = hp.port ?? DEFAULT_PORTS[scheme];
  if (port === undefined) return undefined;
  return { scheme, host: hp.host, port };
}

/** Does an origin pattern admit this origin? Scheme and port must match exactly; host may be a glob. */
export function originMatches(pattern: string, origin: string): boolean {
  const p = parseOrigin(pattern.replace('://*.', '://wildcard-placeholder.'));
  const o = parseOrigin(origin);
  if (!p || !o) return false;
  if (p.scheme !== o.scheme || p.port !== o.port) return false;
  const hostPattern = p.host.startsWith('wildcard-placeholder.') ? `*.${p.host.slice('wildcard-placeholder.'.length)}` : p.host;
  return hostMatches(hostPattern, o.host);
}

/** The hosts and origins a credential is bound to, including those implied by its own host/url. */
export function effectiveScope(meta: Pick<CredentialMeta, 'host' | 'url' | 'port'>, policy: Policy): { hosts: string[]; origins: string[] } {
  const hosts = [...policy.allowedHosts];
  const origins = [...policy.allowedOrigins];
  if (!hosts.length && !origins.length) {
    if (meta.host) hosts.push(meta.port ? `${meta.host}:${meta.port}` : meta.host);
    if (meta.url) {
      const o = parseOrigin(meta.url);
      if (o) {
        if (o.scheme === 'http' || o.scheme === 'https') origins.push(`${o.scheme}://${o.host.includes(':') ? `[${o.host}]` : o.host}:${o.port}`);
        else hosts.push(o.host);
      }
    }
  }
  return { hosts, origins };
}

// ── session grants and rate ──────────────────────────────────────────

/** "Yes, for this session" answers, in memory only. */
export class SessionGrants {
  private readonly granted = new Set<string>();
  private key(credentialId: string, tool: string, sessionId?: string): string {
    return `${credentialId}\u0000${tool}\u0000${sessionId ?? ''}`;
  }
  has(credentialId: string, tool: string, sessionId?: string): boolean {
    return this.granted.has(this.key(credentialId, tool, sessionId));
  }
  add(credentialId: string, tool: string, sessionId?: string): void {
    this.granted.add(this.key(credentialId, tool, sessionId));
  }
  /** Forget every grant for a credential (policy changed, credential deleted). */
  revoke(credentialId: string): void {
    for (const k of [...this.granted]) if (k.startsWith(`${credentialId}\u0000`)) this.granted.delete(k);
  }
  clear(): void { this.granted.clear(); }
}

/** Sliding-window use counter per credential. */
export class RateTracker {
  private readonly uses = new Map<string, number[]>();
  allows(credentialId: string, policy: Policy, now: number): boolean {
    if (!policy.rateLimit) return true;
    const window = policy.rateLimit.perSeconds * 1000;
    const recent = (this.uses.get(credentialId) ?? []).filter(t => now - t < window);
    this.uses.set(credentialId, recent);
    return recent.length < policy.rateLimit.max;
  }
  record(credentialId: string, now: number): void {
    const list = this.uses.get(credentialId) ?? [];
    list.push(now);
    this.uses.set(credentialId, list);
  }
}

// ── the decision ─────────────────────────────────────────────────────

export type UseDecision =
  | { allowed: false; reason: string }
  | { allowed: true; needsApproval: boolean; mode: ApprovalMode; description: string; target?: string };

function describeTarget(use: UseContext): string | undefined {
  return use.origin ?? use.host;
}

/** One line a human can say yes or no to. */
export function describeUse(meta: Pick<CredentialMeta, 'name' | 'kind' | 'username'>, use: UseContext): string {
  const target = describeTarget(use);
  return `${use.tool} wants to use the credential "${meta.name}" (${meta.kind}${meta.username ? `, user ${meta.username}` : ''})`
    + `${target ? ` with ${target}` : ''} to: ${use.purpose.slice(0, 500)}`;
}

/**
 * Decide a use. Pure apart from reading the grant and rate state; the caller
 * records the use once it actually happens.
 */
export function evaluateUse(
  meta: CredentialMeta,
  policy: Policy,
  use: UseContext,
  state: { grants: SessionGrants; rate: RateTracker; now: number },
): UseDecision {
  if (policy.expiresAt !== undefined && state.now >= policy.expiresAt) {
    return { allowed: false, reason: `The credential "${meta.name}" expired and can no longer be used.` };
  }
  const shell = SHELL_TOOLS.has(use.tool);
  if (shell && !policy.allowShell) {
    return {
      allowed: false,
      reason: `The credential "${meta.name}" is not allowed in shell commands. Its owner can enable that `
        + '(allowShell) in the Credential Manager; a trusted tool that takes the credential by name is the safer route.',
    };
  }
  if (policy.allowedTools.length && !policy.allowedTools.includes(use.tool)) {
    return { allowed: false, reason: `The credential "${meta.name}" may not be used by ${use.tool}.` };
  }

  const scope = effectiveScope(meta, policy);
  const scoped = scope.hosts.length > 0 || scope.origins.length > 0;
  if (use.origin) {
    const o = parseOrigin(use.origin);
    if (!o) return { allowed: false, reason: `"${use.origin}" is not a valid origin.` };
    const byOrigin = scope.origins.some(p => originMatches(p, use.origin!));
    const byHost = !byOrigin && scope.hosts.some(p => hostMatches(p, o.host, o.port));
    if (scoped && !byOrigin && !byHost) {
      return { allowed: false, reason: `The credential "${meta.name}" is not bound to ${use.origin}.` };
    }
    // Plain http is never implied. An explicit http:// origin pattern admits
    // it on a private address; anything else needs allowInsecureHttp.
    if (o.scheme === 'http' && !policy.allowInsecureHttp && !(byOrigin && isPrivateHost(o.host))
      && !(byHost && isPrivateHost(o.host) && scope.origins.length === 0)) {
      return {
        allowed: false,
        reason: `The credential "${meta.name}" would be sent over plain http to ${o.host}. Allowed only for an `
          + 'explicit http:// origin on a private address, or with allowInsecureHttp.',
      };
    }
  } else if (use.host) {
    const hp = splitHostPort(use.host);
    const ok = scope.hosts.some(p => hostMatches(p, hp.host, hp.port))
      || scope.origins.some(p => { const o = parseOrigin(p); return !!o && hostMatches(o.host.includes(':') ? `[${o.host}]` : o.host, hp.host); });
    if (scoped && !ok) return { allowed: false, reason: `The credential "${meta.name}" is not bound to ${use.host}.` };
  }

  if (!state.rate.allows(meta.id, policy, state.now)) {
    return { allowed: false, reason: `The credential "${meta.name}" hit its rate limit. Try again later.` };
  }

  // A shell command's target is whatever the command says, so a shell use is
  // shown to a human every time unless a human set `shellApproval: auto`.
  // Any other use whose target nothing vouches for — an unscoped credential,
  // a scoped one used with no declared target — is asked about every time
  // unless the owner explicitly chose `auto`.
  const unvouched = !scoped || (!use.host && !use.origin);
  // A consumer that asks for a person (a destructive remote command, an
  // unknown host key) gets one every time; this can only tighten.
  const mode: ApprovalMode = use.requireApproval ? 'every-use' : shell
    ? (policy.shellApproval === 'auto' ? 'auto' : 'every-use')
    : policy.approval === 'session' && unvouched ? 'every-use' : policy.approval;
  const needsApproval = mode === 'every-use' || (mode === 'session' && !state.grants.has(meta.id, use.tool, use.sessionId));
  const target = describeTarget(use);
  return { allowed: true, needsApproval, mode, description: describeUse(meta, use), ...(target ? { target } : {}) };
}

// ── loosening ────────────────────────────────────────────────────────

const APPROVAL_RANK: Record<ApprovalMode, number> = { 'every-use': 0, session: 1, auto: 2 };

/**
 * Whether moving from `before` to `after` widens what the credential can be
 * used for. Any widening needs a human grant; tightening never does. When in
 * doubt this says yes — a spurious confirmation costs a click, a missed one
 * costs the credential.
 */
export function isLoosening(before: Policy, after: Policy): boolean {
  if (APPROVAL_RANK[after.approval] > APPROVAL_RANK[before.approval]) return true;
  if (after.allowShell && !before.allowShell) return true;
  if (after.shellApproval === 'auto' && before.shellApproval !== 'auto') return true;
  if (after.allowInsecureHttp && !before.allowInsecureHttp) return true;
  if (after.allowSelfSigned && !before.allowSelfSigned) return true;
  if (before.expiresAt !== undefined && (after.expiresAt === undefined || after.expiresAt > before.expiresAt)) return true;
  if (before.rateLimit) {
    const a = after.rateLimit;
    if (!a || a.max / a.perSeconds > before.rateLimit.max / before.rateLimit.perSeconds) return true;
  }
  const widens = (b: string[], a: string[]): boolean =>
    (b.length > 0 && a.length === 0) || a.some(x => !b.includes(x));
  if (widens(before.allowedTools, after.allowedTools)) return true;
  if (widens(before.allowedHosts, after.allowedHosts)) return true;
  if (widens(before.allowedOrigins, after.allowedOrigins)) return true;
  return false;
}

/** Validate and normalise a policy from outside. Unknown keys are dropped. */
export function normalizePolicy(input: Partial<Policy> | undefined, base: Policy): Policy {
  const p = input ?? {};
  const list = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim()).slice(0, 64) : fallback;
  const approval = p.approval === 'every-use' || p.approval === 'session' || p.approval === 'auto' ? p.approval : base.approval;
  const rate = p.rateLimit && Number.isFinite(p.rateLimit.max) && Number.isFinite(p.rateLimit.perSeconds)
    && p.rateLimit.max > 0 && p.rateLimit.perSeconds > 0
    ? { max: Math.floor(p.rateLimit.max), perSeconds: Math.floor(p.rateLimit.perSeconds) }
    : ('rateLimit' in p ? undefined : base.rateLimit);
  const expires = typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt) ? p.expiresAt
    : ('expiresAt' in p ? undefined : base.expiresAt);
  return {
    allowedHosts: list(p.allowedHosts, base.allowedHosts),
    allowedOrigins: list(p.allowedOrigins, base.allowedOrigins),
    allowedTools: list(p.allowedTools, base.allowedTools),
    approval,
    allowShell: typeof p.allowShell === 'boolean' ? p.allowShell : base.allowShell,
    ...((p.shellApproval === 'auto' || p.shellApproval === 'every-use' ? p.shellApproval : base.shellApproval) === 'auto'
      ? { shellApproval: 'auto' as const } : {}),
    ...((typeof p.allowInsecureHttp === 'boolean' ? p.allowInsecureHttp : base.allowInsecureHttp) ? { allowInsecureHttp: true } : {}),
    ...((typeof p.allowSelfSigned === 'boolean' ? p.allowSelfSigned : base.allowSelfSigned) ? { allowSelfSigned: true } : {}),
    ...(expires !== undefined ? { expiresAt: expires } : {}),
    ...(rate ? { rateLimit: rate } : {}),
  };
}
