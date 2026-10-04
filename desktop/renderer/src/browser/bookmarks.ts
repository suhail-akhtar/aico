/**
 * The chrome's side of bookmarks: the tree main pushes, the verbs the bar,
 * menus, star and manager share, drag and drop, and the right-click menu.
 *
 * Main owns the tree (electron/browser-bookmarks.ts) and pushes every change
 * as `browser:bookmarks`; this store only mirrors it, and also keeps the
 * browser store's flat `bookmarks` list current for what reads that (the
 * address bar's suggestions, the new tab page, the tab menu).
 *
 * Drag and drop is HTML5 drag and drop with our own type for bookmarks being
 * moved, plus the ordinary `text/uri-list` — so a page's site icon, a link
 * dragged out of a page, or a URL from another app can be dropped on the bar
 * or into a folder too. Right-click menus are native (they draw above the
 * page view, so the page never has to be hidden for them).
 *
 * @module desktop/renderer/browser/bookmarks
 */

import { create } from 'zustand';
import { desktop, on } from '@/desktop';
import { toast, useDesk } from '@/state/desk';
import {
  BAR_ID, directUrls, flattenBookmarks, getNode, isRoot, locate, emptyTree, findByUrl,
} from '@desk/bookmark-tree';
import type { BookmarkBarMode, BookmarkMenuItem, BookmarkNode, BookmarksSnapshot, BookmarkTree } from '@desk/browser-types';
import { call } from './ipc';
import { activeTab, newTab, openUrl, showInternal, useBrowser } from './store';
import { isBlankUrl } from './urls';
import type { TabState } from './types';

export type BookmarkDialog =
  | { kind: 'edit'; id: string }
  | { kind: 'add-page'; parentId: string; index?: number; url?: string; title?: string }
  | { kind: 'add-folder'; parentId: string; index?: number; then?: (id: string) => void }
  | { kind: 'rename'; id: string }
  | { kind: 'all-tabs' }
  | { kind: 'import' };

interface BookmarksStore {
  tree: BookmarkTree;
  bar: BookmarkBarMode;
  loaded: boolean;
  /** The star's "Bookmark added / Edit bookmark" bubble, for this bookmark. */
  star: { id: string; added: boolean } | null;
  dialog: BookmarkDialog | null;
  /** Where the star put the last bookmark: the next goes there too. */
  lastFolder: string;
}

export const useBookmarks = create<BookmarksStore>(() => ({
  tree: emptyTree(), bar: 'always', loaded: false, star: null, dialog: null, lastFolder: BAR_ID,
}));

function apply(s: BookmarksSnapshot | undefined | null): void {
  if (!s || !s.tree) return;
  const lastFolder = getNode(s.tree, useBookmarks.getState().lastFolder)?.children ? useBookmarks.getState().lastFolder : BAR_ID;
  useBookmarks.setState({ tree: s.tree, bar: s.bar, loaded: true, lastFolder });
  useBrowser.setState({ bookmarks: flattenBookmarks(s.tree) });
}

let installed = false;
/** Subscribe to main once for the window's lifetime (safe to call from every component that needs the tree). */
export function installBookmarks(): void {
  if (installed) return;
  installed = true;
  on<BookmarksSnapshot>('browser:bookmarks', apply);
  void call<BookmarksSnapshot>('browser:bookmarks:get').then(apply).catch(() => {});
}

/** Run a change in main; the snapshot it returns (or pushes) updates the store. Failures are said, not thrown. */
export async function change<T = BookmarksSnapshot>(channel: string, ...args: unknown[]): Promise<T | undefined> {
  try {
    const r = await call<T>(channel, ...args);
    if (r && typeof r === 'object' && 'tree' in (r as object)) apply(r as unknown as BookmarksSnapshot);
    return r;
  } catch (err) {
    toast.error('Bookmarks', (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

// ── Opening ──

export function openBookmark(url: string, inNewTab = false): void { openUrl(url, inNewTab); }

/** Open every bookmark directly in a folder, each in a new tab (asks first when there are many). */
export async function openAll(folder: BookmarkNode): Promise<void> {
  const urls = directUrls(folder);
  if (!urls.length) return;
  if (urls.length > 15) {
    const ok = await desktop.dialog.confirm({ title: 'Open all bookmarks', message: `Open ${urls.length} tabs?`, detail: `Every bookmark in “${folder.title}” opens in its own tab.`, ok: `Open ${urls.length} tabs` }).catch(() => false);
    if (!ok) return;
  }
  for (const u of urls) newTab(u);
}

// ── The star, the bar, and the menu verbs ──

/** Ctrl+D and the star: bookmark the page (into the folder used last) and show the bubble, or show it for the bookmark it has. */
export async function bookmarkTab(tab: TabState | undefined = activeTab()): Promise<void> {
  if (!tab || isBlankUrl(tab.url)) return;
  installBookmarks();
  const s = useBookmarks.getState();
  const had = findByUrl(s.tree, tab.url);
  if (had) { useBookmarks.setState({ star: { id: had.id, added: false } }); return; }
  const node = await change<BookmarkNode>('browser:bookmarks:create', { parentId: s.lastFolder, url: tab.url, title: tab.title, favicon: tab.favicon });
  if (node?.id) useBookmarks.setState({ star: { id: node.id, added: true } });
}

export function setBarMode(mode: BookmarkBarMode): void { void change('browser:bookmarks:barMode', mode); }

/** Ctrl+Shift+B: the bar always, or not at all. */
export function toggleBar(): void {
  installBookmarks();
  setBarMode(useBookmarks.getState().bar === 'always' ? 'never' : 'always');
}

export function openManager(): void { showInternal('bookmarks'); }
export function openDialog(d: BookmarkDialog): void { installBookmarks(); useBookmarks.setState({ dialog: d }); }
export function bookmarkAllTabs(): void { openDialog({ kind: 'all-tabs' }); }

/** Delete, with an Undo in the notice (main keeps the tree from before until anything else changes). */
export async function deleteNodes(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const tree = useBookmarks.getState().tree;
  const one = ids.length === 1 ? getNode(tree, ids[0]!) : undefined;
  const r = await change<{ removed: number }>('browser:bookmarks:delete', ids);
  if (!r) return;
  const what = one ? `“${one.title}”` : `${ids.length} items`;
  useDesk.getState().toast({
    kind: 'info', title: `Deleted ${what}`, body: r.removed > 1 || one?.children ? `${r.removed} bookmark${r.removed === 1 ? '' : 's'} removed.` : undefined,
    action: { label: 'Undo', run: () => { void change('browser:bookmarks:undo'); } },
  });
}

export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast.success('Link copied'); } catch { toast.error('Could not copy the link'); }
}

/** Ask main for a native menu at the pointer; resolves the chosen id (null when dismissed). */
export async function nativeMenu(items: BookmarkMenuItem[]): Promise<string | null> {
  return (await call<string | null>('browser:bookmarks:menu', items).catch(() => null)) ?? null;
}

const SEP: BookmarkMenuItem = { type: 'separator' };

/**
 * The right-click menu for a bookmark, a folder, or empty space in `parentId`
 * (then `index` is where "Add page…" and "Add folder…" put the new one).
 */
export async function bookmarkContextMenu(node: BookmarkNode | null, parentId: string, index?: number, extra?: { onRename?: () => void }): Promise<string | null> {
  const bar = useBookmarks.getState().bar;
  const folder = node?.children ? node : null;
  const items: BookmarkMenuItem[] = [];
  if (node?.url) {
    items.push({ id: 'open', label: 'Open' }, { id: 'newtab', label: 'Open in new tab' }, SEP,
      { id: 'edit', label: 'Edit…' }, { id: 'copy', label: 'Copy link' }, { id: 'delete', label: 'Delete' }, SEP);
  } else if (folder) {
    const n = directUrls(folder).length;
    items.push({ id: 'openall', label: `Open all (${n})`, enabled: n > 0 }, SEP);
    if (!isRoot(folder.id)) items.push({ id: 'rename', label: 'Rename…' }, { id: 'delete', label: 'Delete' });
    items.push({ id: 'sort', label: 'Sort by name', enabled: (folder.children?.length ?? 0) > 1 }, SEP);
  }
  items.push({ id: 'addpage', label: 'Add page…' }, { id: 'addfolder', label: 'Add folder…' }, SEP,
    { id: 'bar', label: 'Show bookmarks bar', checked: bar === 'always', accelerator: 'Ctrl+Shift+B' },
    { id: 'manager', label: 'Bookmark manager', accelerator: 'Ctrl+Shift+O' });
  const pick = await nativeMenu(items);
  // Add inside the folder that was right-clicked; otherwise beside the item.
  const into = folder ? { parentId: folder.id, index: undefined } : { parentId, index: node ? (index ?? 0) + 1 : index };
  switch (pick) {
    case 'open': openBookmark(node!.url!); break;
    case 'newtab': openBookmark(node!.url!, true); break;
    case 'openall': void openAll(folder!); break;
    case 'edit': openDialog({ kind: 'edit', id: node!.id }); break;
    case 'rename': if (extra?.onRename) extra.onRename(); else openDialog({ kind: 'rename', id: node!.id }); break;
    case 'copy': void copyText(node!.url!); break;
    case 'delete': void deleteNodes([node!.id]); break;
    case 'sort': void change('browser:bookmarks:sort', folder!.id); break;
    case 'addpage': {
      const tab = activeTab();
      openDialog({ kind: 'add-page', ...into, ...(tab && !isBlankUrl(tab.url) ? { url: tab.url, title: tab.title } : {}) });
      break;
    }
    case 'addfolder': openDialog({ kind: 'add-folder', ...into }); break;
    case 'bar': toggleBar(); break;
    case 'manager': openManager(); break;
  }
  return pick;
}

// ── Drag and drop ──

export const NODE_MIME = 'application/x-aico-bookmarks';
export const PAGE_MIME = 'application/x-aico-page';

/** The ids being dragged, while a drag that started here is on (dragover cannot read the data itself). */
let dragging: string[] | null = null;
export const draggingIds = (): string[] | null => dragging;

export function startNodeDrag(e: React.DragEvent, ids: string[]): void {
  const tree = useBookmarks.getState().tree;
  dragging = ids;
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData(NODE_MIME, JSON.stringify(ids));
  const first = getNode(tree, ids[0]!);
  if (first?.url) {
    e.dataTransfer.setData('text/uri-list', first.url);
    e.dataTransfer.setData('text/plain', first.url);
  } else if (first) {
    e.dataTransfer.setData('text/plain', first.title);
  }
  const clear = (): void => { dragging = null; window.removeEventListener('dragend', clear, true); };
  window.addEventListener('dragend', clear, true);
}

/** Drag the current page (its site icon in the address bar) to bookmark it wherever it lands. */
export function startPageDrag(e: React.DragEvent, tab: { url: string; title: string; favicon?: string }): void {
  e.dataTransfer.effectAllowed = 'copyLink';
  e.dataTransfer.setData(PAGE_MIME, JSON.stringify({ url: tab.url, title: tab.title, favicon: tab.favicon }));
  e.dataTransfer.setData('text/uri-list', tab.url);
  e.dataTransfer.setData('text/plain', tab.url);
}

/** Can this drag be dropped as bookmarks? */
export function acceptsDrag(e: React.DragEvent): boolean {
  const t = e.dataTransfer.types;
  return t.includes(NODE_MIME) || t.includes(PAGE_MIME) || t.includes('text/uri-list');
}

/** Would dropping the dragged bookmarks into `folderId` put a folder inside itself? */
export function wouldNest(folderId: string): boolean {
  if (!dragging) return false;
  const tree = useBookmarks.getState().tree;
  return dragging.some(id => id === folderId || Boolean(locate(tree, folderId)?.ancestors.some(a => a.id === id)));
}

function titleFromHtml(html: string): string {
  const m = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(html);
  if (!m) return '';
  // Dropped/imported markup is the page's: parse it in an inert DOMParser document
  // (no scripts, no image loads, so no <img onerror>), never via innerHTML on a live node.
  const doc = new DOMParser().parseFromString(m[1]!, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Carry out a drop into `parentId` at `index`: move bookmarks, or bookmark a page or link. */
export async function dropInto(e: React.DragEvent, parentId: string, index?: number): Promise<void> {
  const dt = e.dataTransfer;
  const nodes = dt.getData(NODE_MIME);
  if (nodes) {
    let ids: string[] = [];
    try { ids = JSON.parse(nodes) as string[]; } catch { return; }
    dragging = null;
    await change('browser:bookmarks:move', ids, parentId, index);
    return;
  }
  let page: { url: string; title?: string; favicon?: string } | null = null;
  try { const p = dt.getData(PAGE_MIME); if (p) page = JSON.parse(p) as typeof page; } catch { /* fall through to the URL */ }
  if (!page) {
    const url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find(l => l && !l.startsWith('#'))?.trim();
    if (!url || !/^(https?|file|ftp):/i.test(url)) return;
    const tab = useBrowser.getState().state.tabs.find(t => t.url === url);
    page = { url, title: tab?.title || titleFromHtml(dt.getData('text/html')) || '', favicon: tab?.favicon };
  }
  if (!page.url || isBlankUrl(page.url)) return;
  await change('browser:bookmarks:create', { parentId, index, url: page.url, title: page.title || page.url, favicon: page.favicon });
}

export type DropSpot = 'before' | 'after' | 'into';

/** Where in a row the pointer is: the ends are before / after, the middle of a folder is into it. */
export function dropSpot(e: React.DragEvent, el: HTMLElement, folder: boolean, horizontal: boolean): DropSpot {
  const r = el.getBoundingClientRect();
  const f = horizontal ? (e.clientX - r.left) / Math.max(1, r.width) : (e.clientY - r.top) / Math.max(1, r.height);
  if (folder) return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'into';
  return f < 0.5 ? 'before' : 'after';
}
