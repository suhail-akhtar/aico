/**
 * Bookmarks in and out, as pure text work: Chromium's `Bookmarks` JSON (Chrome,
 * Edge, Brave), the Netscape bookmarks HTML every browser exports and imports
 * (Firefox's "Export bookmarks to HTML" among them), and where the Chromium
 * browsers keep their profiles on each OS. No Electron and no file access
 * here — browser-bookmarks.ts does the reading, only when the person asks.
 *
 * What is brought in: web and file bookmarks (http, https, ftp, file).
 * `javascript:` bookmarklets and Firefox's `place:` queries are skipped and
 * counted — a bookmarklet from another browser is code that would run in
 * whatever page is open, which an import should not bring along silently.
 *
 * @module desktop/electron/browser-bookmarks-io
 */

import type { BookmarkNode, BookmarkTree } from '../shared/browser-types';
import { BAR_ID, type ImportNode } from '../shared/bookmark-tree';

/** A parsed file: what was on its bookmarks bar, and everything else. */
export interface ImportTree { bar: ImportNode[]; other: ImportNode[]; skipped: number }

const MAX_NODES = 100_000;
const MAX_ICON = 16_384;

export function acceptImportUrl(url: string): boolean {
  return /^(https?|ftp|file):/i.test(url.trim());
}

// ── Chromium: <profile>/Bookmarks ──

/** Chromium stores times as microseconds since 1601-01-01. */
export function fromWebkitTime(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = Math.round(n / 1000 - 11_644_473_600_000);
  return ms > 0 ? ms : undefined;
}

interface ChromiumNode { type?: string; name?: string; url?: string; date_added?: string; children?: ChromiumNode[] }

export function parseChromiumBookmarks(text: string): ImportTree {
  const data = JSON.parse(text.replace(/^﻿/, '')) as { roots?: Record<string, ChromiumNode> };
  if (!data || typeof data !== 'object' || !data.roots || typeof data.roots !== 'object') throw new Error('This is not a Chromium bookmarks file.');
  let skipped = 0; let seen = 0;
  const conv = (list: ChromiumNode[] | undefined, depth: number): ImportNode[] => {
    const out: ImportNode[] = [];
    for (const n of list ?? []) {
      if (++seen > MAX_NODES || depth > 64 || !n || typeof n !== 'object') break;
      const addedAt = fromWebkitTime(n.date_added);
      if (n.type === 'folder' || Array.isArray(n.children)) {
        out.push({ title: String(n.name ?? ''), ...(addedAt ? { addedAt } : {}), children: conv(n.children, depth + 1) });
      } else if (typeof n.url === 'string') {
        if (acceptImportUrl(n.url)) out.push({ title: String(n.name ?? ''), url: n.url, ...(addedAt ? { addedAt } : {}) });
        else skipped++;
      }
    }
    return out;
  };
  const r = data.roots;
  const other = [...conv(r.other?.children, 1)];
  const synced = conv(r.synced?.children, 1);
  if (synced.length) other.push({ title: r.synced?.name || 'Mobile bookmarks', children: synced });
  return { bar: conv(r.bookmark_bar?.children, 1), other, skipped };
}

// ── Netscape bookmarks HTML ──

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) { const c = parseInt(k.slice(2), 16); return Number.isFinite(c) && c <= 0x10ffff ? String.fromCodePoint(c) : m; }
    if (k.startsWith('#')) { const c = parseInt(k.slice(1), 10); return Number.isFinite(c) && c <= 0x10ffff ? String.fromCodePoint(c) : m; }
    return ENTITIES[k] ?? m;
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

const seconds = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : undefined;
};

/**
 * Read a Netscape bookmarks file. Browsers write it as loose HTML (`<DT>`
 * never closed, `<p>` after every `<DL>`), so this follows the tags that
 * matter — `<H3>` names the folder whose `<DL>` comes next, `<A>` is a
 * bookmark, `</DL>` closes the folder — and ignores the rest. The folder a
 * browser marks as its toolbar (PERSONAL_TOOLBAR_FOLDER) becomes the bar.
 */
export function parseNetscapeHtml(html: string): ImportTree {
  if (!/<dl/i.test(html) || !/<a\s|<h3/i.test(html)) throw new Error('This is not a bookmarks HTML file.');
  const top: ImportNode = { title: '', children: [] };
  const stack: ImportNode[] = [top];
  let pending: { node: ImportNode; toolbar: boolean } | null = null;
  let toolbar: ImportNode | null = null;
  let opened = 0;
  let skipped = 0; let seen = 0;
  const re = /<(\/?)(dl|h3|a)\b([^>]*)>([\s\S]*?)(?=<)/gi;
  // A leading guard so the last tag's text is captured too.
  const src = `${html}<`;
  for (const m of src.matchAll(re)) {
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (tag === 'dl') {
      if (closing) {
        if (opened > 0) { stack.pop(); opened--; }
        pending = null;
        continue;
      }
      if (opened === 0 && !pending) { opened++; stack.push(top); continue; }
      const folder = pending?.node ?? { title: 'Folder', children: [] };
      if (!pending) stack[stack.length - 1]!.children!.push(folder);
      if (pending?.toolbar && !toolbar) toolbar = folder;
      pending = null;
      if (stack.length > 64) { skipped++; continue; }
      stack.push(folder); opened++;
      continue;
    }
    if (closing) continue;
    if (++seen > MAX_NODES) break;
    const a = attrs(m[3] ?? '');
    const text = decodeEntities((m[4] ?? '').replace(/<[^>]*>/g, '')).trim();
    const parent = stack[stack.length - 1]!;
    if (tag === 'h3') {
      const node: ImportNode = { title: text, ...(seconds(a.add_date) ? { addedAt: seconds(a.add_date) } : {}), children: [] };
      parent.children!.push(node);
      pending = { node, toolbar: parent === top && /^true$/i.test(a.personal_toolbar_folder ?? '') };
    } else if (tag === 'a') {
      pending = null;
      const href = (a.href ?? '').trim();
      if (!href || !acceptImportUrl(href)) { skipped++; continue; }
      const icon = a.icon && /^data:image\//i.test(a.icon) && a.icon.length <= MAX_ICON ? a.icon : undefined;
      parent.children!.push({ title: text, url: href, ...(seconds(a.add_date) ? { addedAt: seconds(a.add_date) } : {}), ...(icon ? { favicon: icon } : {}) });
    }
  }
  const other = top.children!.filter(n => n !== toolbar);
  return { bar: toolbar?.children ?? [], other, skipped };
}

/** What goes into the "Imported from …" folder: the bar's bookmarks, then the rest (in a folder of its own when both exist). */
export function importContents(t: ImportTree): ImportNode[] {
  if (!t.bar.length) return t.other;
  if (!t.other.length) return t.bar;
  return [...t.bar, { title: 'Other bookmarks', children: t.other }];
}

/**
 * The tree as a Netscape bookmarks file — the format Chrome, Edge, Firefox
 * and Safari all import. The bookmarks bar is marked as the toolbar folder,
 * and Other bookmarks follow at the top level, as Chrome writes them.
 */
export function toNetscapeHtml(tree: BookmarkTree): string {
  const secs = (ms: number): string => String(Math.max(0, Math.floor(ms / 1000)));
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const write = (n: BookmarkNode, depth: number, toolbar = false): void => {
    const pad = '    '.repeat(depth);
    if (n.children) {
      lines.push(`${pad}<DT><H3 ADD_DATE="${secs(n.addedAt)}"${toolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : ''}>${escapeHtml(n.title)}</H3>`);
      lines.push(`${pad}<DL><p>`);
      for (const c of n.children) write(c, depth + 1);
      lines.push(`${pad}</DL><p>`);
    } else if (n.url) {
      const icon = n.favicon && /^data:image\//i.test(n.favicon) ? ` ICON="${escapeHtml(n.favicon)}"` : '';
      lines.push(`${pad}<DT><A HREF="${escapeHtml(n.url)}" ADD_DATE="${secs(n.addedAt)}"${icon}>${escapeHtml(n.title)}</A>`);
    }
  };
  for (const root of tree.roots) {
    if (root.id === BAR_ID) write(root, 1, true);
    else for (const c of root.children ?? []) write(c, 1);
  }
  lines.push('</DL><p>');
  return `${lines.join('\n')}\n`;
}

// ── Where Chromium browsers keep their profiles ──

export interface ChromiumInstall { browser: string; dir: string }

/** The "User Data" folders of Chrome, Edge and Brave on this OS (whether or not they exist). */
export function chromiumInstalls(platform: string, env: Record<string, string | undefined>, home: string): ChromiumInstall[] {
  const j = (...p: string[]): string => p.join(platform === 'win32' ? '\\' : '/');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
    return [
      { browser: 'Chrome', dir: j(local, 'Google', 'Chrome', 'User Data') },
      { browser: 'Edge', dir: j(local, 'Microsoft', 'Edge', 'User Data') },
      { browser: 'Brave', dir: j(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    ];
  }
  if (platform === 'darwin') {
    const sup = j(home, 'Library', 'Application Support');
    return [
      { browser: 'Chrome', dir: j(sup, 'Google', 'Chrome') },
      { browser: 'Edge', dir: j(sup, 'Microsoft Edge') },
      { browser: 'Brave', dir: j(sup, 'BraveSoftware', 'Brave-Browser') },
    ];
  }
  const cfg = env.XDG_CONFIG_HOME || j(home, '.config');
  return [
    { browser: 'Chrome', dir: j(cfg, 'google-chrome') },
    { browser: 'Chromium', dir: j(cfg, 'chromium') },
    { browser: 'Edge', dir: j(cfg, 'microsoft-edge') },
    { browser: 'Brave', dir: j(cfg, 'BraveSoftware', 'Brave-Browser') },
  ];
}

/** Profile folder → the name the person gave it, from the browser's `Local State`. */
export function profileNames(localState: string): Record<string, string> {
  try {
    const cache = (JSON.parse(localState) as { profile?: { info_cache?: Record<string, { name?: string }> } }).profile?.info_cache ?? {};
    const out: Record<string, string> = {};
    for (const [dir, info] of Object.entries(cache)) if (typeof info?.name === 'string' && info.name.trim()) out[dir] = info.name.trim();
    return out;
  } catch { return {}; }
}

/** Is this folder name a browser profile ("Default", "Profile 3")? */
export const isProfileDir = (name: string): boolean => name === 'Default' || /^Profile \d+$/.test(name);
