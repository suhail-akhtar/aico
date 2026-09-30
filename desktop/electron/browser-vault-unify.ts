/**
 * One vault: the rules for moving the 0.28.0 browser password store into the
 * engine's credential vault, as pure functions (tested in
 * scripts/test-browser-vault.mjs).
 *
 * Before 0.29 AICO had two vaults — the browser's (`vault.bin`, sealed with
 * safeStorage, walled off from everything) and the engine's (the credential
 * broker). Two stores meant two Credential Managers, two policies for "where
 * may this be filled", and no way for the agent to *use* a login the person
 * saved without also being able to *see* it. Now the browser's logins are
 * engine `login` credentials, and the browser's rules are written into each
 * credential's policy instead of living in browser code:
 *
 *   - exact origin — `allowedOrigins: [origin]`, scheme, host and port;
 *   - only the browser — `allowedTools: ['Browser', 'browser_login']`, so a
 *     web password never reaches an SSH or HTTP tool on the same host;
 *   - asked once per session when the agent uses it (`approval: 'session'`);
 *     a person's own fill is its own approval (vault-host.ts);
 *   - http only where 0.28.0 allowed it (this machine) or the engine allows it
 *     (an explicit http:// origin on a private address) — never inferred.
 *
 * What it deliberately does not do: read or write any file, or talk to the
 * engine. browser-vault.ts does that, and backs the old file up first.
 *
 * @module desktop/electron/browser-vault-unify
 */

export interface LegacyEntry {
  id: string;
  origin: string;
  username: string;
  password: string;
  note?: string;
  created: number;
  updated: number;
}

/** The shape `POST /api/vault/create` takes (src/vault/http.ts). */
export interface CreateBody {
  name: string;
  kind: 'login' | 'note';
  username?: string;
  url: string;
  description: string;
  tags: string[];
  secret: Record<string, string>;
  policy: { allowedOrigins: string[]; allowedTools: string[]; approval: 'session' | 'every-use'; allowShell: false };
  createdBy: 'user';
}

/** The tools a browser login may be used by. */
export const BROWSER_LOGIN_TOOLS = ['Browser', 'browser_login'] as const;

/** Tag every browser login carries, so the Passwords view can filter on it. */
export const BROWSER_TAG = 'browser';
/** Tag of logins that came over from the 0.28.0 store. */
export const MIGRATED_TAG = 'migrated';

/** `https://example.com:8443` for any http(s) URL, else null. */
export function webOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}

/** The policy a person's browser login gets: that origin, the browser only, asked once a session. */
export function loginPolicy(origin: string): CreateBody['policy'] {
  return { allowedOrigins: [origin], allowedTools: [...BROWSER_LOGIN_TOOLS], approval: 'session', allowShell: false };
}

/**
 * A readable, unique credential name for a login: `login-github.com-alice`.
 * Names are `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` (the vault's rule), so dots and
 * @ signs become dashes and long ones are cut; a clash gets `-2`, `-3`…
 */
export function credentialNameFor(origin: string, username: string, taken: ReadonlySet<string>): string {
  let host = origin;
  try { const u = new URL(origin); host = `${u.hostname}${u.port ? `-${u.port}` : ''}`; } catch { /* keep */ }
  const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const user = clean(username).slice(0, 20);
  let base = `login-${clean(host).slice(0, 36)}${user ? `-${user}` : ''}`.slice(0, 60).replace(/-+$/, '');
  if (!/^[a-z0-9]/.test(base)) base = `login-${base}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const cand = `${base.slice(0, 58)}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

/** Everything the vault needs to create one browser login. */
export function loginCreateBody(l: { origin: string; username: string; password: string }, name: string, opts: { migrated?: boolean } = {}): CreateBody {
  return {
    name,
    kind: 'login',
    ...(l.username ? { username: l.username } : {}),
    url: l.origin,
    description: opts.migrated ? 'Saved in the AICO browser (moved from the browser’s own password store).' : 'Saved in the AICO browser.',
    tags: opts.migrated ? [BROWSER_TAG, MIGRATED_TAG] : [BROWSER_TAG],
    secret: { password: l.password },
    policy: loginPolicy(l.origin),
    createdBy: 'user',
  };
}

/**
 * A note saved beside a login. Notes can hold recovery codes, so they are a
 * `note` credential of their own (every use asks), never the login's
 * description — which the agent can read in CredentialList.
 */
export function noteCreateBody(e: { origin: string; note: string }, loginName: string, taken: ReadonlySet<string>): CreateBody {
  const name = taken.has(`${loginName}-note`) ? credentialNameFor(e.origin, `${loginName}-note`, taken) : `${loginName}-note`.slice(0, 64);
  return {
    name,
    kind: 'note',
    url: e.origin,
    description: `Note saved with ${loginName} in the AICO browser.`,
    tags: [BROWSER_TAG, MIGRATED_TAG],
    secret: { text: e.note },
    policy: { allowedOrigins: [e.origin], allowedTools: [], approval: 'every-use', allowShell: false },
    createdBy: 'user',
  };
}

/** A credential as `/api/vault/list` describes it (the fields this module reads). */
export interface ExistingCredential { name: string; kind: string; username?: string; url?: string; tags: string[] }

export interface MigrationPlan {
  create: Array<{ entryId: string; body: CreateBody }>;
  /** Entries already in the vault (same origin and username, a browser login). */
  already: string[];
  /** Entries the vault cannot hold (no usable origin, no password). */
  unusable: string[];
}

/**
 * What to create for the legacy entries. Idempotent: an entry whose
 * (origin, username) is already a browser login in the vault is skipped, so
 * running it twice — or after a crash half-way — creates nothing twice.
 */
export function planMigration(entries: LegacyEntry[], existing: ExistingCredential[]): MigrationPlan {
  const taken = new Set(existing.map(c => c.name));
  const have = new Set(existing.filter(c => c.kind === 'login' && c.url).map(c => `${webOrigin(c.url!) ?? c.url}\u0000${c.username ?? ''}`));
  const plan: MigrationPlan = { create: [], already: [], unusable: [] };
  for (const e of entries) {
    const origin = webOrigin(e.origin);
    if (!origin || !e.password) { plan.unusable.push(e.id); continue; }
    const key = `${origin}\u0000${e.username ?? ''}`;
    if (have.has(key)) { plan.already.push(e.id); continue; }
    const name = credentialNameFor(origin, e.username ?? '', taken);
    taken.add(name);
    have.add(key);
    plan.create.push({ entryId: e.id, body: loginCreateBody({ origin, username: e.username ?? '', password: e.password }, name, { migrated: true }) });
    if (e.note?.trim()) {
      const note = noteCreateBody({ origin, note: e.note.trim() }, name, taken);
      taken.add(note.name);
      plan.create.push({ entryId: e.id, body: note });
    }
  }
  return plan;
}

/**
 * After migrating: is every usable legacy entry a browser login in the vault
 * now? Returns the ids that are not (empty means verified).
 */
export function verifyMigration(entries: LegacyEntry[], after: ExistingCredential[]): string[] {
  const have = new Set(after.filter(c => c.kind === 'login' && c.url).map(c => `${webOrigin(c.url!) ?? c.url}\u0000${c.username ?? ''}`));
  return entries.filter(e => webOrigin(e.origin) && e.password && !have.has(`${webOrigin(e.origin)}\u0000${e.username ?? ''}`)).map(e => e.id);
}
