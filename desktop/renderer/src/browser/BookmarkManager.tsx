/**
 * The bookmark manager (the browser's Bookmarks page): the folder tree on the
 * left, the chosen folder's contents on the right, and a search across
 * everything.
 *
 * Select like a file list — click, Ctrl+click, Shift+click, Ctrl+A, ↑ ↓ — then
 * Delete (with Undo), Move to…, Open all, or drag the selection onto a folder
 * in the tree or between rows. Double-click or F2 on a name renames it in
 * place; Enter opens. Sort by name, Import and Export sit in the header.
 *
 * @module desktop/renderer/browser/BookmarkManager
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast, useDesk } from '@/state/desk';
import { desktop } from '@/desktop';
import { BAR_ID, OTHER_ID, countBookmarks, folderList, getNode, isInside, isRoot, locate, searchTree } from '@desk/bookmark-tree';
import type { BookmarkNode } from '@desk/browser-types';
import { Favicon } from './Omnibox';
import { showInternal } from './store';
import { displayUrl } from './urls';
import {
  acceptsDrag, bookmarkContextMenu, change, deleteNodes, dropInto, dropSpot, installBookmarks, nativeMenu, openAll, openBookmark, openDialog,
  startNodeDrag, useBookmarks, wouldNest, type DropSpot,
} from './bookmarks';

export async function exportBookmarks(): Promise<void> {
  const out = await change<string | null>('browser:bookmarks:export');
  if (out) useDesk.getState().toast({ kind: 'success', title: 'Bookmarks exported', body: out, action: { label: 'Show in folder', run: () => void desktop.shell.showItemInFolder(out) } });
}

export function BookmarkManager(): React.ReactElement {
  useEffect(installBookmarks, []);
  const tree = useBookmarks(s => s.tree);
  const [folderId, setFolderId] = useState(BAR_ID);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const pivot = useRef<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([BAR_ID, OTHER_ID]));
  const [mark, setMark] = useState<{ id: string; spot: DropSpot } | null>(null);
  const [treeMark, setTreeMark] = useState<string | null>(null);
  const expandTimer = useRef<number | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);

  const folder = getNode(tree, folderId)?.children ? getNode(tree, folderId)! : getNode(tree, BAR_ID)!;
  useEffect(() => { if (folder.id !== folderId) setFolderId(folder.id); }, [folder.id, folderId]);
  const q = query.trim();
  const rows = useMemo(() => (q ? searchTree(tree, q) : folder.children ?? []), [tree, q, folder]);
  // Selection only ever names rows that are on screen.
  useEffect(() => { setSel(s => { const ids = new Set(rows.map(r => r.id)); const k = s.filter(id => ids.has(id)); return k.length === s.length ? s : k; }); }, [rows]);

  const go = (id: string): void => {
    setFolderId(id); setQuery(''); setSel([]); setEditing(null);
    setExpanded(s => new Set([...s, ...(locate(tree, id)?.ancestors.map(a => a.id) ?? [])]));
  };
  const select = (e: React.MouseEvent | React.KeyboardEvent, id: string): void => {
    if (e.shiftKey && pivot.current) {
      const a = rows.findIndex(r => r.id === pivot.current); const b = rows.findIndex(r => r.id === id);
      if (a >= 0 && b >= 0) { setSel(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => r.id)); return; }
    }
    if (e.ctrlKey || e.metaKey) setSel(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
    else setSel([id]);
    pivot.current = id;
  };
  const open = (n: BookmarkNode, newTab = false): void => { if (n.children) go(n.id); else openBookmark(n.url!, newTab); };
  const rename = (n: BookmarkNode): void => { if (!isRoot(n.id)) setEditing({ id: n.id, text: n.title }); };
  const finishRename = (): void => {
    if (editing) {
      const n = getNode(tree, editing.id);
      if (n && editing.text.trim() && editing.text !== n.title) void change('browser:bookmarks:update', editing.id, { title: editing.text });
    }
    setEditing(null);
    list.current?.focus();
  };
  const selected = sel.map(id => getNode(tree, id)).filter((n): n is BookmarkNode => Boolean(n));

  const moveTo = async (ids: string[]): Promise<void> => {
    const pick = await nativeMenu(folderList(tree).map(f => ({
      id: f.id, label: `${' '.repeat(f.depth)}${f.title}`, enabled: !ids.some(id => isInside(tree, f.id, id)),
    })));
    if (pick) { await change('browser:bookmarks:move', ids, pick); toast.success(`Moved ${ids.length === 1 ? '1 item' : `${ids.length} items`}`, getNode(useBookmarks.getState().tree, pick)?.title); }
  };
  const openSelected = (nodes: BookmarkNode[]): void => {
    const urls = nodes.filter(n => n.url);
    if (urls.length) void openAll({ id: '', title: 'the selection', addedAt: 0, children: urls });
  };

  const rowMenu = (e: React.MouseEvent, n: BookmarkNode, index: number): void => {
    e.preventDefault(); e.stopPropagation();
    if (sel.length > 1 && sel.includes(n.id)) {
      const urls = selected.filter(x => x.url).length;
      void nativeMenu([
        { id: 'open', label: `Open all (${urls})`, enabled: urls > 0 }, { type: 'separator' },
        { id: 'move', label: 'Move to…' }, { id: 'delete', label: `Delete ${sel.length} items` },
      ]).then(p => { if (p === 'open') openSelected(selected); if (p === 'move') void moveTo(sel); if (p === 'delete') void deleteNodes(sel); });
      return;
    }
    if (!sel.includes(n.id)) setSel([n.id]);
    const where = locate(tree, n.id);
    void bookmarkContextMenu(n, where?.parent?.id ?? folder.id, where?.index ?? index, { onRename: () => rename(n) });
  };

  const onListKey = (e: React.KeyboardEvent): void => {
    if (editing) return;
    const i = rows.findIndex(r => r.id === sel[sel.length - 1]);
    const at = (k: number): void => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (r) { if (e.shiftKey) select(e, r.id); else { setSel([r.id]); pivot.current = r.id; } document.getElementById(`bmm-${r.id}`)?.scrollIntoView({ block: 'nearest' }); } };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); at(i + 1); break;
      case 'ArrowUp': e.preventDefault(); at(i < 0 ? 0 : i - 1); break;
      case 'Home': e.preventDefault(); at(0); break;
      case 'End': e.preventDefault(); at(rows.length - 1); break;
      case 'Enter': e.preventDefault(); if (selected.length === 1) open(selected[0]!, e.ctrlKey || e.metaKey); else openSelected(selected); break;
      case 'Delete': case 'Backspace': e.preventDefault(); void deleteNodes(sel); break;
      case 'F2': e.preventDefault(); if (selected.length === 1) rename(selected[0]!); break;
      case 'a': if (e.ctrlKey || e.metaKey) { e.preventDefault(); setSel(rows.map(r => r.id)); } break;
    }
  };

  const rowDragOver = (e: React.DragEvent<HTMLElement>, n: BookmarkNode): void => {
    if (!acceptsDrag(e)) return;
    let spot = dropSpot(e, e.currentTarget, Boolean(n.children), false);
    if (spot === 'into' && wouldNest(n.id)) spot = dropSpot(e, e.currentTarget, false, false);
    // In search results the rows come from all over: only "into a folder" means anything.
    if (q && spot !== 'into') { setMark(null); return; }
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-aico-bookmarks') ? 'move' : 'copy';
    if (mark?.id !== n.id || mark.spot !== spot) setMark({ id: n.id, spot });
  };
  const rowDrop = (e: React.DragEvent, n: BookmarkNode, index: number): void => {
    if (!acceptsDrag(e) || mark?.id !== n.id) return;
    e.preventDefault(); e.stopPropagation();
    const spot = mark.spot;
    setMark(null);
    if (spot === 'into') void dropInto(e, n.id);
    else void dropInto(e, folder.id, index + (spot === 'after' ? 1 : 0));
  };

  const treeRows = useMemo(() => {
    const out: Array<{ node: BookmarkNode; depth: number; subs: boolean }> = [];
    const visit = (n: BookmarkNode, depth: number): void => {
      const subs = (n.children ?? []).some(c => c.children);
      out.push({ node: n, depth, subs });
      if (expanded.has(n.id)) for (const c of n.children ?? []) if (c.children) visit(c, depth + 1);
    };
    for (const r of tree.roots) visit(r, 0);
    return out;
  }, [tree, expanded]);

  const path = locate(tree, folder.id);
  const total = countBookmarks({ id: '', title: '', addedAt: 0, children: tree.roots });

  return (
    <div className="bx-chrome-page flex flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-aico-border-subtle px-6 py-3">
        <Icon name="star" size={19} className="text-aico-secondary" />
        <h1 className="text-[19px] font-semibold tracking-tight">Bookmarks</h1>
        <div className="mx-4 flex min-w-0 max-w-[460px] flex-1 items-center gap-2 rounded-full border border-aico-border-subtle px-3.5 py-1.5">
          <Icon name="search" size={14} className="text-aico-muted" />
          <input value={query} onChange={e => { setQuery(e.target.value); setSel([]); }} placeholder={`Search ${total} bookmark${total === 1 ? '' : 's'}`} aria-label="Search bookmarks"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-aico-muted" />
          {query && <button className="icon-btn-sm h-5 w-5" onClick={() => setQuery('')} title="Clear search"><Icon name="x" size={12} /></button>}
        </div>
        <div className="flex-1" />
        <button className="btn-ghost btn-sm" onClick={() => openDialog({ kind: 'add-page', parentId: folder.id })} title="Add a bookmark to this folder"><Icon name="plus" size={14} />Add page</button>
        <button className="btn-ghost btn-sm" onClick={() => openDialog({ kind: 'add-folder', parentId: folder.id, then: go })} title="Add a folder here"><Icon name="folder-plus" size={14} />Add folder</button>
        <button className="btn-ghost btn-sm" disabled={Boolean(q) || (folder.children?.length ?? 0) < 2} onClick={() => void change('browser:bookmarks:sort', folder.id)} title="Folders first, then by name"><Icon name="sort" size={14} />Sort by name</button>
        <button className="btn-ghost btn-sm" onClick={() => openDialog({ kind: 'import' })}><Icon name="download" size={14} />Import</button>
        <button className="btn-ghost btn-sm" onClick={() => void exportBookmarks()}><Icon name="upload" size={14} />Export</button>
        <button className="icon-btn" onClick={() => showInternal(null)} title="Close (Esc)"><Icon name="x" size={16} /></button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div role="tree" aria-label="Bookmark folders" className="w-[250px] shrink-0 overflow-y-auto border-r border-aico-border-subtle p-2 thin-scroll">
          {treeRows.map(({ node, depth, subs }) => (
            <div key={node.id} role="treeitem" aria-selected={!q && node.id === folder.id} aria-expanded={subs ? expanded.has(node.id) : undefined}
              className={cls('bx-bmm-folder', !q && node.id === folder.id && 'bx-bmm-current', treeMark === node.id && 'bx-bm-into')}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => go(node.id)}
              onContextMenu={e => { e.preventDefault(); const w = locate(tree, node.id); void bookmarkContextMenu(node, w?.parent?.id ?? BAR_ID, w?.index, { onRename: () => openDialog({ kind: 'rename', id: node.id }) }); }}
              draggable={!isRoot(node.id)}
              onDragStart={e => startNodeDrag(e, [node.id])}
              onDragOver={e => {
                if (!acceptsDrag(e) || wouldNest(node.id)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-aico-bookmarks') ? 'move' : 'copy';
                if (treeMark !== node.id) {
                  setTreeMark(node.id);
                  window.clearTimeout(expandTimer.current);
                  if (subs && !expanded.has(node.id)) expandTimer.current = window.setTimeout(() => setExpanded(s => new Set([...s, node.id])), 600);
                }
              }}
              onDragLeave={() => setTreeMark(v => (v === node.id ? null : v))}
              onDrop={e => { if (!acceptsDrag(e)) return; e.preventDefault(); setTreeMark(null); void dropInto(e, node.id); }}>
              <button type="button" tabIndex={-1} className={cls('flex h-4 w-4 shrink-0 items-center justify-center text-aico-muted', !subs && 'invisible')}
                onClick={e => { e.stopPropagation(); setExpanded(s => { const n = new Set(s); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); }}>
                <Icon name={expanded.has(node.id) ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
              <Icon name={!q && node.id === folder.id ? 'folder-open' : 'folder'} size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{node.title}</span>
            </div>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-1 px-5 text-[12.5px] text-aico-muted">
            {q ? <span>{rows.length} result{rows.length === 1 ? '' : 's'} for “{q}”</span> : [...(path?.ancestors ?? []), folder].map((a, i, all) => (
              <React.Fragment key={a.id}>
                {i > 0 && <Icon name="chevron-right" size={12} />}
                <button className={cls('rounded px-1 hover:bg-aico-hover', i === all.length - 1 && 'font-medium text-aico-primary')} onClick={() => go(a.id)}>{a.title}</button>
              </React.Fragment>
            ))}
            <div className="flex-1" />
            {sel.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="mr-1 text-aico-secondary">{sel.length} selected</span>
                <button className="btn-ghost btn-sm" disabled={!selected.some(n => n.url)} onClick={() => openSelected(selected)}><Icon name="external" size={13} />Open</button>
                <button className="btn-ghost btn-sm" onClick={() => void moveTo(sel)}><Icon name="folder" size={13} />Move to…</button>
                <button className="btn-ghost btn-sm text-aico-danger" onClick={() => void deleteNodes(sel)}><Icon name="trash" size={13} />Delete</button>
                <button className="icon-btn-sm" onClick={() => setSel([])} title="Clear selection"><Icon name="x" size={13} /></button>
              </span>
            )}
          </div>
          <div ref={list} role="grid" aria-multiselectable tabIndex={0} className="bx-bmm-list min-h-0 flex-1 overflow-y-auto px-3 pb-10 thin-scroll"
            onKeyDown={onListKey}
            onClick={e => { if (e.target === e.currentTarget) setSel([]); }}
            onContextMenu={e => { if (e.target !== e.currentTarget) return; e.preventDefault(); void bookmarkContextMenu(null, folder.id, folder.children?.length); }}
            onDragOver={e => {
              if (q || !acceptsDrag(e) || wouldNest(folder.id)) return;
              e.preventDefault();
              if (mark?.id !== '$end') setMark({ id: '$end', spot: 'after' });
            }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMark(null); }}
            onDrop={e => { if (q || !acceptsDrag(e)) return; e.preventDefault(); setMark(null); void dropInto(e, folder.id); }}>
            {rows.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-[13px] text-aico-muted">
                <Icon name={q ? 'search' : 'folder'} size={26} />
                {q ? 'No bookmarks match.' : 'This folder is empty. Drag bookmarks here, or use Add page.'}
              </div>
            )}
            {rows.map((n, i) => {
              const on = sel.includes(n.id);
              const where = q ? locate(tree, n.id)?.ancestors.map(a => a.title).join(' › ') : '';
              return (
                <div key={n.id} id={`bmm-${n.id}`} role="row" aria-selected={on} draggable={editing?.id !== n.id}
                  className={cls('bx-bmm-row group', on && 'bx-bmm-selected', mark?.id === n.id && `bx-bm-${mark.spot}`)}
                  onClick={e => { list.current?.focus(); select(e, n.id); }}
                  onDoubleClick={() => open(n)}
                  onAuxClick={e => { if (e.button === 1 && n.url) openBookmark(n.url, true); }}
                  onContextMenu={e => rowMenu(e, n, i)}
                  onDragStart={e => { const ids = sel.includes(n.id) ? sel : [n.id]; if (!sel.includes(n.id)) setSel([n.id]); startNodeDrag(e, ids); }}
                  onDragOver={e => rowDragOver(e, n)}
                  onDragLeave={() => setMark(v => (v?.id === n.id ? null : v))}
                  onDrop={e => rowDrop(e, n, i)}>
                  {n.children ? <Icon name="folder" size={16} className="shrink-0 text-aico-secondary" /> : <Favicon src={n.favicon} url={n.url} size={16} />}
                  {editing?.id === n.id ? (
                    <input autoFocus className="input h-7 min-w-0 flex-1 px-2 py-0 text-[13px]" value={editing.text}
                      onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
                      onFocus={e => e.currentTarget.select()} onChange={e => setEditing({ id: n.id, text: e.target.value })} onBlur={finishRename}
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') finishRename(); if (e.key === 'Escape') { setEditing(null); list.current?.focus(); } }} />
                  ) : (
                    <span className="min-w-0 flex-[2] truncate text-[13px]">{n.title || n.url}</span>
                  )}
                  <span className="min-w-0 flex-[3] truncate text-[12px] text-aico-muted">
                    {n.url ? displayUrl(n.url) : `${countBookmarks(n)} bookmark${countBookmarks(n) === 1 ? '' : 's'}`}
                    {where && <span className="ml-2 text-aico-muted/80">in {where}</span>}
                  </span>
                  <button className="icon-btn-sm opacity-0 group-hover:opacity-100 bx-bmm-more" onClick={e => rowMenu(e, n, i)} title="More"><Icon name="more-v" size={14} /></button>
                </div>
              );
            })}
            {mark?.id === '$end' && <div className="bx-bmm-endmark" />}
          </div>
        </div>
      </div>
    </div>
  );
}
