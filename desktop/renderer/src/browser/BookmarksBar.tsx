/**
 * The bookmarks bar under the toolbar: bookmarks with their icons, folders
 * that drop down (BookmarkMenu), a » menu for what does not fit, and Other
 * bookmarks at the right end — shown always, only on the new tab page, or
 * never (Ctrl+Shift+B, the ⋮ menu, or right-click).
 *
 * Click opens in this tab; middle-click or Ctrl+click in a new one. Items
 * drag to reorder, onto a folder to go inside it (hovering opens it, so a
 * bookmark can be dropped deep into sub-folders), and a page's site icon or
 * a link dragged here becomes a bookmark where it lands.
 *
 * Which items fit is measured on a hidden copy of the whole row, so the bar
 * never re-lays itself out in a loop as items move into and out of ».
 *
 * @module desktop/renderer/browser/BookmarksBar
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { BAR_ID, OTHER_ID, getNode } from '@desk/bookmark-tree';
import type { BookmarkNode } from '@desk/browser-types';
import { Favicon } from './Omnibox';
import { useActiveTab, useBrowser } from './store';
import { isBlankUrl } from './urls';
import { MenuItem, MenuSep } from '@/shell/Popover';
import {
  acceptsDrag, bookmarkAllTabs, bookmarkContextMenu, bookmarkTab, dropInto, dropSpot, installBookmarks, openAll, openBookmark, openDialog,
  openManager, setBarMode, startNodeDrag, useBookmarks, wouldNest, type DropSpot,
} from './bookmarks';
import { exportBookmarks } from './BookmarkManager';
import { BookmarkMenu, type MenuRoot } from './BookmarkMenu';
import { BookmarkDialogs } from './BookmarkEditor';

const GAP = 2;
const MORE_WIDTH = 30;

export function BookmarksBar(): React.ReactElement {
  useEffect(installBookmarks, []);
  const tree = useBookmarks(s => s.tree);
  const mode = useBookmarks(s => s.bar);
  const loaded = useBookmarks(s => s.loaded);
  const tab = useActiveTab();
  const internal = useBrowser(s => s.internal !== null);
  const onNewTab = !tab || isBlankUrl(tab.url);
  const show = loaded && (mode === 'always' || (mode === 'newtab' && onNewTab && !internal));
  return (
    <>
      {show && <Bar items={getNode(tree, BAR_ID)?.children ?? []} other={getNode(tree, OTHER_ID)} />}
      <BookmarkDialogs />
    </>
  );
}

function Bar({ items, other }: { items: BookmarkNode[]; other: BookmarkNode | undefined }): React.ReactElement {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(items.length);
  const [menu, setMenu] = useState<(MenuRoot & { key: string }) | null>(null);
  const [mark, setMark] = useState<{ id: string; spot: DropSpot } | null>(null);
  const dragTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(dragTimer.current), []);

  useLayoutEffect(() => {
    const r = row.current; const m = measure.current;
    if (!r || !m) return;
    const calc = (): void => {
      const avail = r.clientWidth;
      const widths = [...m.children].map(c => (c as HTMLElement).offsetWidth + GAP);
      let used = 0; let n = 0;
      for (let i = 0; i < widths.length; i++) {
        const reserve = i < widths.length - 1 ? MORE_WIDTH : 0;
        if (used + widths[i]! + reserve > avail) break;
        used += widths[i]!; n++;
      }
      setFit(n);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(r);
    return () => ro.disconnect();
  }, [items]);

  const closeMenu = React.useCallback(() => setMenu(null), []);
  const openMenu = (key: string, el: HTMLElement, folderId: string, offset = 0): void => {
    setMenu({ key, folderId, offset, anchor: el.getBoundingClientRect() });
  };
  const toggleMenu = (key: string, el: HTMLElement, folderId: string, offset = 0): void => {
    if (menu?.key === key) setMenu(null); else openMenu(key, el, folderId, offset);
  };
  const overflow = items.length - fit;

  const itemDragOver = (e: React.DragEvent<HTMLElement>, node: BookmarkNode): void => {
    if (!acceptsDrag(e)) return;
    let spot = dropSpot(e, e.currentTarget, Boolean(node.children), true);
    if (spot === 'into' && wouldNest(node.id)) spot = dropSpot(e, e.currentTarget, false, true);
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-aico-bookmarks') ? 'move' : 'copy';
    if (mark?.id !== node.id || mark.spot !== spot) setMark({ id: node.id, spot });
    // Hovering a folder opens it, so the drop can go deeper.
    if (node.children && spot === 'into' && menu?.folderId !== node.id) {
      const el = e.currentTarget;
      window.clearTimeout(dragTimer.current);
      dragTimer.current = window.setTimeout(() => openMenu(node.id, el, node.id), 500);
    } else if (spot !== 'into') window.clearTimeout(dragTimer.current);
  };
  const itemDrop = (e: React.DragEvent, node: BookmarkNode, index: number): void => {
    if (!acceptsDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    window.clearTimeout(dragTimer.current);
    const spot = mark?.id === node.id ? mark.spot : 'after';
    setMark(null);
    if (spot === 'into' && node.children) void dropInto(e, node.id);
    else void dropInto(e, BAR_ID, index + (spot === 'after' ? 1 : 0));
  };

  const renderItem = (node: BookmarkNode, index: number, measuring = false): React.ReactElement => {
    const key = node.id;
    const open = !measuring && menu?.key === key;
    const m = !measuring && mark?.id === node.id ? mark.spot : null;
    return (
      <button key={node.id} type="button"
        className={cls('bx-bm-item', open && 'bx-bm-open', m && `bx-bm-${m}`, !node.title && 'bx-bm-icononly')}
        {...(measuring ? { tabIndex: -1, 'aria-hidden': true } : {
          'data-bm-keep': node.children ? true : undefined,
          title: node.url ? `${node.title}\n${node.url}` : node.title,
          draggable: true,
          onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
            if (node.children) toggleMenu(key, e.currentTarget, node.id);
            else openBookmark(node.url!, e.ctrlKey || e.metaKey || e.shiftKey);
          },
          onMouseDown: (e: React.MouseEvent) => { if (e.button === 1) e.preventDefault(); },
          onAuxClick: (e: React.MouseEvent) => { if (e.button === 1) { if (node.url) openBookmark(node.url, true); else void openAll(node); } },
          onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { if (menu && menu.key !== key && node.children) openMenu(key, e.currentTarget, node.id); },
          onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu(null); void bookmarkContextMenu(node, BAR_ID, index); },
          onDragStart: (e: React.DragEvent) => { setMenu(null); startNodeDrag(e, [node.id]); },
          onDragOver: (e: React.DragEvent<HTMLElement>) => itemDragOver(e, node),
          onDragLeave: () => { window.clearTimeout(dragTimer.current); setMark(v => (v?.id === node.id ? null : v)); },
          onDrop: (e: React.DragEvent) => itemDrop(e, node, index),
        })}>
        {node.children
          ? <Icon name={open ? 'folder-open' : 'folder'} size={15} className="shrink-0 text-aico-secondary" />
          : <Favicon src={node.favicon} url={node.url} size={16} />}
        {node.title && <span className="min-w-0 truncate">{node.title}</span>}
      </button>
    );
  };

  return (
    <>
    <div className="bx-bmbar" role="toolbar" aria-label="Bookmarks bar"
      onContextMenu={e => { e.preventDefault(); setMenu(null); void bookmarkContextMenu(null, BAR_ID, items.length); }}
      onDragOver={e => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-aico-bookmarks') ? 'move' : 'copy';
        if (mark?.id !== '$end') setMark({ id: '$end', spot: 'after' });
      }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setMark(null); window.clearTimeout(dragTimer.current); } }}
      onDrop={e => { if (!acceptsDrag(e)) return; e.preventDefault(); setMark(null); void dropInto(e, BAR_ID); }}>
      <div ref={row} className="relative flex min-w-0 flex-1 items-center overflow-hidden" style={{ gap: GAP }}>
        {items.slice(0, fit).map((n, i) => renderItem(n, i))}
        {mark?.id === '$end' && <span className="bx-bm-endmark" aria-hidden />}
        {items.length === 0 && (
          <span className="truncate px-2 text-[12px] text-aico-muted">
            For quick access, place your bookmarks here on the bookmarks bar.{' '}
            <button className="text-aico-accent hover:underline" onClick={() => openDialog({ kind: 'import' })}>Import bookmarks now…</button>
          </span>
        )}
        {overflow > 0 && (
          <button type="button" data-bm-keep className={cls('bx-bm-item bx-bm-more', menu?.key === '$more' && 'bx-bm-open')}
            title={`${overflow} more bookmark${overflow === 1 ? '' : 's'}`} aria-label="More bookmarks"
            onClick={e => toggleMenu('$more', e.currentTarget, BAR_ID, fit)}
            onDragOver={e => {
              if (!acceptsDrag(e)) return;
              e.preventDefault(); e.stopPropagation();
              if (menu?.key !== '$more') { const el = e.currentTarget; window.clearTimeout(dragTimer.current); dragTimer.current = window.setTimeout(() => openMenu('$more', el, BAR_ID, fit), 400); }
            }}>
            <span className="-mt-0.5 text-[17px] leading-none" aria-hidden>»</span>
          </button>
        )}
        {/* Every item at its natural width, off screen: what decides how many fit. */}
        <div ref={measure} className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap" aria-hidden>
          {items.map((n, i) => renderItem(n, i, true))}
        </div>
      </div>
      {other && (other.children?.length ?? 0) > 0 && (
        <>
          <span className="mx-1 h-4 border-l border-aico-border-subtle" />
          <button type="button" data-bm-keep className={cls('bx-bm-item', menu?.key === OTHER_ID && 'bx-bm-open', mark?.id === OTHER_ID && 'bx-bm-into')}
            title="Other bookmarks"
            onClick={e => toggleMenu(OTHER_ID, e.currentTarget, OTHER_ID)}
            onMouseEnter={e => { if (menu && menu.key !== OTHER_ID) openMenu(OTHER_ID, e.currentTarget, OTHER_ID); }}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setMenu(null); void bookmarkContextMenu(other, OTHER_ID); }}
            onDragOver={e => {
              if (!acceptsDrag(e)) return;
              e.preventDefault(); e.stopPropagation();
              if (mark?.id !== OTHER_ID) setMark({ id: OTHER_ID, spot: 'into' });
              if (menu?.key !== OTHER_ID) { const el = e.currentTarget; window.clearTimeout(dragTimer.current); dragTimer.current = window.setTimeout(() => openMenu(OTHER_ID, el, OTHER_ID), 500); }
            }}
            onDragLeave={() => { window.clearTimeout(dragTimer.current); setMark(v => (v?.id === OTHER_ID ? null : v)); }}
            onDrop={e => { if (!acceptsDrag(e)) return; e.preventDefault(); e.stopPropagation(); setMark(null); void dropInto(e, OTHER_ID); }}>
            <Icon name={menu?.key === OTHER_ID ? 'folder-open' : 'folder'} size={15} className="shrink-0 text-aico-secondary" />
            <span className="truncate">Other bookmarks</span>
          </button>
        </>
      )}
    </div>
    {/* Outside the bar: React events bubble through portals, and the menu's drags and right-clicks are its own. */}
    {menu && <BookmarkMenu root={menu} onClose={closeMenu} />}
    </>
  );
}

/** The ⋮ menu's Bookmarks sub-menu. */
export function BookmarksSubmenu({ close }: { close: () => void }): React.ReactElement {
  useEffect(installBookmarks, []);
  const mode = useBookmarks(s => s.bar);
  const tab = useActiveTab();
  const tabs = useBrowser(s => s.state.tabs.filter(t => !isBlankUrl(t.url)).length);
  const run = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <MenuItem icon="star" label="Bookmark this tab…" hint="Ctrl+D" disabled={!tab || isBlankUrl(tab.url)} onClick={run(() => void bookmarkTab())} />
      <MenuItem icon="folder-plus" label="Bookmark all tabs…" hint="Ctrl+Shift+D" disabled={tabs === 0} onClick={run(bookmarkAllTabs)} />
      <MenuSep />
      <div className="px-2.5 pb-0.5 pt-1 text-[11.5px] font-medium text-aico-muted">Show bookmarks bar</div>
      <MenuItem icon="eye" label="Always" hint="Ctrl+Shift+B" checked={mode === 'always'} onClick={run(() => setBarMode('always'))} />
      <MenuItem icon="home" label="Only on new tab" checked={mode === 'newtab'} onClick={run(() => setBarMode('newtab'))} />
      <MenuItem icon="eye-off" label="Never" checked={mode === 'never'} onClick={run(() => setBarMode('never'))} />
      <MenuSep />
      <MenuItem icon="book" label="Bookmark manager" hint="Ctrl+Shift+O" onClick={run(openManager)} />
      <MenuItem icon="download" label="Import bookmarks…" onClick={run(() => openDialog({ kind: 'import' }))} />
      <MenuItem icon="upload" label="Export bookmarks…" onClick={run(() => void exportBookmarks())} />
    </>
  );
}
