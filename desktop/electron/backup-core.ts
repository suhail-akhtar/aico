/**
 * Backing up and restoring the AICO home — the part of a backup that does not
 * need Electron, so it can be tested end to end against a temporary folder.
 *
 * WHAT A BACKUP IS FOR. Moving to another machine. So it holds what you made
 * and configured — settings (with the project and group lists inside them),
 * the desktop's prefs and plugins, your skills and agents, memories and
 * knowledge, scheduled jobs, which registry entries are switched off, your app
 * templates — and, only if asked, the chats. It does not hold caches (codemap,
 * learning, drafts, todos, the work ledger): those rebuild themselves, and
 * carrying them to a machine with different paths would only mislead.
 *
 * API KEYS ARE LEFT OUT BY DEFAULT. A backup file gets copied to USB sticks
 * and cloud folders. Stripping removes every credential-shaped key (`apiKey`,
 * `token`, `…_API_KEY`, an `Authorization` header) wherever it sits in
 * `settings.json`. Restoring a stripped backup then keeps the keys this
 * machine already has, rather than wiping them because the file had none.
 *
 * Layout: `manifest.json` at the root and every file under `home/<path>`.
 *
 * @module desktop/electron/backup-core
 */

import fs from 'node:fs';
import path from 'node:path';
import { ZipReader, ZipWriter, walk, safeEntryPath } from './zip';

export const BACKUP_FORMAT = 'aico-backup';
export const BACKUP_VERSION = 1;

export type BackupCategory = 'settings' | 'desktop' | 'plugins' | 'skills' | 'agents' | 'memory' | 'schedules' | 'state' | 'chats';

interface CategoryDef {
  id: BackupCategory;
  label: string;
  /** Files, or folders ending in "/", relative to the AICO home. */
  paths: string[];
}

/** What goes into a backup, in the order it is described. Chats are added only on request. */
export const CATEGORIES: CategoryDef[] = [
  { id: 'settings', label: 'Settings, providers, projects and groups', paths: ['settings.json'] },
  { id: 'desktop', label: 'Desktop preferences', paths: ['desktop/prefs.json'] },
  { id: 'plugins', label: 'Desktop plugins', paths: ['desktop/plugins/'] },
  { id: 'skills', label: 'Skills', paths: ['skills/'] },
  { id: 'agents', label: 'Agents', paths: ['agents/'] },
  { id: 'memory', label: 'Memory and knowledge', paths: ['memories/', 'memory/', 'knowledge/', 'AICO.md', 'USER.md'] },
  { id: 'schedules', label: 'Scheduled jobs', paths: ['cron.json'] },
  { id: 'state', label: 'Switched-off skills, MCP servers and agents; app templates', paths: ['registry-state.json', 'templates/'] },
  { id: 'chats', label: 'Chats', paths: ['projects/', 'workspace/projects/*/sessions/'] },
];

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  app: string;
  engine: string;
  platform: string;
  includes: BackupCategory[];
  apiKeys: boolean;
  chats: boolean;
  files: number;
  counts: Partial<Record<BackupCategory, number>>;
}

export interface BackupOptions {
  includeApiKeys?: boolean;
  includeChats?: boolean;
  /** Only these categories (the pre-restore safety copy uses the incoming backup's list). */
  only?: BackupCategory[];
}

// ── Credentials ──────────────────────────────────────────────────────────────

const SECRET_NAME = /^(?:x-)?(?:api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|bearer|authorization|private[-_]?key|cookie)$|(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PAT|_KEY)$/i;

/** Whether a settings key holds a credential (only string values are ever treated as one). */
export function isSecretKey(key: string): boolean {
  return SECRET_NAME.test(key);
}

/** A copy of `value` with every credential removed, and how many were. */
export function stripCredentials<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (typeof child === 'string' && isSecretKey(k)) { removed++; continue; }
      out[k] = visit(child);
    }
    return out;
  };
  return { value: visit(value) as T, removed };
}

/** An array element's identity, so a key follows its provider even if the order changed. */
function identity(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of ['id', 'name', 'type']) if (typeof o[k] === 'string') return `${k}:${o[k]}`;
  return null;
}

/**
 * Put this machine's credentials back into settings restored from a stripped
 * backup: wherever the current settings have a key and the incoming ones have
 * the same object without it, the current key is kept. Nothing is added to an
 * object the backup does not have (a provider you removed stays removed).
 */
export function restoreCredentials<T>(incoming: T, current: unknown): { value: T; kept: number } {
  let kept = 0;
  const merge = (inc: unknown, cur: unknown): unknown => {
    if (Array.isArray(inc) && Array.isArray(cur)) {
      return inc.map((item, i) => {
        const id = identity(item);
        const match = id ? cur.find(c => identity(c) === id) : cur[i];
        return match === undefined ? item : merge(item, match);
      });
    }
    if (!inc || typeof inc !== 'object' || !cur || typeof cur !== 'object' || Array.isArray(inc) || Array.isArray(cur)) return inc;
    const out: Record<string, unknown> = { ...(inc as Record<string, unknown>) };
    for (const [k, c] of Object.entries(cur as Record<string, unknown>)) {
      if (typeof c === 'string' && isSecretKey(k)) {
        if (!(k in out)) { out[k] = c; kept++; }
      } else if (k in out) {
        out[k] = merge(out[k], c);
      }
    }
    return out;
  };
  return { value: merge(incoming, current) as T, kept };
}

// ── Collecting ───────────────────────────────────────────────────────────────

/** Expand one category path (`dir/`, `file`, or one `*` folder wildcard) into home-relative file paths. */
function expand(home: string, spec: string): string[] {
  if (spec.includes('*')) {
    const [before, after] = spec.split('*') as [string, string];
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(home, before), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
    return names.flatMap(n => expand(home, `${before}${n}${after}`));
  }
  const abs = path.join(home, spec);
  if (spec.endsWith('/')) {
    return walk(abs, (rel) => !/\.(tmp|lock)$/i.test(rel)).filter(r => !r.endsWith('/')).map(r => spec + r);
  }
  try { return fs.statSync(abs).isFile() ? [spec] : []; } catch { return []; }
}

/**
 * Never in a backup, whatever a category says: the browser's saved passwords
 * (desktop/browser/vault.bin). It is sealed with this machine's OS keychain, so
 * it would not open anywhere else — and a backup file is exactly what should
 * not carry passwords around. Move them with the Passwords page's CSV export.
 */
export const NEVER_BACKED_UP = /^desktop\/browser\/vault\.bin(\.tmp)?$/i;

/** The files a backup with these options would hold, by category. */
export function collect(home: string, opts: BackupOptions = {}): Map<BackupCategory, string[]> {
  const out = new Map<BackupCategory, string[]>();
  for (const c of CATEGORIES) {
    if (c.id === 'chats' && !opts.includeChats) continue;
    if (opts.only && !opts.only.includes(c.id)) continue;
    const files = [...new Set(c.paths.flatMap(p => expand(home, p)))].filter(f => !NEVER_BACKED_UP.test(f.replace(/\\/g, '/')));
    if (files.length) out.set(c.id, files);
  }
  return out;
}

/** Which category a home-relative path belongs to, or null when it is none of a backup's business. */
export function categoryOf(rel: string): BackupCategory | null {
  const r = rel.replace(/\\/g, '/');
  if (NEVER_BACKED_UP.test(r)) return null;
  for (const c of CATEGORIES) {
    for (const p of c.paths) {
      if (p.includes('*')) {
        const [before, after] = p.split('*') as [string, string];
        if (r.startsWith(before)) {
          const rest = r.slice(before.length);
          const slash = rest.indexOf('/');
          if (slash > 0 && rest.slice(slash).startsWith(after) && rest.length > slash + after.length) return c.id;
        }
      } else if (p.endsWith('/') ? r.startsWith(p) && r.length > p.length : r === p) {
        return c.id;
      }
    }
  }
  return null;
}

export async function exportBackup(
  home: string,
  destFile: string,
  opts: BackupOptions,
  meta: { app: string; engine: string },
): Promise<{ file: string; files: number; bytes: number; manifest: BackupManifest }> {
  const groups = collect(home, opts);
  const w = await ZipWriter.create(destFile);
  const counts: Partial<Record<BackupCategory, number>> = {};
  let files = 0;
  try {
    for (const [cat, list] of groups) {
      for (const rel of list) {
        const abs = path.join(home, rel);
        if (rel === 'settings.json' && !opts.includeApiKeys) {
          let text: string;
          try {
            text = JSON.stringify(stripCredentials(JSON.parse(fs.readFileSync(abs, 'utf8'))).value, null, 2);
          } catch {
            // A settings file that does not parse cannot be stripped reliably, so it is not copied at all.
            continue;
          }
          await w.addFile(`home/${rel}`, text, fs.statSync(abs).mtime);
        } else {
          try { await w.addPath(`home/${rel}`, abs); } catch { continue; /* vanished while walking */ }
        }
        counts[cat] = (counts[cat] ?? 0) + 1;
        files++;
      }
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      app: meta.app,
      engine: meta.engine,
      platform: process.platform,
      includes: [...groups.keys()],
      apiKeys: Boolean(opts.includeApiKeys),
      chats: Boolean(opts.includeChats) && groups.has('chats'),
      files,
      counts,
    };
    await w.addFile('manifest.json', JSON.stringify(manifest, null, 2));
    const bytes = await w.finish();
    return { file: destFile, files, bytes, manifest };
  } catch (err) {
    await w.abort();
    throw err;
  }
}

// ── Reading and restoring ────────────────────────────────────────────────────

export interface BackupPreview {
  file: string;
  manifest: BackupManifest;
  /** What will be restored, per category, in display order. */
  summary: Array<{ id: BackupCategory; label: string; files: number }>;
  /** Entries that are not part of any category (or would escape the home) and will be skipped. */
  ignored: number;
}

function validManifest(m: unknown): m is BackupManifest {
  const o = m as Partial<BackupManifest> | null;
  return Boolean(o && o.format === BACKUP_FORMAT && typeof o.version === 'number' && Array.isArray(o.includes));
}

export async function readBackup(file: string): Promise<BackupPreview> {
  const r = await ZipReader.open(file);
  try {
    const entry = r.find('manifest.json');
    if (!entry) throw new Error('This is not an AICO backup (there is no manifest.json in it).');
    let manifest: unknown;
    try { manifest = JSON.parse((await r.read(entry)).toString('utf8')); } catch { throw new Error('The backup\'s manifest.json is not valid JSON.'); }
    if (!validManifest(manifest)) throw new Error('This is not an AICO backup (its manifest is not one).');
    if (manifest.version > BACKUP_VERSION) throw new Error(`This backup was made by a newer AICO (format ${manifest.version}); update AICO to restore it.`);
    const counts = new Map<BackupCategory, number>();
    let ignored = 0;
    for (const e of r.entries) {
      if (e.dir || e.name === 'manifest.json') continue;
      const rel = e.name.startsWith('home/') ? e.name.slice(5) : null;
      const cat = rel && safeEntryPath('/', rel) ? categoryOf(rel) : null;
      if (!cat) { ignored++; continue; }
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    const summary = CATEGORIES.filter(c => counts.has(c.id)).map(c => ({ id: c.id, label: c.label, files: counts.get(c.id)! }));
    return { file, manifest, summary, ignored };
  } finally {
    await r.close();
  }
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * Restore a backup into `home`.
 *
 * Order matters for not losing anything: the files about to be replaced are
 * first zipped to `backups/pre-restore-<date>.zip`; the archive is unpacked
 * into a staging folder inside the home (same volume, so the final step is a
 * rename); only when every entry unpacked cleanly are files moved into place.
 * Files the backup does not mention are left alone — this merges, it does not
 * wipe.
 */
export async function restoreBackup(
  home: string,
  file: string,
  meta: { app: string; engine: string },
): Promise<{ restored: number; safetyCopy: string; keptKeys: number; preview: BackupPreview }> {
  const preview = await readBackup(file);
  const cats = preview.summary.map(s => s.id);
  const safetyCopy = path.join(home, 'backups', `pre-restore-${stamp()}.zip`);
  await exportBackup(home, safetyCopy, { includeApiKeys: true, includeChats: cats.includes('chats'), only: cats }, meta);

  const staging = path.join(home, `.restore-${stamp()}`);
  const moves: Array<[string, string]> = [];
  let keptKeys = 0;
  const r = await ZipReader.open(file);
  try {
    for (const e of r.entries) {
      if (e.dir || !e.name.startsWith('home/')) continue;
      const rel = e.name.slice(5);
      const staged = safeEntryPath(staging, rel);
      const target = safeEntryPath(home, rel);
      if (!staged || !target || !categoryOf(rel)) continue;
      let data = await r.read(e);
      if (rel === 'settings.json' && !preview.manifest.apiKeys) {
        try {
          const current = JSON.parse(fs.readFileSync(target, 'utf8'));
          const merged = restoreCredentials(JSON.parse(data.toString('utf8')), current);
          keptKeys = merged.kept;
          data = Buffer.from(JSON.stringify(merged.value, null, 2), 'utf8');
        } catch { /* no current settings (or unreadable): nothing to keep */ }
      }
      await fs.promises.mkdir(path.dirname(staged), { recursive: true });
      await fs.promises.writeFile(staged, data);
      moves.push([staged, target]);
    }
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await r.close();
  }

  for (const [from, to] of moves) {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.promises.rename(from, to);
    } catch {
      // Another volume, or a file held open for a moment: copy instead.
      await fs.promises.copyFile(from, to);
    }
  }
  await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  return { restored: moves.length, safetyCopy, keptKeys, preview };
}
