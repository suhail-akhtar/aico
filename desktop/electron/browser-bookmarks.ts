/**
 * Bookmarks for the built-in browser: the tree in bookmarks.json, its IPC,
 * the native right-click menu the bar and the manager use, and import/export.
 *
 * Main is the only writer. Every change is pushed to the interface as
 * `browser:bookmarks` (the whole snapshot — a tree of a few thousand entries
 * is small, and one message means the bar, the open menus and the manager can
 * never disagree), and the invoke that made it returns the same snapshot.
 *
 * Earlier versions kept a flat list; the first start of this one migrates it
 * (see migrateLegacy for where things go) and leaves the old file beside the
 * new as bookmarks.v1.json, so nothing is lost even if the move were wrong.
 *
 * Import reads other browsers' files only when the person picks one, and only
 * reads: Chrome / Edge / Brave profiles from their standard places, Firefox
 * and anything else through an exported bookmarks HTML file they choose.
 *
 * @module desktop/electron/browser-bookmarks
 */

import { app, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesktopContext } from './context';
import type {
  Bookmark, BookmarkBarMode, BookmarkImportResult, BookmarkImportSource, BookmarkInput, BookmarkMenuItem, BookmarksSnapshot, BookmarkTree,
} from '../shared/browser-types';
import {
  addImported, BAR_ID, createBookmark, createFolder, emptyTree, flattenBookmarks, JsonFile, moveNodes, normaliseTree,
  removeByUrl, removeNodes, sortFolder, updateNode, upsertBookmark, type BrowserSettings,
} from './browser-store';
import {
  chromiumInstalls, importContents, isProfileDir, parseChromiumBookmarks, parseNetscapeHtml, profileNames, toNetscapeHtml, type ImportTree,
} from './browser-bookmarks-io';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface BookmarksHandle {
  flush(): void;
  tree(): BookmarkTree;
  /** Add a parsed import as a new folder on the bar (the import centre, browser-import.ts). */
  importTree(parsed: ImportTree, title: string): { count: number; title: string; skipped: number };
  /** A new folder on the bar holding these pages (tidying tabs, browser-learn.ts); its id. */
  addTabs(c: { title?: string; items: Array<{ url: string; title?: string }> }): string;
}

interface FoundProfile { source: BookmarkImportSource; file: string }

/** The Chromium profiles on this machine that have bookmarks (their names come from `Local State`). Reads, never writes. */
function findChromiumProfiles(): FoundProfile[] {
  const out: FoundProfile[] = [];
  for (const inst of chromiumInstalls(process.platform, process.env, os.homedir())) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(inst.dir).filter(isProfileDir); } catch { continue; }
    let names: Record<string, string> = {};
    try { names = profileNames(fs.readFileSync(path.join(inst.dir, 'Local State'), 'utf8')); } catch { /* no names: use the folder's */ }
    dirs.sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true })));
    for (const d of dirs) {
      // Listed by whether the file is there; its contents are read only once this profile is picked.
      const file = path.join(inst.dir, d, 'Bookmarks');
      if (!fs.existsSync(file)) continue;
      out.push({ file, source: { id: `chromium:${inst.browser}:${d}`, browser: inst.browser, profile: names[d] ?? d, kind: 'chromium' } });
    }
  }
  return out;
}

export function registerBookmarks(ctx: DesktopContext, o: { dataDir: string; settings: JsonFile<BrowserSettings> }): BookmarksHandle {
  const fileName = path.join(o.dataDir, 'bookmarks.json');
  // Keep the flat list of an earlier version beside the tree it becomes.
  try {
    const raw = JSON.parse(fs.readFileSync(fileName, 'utf8')) as unknown;
    const backup = path.join(o.dataDir, 'bookmarks.v1.json');
    if (Array.isArray(raw) && !fs.existsSync(backup)) fs.copyFileSync(fileName, backup);
  } catch { /* first run, or nothing to keep */ }
  const file = new JsonFile<BookmarkTree>(fileName, emptyTree(), raw => normaliseTree(raw));

  let undo: { before: BookmarkTree; after: BookmarkTree } | null = null;
  const barMode = (): BookmarkBarMode => o.settings.get().bookmarksBar ?? 'always';
  const snapshot = (): BookmarksSnapshot => ({ tree: file.get(), bar: barMode() });
  const commit = (next: BookmarkTree): BookmarksSnapshot => {
    if (next !== file.get()) file.set(next);
    const s = snapshot();
    ctx.emit('browser:bookmarks', s);
    return s;
  };
  const flatOf = (id: string): Bookmark | undefined => flattenBookmarks(file.get()).find(b => b.id === id);
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');

  // ── The flat interface earlier chrome (and the star) use ──
  ctx.handle('browser:bookmarks:list', () => flattenBookmarks(file.get()));
  ctx.handle('browser:bookmarks:add', (b: BookmarkInput) => {
    const r = upsertBookmark(file.get(), b, Date.now());
    commit(r.tree);
    return flatOf(r.node.id);
  });
  ctx.handle('browser:bookmarks:remove', (url: string) => { commit(removeByUrl(file.get(), String(url))); return true; });

  // ── The tree ──
  ctx.handle('browser:bookmarks:get', () => snapshot());
  ctx.handle('browser:bookmarks:create', (c: { parentId?: string; index?: number; title?: string; url?: string; favicon?: string }) => {
    const parentId = c?.parentId || BAR_ID;
    const r = typeof c?.url === 'string'
      ? createBookmark(file.get(), { parentId, index: c.index, title: c.title, url: c.url, favicon: c.favicon }, Date.now())
      : createFolder(file.get(), { parentId, index: c?.index, title: c?.title }, Date.now());
    commit(r.tree);
    return r.node;
  });
  ctx.handle('browser:bookmarks:update', (id: string, patch: { title?: string; url?: string; favicon?: string }) => commit(updateNode(file.get(), String(id), patch ?? {})));
  ctx.handle('browser:bookmarks:move', (which: string | string[], parentId: string, index?: number) =>
    commit(moveNodes(file.get(), ids(which), String(parentId), typeof index === 'number' ? index : undefined)));
  ctx.handle('browser:bookmarks:delete', (which: string | string[]) => {
    const before = file.get();
    const after = removeNodes(before, ids(which));
    undo = { before, after };
    commit(after);
    return { removed: flattenBookmarks(before).length - flattenBookmarks(after).length };
  });
  /** Put back the last delete — only while nothing else has changed since. */
  ctx.handle('browser:bookmarks:undo', () => {
    if (!undo || file.get() !== undo.after) return false;
    const { before } = undo;
    undo = null;
    commit(before);
    return true;
  });
  ctx.handle('browser:bookmarks:sort', (id: string) => commit(sortFolder(file.get(), String(id))));
  const addTabs = (c: { parentId?: string; title?: string; items: Array<{ url: string; title?: string; favicon?: string }> }): string => {
    const now = Date.now();
    let r = createFolder(file.get(), { parentId: c?.parentId || BAR_ID, title: c?.title }, now);
    const folderId = r.node.id;
    let tree = r.tree;
    for (const t of (c?.items ?? []).filter(i => i && typeof i.url === 'string' && /^(https?|file|ftp):/i.test(i.url))) {
      r = createBookmark(tree, { parentId: folderId, url: t.url, title: t.title, favicon: t.favicon }, now);
      tree = r.tree;
    }
    commit(tree);
    return folderId;
  };
  ctx.handle('browser:bookmarks:addTabs', addTabs);
  ctx.handle('browser:bookmarks:barMode', (mode: BookmarkBarMode) => {
    if (mode !== 'always' && mode !== 'newtab' && mode !== 'never') throw new Error(`Unknown bookmarks bar setting: ${String(mode)}`);
    o.settings.set({ ...o.settings.get(), bookmarksBar: mode });
    return commit(file.get());
  });

  // ── A native menu: drawn above the page view, so it never needs the page hidden ──
  ctx.handle('browser:bookmarks:menu', (items: BookmarkMenuItem[]) => new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v); } };
    const template: MenuItemConstructorOptions[] = (Array.isArray(items) ? items : []).map((i): MenuItemConstructorOptions => {
      if ('type' in i) return { type: 'separator' };
      return {
        label: String(i.label), enabled: i.enabled ?? true,
        ...(typeof i.checked === 'boolean' ? { type: 'checkbox' as const, checked: i.checked } : {}),
        ...(i.accelerator ? { accelerator: i.accelerator, registerAccelerator: false } : {}),
        click: () => finish(i.id),
      };
    });
    if (!template.length) { finish(null); return; }
    // The click arrives just after the menu closes on some platforms: give it a moment before calling it dismissed.
    Menu.buildFromTemplate(template).popup({ window: ctx.browserWindow() ?? undefined, callback: () => setTimeout(() => finish(null), 80) });
  }));

  // ── Import and export ──
  ctx.handle('browser:bookmarks:importSources', (): BookmarkImportSource[] => [
    ...findChromiumProfiles().map(p => p.source),
    { id: 'html:firefox', browser: 'Firefox', profile: 'exported bookmarks HTML file', kind: 'html' },
    { id: 'html:file', browser: 'Bookmarks HTML file', kind: 'html' },
  ]);
  ctx.handle('browser:bookmarks:import', async (sourceId: string): Promise<BookmarkImportResult | null> => {
    const id = String(sourceId);
    let parsed; let title: string;
    if (id.startsWith('chromium:')) {
      const found = findChromiumProfiles();
      const hit = found.find(p => p.source.id === id);
      if (!hit) throw new Error('That browser profile was not found any more.');
      parsed = parseChromiumBookmarks(fs.readFileSync(hit.file, 'utf8'));
      const several = found.filter(p => p.source.browser === hit.source.browser).length > 1;
      title = `Imported from ${hit.source.browser}${several && hit.source.profile ? ` (${hit.source.profile})` : ''}`;
    } else if (id === 'html:firefox' || id === 'html:file') {
      const w = ctx.browserWindow();
      const opts = {
        title: id === 'html:firefox' ? 'Choose the bookmarks file exported from Firefox' : 'Choose a bookmarks HTML file',
        defaultPath: app.getPath('downloads'),
        properties: ['openFile' as const],
        filters: [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }, { name: 'All files', extensions: ['*'] }],
      };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      const picked = r.filePaths[0];
      if (r.canceled || !picked) return null;
      if (fs.statSync(picked).size > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a bookmarks file.');
      parsed = parseNetscapeHtml(fs.readFileSync(picked, 'utf8'));
      title = id === 'html:firefox' ? 'Imported from Firefox' : `Imported from ${path.basename(picked).replace(/\.html?$/i, '')}`;
    } else {
      throw new Error(`Unknown import source: ${id}`);
    }
    const r = addImported(file.get(), BAR_ID, title, importContents(parsed), Date.now());
    commit(r.tree);
    file.flush();
    return { folderId: r.folder.id, title, count: r.count, skipped: parsed.skipped };
  });
  ctx.handle('browser:bookmarks:export', async (): Promise<string | null> => {
    const w = ctx.browserWindow();
    const d = new Date();
    const name = `bookmarks_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}.html`;
    const opts = { title: 'Export bookmarks', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Bookmarks HTML', extensions: ['html'] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, toNetscapeHtml(file.get()), 'utf8');
    return r.filePath;
  });

  return {
    flush: () => file.flush(),
    tree: () => file.get(),
    addTabs: (c) => { const id = addTabs(c); file.flush(); return id; },
    importTree(parsed, title) {
      const r = addImported(file.get(), BAR_ID, title, importContents(parsed), Date.now());
      commit(r.tree);
      file.flush();
      return { count: r.count, title, skipped: parsed.skipped };
    },
  };
}
