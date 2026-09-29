/**
 * The bookmark tree — folders and sub-folders in order, like any browser's —
 * as pure operations on plain data. Main keeps the tree in bookmarks.json and
 * is the only writer; the chrome imports the read-side helpers (locate, path,
 * flatten, folder lists) so the bar, the menus and the manager agree with main
 * without asking it.
 *
 * Every operation returns a new tree and leaves its input untouched (the whole
 * tree is cloned: a few thousand bookmarks copy in well under a millisecond,
 * and there is no half-updated state to reason about).
 *
 * The two roots are fixed — "Bookmarks bar" (id `bar`) and "Other bookmarks"
 * (id `other`) — and can be filled, reordered and emptied, but never renamed,
 * moved or deleted.
 *
 * @module desktop/shared/bookmark-tree
 */

import type { Bookmark, BookmarkNode, BookmarkTree } from './browser-types';

export const BAR_ID = 'bar';
export const OTHER_ID = 'other';
export const ROOT_TITLES: Record<string, string> = { [BAR_ID]: 'Bookmarks bar', [OTHER_ID]: 'Other bookmarks' };
const MAX_DEPTH = 64;

export const isFolder = (n: BookmarkNode | undefined | null): boolean => Array.isArray(n?.children);
export const isRoot = (id: string): boolean => id === BAR_ID || id === OTHER_ID;

let seq = 0;
export function newBookmarkId(now = Date.now()): string {
  return `b${now.toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyTree(): BookmarkTree {
  return { version: 2, roots: [{ id: BAR_ID, title: ROOT_TITLES[BAR_ID]!, addedAt: 0, children: [] }, { id: OTHER_ID, title: ROOT_TITLES[OTHER_ID]!, addedAt: 0, children: [] }] };
}

const clone = (t: BookmarkTree): BookmarkTree => structuredClone(t);

/** Visit every node, depth first in display order. Return false from `fn` to stop. */
export function walk(tree: BookmarkTree, fn: (node: BookmarkNode, parent: BookmarkNode | null, depth: number) => boolean | void): void {
  let stopped = false;
  const visit = (n: BookmarkNode, parent: BookmarkNode | null, depth: number): void => {
    if (stopped) return;
    if (fn(n, parent, depth) === false) { stopped = true; return; }
    for (const c of n.children ?? []) visit(c, n, depth + 1);
  };
  for (const r of tree.roots) visit(r, null, 0);
}

export interface Located { node: BookmarkNode; parent: BookmarkNode | null; index: number; ancestors: BookmarkNode[] }

/** A node, its parent, its place in the parent, and every folder above it (root first). */
export function locate(tree: BookmarkTree, id: string): Located | null {
  const find = (list: BookmarkNode[], parent: BookmarkNode | null, ancestors: BookmarkNode[]): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!;
      if (n.id === id) return { node: n, parent, index: i, ancestors };
      if (n.children) {
        const hit = find(n.children, n, [...ancestors, n]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(tree.roots, null, []);
}

export function getNode(tree: BookmarkTree, id: string): BookmarkNode | undefined {
  return locate(tree, id)?.node;
}

/** The titles of the folders a node is in, root first: ["Bookmarks bar", "Work"]. */
export function pathOf(tree: BookmarkTree, id: string): string[] {
  return locate(tree, id)?.ancestors.map(a => a.title) ?? [];
}

/** Is `id` the folder `ancestorId` or somewhere inside it? */
export function isInside(tree: BookmarkTree, id: string, ancestorId: string): boolean {
  const hit = locate(tree, id);
  return Boolean(hit && (hit.node.id === ancestorId || hit.ancestors.some(a => a.id === ancestorId)));
}

export function countBookmarks(node: BookmarkNode): number {
  if (!node.children) return node.url ? 1 : 0;
  return node.children.reduce((n, c) => n + countBookmarks(c), 0);
}

/** The bookmarks directly in a folder (not in its sub-folders) — what "Open all" opens. */
export function directUrls(node: BookmarkNode): string[] {
  return (node.children ?? []).filter(c => c.url).map(c => c.url!);
}

/** The first bookmark with this URL, in display order. */
export function findByUrl(tree: BookmarkTree, url: string): BookmarkNode | undefined {
  let hit: BookmarkNode | undefined;
  walk(tree, n => { if (n.url === url) { hit = n; return false; } });
  return hit;
}

/** Every folder as a list for pickers, indented by depth. */
export function folderList(tree: BookmarkTree): Array<{ id: string; title: string; depth: number }> {
  const out: Array<{ id: string; title: string; depth: number }> = [];
  walk(tree, (n, _p, depth) => { if (n.children) out.push({ id: n.id, title: n.title, depth }); });
  return out;
}

/** Every bookmark, flattened — what the address bar's suggestions and the star read. */
export function flattenBookmarks(tree: BookmarkTree): Bookmark[] {
  const out: Bookmark[] = [];
  const visit = (n: BookmarkNode, path: string[]): void => {
    for (const c of n.children ?? []) {
      if (c.children) visit(c, [...path, c.title]);
      else if (c.url) out.push({ id: c.id, url: c.url, title: c.title, ...(c.favicon ? { favicon: c.favicon } : {}), addedAt: c.addedAt, parentId: n.id, folder: path.join('/') });
    }
  };
  for (const r of tree.roots) visit(r, [r.title]);
  return out;
}

/** Search titles and URLs: every word must appear. Folders match on their title. */
export function searchTree(tree: BookmarkTree, query: string, limit = 500): BookmarkNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: BookmarkNode[] = [];
  walk(tree, (n, parent) => {
    if (!parent) return;
    const hay = `${n.title} ${n.url ?? ''}`.toLowerCase();
    if (words.every(w => hay.includes(w))) out.push(n);
    if (out.length >= limit) return false;
  });
  return out;
}

// ── Changes ──

function folderIn(tree: BookmarkTree, id: string): BookmarkNode {
  const hit = locate(tree, id);
  if (!hit) throw new Error('That bookmark folder no longer exists.');
  if (!hit.node.children) throw new Error('Bookmarks can only go into a folder.');
  return hit.node;
}

function clampIndex(index: number | undefined, length: number): number {
  return index === undefined || !Number.isFinite(index) ? length : Math.max(0, Math.min(length, Math.floor(index)));
}

export function checkUrl(url: unknown): string {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u) throw new Error('A bookmark needs a URL.');
  if (u.length > 8192) throw new Error('That URL is too long to bookmark.');
  return u;
}

const cleanTitle = (t: unknown): string => (typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 1024) : '');

export function createBookmark(tree: BookmarkTree, o: { parentId: string; index?: number; title?: string; url: string; favicon?: string }, now: number): { tree: BookmarkTree; node: BookmarkNode } {
  const url = checkUrl(o.url);
  const next = clone(tree);
  const parent = folderIn(next, o.parentId);
  const node: BookmarkNode = { id: newBookmarkId(now), title: cleanTitle(o.title) || url, addedAt: now, url, ...(o.favicon ? { favicon: o.favicon } : {}) };
  parent.children!.splice(clampIndex(o.index, parent.children!.length), 0, node);
  return { tree: next, node };
}

export function createFolder(tree: BookmarkTree, o: { parentId: string; index?: number; title?: string }, now: number): { tree: BookmarkTree; node: BookmarkNode } {
  const next = clone(tree);
  const parent = folderIn(next, o.parentId);
  const node: BookmarkNode = { id: newBookmarkId(now), title: cleanTitle(o.title) || 'New folder', addedAt: now, children: [] };
  parent.children!.splice(clampIndex(o.index, parent.children!.length), 0, node);
  return { tree: next, node };
}

/** Rename, re-point or re-icon one node. A root keeps its name; a folder has no URL. */
export function updateNode(tree: BookmarkTree, id: string, patch: { title?: string; url?: string; favicon?: string }): BookmarkTree {
  const next = clone(tree);
  const hit = locate(next, id);
  if (!hit) throw new Error('That bookmark no longer exists.');
  const n = hit.node;
  if (patch.title !== undefined && !isRoot(id)) n.title = cleanTitle(patch.title) || (n.children ? 'New folder' : n.url ?? '');
  if (patch.url !== undefined && !n.children) n.url = checkUrl(patch.url);
  if (patch.favicon !== undefined && !n.children) { if (patch.favicon) n.favicon = patch.favicon; else delete n.favicon; }
  return next;
}

/**
 * Move nodes into a folder at `index` — the position among the folder's
 * children as they are *before* the move, which is what a drop marker points
 * at. A node chosen together with its own folder moves with the folder, and a
 * folder cannot go into itself.
 */
export function moveNodes(tree: BookmarkTree, ids: string[], parentId: string, index?: number): BookmarkTree {
  const next = clone(tree);
  const target = folderIn(next, parentId);
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (isRoot(id)) throw new Error('The bookmarks bar and Other bookmarks cannot be moved.');
    if (!locate(next, id)) throw new Error('That bookmark no longer exists.');
    if (isInside(next, parentId, id)) throw new Error('A folder cannot go inside itself.');
  }
  // Drop the ones whose folder is also moving.
  const moving = unique.filter(id => !unique.some(other => other !== id && isInside(next, id, other)));
  let at = clampIndex(index, target.children!.length);
  at -= target.children!.slice(0, at).filter(c => moving.includes(c.id)).length;
  const nodes: BookmarkNode[] = [];
  for (const id of moving) {
    const hit = locate(next, id)!;
    hit.parent!.children!.splice(hit.index, 1);
    nodes.push(hit.node);
  }
  target.children!.splice(Math.min(at, target.children!.length), 0, ...nodes);
  return next;
}

/** Delete nodes; a folder goes with everything in it. */
export function removeNodes(tree: BookmarkTree, ids: string[]): BookmarkTree {
  if (ids.some(isRoot)) throw new Error('The bookmarks bar and Other bookmarks cannot be deleted.');
  const gone = new Set(ids);
  const next = clone(tree);
  const prune = (n: BookmarkNode): void => {
    if (!n.children) return;
    n.children = n.children.filter(c => !gone.has(c.id));
    n.children.forEach(prune);
  };
  next.roots.forEach(prune);
  return next;
}

export function removeByUrl(tree: BookmarkTree, url: string): BookmarkTree {
  const ids: string[] = [];
  walk(tree, n => { if (n.url === url) ids.push(n.id); });
  return ids.length ? removeNodes(tree, ids) : tree;
}

/** Sort a folder like "Sort by name": folders first, then bookmarks, each by title (numbers in order). */
export function sortFolder(tree: BookmarkTree, id: string): BookmarkTree {
  const next = clone(tree);
  const f = folderIn(next, id);
  const cmp = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  f.children!.sort((a, b) => (Number(Boolean(b.children)) - Number(Boolean(a.children))) || cmp(a.title, b.title));
  return next;
}

/** Find a folder path under `rootId` by title (case-insensitive), creating what is missing. */
export function ensureFolderPath(tree: BookmarkTree, rootId: string, parts: string[], now: number): { tree: BookmarkTree; folderId: string } {
  let next = tree;
  let id = rootId;
  for (const raw of parts) {
    const part = cleanTitle(raw);
    if (!part) continue;
    const here = folderIn(next, id);
    const found = here.children!.find(c => c.children && c.title.toLowerCase() === part.toLowerCase());
    if (found) { id = found.id; continue; }
    const made = createFolder(next, { parentId: id, title: part }, now);
    next = made.tree; id = made.node.id;
  }
  return { tree: next, folderId: id };
}

/** A tree to add from outside (an import): folders have children, bookmarks a URL. */
export interface ImportNode { title: string; url?: string; addedAt?: number; favicon?: string; children?: ImportNode[] }

/** Add an imported set as a new folder in `parentId`. */
export function addImported(tree: BookmarkTree, parentId: string, title: string, items: ImportNode[], now: number): { tree: BookmarkTree; folder: BookmarkNode; count: number } {
  const made = createFolder(tree, { parentId, title }, now);
  let count = 0;
  const build = (n: ImportNode, depth: number): BookmarkNode | null => {
    if (n.children) {
      if (depth > MAX_DEPTH) return null;
      return { id: newBookmarkId(now), title: cleanTitle(n.title) || 'Folder', addedAt: n.addedAt ?? now, children: n.children.map(c => build(c, depth + 1)).filter((c): c is BookmarkNode => c !== null) };
    }
    if (!n.url) return null;
    count++;
    return { id: newBookmarkId(now), title: cleanTitle(n.title) || n.url, addedAt: n.addedAt ?? now, url: n.url, ...(n.favicon ? { favicon: n.favicon } : {}) };
  };
  const folder = getNode(made.tree, made.node.id)!;
  folder.children = items.map(i => build(i, 1)).filter((c): c is BookmarkNode => c !== null);
  return { tree: made.tree, folder, count };
}

// ── Reading the file ──

interface LegacyBookmark { url?: unknown; title?: unknown; favicon?: unknown; addedAt?: unknown; folder?: unknown }

/** How many top-level entries a migrated list may put on the bar before it goes to Other bookmarks instead. */
export const MIGRATE_BAR_LIMIT = 12;

/**
 * The flat list of earlier versions, as a tree. Nothing is lost: every entry
 * keeps its title, icon and date, and its `folder` becomes a real folder
 * ("A/B" nests). They go on the bookmarks bar — that is where a browser puts
 * what you bookmark, and a short list is exactly what the bar is for — unless
 * they would not fit on it (more than MIGRATE_BAR_LIMIT top-level entries),
 * in which case they all go to Other bookmarks, in order, and the bar starts
 * empty rather than as a wall of overflow.
 */
export function migrateLegacy(list: LegacyBookmark[], now: number): BookmarkTree {
  const valid = list.filter(b => b && typeof b.url === 'string' && b.url.trim());
  const tops = new Set(valid.map(b => (typeof b.folder === 'string' && b.folder.trim() ? `f:${b.folder.split('/')[0]!.trim().toLowerCase()}` : `u:${String(b.url)}`)));
  const rootId = tops.size > MIGRATE_BAR_LIMIT ? OTHER_ID : BAR_ID;
  let tree = emptyTree();
  for (const b of valid) {
    let parentId = rootId;
    if (typeof b.folder === 'string' && b.folder.trim()) {
      const r = ensureFolderPath(tree, rootId, b.folder.split('/'), typeof b.addedAt === 'number' ? b.addedAt : now);
      tree = r.tree; parentId = r.folderId;
    }
    const added = typeof b.addedAt === 'number' && Number.isFinite(b.addedAt) ? b.addedAt : now;
    const r = createBookmark(tree, { parentId, url: String(b.url), title: typeof b.title === 'string' ? b.title : '', favicon: typeof b.favicon === 'string' ? b.favicon : undefined }, added);
    tree = r.tree;
  }
  return tree;
}

/**
 * Whatever bookmarks.json holds, as a sound tree: a flat list from an earlier
 * version is migrated; a damaged tree keeps what can be kept (bad nodes are
 * dropped, repeated ids renumbered, missing roots put back).
 */
export function normaliseTree(raw: unknown, now = Date.now()): BookmarkTree {
  if (Array.isArray(raw)) return migrateLegacy(raw as LegacyBookmark[], now);
  const r = raw as Partial<BookmarkTree> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.roots)) return emptyTree();
  const seen = new Set<string>();
  const clean = (n: unknown, depth: number): BookmarkNode | null => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return null;
    const x = n as Partial<BookmarkNode>;
    let id = typeof x.id === 'string' && x.id ? x.id : newBookmarkId(now);
    if (seen.has(id) || (depth > 0 && isRoot(id))) id = newBookmarkId(now);
    seen.add(id);
    const title = cleanTitle(x.title);
    const addedAt = typeof x.addedAt === 'number' && Number.isFinite(x.addedAt) ? x.addedAt : now;
    if (Array.isArray(x.children)) {
      return { id, title: title || 'Folder', addedAt, children: x.children.map(c => clean(c, depth + 1)).filter((c): c is BookmarkNode => c !== null) };
    }
    if (typeof x.url !== 'string' || !x.url.trim()) return null;
    return { id, title: title || x.url, addedAt, url: x.url.trim(), ...(typeof x.favicon === 'string' && x.favicon ? { favicon: x.favicon } : {}) };
  };
  const out = emptyTree();
  for (const root of r.roots) {
    const rid = (root as BookmarkNode | null)?.id;
    const slot = out.roots.find(o => o.id === rid);
    if (!slot || !Array.isArray((root as BookmarkNode).children)) continue;
    seen.add(slot.id);
    slot.children = (root as BookmarkNode).children!.map(c => clean(c, 1)).filter((c): c is BookmarkNode => c !== null);
  }
  return out;
}
