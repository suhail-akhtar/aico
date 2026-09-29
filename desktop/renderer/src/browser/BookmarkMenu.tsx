/**
 * A bookmark folder's drop-down, as on any browser's bookmarks bar: the
 * folder's bookmarks with their icons, sub-folders that open to the side
 * (hover, click or →), "Open all (n)" at the foot, and long lists that scroll.
 *
 * Every level is a panel of its own; the chain of open levels is one piece of
 * state, so the keyboard (↑ ↓ → ← Enter Esc Home End) and the pointer agree on
 * what is open. Rows are drag sources and drop targets: a bookmark dragged
 * onto a folder row goes inside it (hovering there opens it), onto the top or
 * bottom of a row goes before or after it.
 *
 * It drops over the page, so it registers as an overlay: the pane hides the
 * native page view and shows a still of it while the menu is open.
 *
 * @module desktop/renderer/browser/BookmarkMenu
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { useOverlay } from '@/lib/overlay';
import { directUrls, getNode } from '@desk/bookmark-tree';
import type { BookmarkNode } from '@desk/browser-types';
import { Favicon } from './Omnibox';
import {
  acceptsDrag, bookmarkContextMenu, dropInto, dropSpot, openAll, openBookmark, startNodeDrag, useBookmarks, wouldNest, type DropSpot,
} from './bookmarks';

export interface MenuRoot {
  folderId: string;
  /** Show the folder's children from here on (the bar's overflow menu starts where the bar stopped fitting). */
  offset?: number;
  anchor: DOMRect;
}

interface Level { folderId: string; offset: number; anchor: DOMRect; sub: boolean; active: number }

const OPEN_DELAY = 180;
const DRAG_OPEN_DELAY = 450;

export function BookmarkMenu({ root, onClose }: { root: MenuRoot; onClose: () => void }): React.ReactElement | null {
  useOverlay(true);
  const tree = useBookmarks(s => s.tree);
  const [levels, setLevels] = useState<Level[]>(() => [{ folderId: root.folderId, offset: root.offset ?? 0, anchor: root.anchor, sub: false, active: -1 }]);
  const [focus, setFocus] = useState(0);
  const [mark, setMark] = useState<{ level: number; index: number; spot: DropSpot } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const later = (fn: () => void, ms: number): void => { window.clearTimeout(timer.current); timer.current = window.setTimeout(fn, ms); };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    setLevels([{ folderId: root.folderId, offset: root.offset ?? 0, anchor: root.anchor, sub: false, active: -1 }]);
    setFocus(0);
  }, [root.folderId, root.offset, root.anchor]);

  // A folder that was deleted (or moved away) closes its level.
  useEffect(() => {
    const alive = levels.findIndex(l => !getNode(tree, l.folderId)?.children);
    if (alive === 0) onClose();
    else if (alive > 0) { setLevels(ls => ls.slice(0, alive)); setFocus(f => Math.min(f, alive - 1)); }
  }, [tree]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The rows of a level: its nodes, then "Open all" (index = nodes.length) when there is something to open. */
  const rowsOf = useCallback((l: Level): { nodes: BookmarkNode[]; openAll: number } => {
    const f = getNode(tree, l.folderId);
    const nodes = (f?.children ?? []).slice(l.offset);
    const n = l.offset === 0 && f ? directUrls(f).length : 0;
    return { nodes, openAll: n > 0 ? n : 0 };
  }, [tree]);

  const openSub = (level: number, node: BookmarkNode, rect: DOMRect, focusIt: boolean): void => {
    setLevels(ls => {
      const cur = ls[level + 1];
      if (cur && cur.folderId === node.id) return ls.slice(0, level + 2);
      return [...ls.slice(0, level + 1), { folderId: node.id, offset: 0, anchor: rect, sub: true, active: focusIt ? 0 : -1 }];
    });
    if (focusIt) setFocus(level + 1);
  };
  const setActive = (level: number, index: number, truncate = true): void => {
    setLevels(ls => (truncate ? ls.slice(0, level + 1) : ls).map((l, i) => (i === level ? { ...l, active: index } : l)));
    setFocus(level);
  };

  const activate = (level: number, index: number, how: { newTab?: boolean; keepOpen?: boolean } = {}): void => {
    const l = levels[level];
    if (!l) return;
    const { nodes, openAll: n } = rowsOf(l);
    if (index === nodes.length && n) { void openAll(getNode(tree, l.folderId)!); onClose(); return; }
    const node = nodes[index];
    if (!node) return;
    if (node.children) {
      const el = document.querySelector<HTMLElement>(`[data-bm-level="${level}"] [data-bm-row="${index}"]`);
      if (el) openSub(level, node, el.getBoundingClientRect(), true);
      return;
    }
    openBookmark(node.url!, how.newTab);
    if (!how.keepOpen) onClose();
  };

  // Keyboard: the focused level moves, → opens, ← and Esc close one level.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      const l = levels[focus];
      if (!l) return;
      const { nodes, openAll: n } = rowsOf(l);
      const count = nodes.length + (n ? 1 : 0);
      const stop = (): void => { e.preventDefault(); e.stopPropagation(); };
      switch (e.key) {
        case 'ArrowDown': stop(); if (count) setActive(focus, (l.active + 1 + count) % count); break;
        case 'ArrowUp': stop(); if (count) setActive(focus, (l.active - 1 + count) % count); break;
        case 'Home': stop(); if (count) setActive(focus, 0); break;
        case 'End': stop(); if (count) setActive(focus, count - 1); break;
        case 'ArrowRight': {
          stop();
          const node = nodes[l.active];
          if (node?.children) activate(focus, l.active);
          break;
        }
        case 'ArrowLeft': case 'Escape':
          stop();
          if (focus > 0) { setLevels(ls => ls.slice(0, focus)); setFocus(focus - 1); } else onClose();
          break;
        case 'Enter': case ' ':
          stop();
          if (l.active >= 0) activate(focus, l.active, { newTab: e.ctrlKey || e.metaKey });
          break;
        case 'Tab': stop(); onClose(); break;
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  // A press anywhere else closes it (the bar's own folder buttons decide for themselves).
  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (t?.closest?.('[data-bm-menu], [data-bm-keep]')) return;
      onClose();
    };
    const resize = (): void => onClose();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('resize', resize); };
  }, [onClose]);

  const onRowDragOver = (e: React.DragEvent<HTMLElement>, level: number, index: number, node: BookmarkNode | undefined): void => {
    if (!acceptsDrag(e)) return;
    const folder = Boolean(node?.children);
    let spot: DropSpot = node ? dropSpot(e, e.currentTarget, folder, false) : 'into';
    if (spot === 'into' && node && wouldNest(node.id)) spot = dropSpot(e, e.currentTarget, false, false);
    if (!node && wouldNest(levels[level]!.folderId)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-aico-bookmarks') ? 'move' : 'copy';
    if (mark?.level !== level || mark.index !== index || mark.spot !== spot) setMark({ level, index, spot });
    if (folder && spot === 'into' && levels[level + 1]?.folderId !== node!.id) {
      const rect = e.currentTarget.getBoundingClientRect();
      later(() => openSub(level, node!, rect, false), DRAG_OPEN_DELAY);
    }
  };
  const onRowDrop = (e: React.DragEvent, level: number, index: number, node: BookmarkNode | undefined): void => {
    if (!acceptsDrag(e) || !mark) return;
    e.preventDefault();
    e.stopPropagation();
    const l = levels[level]!;
    const spot = mark.spot;
    setMark(null);
    window.clearTimeout(timer.current);
    if (!node) { void dropInto(e, l.folderId); return; }
    if (spot === 'into' && node.children) void dropInto(e, node.id);
    else void dropInto(e, l.folderId, l.offset + index + (spot === 'after' ? 1 : 0));
  };

  return createPortal(
    <>
      {levels.map((l, level) => {
        const { nodes, openAll: n } = rowsOf(l);
        return (
          <Panel key={`${level}:${l.folderId}`} level={level} anchor={l.anchor} sub={l.sub}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMark(null); }}
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); void bookmarkContextMenu(getNode(tree, l.folderId) ?? null, l.folderId, undefined).then(p => { if (p && CLOSES.has(p)) onClose(); }); }}>
            {nodes.length === 0 && (
              <div className={cls('bx-bm-row text-aico-muted', mark?.level === level && mark.index === -1 && 'bx-bm-into')}
                onDragOver={e => onRowDragOver(e, level, -1, undefined)} onDrop={e => onRowDrop(e, level, -1, undefined)}>
                <span className="w-4" />(empty)
              </div>
            )}
            {nodes.map((node, i) => (
              <div key={node.id} role="menuitem" tabIndex={-1} data-bm-row={i} draggable
                className={cls('bx-bm-row', l.active === i && 'bx-bm-active',
                  levels[level + 1]?.folderId === node.id && 'bx-bm-open',
                  mark?.level === level && mark.index === i && `bx-bm-${mark.spot}`)}
                title={node.url ? `${node.title}\n${node.url}` : node.title}
                onMouseEnter={e => {
                  // Deeper levels close (or this folder opens) after a moment, so a diagonal move into an open sub-menu does not lose it.
                  setActive(level, i, false);
                  const rect = e.currentTarget.getBoundingClientRect();
                  later(() => (node.children ? openSub(level, node, rect, false) : setLevels(ls => ls.slice(0, level + 1))), OPEN_DELAY);
                }}
                onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
                onClick={e => activate(level, i, { newTab: e.ctrlKey || e.metaKey || e.shiftKey })}
                onAuxClick={e => { if (e.button === 1) { if (node.url) openBookmark(node.url, true); else if (node.children) { void openAll(node); onClose(); } } }}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation();
                  void bookmarkContextMenu(node, l.folderId, l.offset + i).then(p => { if (p && CLOSES.has(p)) onClose(); });
                }}
                onDragStart={e => startNodeDrag(e, [node.id])}
                onDragOver={e => onRowDragOver(e, level, i, node)}
                onDrop={e => onRowDrop(e, level, i, node)}>
                {node.children
                  ? <Icon name="folder" size={16} className="shrink-0 text-aico-secondary" />
                  : <Favicon src={node.favicon} url={node.url} size={16} />}
                <span className="min-w-0 flex-1 truncate">{node.title || node.url}</span>
                {node.children && <Icon name="chevron-right" size={14} className="shrink-0 text-aico-muted" />}
              </div>
            ))}
            {n > 0 && (
              <>
                <div className="menu-sep" />
                <div role="menuitem" tabIndex={-1} data-bm-row={nodes.length}
                  className={cls('bx-bm-row', l.active === nodes.length && 'bx-bm-active')}
                  onMouseEnter={() => { setActive(level, nodes.length, false); later(() => setLevels(ls => ls.slice(0, level + 1)), OPEN_DELAY); }}
                  onClick={() => activate(level, nodes.length)}>
                  <Icon name="external" size={15} className="shrink-0 text-aico-secondary" />
                  <span className="flex-1">Open all ({n})</span>
                </div>
              </>
            )}
          </Panel>
        );
      })}
    </>,
    document.body,
  );
}

/** Picks from the right-click menu that take you somewhere else (a dialog, a page) close the drop-down. */
const CLOSES = new Set(['open', 'newtab', 'openall', 'edit', 'rename', 'addpage', 'addfolder', 'manager']);

/** One level: placed under the bar button, or beside its row; flips and scrolls to stay on screen. */
function Panel({ level, anchor, sub, children, onDragLeave, onContextMenu }: {
  level: number; anchor: DOMRect; sub: boolean; children: React.ReactNode;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void; onContextMenu: (e: React.MouseEvent) => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const place = (): void => {
      const el = ref.current;
      if (!el) return;
      const w = el.offsetWidth; const h = el.scrollHeight;
      const vw = window.innerWidth; const vh = window.innerHeight; const m = 8;
      let top: number; let left: number;
      if (sub) {
        left = anchor.right - 2;
        if (left + w > vw - m) left = Math.max(m, anchor.left - w + 2);
        top = anchor.top - 6;
        if (top + h > vh - m) top = Math.max(m, vh - m - h);
      } else {
        left = Math.max(m, Math.min(anchor.left, vw - m - w));
        top = anchor.bottom + 2;
      }
      setPos({ top, left, maxHeight: vh - top - m });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [anchor, sub]);
  return (
    <div ref={ref} role="menu" data-bm-menu data-bm-level={level}
      className="menu bx-bm-menu fixed overflow-y-auto thin-scroll"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden', zIndex: 70 + level }}
      onDragLeave={onDragLeave} onContextMenu={onContextMenu}>
      {children}
    </div>
  );
}
