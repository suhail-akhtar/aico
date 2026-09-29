/**
 * The password vault's rules, as pure functions: the file format (sealed with
 * a cipher that is handed in — Electron's safeStorage in the app, a stand-in
 * in the tests), adding and updating logins, which page a login may be filled
 * into, the weak / reused report, and the CSV export.
 *
 * WHERE A PASSWORD MAY GO. Only into a page whose top-level origin is exactly
 * the login's origin — scheme, host and port; no subdomains, no look-alike
 * hosts, no credentials-in-URL tricks — over https (or http on this machine's
 * own loopback, which browsers treat as secure), and only into frames of that
 * same origin. Everything else is refused here, before any value leaves main.
 *
 * @module desktop/electron/browser-vault-core
 */

export interface VaultEntry {
  id: string;
  /** https://example.com — scheme, host and port. */
  origin: string;
  username: string;
  password: string;
  note?: string;
  created: number;
  updated: number;
}

export interface VaultData {
  v: 1;
  entries: VaultEntry[];
  /** Origins the person said never to offer saving for. */
  never: string[];
}

/** How the vault file is sealed (safeStorage in the app). */
export interface VaultCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

const MAGIC = Buffer.from('AICOVAULT1\n', 'utf8');
export const MAX_ENTRIES = 20_000;

export const emptyVault = (): VaultData => ({ v: 1, entries: [], never: [] });

export function sealVault(data: VaultData, cipher: VaultCipher): Buffer {
  if (!cipher.available()) throw new Error('Encryption is not available, so passwords cannot be stored.');
  return Buffer.concat([MAGIC, cipher.encrypt(JSON.stringify(data))]);
}

export function openVault(buf: Buffer, cipher: VaultCipher): VaultData {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not an AICO password vault.');
  return normaliseVault(JSON.parse(cipher.decrypt(buf.subarray(MAGIC.length))));
}

export function normaliseVault(raw: unknown): VaultData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { entries?: unknown; never?: unknown };
  const entries: VaultEntry[] = [];
  for (const e of Array.isArray(r.entries) ? r.entries : []) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    const origin = typeof x.origin === 'string' ? loginOrigin(x.origin) : null;
    if (!origin || typeof x.password !== 'string' || !x.password || typeof x.id !== 'string') continue;
    entries.push({
      id: x.id, origin, username: typeof x.username === 'string' ? x.username : '', password: x.password,
      ...(typeof x.note === 'string' && x.note ? { note: x.note } : {}),
      created: typeof x.created === 'number' ? x.created : 0, updated: typeof x.updated === 'number' ? x.updated : 0,
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  const never = Array.isArray(r.never) ? [...new Set(r.never.filter((o): o is string => typeof o === 'string' && loginOrigin(o) === o))] : [];
  return { v: 1, entries, never };
}

let seq = 0;
export const newEntryId = (now = Date.now()): string => `p${now.toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type UpsertResult = 'added' | 'updated' | 'unchanged';

/**
 * Save a login: a new (origin, username) is added; the same one with a new
 * password or note is updated; an identical one changes nothing.
 */
export function upsertLogin(data: VaultData, login: { origin: string; username: string; password: string; note?: string; created?: number }, now: number): { data: VaultData; result: UpsertResult; id: string } {
  const origin = loginOrigin(login.origin);
  if (!origin) throw new Error('A saved password needs a web address (https://…).');
  if (!login.password) throw new Error('There is no password to save.');
  const username = login.username.trim().slice(0, 500);
  const note = login.note?.trim().slice(0, 2000) || undefined;
  const prev = data.entries.find(e => e.origin === origin && e.username === username);
  if (prev) {
    if (prev.password === login.password && (note === undefined || note === prev.note)) return { data, result: 'unchanged', id: prev.id };
    const next: VaultEntry = { ...prev, password: login.password, ...(note !== undefined ? { note } : {}), updated: now };
    return { data: { ...data, entries: data.entries.map(e => (e.id === prev.id ? next : e)) }, result: 'updated', id: prev.id };
  }
  if (data.entries.length >= MAX_ENTRIES) throw new Error(`The vault is full (${MAX_ENTRIES} passwords).`);
  const created = login.created && login.created > 0 && login.created <= now ? login.created : now;
  const entry: VaultEntry = { id: newEntryId(now), origin, username, password: login.password, ...(note ? { note } : {}), created, updated: now };
  return { data: { ...data, entries: [...data.entries, entry] }, result: 'added', id: entry.id };
}

export function editEntry(data: VaultData, id: string, patch: { username?: string; password?: string; note?: string }, now: number): VaultData {
  const prev = data.entries.find(e => e.id === id);
  if (!prev) throw new Error('That password is no longer saved.');
  const username = patch.username !== undefined ? patch.username.trim().slice(0, 500) : prev.username;
  if (data.entries.some(e => e.id !== id && e.origin === prev.origin && e.username === username)) throw new Error(`A password for “${username || 'no username'}” on this site is already saved.`);
  const next: VaultEntry = {
    ...prev, username,
    password: patch.password ? patch.password : prev.password,
    updated: now,
  };
  if (patch.note !== undefined) { if (patch.note.trim()) next.note = patch.note.trim().slice(0, 2000); else delete next.note; }
  return { ...data, entries: data.entries.map(e => (e.id === id ? next : e)) };
}

// ── Origins ──

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The origin of a login's address (https://host[:port]), or null for anything that is not a plain http(s) address. */
export function loginOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
    return u.origin;
  } catch { return null; }
}

/** https, or http to this machine itself (localhost / 127.x / [::1] — "potentially trustworthy" to browsers). */
export function isSecureOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (LOOPBACK.test(u.hostname) || /\.localhost$/i.test(u.hostname));
  } catch { return false; }
}

export type FillVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May this login be filled into this frame? The page's top-level URL and the
 * frame's own URL must both have exactly the login's origin, over a secure
 * connection. (A frame's origin from Electron is trusted; the URLs are
 * parsed, never compared as text, so `https://bank.com.evil.test` and
 * `https://evil.test/?https://bank.com` are what they are.)
 */
export function canFill(entryOrigin: string, topUrl: string, frameUrl: string = topUrl): FillVerdict {
  const want = loginOrigin(entryOrigin);
  const top = loginOrigin(topUrl);
  const frame = loginOrigin(frameUrl);
  if (!want || !top) return { ok: false, reason: 'This page has no web address a password can belong to.' };
  if (top !== want) return { ok: false, reason: `This password is for ${want}, not ${top}.` };
  if (!isSecureOrigin(top)) return { ok: false, reason: 'Passwords are never filled into a page that is not secure (http).' };
  if (frame !== top) return { ok: false, reason: 'Passwords are never filled into a frame from another site.' };
  return { ok: true };
}

/** Logins saved for exactly this page's origin (no other origin, not even a subdomain). */
export function entriesFor(data: VaultData, pageUrl: string): VaultEntry[] {
  const o = loginOrigin(pageUrl);
  return o ? data.entries.filter(e => e.origin === o).sort((a, b) => b.updated - a.updated) : [];
}

// ── Report ──

const COMMON = new Set([
  'password', 'password1', 'password123', '123456', '1234567', '12345678', '123456789', '1234567890', '12345', '1234', '111111', '000000',
  'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'letmein', 'welcome', 'welcome1', 'admin', 'admin123', 'iloveyou', 'monkey', 'dragon',
  'football', 'baseball', 'sunshine', 'princess', 'master', 'login', 'passw0rd', 'trustno1', 'changeme', 'secret', '654321', '666666',
]);

export function weakness(e: { password: string; username: string; origin: string }): string | null {
  const p = e.password;
  const low = p.toLowerCase();
  if (COMMON.has(low)) return 'one of the most common passwords';
  if (p.length < 8) return 'shorter than 8 characters';
  if (e.username && low === e.username.toLowerCase()) return 'the same as the username';
  try { const host = new URL(e.origin).hostname.replace(/^www\./, '').split('.')[0]!; if (host.length >= 4 && low.includes(host)) return 'contains the site’s name'; } catch { /* ignore */ }
  if (/^(.)\1+$/.test(p)) return 'one character repeated';
  if (/^\d+$/.test(p) && p.length < 12) return 'only digits';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  if (classes === 1 && p.length < 12) return 'only one kind of character and under 12 long';
  return null;
}

export interface PasswordReport {
  weak: Array<{ id: string; reason: string }>;
  /** Groups of entries (different sites) that share a password. */
  reused: string[][];
}

/** Weak and reused passwords, by entry id — never the passwords themselves. */
export function passwordReport(entries: VaultEntry[]): PasswordReport {
  const weak: PasswordReport['weak'] = [];
  const byPw = new Map<string, VaultEntry[]>();
  for (const e of entries) {
    const w = weakness(e);
    if (w) weak.push({ id: e.id, reason: w });
    byPw.set(e.password, [...(byPw.get(e.password) ?? []), e]);
  }
  const reused = [...byPw.values()].filter(g => new Set(g.map(e => e.origin)).size > 1).map(g => g.map(e => e.id));
  return { weak, reused };
}

// ── Export ──

const csvCell = (s: string): string => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The vault as Chrome's CSV (name,url,username,password,note) — what every browser and manager imports. */
export function toPasswordCsv(entries: VaultEntry[]): string {
  const lines = ['name,url,username,password,note'];
  for (const e of [...entries].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))) {
    let name = e.origin;
    try { name = new URL(e.origin).host; } catch { /* keep the origin */ }
    lines.push([name, e.origin, e.username, e.password, e.note ?? ''].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
