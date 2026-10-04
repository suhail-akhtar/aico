/**
 * Files for the explorer and editor.
 *
 * Deleting sends to the system trash (never a hard delete), writes are atomic,
 * and reads refuse binaries and anything over a size a code editor should be
 * asked to open. Folder watches tell the interface when something changed on
 * disk — the agent writing a file shows up in an open editor tab.
 *
 * Reading, writing, creating, renaming and trashing are scoped to the folders
 * the person opened in AICO (opened-roots.ts): a path outside is refused.
 *
 * @module desktop/electron/files
 */

import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import fg from 'fast-glob';
import type { DesktopContext } from './context';
import { zipDirectory } from './zip';
import { openedRoots } from './opened-roots';

const MAX_READ = 8 * 1024 * 1024;
const HIDDEN_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode-test']);

export interface DirEntry { name: string; path: string; dir: boolean; size: number; mtime: number; hidden: boolean }

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/*
  Quick open and @-mentions ask on every keystroke. Walking a large repository
  each time made the menu lag behind the typing, so the listing is kept for a
  few seconds per root; a new file shows up on the next walk.
*/
const LIST_TTL_MS = 8000;
const listings = new Map<string, { at: number; files: Promise<string[]> }>();
function listFiles(root: string): Promise<string[]> {
  const hit = listings.get(root);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.files;
  const files = fg(['**/*'], {
    cwd: root, dot: false, onlyFiles: true, suppressErrors: true, followSymbolicLinks: false,
    ignore: [...HIDDEN_DIRS].map(d => `**/${d}/**`),
  });
  listings.set(root, { at: Date.now(), files });
  files.catch(() => listings.delete(root));
  if (listings.size > 16) listings.delete(listings.keys().next().value!);
  return files;
}

export function registerFiles(ctx: DesktopContext): void {
  ctx.handle('fs:list', (dir: string, opts?: { showHidden?: boolean }) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const hidden = e.name.startsWith('.') || (e.isDirectory() && HIDDEN_DIRS.has(e.name));
      if (hidden && !opts?.showHidden && e.name !== '.github' && e.name !== '.aico') continue;
      let size = 0; let mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch { /* broken link */ }
      out.push({ name: e.name, path: full, dir: e.isDirectory(), size, mtime, hidden });
    }
    return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  });

  const roots = openedRoots(ctx);
  ctx.handle('fs:read', async (file: string) => {
    await roots.check(file, 'Cannot open');
    const st = fs.statSync(file);
    if (st.isDirectory()) throw new Error('That is a folder.');
    if (st.size > MAX_READ) return { binary: false, tooLarge: true, size: st.size, content: '' };
    const buf = fs.readFileSync(file);
    if (looksBinary(buf)) return { binary: true, tooLarge: false, size: st.size, content: '' };
    const text = buf.toString('utf8');
    return { binary: false, tooLarge: false, size: st.size, mtime: st.mtimeMs, content: text, eol: text.includes('\r\n') ? 'crlf' : 'lf' };
  });

  ctx.handle('fs:readDataUrl', async (file: string) => {
    await roots.check(file, 'Cannot preview');
    const st = fs.statSync(file);
    if (st.size > 30 * 1024 * 1024) throw new Error('Too large to preview.');
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  });

  ctx.handle('fs:write', async (file: string, content: string) => {
    await roots.check(file, 'Cannot save');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.aico-${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return fs.statSync(file).mtimeMs;
  });

  ctx.handle('fs:create', async (target: string, kind: 'file' | 'dir') => {
    await roots.check(target, 'Cannot create');
    if (fs.existsSync(target)) throw new Error(`${path.basename(target)} already exists.`);
    if (kind === 'dir') fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ''); }
    return target;
  });

  ctx.handle('fs:rename', async (from: string, to: string) => {
    await roots.check(from, 'Cannot rename');
    await roots.check(to, 'Cannot rename');
    if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists.`);
    fs.renameSync(from, to);
    return to;
  });

  /** To the recycle bin / trash — recoverable, on purpose. */
  ctx.handle('fs:trash', async (target: string) => { await roots.check(target, 'Cannot delete'); await shell.trashItem(target); return true; });

  /**
   * Zip a folder to a file. With `rootName` every entry sits under that one
   * top-level folder — the `.skill` layout (`<skill-name>/SKILL.md` + files).
   */
  ctx.handle('fs:zipDir', (srcDir: string, destFile: string, rootName?: string) => zipDirectory(srcDir, destFile, rootName));

  ctx.handle('fs:stat', (p: string) => {
    try { const st = fs.statSync(p); return { exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }
    catch { return { exists: false, dir: false, size: 0, mtime: 0 }; }
  });

  /** Quick-open and @-mentions: files under a root matching a query. */
  ctx.handle('fs:find', async (root: string, query: string, limit?: number) => {
    const files = await listFiles(root);
    const q = query.toLowerCase().replace(/\\/g, '/');
    const scored: Array<[number, string]> = [];
    for (const f of files) {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      let score = -1;
      if (!q) score = 1;
      else if (base === q) score = 1000;
      else if (base.startsWith(q)) score = 800 - base.length;
      else if (base.includes(q)) score = 600 - base.indexOf(q);
      else if (lower.includes(q)) score = 400 - lower.indexOf(q) / 10;
      if (score >= 0) scored.push([score - f.length / 100, f]);
      if (scored.length > 5000) break;
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit ?? 60).map(([, f]) => path.join(root, f));
  });

  /** Search inside files (a small grep for the Files view). */
  ctx.handle('fs:grep', async (root: string, pattern: string, opts?: { regex?: boolean; caseSensitive?: boolean; limit?: number }) => {
    const re = opts?.regex ? new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts?.caseSensitive ? 'g' : 'gi');
    const files = await fg(['**/*'], { cwd: root, onlyFiles: true, suppressErrors: true, ignore: [...HIDDEN_DIRS].map(d => `**/${d}/**`) });
    const hits: Array<{ file: string; line: number; text: string }> = [];
    const limit = opts?.limit ?? 500;
    for (const f of files) {
      const full = path.join(root, f);
      let buf: Buffer;
      try { const st = fs.statSync(full); if (st.size > 2 * 1024 * 1024) continue; buf = fs.readFileSync(full); } catch { continue; }
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i]!)) {
          hits.push({ file: full, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  });

  // Watches: one per root the interface asks about.
  const watches = new Map<string, fs.FSWatcher>();
  ctx.handle('fs:watch', (root: string) => {
    if (watches.has(root)) return true;
    try {
      let timer: NodeJS.Timeout | null = null;
      const changed = new Set<string>();
      const w = fs.watch(root, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const n = String(name);
        if (n.split(/[\\/]/).some(part => HIDDEN_DIRS.has(part))) return;
        changed.add(path.join(root, n));
        if (timer) return;
        timer = setTimeout(() => { timer = null; ctx.emit('fs:changed', { root, paths: [...changed] }); changed.clear(); }, 250);
      });
      watches.set(root, w);
      return true;
    } catch { return false; }
  });
  ctx.handle('fs:unwatch', (root: string) => { watches.get(root)?.close(); watches.delete(root); });
}
