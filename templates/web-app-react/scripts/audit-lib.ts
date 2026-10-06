/**
 * The decision half of `npm run audit`: which advisories fail the build.
 *
 * Why it is separate from the runner: the policy ("high and critical fail, an
 * allow-list entry needs a reason and an expiry") is what a reviewer must be
 * able to trust, so it is a pure function with tests; `audit.ts` only runs npm
 * and prints.
 *
 * Policy:
 *  - an advisory of severity high or critical fails the audit, in runtime and
 *    dev dependencies alike (build tooling is part of the supply chain);
 *  - an advisory can be allow-listed in `.audit-allowlist.json` with a reason
 *    and an expiry date; an expired entry stops suppressing it and is reported;
 *  - the audit never passes because it could not run (no network): the runner
 *    exits with a distinct status instead.
 */

export interface Advisory {
  id: string;
  severity: string;
  package: string;
  title: string;
  url: string;
}

export interface AllowEntry {
  id: string;
  reason: string;
  /** YYYY-MM-DD, inclusive. */
  expires: string;
}

export interface Verdict {
  failing: Advisory[];
  allowed: Advisory[];
  expired: AllowEntry[];
  invalid: string[];
}

const BLOCKING = new Set(['high', 'critical']);

interface NpmAuditReport {
  vulnerabilities?: Record<string, { name?: string; via?: unknown[] }>;
}

/** The advisories in `npm audit --json` output (format version 2), once each. */
export function advisoriesOf(report: unknown): Advisory[] {
  const vulnerabilities = (report as NpmAuditReport | null)?.vulnerabilities ?? {};
  const seen = new Map<string, Advisory>();
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (!via || typeof via !== 'object') continue;
      const entry = via as Record<string, unknown>;
      const url = typeof entry.url === 'string' ? entry.url : '';
      const id = url.split('/').at(-1) || String(entry.source ?? 'unknown');
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        severity: typeof entry.severity === 'string' ? entry.severity : 'unknown',
        package: typeof entry.name === 'string' ? entry.name : name,
        title: typeof entry.title === 'string' ? entry.title : '',
        url,
      });
    }
  }
  return [...seen.values()];
}

export function parseAllowList(raw: unknown): { entries: AllowEntry[]; invalid: string[] } {
  const entries: AllowEntry[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(raw)) return { entries, invalid: ['the allow-list must be a JSON array'] };
  for (const [i, item] of raw.entries()) {
    const e = item as Partial<AllowEntry> | null;
    if (
      !e ||
      typeof e.id !== 'string' ||
      !e.id ||
      typeof e.reason !== 'string' ||
      e.reason.trim().length < 10 ||
      typeof e.expires !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)
    ) {
      invalid.push(
        `entry ${i}: needs an id, a reason of at least 10 characters and an expires date (YYYY-MM-DD)`,
      );
      continue;
    }
    entries.push({ id: e.id, reason: e.reason, expires: e.expires });
  }
  return { entries, invalid };
}

/** `today` is YYYY-MM-DD in UTC; passed in so tests do not depend on the clock. */
export function evaluate(advisories: Advisory[], allow: AllowEntry[], today: string): Verdict {
  const live = new Map(allow.filter((e) => e.expires >= today).map((e) => [e.id, e]));
  const expired = allow.filter((e) => e.expires < today);
  const failing: Advisory[] = [];
  const allowed: Advisory[] = [];
  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity)) continue;
    (live.has(advisory.id) ? allowed : failing).push(advisory);
  }
  return { failing, allowed, expired, invalid: [] };
}
