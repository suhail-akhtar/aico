/**
 * Certificate exceptions for the built-in browser — the rules, with no Electron.
 *
 * WHY THIS EXISTS. Until 0.41 a broken certificate was a dead end: "AICO does
 * not let you or the agent continue". People run internal consoles and dev
 * servers on a private CA or a self-signed certificate
 * (`https://console.example.internal` → ERR_CERT_AUTHORITY_INVALID) and had to
 * leave AICO to open them. Chrome lets the person click through; so does AICO
 * now — but only the person, only for the exact certificate they looked at,
 * and with the site marked and its passwords kept out (ADR 0029).
 *
 * The rules decided here (browser.ts wires them to Electron):
 *   - which errors may be bypassed at all (an authority / name / date problem);
 *     ERR_CERT_REVOKED and every other error never are;
 *   - a host that uses HSTS (a short built-in subset of the preload list, or
 *     a Strict-Transport-Security header seen earlier over a good connection)
 *     is never bypassed — Chrome's rule;
 *   - an exception binds host + SHA-256 fingerprint: a different certificate
 *     for the same host is a new warning. "This session" lives in memory;
 *     "Always trust" is persisted in the browser's settings;
 *   - loopback (localhost, 127.x, [::1], *.localhost) auto-proceeds only when
 *     the person ticked "Allow self-signed certificates on localhost";
 *   - "Proceed" counts only with the warning's own token and a real input
 *     event on the AICO window moments before (the agent drives tabs, never
 *     the AICO window, so it cannot produce one);
 *   - passwords are not filled on an excepted site (a session exception
 *     refuses; an "always" one asks the person once per host).
 *
 * What it deliberately does NOT do: let the agent proceed, trust a
 * certificate for any session other than the browser's, or touch the app's
 * own aico:// pages and the engine's traffic (they never reach this code).
 *
 * @module desktop/electron/browser-certs-core
 */

/** Errors a person may click through. Everything else (REVOKED, INVALID, pinning, interception…) is final. */
const BYPASSABLE = new Set(['ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_VALIDITY_TOO_LONG']);

/** `net::ERR_CERT_AUTHORITY_INVALID` → `ERR_CERT_AUTHORITY_INVALID`. */
export function certErrorName(error: string): string {
  const m = /ERR_[A-Z0-9_]+/.exec(String(error ?? ''));
  return m ? m[0] : 'ERR_CERT_INVALID';
}

export function isBypassableError(error: string): boolean {
  return BYPASSABLE.has(certErrorName(error));
}

/** Why an error cannot be bypassed, in words for the warning page and the agent. */
export function unbypassableReason(error: string): string {
  const name = certErrorName(error);
  if (name === 'ERR_CERT_REVOKED') return 'The certificate has been revoked by the authority that issued it. A revoked certificate cannot be trusted, so AICO does not offer to continue.';
  return `This kind of certificate problem (${name}) cannot be bypassed.`;
}

// ── Hosts ──

/** A URL's host name, lower-case, without brackets; '' for anything that is not http(s). */
export function hostOfUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch { return ''; }
}

/** This machine: localhost, *.localhost, 127.0.0.0/8, ::1. */
export function isLoopbackHost(host: string): boolean {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// ── HSTS ──

/**
 * A short, conservative subset of Chromium's HSTS preload list (whole TLDs
 * Google registered as HTTPS-only, and a few large sites that preload with
 * subdomains). Chromium's full list is compiled into the binary and Electron
 * gives no way to ask it, so this is not complete; the headers a site sends
 * (below) cover the sites the person actually uses.
 */
export const HSTS_PRELOADED_TLDS = ['app', 'dev', 'page', 'bank', 'insurance', 'foo', 'new', 'day', 'android', 'chrome', 'google', 'youtube', 'gle', 'how', 'soy', 'boo', 'dad', 'eat', 'esq', 'fly', 'ing', 'meme', 'mov', 'nexus', 'phd', 'prof', 'rsvp', 'zip'];
export const HSTS_PRELOADED_HOSTS = ['google.com', 'gmail.com', 'paypal.com', 'github.com', 'facebook.com', 'twitter.com', 'x.com', 'dropbox.com', 'torproject.org', 'login.microsoftonline.com', 'accounts.google.com'];

/** HSTS hosts learned from headers: host → expiry (ms) and whether subdomains are covered. */
export type HstsRecord = Record<string, { until: number; sub: boolean }>;

/** `max-age=31536000; includeSubDomains` → { maxAge, includeSubDomains }; null when malformed. */
export function parseHsts(value: string | string[] | undefined): { maxAge: number; includeSubDomains: boolean } | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return null;
  const m = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?\s*(?:;|$)/i.exec(v);
  if (!m) return null;
  return { maxAge: Number(m[1]), includeSubDomains: /(?:^|;)\s*includesubdomains\s*(?:;|$)/i.test(v) };
}

/** Remember (or, with max-age=0, forget) a host's HSTS policy. Pure: returns the next record. */
export function noteHsts(rec: HstsRecord, host: string, header: string | string[] | undefined, now: number): HstsRecord {
  const p = parseHsts(header);
  const h = host.toLowerCase();
  if (!p || !h || isLoopbackHost(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return rec;
  const next = { ...rec };
  if (p.maxAge <= 0) delete next[h];
  else next[h] = { until: now + Math.min(p.maxAge, 2 * 365 * 86_400) * 1000, sub: p.includeSubDomains };
  return next;
}

/** Does HSTS forbid clicking through on this host? */
export function isHstsHost(host: string, dynamic: HstsRecord, now: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || isLoopbackHost(h)) return false;
  const labels = h.split('.');
  if (HSTS_PRELOADED_TLDS.includes(labels[labels.length - 1]!)) return true;
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join('.');
    if (HSTS_PRELOADED_HOSTS.includes(suffix)) return true;
    const d = dynamic[suffix];
    if (d && d.until > now && (i === 0 || d.sub)) return true;
  }
  return false;
}

export function normaliseHsts(raw: unknown, now = Date.now()): HstsRecord {
  const out: HstsRecord = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [h, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as { until?: unknown; sub?: unknown };
    if (typeof r?.until === 'number' && r.until > now && /^[a-z0-9.-]+$/i.test(h)) out[h.toLowerCase()] = { until: r.until, sub: r.sub === true };
  }
  return out;
}

// ── Exceptions ──

export interface CertException {
  host: string;
  /** Electron's `sha256/<base64>` fingerprint of the leaf certificate. */
  fingerprint: string;
  error: string;
  issuer: string;
  subject: string;
  validTo: number;
  addedAt: number;
  scope: 'session' | 'always';
  /** "Always" only: the person agreed (once for this host) that saved passwords may be used here. */
  credentialsConfirmed?: boolean;
}

export type PersistedCertException = Omit<CertException, 'scope'>;

/** Clean what settings.json holds: only well-formed "always" exceptions survive. */
export function normaliseCertExceptions(raw: unknown): PersistedCertException[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedCertException[] = [];
  const seen = new Set<string>();
  for (const x of raw as Array<Record<string, unknown>>) {
    if (!x || typeof x !== 'object') continue;
    const host = typeof x.host === 'string' ? x.host.toLowerCase() : '';
    const fingerprint = typeof x.fingerprint === 'string' ? x.fingerprint : '';
    if (!host || !/^sha256\/[A-Za-z0-9+/=]{20,}$/.test(fingerprint) || seen.has(`${host} ${fingerprint}`)) continue;
    seen.add(`${host} ${fingerprint}`);
    out.push({
      host, fingerprint,
      error: typeof x.error === 'string' ? x.error : '', issuer: typeof x.issuer === 'string' ? x.issuer : '',
      subject: typeof x.subject === 'string' ? x.subject : '', validTo: typeof x.validTo === 'number' ? x.validTo : 0,
      addedAt: typeof x.addedAt === 'number' ? x.addedAt : 0,
      ...(x.credentialsConfirmed === true ? { credentialsConfirmed: true } : {}),
    });
  }
  return out;
}

/**
 * The exceptions: per host, bound to one fingerprint. Session ones are in
 * memory (gone at restart, like Chrome); "always" ones are read and written
 * through `persisted` (the browser's settings.json).
 */
export class CertExceptions {
  private readonly session = new Map<string, CertException>();

  constructor(private readonly persisted: { get(): PersistedCertException[]; set(list: PersistedCertException[]): void }) {}

  /** The exception for exactly this host and certificate, or null. */
  match(host: string, fingerprint: string): CertException | null {
    const h = host.toLowerCase();
    const s = this.session.get(h);
    if (s && s.fingerprint === fingerprint) return s;
    const p = this.persisted.get().find(x => x.host === h && x.fingerprint === fingerprint);
    return p ? { ...p, scope: 'always' } : null;
  }

  add(e: Omit<CertException, 'scope' | 'credentialsConfirmed'>, scope: 'session' | 'always'): CertException {
    const host = e.host.toLowerCase();
    const entry: CertException = { ...e, host, scope };
    // One certificate per host and scope: a new one replaces the old (it was a different certificate).
    this.session.delete(host);
    if (scope === 'always') this.persisted.set([...this.persisted.get().filter(x => x.host !== host), { ...e, host }]);
    else this.session.set(host, entry);
    return entry;
  }

  /** Remove one exception (a host's, optionally only for one certificate). True when something went. */
  remove(host: string, fingerprint?: string): boolean {
    const h = host.toLowerCase();
    let gone = false;
    const s = this.session.get(h);
    if (s && (!fingerprint || s.fingerprint === fingerprint)) { this.session.delete(h); gone = true; }
    const list = this.persisted.get();
    const rest = list.filter(x => !(x.host === h && (!fingerprint || x.fingerprint === fingerprint)));
    if (rest.length !== list.length) { this.persisted.set(rest); gone = true; }
    return gone;
  }

  /** Record the person's one-time "yes, use saved passwords here" for an "always" exception. */
  confirmCredentials(host: string, fingerprint: string): boolean {
    const h = host.toLowerCase();
    const list = this.persisted.get();
    if (!list.some(x => x.host === h && x.fingerprint === fingerprint)) return false;
    this.persisted.set(list.map(x => (x.host === h && x.fingerprint === fingerprint ? { ...x, credentialsConfirmed: true } : x)));
    return true;
  }

  list(): CertException[] {
    return [...this.session.values(), ...this.persisted.get().map(p => ({ ...p, scope: 'always' as const }))]
      .sort((a, b) => a.host.localeCompare(b.host));
  }
}

// ── Decisions ──

export type CertDecision =
  | { kind: 'accept'; via: 'exception' | 'loopback'; exception?: CertException }
  | { kind: 'block'; bypassable: boolean; reason?: string };

/** A certificate error arrived for `host`: let it through, or show the warning (and whether it offers Proceed). */
export function decideCertError(i: {
  host: string; fingerprint: string; error: string;
  exceptions: Pick<CertExceptions, 'match'>; allowInsecureLocalhost: boolean; hsts: HstsRecord; now: number;
}): CertDecision {
  if (!isBypassableError(i.error)) return { kind: 'block', bypassable: false, reason: unbypassableReason(i.error) };
  if (isHstsHost(i.host, i.hsts, i.now)) {
    return { kind: 'block', bypassable: false, reason: `${i.host} normally uses encryption to protect your information and has told browsers to accept only a valid certificate (HSTS). You cannot visit it right now because its certificate is not valid — this is often an attack or a network that intercepts traffic.` };
  }
  if (isLoopbackHost(i.host) && i.allowInsecureLocalhost) return { kind: 'accept', via: 'loopback' };
  const ex = i.exceptions.match(i.host, i.fingerprint);
  if (ex) return { kind: 'accept', via: 'exception', exception: ex };
  return { kind: 'block', bypassable: true };
}

/** What the warning page is waiting on, as main recorded it (the renderer never supplies the certificate). */
export interface PendingCertError {
  token: string;
  tabId: string;
  url: string;
  host: string;
  fingerprint: string;
  bypassable: boolean;
}

/** How recent the person's own click or key on the AICO window must be for "Proceed" to count. */
export const PROCEED_INPUT_WINDOW_MS = 3000;

/**
 * May "Proceed" go ahead? Only for the warning main is showing (its token),
 * only when the error may be bypassed, and only with a real input event on
 * the AICO window just before — which the agent cannot produce (it drives
 * tabs, never the AICO window, and has no tool that reaches this channel).
 */
export function decideProceed(i: { pending: PendingCertError | undefined; token: unknown; now: number; lastPersonInputAt: number }): { ok: true } | { ok: false; reason: string } {
  if (!i.pending || typeof i.token !== 'string' || i.token !== i.pending.token) return { ok: false, reason: 'This warning is no longer showing. Open the page again.' };
  if (!i.pending.bypassable) return { ok: false, reason: 'This certificate problem cannot be bypassed.' };
  if (!(i.lastPersonInputAt > 0) || i.now - i.lastPersonInputAt > PROCEED_INPUT_WINDOW_MS || i.lastPersonInputAt > i.now + 50) {
    return { ok: false, reason: 'Proceeding needs your own click on the warning page.' };
  }
  return { ok: true };
}

export type CredentialGate = { ok: true } | { ok: false; reason: string } | { ok: 'confirm'; host: string };

/**
 * May a saved password (vault fill, browser_login) go into a page whose
 * certificate was only accepted by an exception? A session exception: no. An
 * "always" one: after the person confirms once for the host. Loopback under
 * the localhost setting: yes — the traffic never leaves this machine.
 */
export function credentialGate(i: { host: string; certOk: boolean; via?: 'exception' | 'loopback' | null; exception: CertException | null }): CredentialGate {
  if (i.certOk) return { ok: true };
  if (i.via === 'loopback' && isLoopbackHost(i.host)) return { ok: true };
  const e = i.exception;
  if (!e) return { ok: false, reason: `The certificate of ${i.host} is not trusted, so a saved password could be intercepted. AICO does not fill or sign in here.` };
  if (e.scope === 'session') return { ok: false, reason: `You allowed the certificate of ${i.host} for this session only. The connection is not verified, so a saved password could be intercepted: AICO does not fill passwords or sign in here. Type it yourself, or choose "Always trust this certificate" on the warning and confirm once.` };
  if (!e.credentialsConfirmed) return { ok: 'confirm', host: e.host };
  return { ok: true };
}
