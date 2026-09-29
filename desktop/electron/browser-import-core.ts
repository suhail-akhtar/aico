/**
 * Bringing another browser's data into AICO, as pure work on plain data: where
 * the browsers keep their profiles, Firefox's profiles.ini, the two timestamp
 * epochs, merging visits into AICO's history, Firefox's bookmark rows, the
 * address tables, and the password CSV files browsers and password managers
 * export. No Electron and no file access — browser-import.ts reads, and only
 * when the person asks.
 *
 * WHAT IS NEVER READ. Saved-password databases (Chromium's `Login Data`,
 * Firefox's `logins.json` / `key4.db`), cookie stores, keychains and the keys
 * that encrypt them are not opened by anything here, with or without consent:
 * passwords come in only through a CSV file the person exports from the other
 * browser themselves (mapPasswordCsv). Payment cards are skipped wherever they
 * sit beside addresses (Chromium's `credit_cards`, Firefox's `creditCards`).
 *
 * @module desktop/electron/browser-import-core
 */

import type { HistoryEntry, ImportPart, ImportPreset } from '../shared/browser-types';
import type { ImportNode } from '../shared/bookmark-tree';
import { HISTORY_CAP, historyKey, isRecordable } from './browser-store';
import { acceptImportUrl, chromiumInstalls, fromWebkitTime, isProfileDir, type ImportTree } from './browser-bookmarks-io';
import type { AutofillAddress, AutofillProfile } from './browser-autofill';

export { fromWebkitTime };

// ── Where browsers keep their profiles ──

export type ImportEngine = 'chromium' | 'firefox';
export interface BrowserRoot { browser: string; dir: string; engine: ImportEngine }

/**
 * The folders to look in, whether or not they exist: Chrome, Edge and Brave
 * (the bookmarks importer's list), Vivaldi, Opera, Opera GX and Chromium, and
 * Firefox's profile root (read through its profiles.ini).
 */
export function browserRoots(platform: string, env: Record<string, string | undefined>, home: string): BrowserRoot[] {
  const j = (...p: string[]): string => p.join(platform === 'win32' ? '\\' : '/');
  const out: BrowserRoot[] = chromiumInstalls(platform, env, home).map(i => ({ ...i, engine: 'chromium' as const }));
  const add = (browser: string, dir: string, engine: ImportEngine = 'chromium'): void => { out.push({ browser, dir, engine }); };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
    const roaming = env.APPDATA || j(home, 'AppData', 'Roaming');
    add('Vivaldi', j(local, 'Vivaldi', 'User Data'));
    add('Chromium', j(local, 'Chromium', 'User Data'));
    add('Opera', j(roaming, 'Opera Software', 'Opera Stable'));
    add('Opera GX', j(roaming, 'Opera Software', 'Opera GX Stable'));
    add('Firefox', j(roaming, 'Mozilla', 'Firefox'), 'firefox');
  } else if (platform === 'darwin') {
    const sup = j(home, 'Library', 'Application Support');
    add('Vivaldi', j(sup, 'Vivaldi'));
    add('Chromium', j(sup, 'Chromium'));
    add('Opera', j(sup, 'com.operasoftware.Opera'));
    add('Firefox', j(sup, 'Firefox'), 'firefox');
  } else {
    const cfg = env.XDG_CONFIG_HOME || j(home, '.config');
    add('Vivaldi', j(cfg, 'vivaldi'));
    add('Opera', j(cfg, 'opera'));
    add('Firefox', j(home, '.mozilla', 'firefox'), 'firefox');
    add('Firefox', j(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), 'firefox');
    add('Firefox', j(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'), 'firefox');
  }
  return out;
}

/**
 * The profile folders of a Chromium "User Data" folder: "Default" and
 * "Profile N" — or, for Opera, which keeps one profile in the folder itself,
 * the folder (`.` stands for it).
 */
export function chromiumProfileDirs(entries: string[], rootHasData: boolean): string[] {
  const dirs = entries.filter(isProfileDir)
    .sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
  return rootHasData && !dirs.length ? ['.'] : dirs;
}

export interface FirefoxProfile { name: string; path: string; isDefault: boolean }

/** Firefox's profiles.ini: every [ProfileN] with its name and folder (made absolute against `root`). */
export function parseProfilesIni(text: string, root: string, sep = '/'): FirefoxProfile[] {
  const sections: Array<{ name: string; kv: Record<string, string> }> = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { sections.push({ name: sec[1]!, kv: {} }); continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && sections.length) sections[sections.length - 1]!.kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  // Newer Firefox names the profile in use in an [Install…] section.
  const installDefaults = new Set(sections.filter(s => /^Install/i.test(s.name)).map(s => s.kv.Default).filter(Boolean));
  const out: FirefoxProfile[] = [];
  for (const s of sections) {
    if (!/^Profile\d+$/i.test(s.name) || !s.kv.Path) continue;
    const rel = s.kv.IsRelative !== '0';
    const p = s.kv.Path.replace(/[\\/]/g, sep);
    out.push({
      name: s.kv.Name || s.kv.Path,
      path: rel ? `${root.replace(/[\\/]+$/, '')}${sep}${p}` : p,
      isDefault: installDefaults.has(s.kv.Path) || (!installDefaults.size && s.kv.Default === '1'),
    });
  }
  return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

// ── Time ──

/** Firefox (PRTime): microseconds since 1970. Implausible values (before 1995, after 2100) are dropped. */
export function fromFirefoxTime(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = Math.round(n / 1000);
  return ms > 788_918_400_000 && ms < 4_102_444_800_000 ? ms : undefined;
}

/** Chromium time, with the same plausibility check. */
export function fromChromiumTime(v: unknown): number | undefined {
  const ms = fromWebkitTime(v);
  return ms !== undefined && ms > 788_918_400_000 && ms < 4_102_444_800_000 ? ms : undefined;
}

// ── History ──

export interface ImportedVisit { url: string; title: string; visits: number; lastVisit: number }

/** Rows from Chromium's `urls` table (url, title, visit_count, last_visit_time). */
export function chromiumHistory(rows: Array<Record<string, unknown>>): ImportedVisit[] {
  return visits(rows.map(r => ({ url: r.url, title: r.title, visits: r.visit_count, at: fromChromiumTime(r.last_visit_time) })));
}

/** Rows from Firefox's `moz_places` (url, title, visit_count, last_visit_date). */
export function firefoxHistory(rows: Array<Record<string, unknown>>): ImportedVisit[] {
  return visits(rows.map(r => ({ url: r.url, title: r.title, visits: r.visit_count, at: fromFirefoxTime(r.last_visit_date) })));
}

function visits(rows: Array<{ url: unknown; title: unknown; visits: unknown; at: number | undefined }>): ImportedVisit[] {
  const out: ImportedVisit[] = [];
  for (const r of rows) {
    if (typeof r.url !== 'string' || !r.at || !/^https?:/i.test(r.url) || !isRecordable(r.url) || r.url.length > 4096) continue;
    out.push({ url: r.url, title: typeof r.title === 'string' ? r.title.trim().slice(0, 500) : '', visits: Math.max(1, Math.floor(Number(r.visits) || 1)), lastVisit: r.at });
  }
  return out;
}

/**
 * Merge imported visits into AICO's history: one entry per URL (without its
 * #fragment, as AICO records them), the later visit wins the date, the larger
 * count wins the count — so importing the same profile twice changes nothing —
 * and a title is kept when the import has none. Newest first, capped like
 * AICO's own history (the oldest fall off).
 */
export function mergeHistory(list: HistoryEntry[], incoming: ImportedVisit[], cap = HISTORY_CAP): { list: HistoryEntry[]; added: number; updated: number } {
  const byUrl = new Map<string, HistoryEntry>();
  for (const e of list) byUrl.set(e.url, e);
  const before = new Set(byUrl.keys());
  let updated = 0;
  const touched = new Set<string>();
  for (const v of incoming) {
    const key = historyKey(v.url);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, { url: key, title: v.title || key, visits: v.visits, lastVisit: v.lastVisit });
      continue;
    }
    const next: HistoryEntry = {
      ...prev,
      title: prev.title && prev.title !== prev.url ? prev.title : v.title || prev.title,
      visits: Math.max(prev.visits, v.visits),
      lastVisit: Math.max(prev.lastVisit, v.lastVisit),
    };
    if (next.title !== prev.title || next.visits !== prev.visits || next.lastVisit !== prev.lastVisit) {
      byUrl.set(key, next);
      if (before.has(key) && !touched.has(key)) { touched.add(key); updated++; }
    }
  }
  const merged = [...byUrl.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, cap);
  const added = merged.filter(e => !before.has(e.url)).length;
  return { list: merged, added, updated };
}

// ── Firefox bookmarks (places.sqlite) ──

export interface FirefoxBookmarkRow { id: number; type: number; parent: number; position: number; title: string | null; dateAdded: number | null; guid: string; url: string | null }

/**
 * Firefox's bookmark rows as a tree: the toolbar becomes the bar; the
 * Bookmarks Menu, Other Bookmarks and Mobile Bookmarks follow. Tags and
 * `place:` queries (smart folders) are not bookmarks and are skipped.
 */
export function firefoxBookmarkTree(rows: FirefoxBookmarkRow[]): ImportTree {
  const kids = new Map<number, FirefoxBookmarkRow[]>();
  for (const r of rows) {
    const list = kids.get(r.parent) ?? [];
    list.push(r);
    kids.set(r.parent, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  let skipped = 0; let seen = 0;
  const conv = (parent: number, depth: number): ImportNode[] => {
    const out: ImportNode[] = [];
    for (const r of kids.get(parent) ?? []) {
      if (++seen > 100_000 || depth > 64) break;
      const addedAt = fromFirefoxTime(r.dateAdded);
      if (r.type === 2) out.push({ title: r.title ?? '', ...(addedAt ? { addedAt } : {}), children: conv(r.id, depth + 1) });
      else if (r.type === 1 && r.url) {
        if (acceptImportUrl(r.url)) out.push({ title: r.title ?? '', url: r.url, ...(addedAt ? { addedAt } : {}) });
        else skipped++;
      }
    }
    return out;
  };
  const root = (guid: string): FirefoxBookmarkRow | undefined => rows.find(r => r.guid === guid);
  const bar = root('toolbar_____');
  const menu = root('menu________');
  const unfiled = root('unfiled_____');
  const mobile = root('mobile______');
  const other: ImportNode[] = [];
  const menuItems = menu ? conv(menu.id, 1) : [];
  if (menuItems.length) other.push({ title: 'Bookmarks menu', children: menuItems });
  if (unfiled) other.push(...conv(unfiled.id, 1));
  const mobileItems = mobile ? conv(mobile.id, 1) : [];
  if (mobileItems.length) other.push({ title: 'Mobile bookmarks', children: mobileItems });
  return { bar: bar ? conv(bar.id, 1) : [], other, skipped };
}

export function countTree(nodes: ImportNode[]): number {
  let n = 0;
  const walk = (list: ImportNode[]): void => { for (const x of list) { if (x.children) walk(x.children); else if (x.url) n++; } };
  walk(nodes);
  return n;
}

// ── Addresses ──

/** An address as another browser keeps it, before it becomes one of AICO's autofill addresses. */
export interface ImportedAddress {
  name?: string; company?: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string;
  phone?: string; email?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function address(o: { name?: unknown; company?: unknown; street?: unknown; city?: unknown; region?: unknown; zip?: unknown; country?: unknown; phone?: unknown; email?: unknown }): ImportedAddress | null {
  const lines = str(o.street).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const a: ImportedAddress = { line1: lines[0] ?? '', city: str(o.city), postalCode: str(o.zip), country: str(o.country) };
  if (lines.length > 1) a.line2 = lines.slice(1).join(', ');
  for (const [k, v] of [['name', o.name], ['company', o.company], ['region', o.region], ['phone', o.phone], ['email', o.email]] as const) { const s = str(v); if (s) a[k] = s; }
  return a.line1 || a.city || a.postalCode ? a : null;
}

/**
 * Chromium's older address tables: `autofill_profiles` (one row per address)
 * with the names, e-mails and phone numbers in their own tables by guid.
 */
export function chromiumAddressesLegacy(t: {
  profiles: Array<Record<string, unknown>>; names?: Array<Record<string, unknown>>; emails?: Array<Record<string, unknown>>; phones?: Array<Record<string, unknown>>;
}): ImportedAddress[] {
  const first = (rows: Array<Record<string, unknown>> | undefined, guid: unknown, pick: (r: Record<string, unknown>) => string): string =>
    (rows ?? []).filter(r => r.guid === guid).map(pick).find(Boolean) ?? '';
  return t.profiles.map(p => address({
    name: first(t.names, p.guid, r => str(r.full_name) || [str(r.first_name), str(r.middle_name), str(r.last_name)].filter(Boolean).join(' ')),
    company: p.company_name, street: p.street_address, city: p.city, region: p.state, zip: p.zipcode, country: p.country_code,
    phone: first(t.phones, p.guid, r => str(r.number)), email: first(t.emails, p.guid, r => str(r.email)),
  })).filter((a): a is ImportedAddress => a !== null);
}

/** Chromium's field-type numbers (components/autofill field_types.h) for the parts of an address. */
const FT = { first: 3, middle: 4, last: 5, full: 7, email: 9, phone: 14, line1: 30, line2: 31, city: 33, state: 34, zip: 35, country: 36, company: 60, street: 77 } as const;

/** Chromium's newer address tables (`local_addresses` / `addresses` with their `…_type_tokens`): one row per (guid, type, value). */
export function chromiumAddressesTokens(tokens: Array<Record<string, unknown>>): ImportedAddress[] {
  const by = new Map<string, Map<number, string>>();
  for (const t of tokens) {
    const g = str(t.guid); const v = str(t.value);
    if (!g || !v) continue;
    const m = by.get(g) ?? new Map<number, string>();
    m.set(Number(t.type), v);
    by.set(g, m);
  }
  const out: ImportedAddress[] = [];
  for (const m of by.values()) {
    const name = m.get(FT.full) || [m.get(FT.first), m.get(FT.middle), m.get(FT.last)].filter(Boolean).join(' ');
    const street = m.get(FT.street) || [m.get(FT.line1), m.get(FT.line2)].filter(Boolean).join('\n');
    const a = address({ name, company: m.get(FT.company), street, city: m.get(FT.city), region: m.get(FT.state), zip: m.get(FT.zip), country: m.get(FT.country), phone: m.get(FT.phone), email: m.get(FT.email) });
    if (a) out.push(a);
  }
  return out;
}

/** Firefox's autofill-profiles.json: its `addresses` (its `creditCards` are never looked at). */
export function firefoxAddresses(json: string): ImportedAddress[] {
  let data: { addresses?: unknown };
  try { data = JSON.parse(json.replace(/^﻿/, '')) as { addresses?: unknown }; } catch { return []; }
  if (!Array.isArray(data?.addresses)) return [];
  return data.addresses.map((raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (r.deleted || r.timeDeleted) return null;
    return address({
      name: str(r.name) || [str(r['given-name']), str(r['additional-name']), str(r['family-name'])].filter(Boolean).join(' '),
      company: r.organization, street: r['street-address'], city: r['address-level2'], region: r['address-level1'],
      zip: r['postal-code'], country: r.country, phone: r.tel, email: r.email,
    });
  }).filter((a): a is ImportedAddress => a !== null);
}

const addrKey = (a: { line1: string; postalCode: string }): string => `${a.line1}|${a.postalCode}`.toLowerCase().replace(/[\s,.]+/g, '');

/**
 * Add imported addresses to AICO's autofill profile: ones it already has (same
 * first line and postcode) are skipped, the list stays within the profile's
 * limit of 20, and an empty name / e-mail / phone on the profile is taken from
 * the first address that has one.
 */
export function mergeAddresses(p: AutofillProfile, incoming: ImportedAddress[], label: string, maxAddresses = 20): { profile: AutofillProfile; added: number; skipped: number } {
  const have = new Set(p.addresses.map(addrKey));
  const addresses: AutofillAddress[] = [...p.addresses];
  let added = 0; let skipped = 0;
  for (const a of incoming) {
    if (have.has(addrKey(a)) || addresses.length >= maxAddresses) { skipped++; continue; }
    have.add(addrKey(a));
    added++;
    const { email: _e, ...rest } = a;
    addresses.push({ ...rest, id: `imp${Date.now().toString(36)}${added}`, label: incoming.length > 1 ? `${label} ${added}` : label });
  }
  const firstWith = (k: 'name' | 'email' | 'phone'): string => incoming.map(a => a[k] ?? '').find(Boolean) ?? '';
  return {
    profile: {
      ...p,
      addresses,
      fullName: p.fullName || (p.givenName || p.familyName ? '' : firstWith('name')),
      email: p.email || firstWith('email'),
      phone: p.phone || firstWith('phone'),
      defaultAddress: p.defaultAddress ?? addresses[0]?.id,
    },
    added,
    skipped,
  };
}

// ── Password CSV files ──

/** RFC 4180 CSV: quoted fields with doubled quotes and line breaks inside, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

export interface ImportedLogin { origin: string; username: string; password: string; note?: string; created?: number }
export interface CsvImport { source: string; logins: ImportedLogin[]; skipped: number; reasons: Record<string, number> }

/**
 * The web origin a saved login belongs to, from whatever a CSV holds: a full
 * URL, or the bare domain some managers export. Only http(s); an app's
 * `android://` entry or a browser-internal one has no web page to fill.
 */
export function originFromUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t) ? `https://${t}` : '';
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch { return null; }
}

const COLS = {
  url: ['url', 'login_uri', 'website', 'web site', 'login url', 'uri', 'hostname', 'origin', 'login_url'],
  username: ['username', 'login_username', 'user name', 'login', 'user', 'email', 'login name'],
  password: ['password', 'login_password', 'pass'],
  note: ['note', 'notes', 'extra', 'comments'],
  type: ['type'],
  created: ['timecreated'],
} as const;

/** Which program wrote this file, from its header row. */
export function csvSource(header: string[]): string {
  const h = new Set(header.map(x => x.trim().toLowerCase()));
  if (h.has('login_uri') || h.has('login_password')) return 'Bitwarden';
  if (h.has('httprealm') || h.has('formactionorigin') || h.has('timepasswordchanged')) return 'Firefox';
  if (h.has('otpauth')) return 'Safari';
  if (h.has('website') || h.has('one-time password') || h.has('archived status')) return '1Password';
  if (h.has('name') && h.has('url') && h.has('username') && h.has('password')) return 'Chrome, Edge or Brave';
  return 'CSV file';
}

/**
 * A password CSV mapped to logins, whichever of the usual programs wrote it:
 *   Chrome / Edge / Brave  name,url,username,password[,note]
 *   Firefox                "url","username","password","httpRealm","formActionOrigin","guid","timeCreated",…
 *   Safari                 Title,URL,Username,Password,Notes,OTPAuth
 *   Bitwarden              folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
 *   1Password              Title,Website,Username,Password,One-time password,Favorite status,Archived status,Tags,Notes
 * Rows with no password or no web address are skipped and counted by reason.
 * One-time-password secrets (OTPAuth, login_totp) are not imported.
 */
export function mapPasswordCsv(text: string, maxRows = 50_000): CsvImport {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map(h => h.trim().toLowerCase());
  const col = (names: readonly string[]): number => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const iUrl = col(COLS.url); const iUser = col(COLS.username); const iPw = col(COLS.password);
  if (iUrl < 0 || iPw < 0) throw new Error('This file does not look like a password export: it needs a URL (or website) column and a password column.');
  const iNote = col(COLS.note); const iType = col(COLS.type); const iCreated = col(COLS.created);
  const source = csvSource(header);
  const logins: ImportedLogin[] = [];
  const reasons: Record<string, number> = {};
  let skipped = 0;
  const skip = (why: string): void => { skipped++; reasons[why] = (reasons[why] ?? 0) + 1; };
  for (const r of rows.slice(1, maxRows + 1)) {
    const get = (i: number): string => (i >= 0 ? (r[i] ?? '') : '');
    if (iType >= 0 && source === 'Bitwarden' && get(iType) && get(iType).toLowerCase() !== 'login') { skip('not a login (card, note or identity)'); continue; }
    const password = get(iPw);
    if (!password) { skip('no password'); continue; }
    // Bitwarden puts several addresses in one cell: the first web one is used.
    const origin = get(iUrl).split(/[,\s]+/).map(originFromUrl).find((o): o is string => o !== null) ?? null;
    if (!origin) { skip(get(iUrl) ? 'not a web address (an app or browser page)' : 'no web address'); continue; }
    const note = get(iNote).trim();
    const created = iCreated >= 0 ? Number(get(iCreated)) : NaN;
    logins.push({
      origin, username: get(iUser).trim(), password,
      ...(note ? { note: note.slice(0, 2000) } : {}),
      ...(Number.isFinite(created) && created > 0 ? { created } : {}),
    });
  }
  if (rows.length - 1 > maxRows) skip('beyond the first 50,000 rows');
  return { source, logins, skipped, reasons };
}

// ── The agent's request (browser_import) ──

/** What the agent asked the wizard to pre-select, from loose words: "chrome", ["Bookmarks", "hist"]. */
export function presetFor(browser: unknown, parts: unknown, passwords: unknown): ImportPreset {
  const names = ['Chrome', 'Edge', 'Brave', 'Vivaldi', 'Opera GX', 'Opera', 'Chromium', 'Firefox'];
  const b = typeof browser === 'string' ? names.find(n => n.toLowerCase() === browser.trim().toLowerCase()) ?? names.find(n => browser.toLowerCase().includes(n.toLowerCase())) : undefined;
  const list = (Array.isArray(parts) ? parts : typeof parts === 'string' ? parts.split(/[,\s+]+/) : [])
    .map(x => String(x).toLowerCase()).map(x => (x.startsWith('bookmark') ? 'bookmarks' : x.startsWith('hist') ? 'history' : x.startsWith('addr') ? 'addresses' : ''))
    .filter((x): x is ImportPart => x !== '');
  return { ...(b ? { browser: b } : {}), ...(list.length ? { parts: [...new Set(list)] } : {}), ...(passwords === true ? { passwords: true } : {}) };
}
