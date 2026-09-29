/**
 * Reading another browser's profile — the file half of the import centre,
 * with no Electron in it, so the tests run it against generated profiles.
 *
 * ALWAYS READ-ONLY. Nothing here writes to, locks or opens in place another
 * browser's files: a SQLite database (History, Web Data, places.sqlite) is
 * first copied with its -wal / -journal into a fresh temporary folder, read
 * there with `node:sqlite`, and the copy is deleted straight after, whatever
 * happens. A browser that is running may hold its database locked; then the
 * copy fails and the person is asked to close that browser and try again.
 *
 * The files read are only these: Bookmarks, History and Web Data (addresses)
 * of a Chromium profile; places.sqlite and autofill-profiles.json of a Firefox
 * profile; the browsers' own profile lists (Local State, profiles.ini). Never
 * Login Data, Cookies, logins.json, key4.db or Local State's encryption key.
 *
 * @module desktop/electron/browser-import-read
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseChromiumBookmarks, profileNames, type ImportTree } from './browser-bookmarks-io';
import {
  browserRoots, chromiumAddressesLegacy, chromiumAddressesTokens, chromiumHistory, chromiumProfileDirs, countTree,
  firefoxAddresses, firefoxBookmarkTree, firefoxHistory, parseProfilesIni,
  type FirefoxBookmarkRow, type ImportEngine, type ImportedAddress, type ImportedVisit,
} from './browser-import-core';
import { HISTORY_CAP } from './browser-store';

export interface FoundProfile { id: string; browser: string; profile: string; engine: ImportEngine; dir: string; isDefault?: boolean }
export interface ProfileCounts { bookmarks?: number; history?: number; addresses?: number; errors?: string[] }

type Db = { prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown }; close(): void };
type DbCtor = new (file: string, opts?: { readOnly?: boolean }) => Db;

let ctor: DbCtor | null = null;
async function sqlite(): Promise<DbCtor> {
  if (ctor) return ctor;
  try {
    ctor = (await import('node:sqlite')).DatabaseSync as unknown as DbCtor;
    return ctor;
  } catch {
    throw new Error('This version of AICO cannot read browser databases (node:sqlite is missing).');
  }
}

/** Every browser profile on this machine that has something to import. Only lists folders and reads the profile lists. */
export function findProfiles(platform = process.platform, env: Record<string, string | undefined> = process.env, home = os.homedir()): FoundProfile[] {
  const out: FoundProfile[] = [];
  const seen = new Set<string>();
  for (const root of browserRoots(platform, env, home)) {
    if (!fs.existsSync(root.dir)) continue;
    if (root.engine === 'firefox') {
      let ini = '';
      try { ini = fs.readFileSync(path.join(root.dir, 'profiles.ini'), 'utf8'); } catch { continue; }
      for (const p of parseProfilesIni(ini, root.dir, path.sep)) {
        const dir = path.resolve(p.path);
        if (seen.has(dir) || !fs.existsSync(path.join(dir, 'places.sqlite'))) continue;
        seen.add(dir);
        out.push({ id: dir, browser: root.browser, profile: p.name, engine: 'firefox', dir, ...(p.isDefault ? { isDefault: true } : {}) });
      }
      continue;
    }
    let entries: string[] = [];
    try { entries = fs.readdirSync(root.dir); } catch { continue; }
    const hasData = (d: string): boolean => ['Bookmarks', 'History', 'Web Data'].some(f => fs.existsSync(path.join(d, f)));
    let names: Record<string, string> = {};
    try { names = profileNames(fs.readFileSync(path.join(root.dir, 'Local State'), 'utf8')); } catch { /* the folder's name will do */ }
    for (const d of chromiumProfileDirs(entries, hasData(root.dir))) {
      const dir = path.resolve(root.dir, d);
      if (seen.has(dir) || !hasData(dir)) continue;
      seen.add(dir);
      out.push({ id: dir, browser: root.browser, profile: d === '.' ? 'Default' : names[d] ?? d, engine: 'chromium', dir, ...(d === 'Default' || d === '.' ? { isDefault: true } : {}) });
    }
  }
  return out;
}

/**
 * Run `fn` on a private copy of a SQLite database. The copy (and its -wal /
 * -journal) lives in a new folder under the system temp and is removed when
 * `fn` returns or throws.
 */
export async function withCopy<T>(file: string, label: string, fn: (db: Db) => T): Promise<T> {
  const Database = await sqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-import-'));
  try {
    const copy = path.join(tmp, path.basename(file));
    try {
      fs.copyFileSync(file, copy);
      for (const ext of ['-wal', '-journal']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new Error(`${label} is in use. Close ${label} and try again.`);
      throw err;
    }
    const db = new Database(copy);
    try { return fn(db); } finally { db.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const tables = (db: Db): Set<string> => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name));
const count = (db: Db, sql: string): number => Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
const HTTP = "(url LIKE 'http:%' OR url LIKE 'https:%')";

function chromiumAddressRows(db: Db): ImportedAddress[] {
  const t = tables(db);
  for (const [addr, tokens] of [['addresses', 'address_type_tokens'], ['local_addresses', 'local_addresses_type_tokens']] as const) {
    if (t.has(addr) && t.has(tokens)) {
      const rows = db.prepare(`SELECT guid, type, value FROM ${tokens} WHERE guid IN (SELECT guid FROM ${addr})`).all() as Array<Record<string, unknown>>;
      const list = chromiumAddressesTokens(rows);
      if (list.length) return list;
    }
  }
  if (!t.has('autofill_profiles')) return [];
  const all = (table: string): Array<Record<string, unknown>> => (t.has(table) ? db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>> : []);
  return chromiumAddressesLegacy({ profiles: all('autofill_profiles'), names: all('autofill_profile_names'), emails: all('autofill_profile_emails'), phones: all('autofill_profile_phones') });
}

const FF_BOOKMARKS = 'SELECT b.id AS id, b.type AS type, b.parent AS parent, b.position AS position, b.title AS title, b.dateAdded AS dateAdded, b.guid AS guid, p.url AS url FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id';

function readChromiumBookmarks(dir: string): ImportTree | null {
  const file = path.join(dir, 'Bookmarks');
  if (!fs.existsSync(file)) return null;
  return parseChromiumBookmarks(fs.readFileSync(file, 'utf8'));
}

/** What a profile holds, counted — shown before anything is imported. A part that cannot be read says why. */
export async function scanProfile(p: FoundProfile): Promise<ProfileCounts> {
  const c: ProfileCounts = {};
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); } catch (err) { errors.push(`${what}: ${(err as Error).message}`); }
  };
  if (p.engine === 'chromium') {
    await attempt('Bookmarks', () => { const t = readChromiumBookmarks(p.dir); if (t) c.bookmarks = countTree([...t.bar, ...t.other]); });
    await attempt('History', async () => {
      const f = path.join(p.dir, 'History');
      if (fs.existsSync(f)) c.history = await withCopy(f, p.browser, db => count(db, `SELECT count(*) AS n FROM urls WHERE hidden = 0 AND ${HTTP}`));
    });
    await attempt('Addresses', async () => {
      const f = path.join(p.dir, 'Web Data');
      if (fs.existsSync(f)) c.addresses = await withCopy(f, p.browser, db => chromiumAddressRows(db).length);
    });
  } else {
    await attempt('Bookmarks and history', async () => {
      await withCopy(path.join(p.dir, 'places.sqlite'), p.browser, (db) => {
        const t = firefoxBookmarkTree(db.prepare(FF_BOOKMARKS).all() as unknown as FirefoxBookmarkRow[]);
        c.bookmarks = countTree([...t.bar, ...t.other]);
        c.history = count(db, `SELECT count(*) AS n FROM moz_places WHERE last_visit_date IS NOT NULL AND hidden = 0 AND ${HTTP}`);
      });
    });
    await attempt('Addresses', () => {
      const f = path.join(p.dir, 'autofill-profiles.json');
      if (fs.existsSync(f)) c.addresses = firefoxAddresses(fs.readFileSync(f, 'utf8')).length;
    });
  }
  if (errors.length) c.errors = errors;
  return c;
}

export interface ProfileData { bookmarks?: ImportTree; history?: ImportedVisit[]; addresses?: ImportedAddress[] }

/** Read the parts asked for (the most recent HISTORY_CAP visits — AICO keeps no more). */
export async function readProfile(p: FoundProfile, what: { bookmarks?: boolean; history?: boolean; addresses?: boolean }): Promise<ProfileData> {
  const out: ProfileData = {};
  if (p.engine === 'chromium') {
    if (what.bookmarks) out.bookmarks = readChromiumBookmarks(p.dir) ?? { bar: [], other: [], skipped: 0 };
    const hist = path.join(p.dir, 'History');
    if (what.history && fs.existsSync(hist)) {
      // Chromium's times (µs since 1601) are past 2^53: read as text, or node:sqlite refuses the row.
      out.history = await withCopy(hist, p.browser, db => chromiumHistory(db.prepare(
        `SELECT url, title, visit_count, CAST(last_visit_time AS TEXT) AS last_visit_time FROM urls WHERE hidden = 0 AND ${HTTP} ORDER BY last_visit_time DESC LIMIT ${HISTORY_CAP}`,
      ).all() as Array<Record<string, unknown>>));
    }
    const web = path.join(p.dir, 'Web Data');
    if (what.addresses && fs.existsSync(web)) out.addresses = await withCopy(web, p.browser, db => chromiumAddressRows(db));
    return out;
  }
  if (what.bookmarks || what.history) {
    await withCopy(path.join(p.dir, 'places.sqlite'), p.browser, (db) => {
      if (what.bookmarks) out.bookmarks = firefoxBookmarkTree(db.prepare(FF_BOOKMARKS).all() as unknown as FirefoxBookmarkRow[]);
      if (what.history) {
        out.history = firefoxHistory(db.prepare(
          `SELECT url, title, visit_count, last_visit_date FROM moz_places WHERE last_visit_date IS NOT NULL AND hidden = 0 AND ${HTTP} ORDER BY last_visit_date DESC LIMIT ${HISTORY_CAP}`,
        ).all() as Array<Record<string, unknown>>);
      }
    });
  }
  const af = path.join(p.dir, 'autofill-profiles.json');
  if (what.addresses && fs.existsSync(af)) out.addresses = firefoxAddresses(fs.readFileSync(af, 'utf8'));
  return out;
}
