/**
 * Artifacts — everything this chat produced or opened, in the right-hand
 * slot: documents, sheets, code canvases, exported and generated files,
 * images, attachments — and a viewer for each.
 *
 * The list is the engine's (`GET artifacts/list`, `server/artifact-routes`),
 * which joins the three stores a chat's work lives in. This panel names,
 * folds, groups and shows it (`artifacts-core` is the pure half, unit-tested):
 *
 *   - **Names a person reads.** "the-chart-still-draws-all-50-days-1440.png"
 *     is shown as "The chart still draws all 50 days", with the real file name
 *     under it and in the tooltip. Identical copies (same name and size) are
 *     one row with a ×N badge; different files that share a name are numbered.
 *   - **Grouped** by type, by day, or by topic (an export sits under the
 *     canvas it came from); a search box filters; pictures can be a grid.
 *   - **A viewer per type** (`ArtifactViewer`): selecting a file swaps the list
 *     for its preview, wider, with back, previous/next (← →), a full-size view,
 *     and Open / Show in folder / Copy path / Save as. A canvas still opens in
 *     the canvas editor beside the chat — that *is* its viewer.
 *
 * What the first version got wrong, kept here so it is not repeated: the "…"
 * menu was an absolutely-positioned div inside a scrolling list, drawn with a
 * colour class that does not exist (`bg-aico-panel`), so it was transparent,
 * overlapped the next row and was clipped by the list. Menus now use the
 * shell's Popover (portalled, measured, flips at the edge). Thumbnails of full
 * page screenshots were centre-cropped to a 32 px square of white page; they
 * are now anchored to the top, where the page's header is.
 *
 * Refreshed when it opens, on every canvas frame, and when a turn ends —
 * that is when exports and generated images appear. The panel belongs to the
 * chat: switching chats closes it, like Sources and the canvas.
 *
 * @module desktop/renderer/chat/ArtifactsPanel
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '@web/store';
import { api, type ArtifactItem } from '@web/api';
import { onCanvasEvent } from '@aico/ui';
import { getCanvasHost } from '@aico/shared/ui/canvas/host';
import { Icon } from '@/lib/icons';
import { ago, bytes, cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { toast } from '@/state/desk';
import { MenuButton, MenuItem, MenuSep, MenuSub } from '@/shell/Popover';
import { Modal } from '@/shell/Modal';
import { useCanvasPanel } from './CanvasPanel';
import { ArtifactViewer, artifactUrl, fileRef, typeStyle, type ViewerActions } from './ArtifactViewer';
import { buildEntries, groupEntries, matchesQuery, typeLabel, type ArtifactEntry, type Grouping } from './artifacts-core';

export const useArtifactsPanel = create<{ open: boolean; toggle: () => void; close: () => void }>(set => ({
  open: false,
  toggle: () => set(s => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

const GROUP_KEY = 'aico.desk.artifactsGroup';
const LAYOUT_KEY = 'aico.desk.artifactsLayout';
const WIDTH_KEY = 'aico.desk.artifactsWidth';
const VIEWER_WIDTH_KEY = 'aico.desk.artifactsViewerWidth';
const LIST_WIDTH = 400;
const VIEWER_WIDTH = 680;
const MIN_WIDTH = 340;

const EXPORTS: Record<string, Array<{ format: 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv'; label: string }>> = {
  document: [{ format: 'docx', label: 'Word (.docx)' }, { format: 'pdf', label: 'PDF' }, { format: 'md', label: 'Markdown' }, { format: 'html', label: 'Web page' }],
  sheet: [{ format: 'xlsx', label: 'Excel (.xlsx)' }, { format: 'csv', label: 'CSV' }],
  code: [{ format: 'md', label: 'Markdown' }],
};

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback; } catch { return fallback; }
}
function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* not remembered */ }
}
function clampWidth(w: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - 420)));
}
function storedWidth(key: string, fallback: number): number {
  try { const n = Number(localStorage.getItem(key)); return clampWidth(Number.isFinite(n) && n >= MIN_WIDTH ? n : fallback); } catch { return clampWidth(fallback); }
}

function base64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function saveAs(name: string, blob: Blob): Promise<void> {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const where = await desktop.dialog.saveFile({
    defaultName: name, content: base64(await blob.arrayBuffer()), encoding: 'base64',
    ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {}),
  });
  if (where) toast.success('Saved', where);
}

/** Scroll the transcript to a canvas's card and flash it — "where in the chat did this come from". */
function showInChat(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-canvas-card="${id}"]`);
  if (!card) return false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.animate([{ boxShadow: '0 0 0 3px var(--aico-accent)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1600 });
  return true;
}

/** "Today 3:42 PM" / "2 Oct, 3:42 PM" — the moment, for telling namesakes apart. */
function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return ts >= today.getTime() ? `Today ${time}` : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

function Thumb({ entry, sessionId, large }: { entry: ArtifactEntry; sessionId: string; large?: boolean }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  const t = typeStyle(entry);
  if (entry.kind === 'image' && !broken) {
    return (
      <img src={artifactUrl(sessionId, entry.item)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)}
        // Anchored to the top: a full-page screenshot centre-cropped is a square of blank page.
        className={cls('shrink-0 border border-aico-border-subtle bg-white object-cover object-top',
          large ? 'aspect-[4/3] w-full rounded-lg' : 'h-10 w-10 rounded-lg')} />
    );
  }
  return (
    <span className={cls('grid shrink-0 place-items-center', t.tint, large ? 'aspect-[4/3] w-full rounded-lg' : 'h-10 w-10 rounded-lg')}>
      <Icon name={t.icon} size={large ? 28 : 18} />
    </span>
  );
}

/** The list's second line: the real file name first, then size and age. */
function metaLine(e: ArtifactEntry): string {
  const a = e.item;
  if (e.kind === 'canvas') return `${typeLabel(e)} canvas · edited ${ago(a.updatedAt)} ago`;
  const parts = [a.title];
  if (a.kind === 'export') parts.push(`from ${a.topic}`);
  if (a.bytes !== undefined) parts.push(bytes(a.bytes));
  parts.push(ago(a.updatedAt) === 'now' ? 'just now' : ago(a.updatedAt));
  if (a.uploaded) parts.push('uploaded');
  return parts.join(' · ');
}

export function ArtifactsPanel(): React.ReactElement | null {
  const open = useArtifactsPanel(s => s.open);
  const close = useArtifactsPanel(s => s.close);
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);
  const [items, setItems] = useState<ArtifactItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<Grouping>(() => stored(GROUP_KEY, ['type', 'time', 'topic'] as const, 'type'));
  const [layout, setLayout] = useState<'list' | 'grid'>(() => stored(LAYOUT_KEY, ['list', 'grid'] as const, 'list'));
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(() => storedWidth(WIDTH_KEY, LIST_WIDTH));
  const [viewerWidth, setViewerWidth] = useState(() => storedWidth(VIEWER_WIDTH_KEY, VIEWER_WIDTH));
  const listRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!sessionId) return;
    api.artifactsList(sessionId).then(r => { setItems(r.artifacts); setError(null); }, err => setError(err instanceof Error ? err.message : String(err)));
  }, [sessionId]);

  useEffect(() => { if (open) load(); else { setSelected(null); setFull(false); } }, [open, load]);
  useEffect(() => { if (open && !busy) load(); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (open ? onCanvasEvent(() => load()) : undefined), [open, load]);

  const entries = useMemo(() => buildEntries(items ?? []), [items]);
  const groups = useMemo(() => groupEntries(entries.filter(e => matchesQuery(e, query)), grouping), [entries, query, grouping]);
  const ordered = useMemo(() => groups.flatMap(g => g.entries), [groups]);
  const current = selected ? entries.find(e => e.item.key === selected) ?? null : null;
  const position = current ? ordered.indexOf(current) : -1;

  const focusRow = (key: string | null): void => {
    requestAnimationFrame(() => {
      const el = key ? listRef.current?.querySelector<HTMLElement>(`[data-artifact-row="${CSS.escape(key)}"]`) : null;
      (el ?? listRef.current?.querySelector<HTMLElement>('[data-artifact-row]'))?.focus();
    });
  };
  const back = useCallback((): void => { const k = selected; setSelected(null); setFull(false); focusRow(k); }, [selected]);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('[role="menu"]')) return;
      if (selected) back(); else close();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, close, selected, back]);

  // The viewer takes the keyboard when it opens, so ← → page through at once.
  useEffect(() => { if (selected && !full) requestAnimationFrame(() => viewerRef.current?.focus()); }, [selected, full]);

  if (!open) return null;

  const setGroup = (g: Grouping): void => { setGrouping(g); remember(GROUP_KEY, g); };
  const setView = (l: 'list' | 'grid'): void => { setLayout(l); remember(LAYOUT_KEY, l); };
  const ref = (a: ArtifactItem) => ({ id: a.id, title: a.title, kind: a.kind as 'document' | 'sheet' | 'code', ...(a.language ? { language: a.language } : {}) });
  const openCanvas = (a: ArtifactItem, beside = false): void => {
    if (beside) useCanvasPanel.getState().showBeside(ref(a)); else useCanvasPanel.getState().show(ref(a));
    close();
  };
  const fileBlob = (a: ArtifactItem): Promise<Blob> => api.artifactFile(sessionId, fileRef(a));
  const sourceCanvas = (a: ArtifactItem): ArtifactItem | undefined =>
    a.kind === 'export' ? (items ?? []).find(c => c.source === 'canvas' && c.title === a.topic) : undefined;

  const activate = (e: ArtifactEntry): void => {
    if (e.kind === 'canvas') openCanvas(e.item);
    else setSelected(e.item.key);
  };
  const step = (by: number): void => {
    if (!ordered.length) return;
    const at = position < 0 ? 0 : (position + by + ordered.length) % ordered.length;
    setSelected(ordered[at]!.item.key);
  };

  const fileActions = (a: ArtifactItem): ViewerActions => ({
    ...(a.path ? {
      openWith: () => void desktop.shell.openPath(a.path!).catch((err: unknown) => toast.error('Could not open it', String(err))),
      reveal: () => void desktop.shell.showItemInFolder(a.path!),
    } : {}),
    save: () => void fileBlob(a).then(b => saveAs(a.title, b), (err: unknown) => toast.error('Not saved', err instanceof Error ? err.message : String(err))),
    openCanvas: () => openCanvas(a),
  });
  const copyPath = (p: string): void => {
    navigator.clipboard.writeText(p).then(() => toast.success('Path copied', p), () => void desktop.clipboard.writeRich(p).then(() => toast.success('Path copied', p)));
  };

  const rename = async (a: ArtifactItem, name: string): Promise<void> => {
    setRenaming(null);
    const next = name.trim();
    if (!next || next === a.title) { focusRow(a.key); return; }
    try {
      if (a.source === 'canvas') await api.canvasRename(sessionId, a.id, next);
      else if (a.source === 'file') await api.artifactRename(sessionId, a.id, next);
      load();
    } catch (err) { toast.error('Not renamed', err instanceof Error ? err.message : String(err)); }
  };

  const exportCanvas = async (a: ArtifactItem, format: 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv'): Promise<void> => {
    const host = getCanvasHost();
    if (!host?.exportFile) return;
    try {
      const { blob, name } = await host.exportFile(a.id, format);
      await saveAs(name, blob);
    } catch (err) { toast.error('Export failed', err instanceof Error ? err.message : String(err)); }
  };

  /** One menu for a row and for the viewer, so the same file offers the same things everywhere. */
  const menu = (e: ArtifactEntry, done: () => void, inViewer: boolean): React.ReactNode => {
    const a = e.item;
    const run = (fn: () => void) => () => { done(); fn(); };
    if (e.kind === 'canvas') {
      const openNow = useCanvasPanel.getState().open;
      const canOpenBeside = Boolean(openNow && openNow.id !== a.id);
      return (
        <>
          <MenuItem icon="panel-right" label="Open beside the chat" onClick={run(() => openCanvas(a))} />
          <MenuItem icon="split" label={canOpenBeside ? `Open next to “${openNow!.title ?? ''}”` : 'Open next to another canvas'} disabled={!canOpenBeside}
            title={canOpenBeside ? undefined : 'Open another canvas first'} onClick={run(() => openCanvas(a, true))} />
          {(EXPORTS[a.kind] ?? []).length > 0 && (
            <MenuSub icon="download" label="Export as">
              {(EXPORTS[a.kind] ?? []).map(x => <MenuItem key={x.format} label={x.label} onClick={run(() => void exportCanvas(a, x.format))} />)}
            </MenuSub>
          )}
          <MenuSep />
          {!inViewer && <MenuItem icon="edit" label="Rename" onClick={run(() => setRenaming(a.key))} />}
          <MenuItem icon="chat" label="Show in chat" onClick={run(() => { if (!showInChat(a.id)) toast.info('Not in the visible chat', 'Its card is further up — scroll up to load earlier messages.'); })} />
        </>
      );
    }
    const acts = fileActions(a);
    const from = sourceCanvas(a);
    return (
      <>
        {!inViewer && <MenuItem icon="eye" label="Preview" hint="Enter" onClick={run(() => setSelected(a.key))} />}
        {acts.openWith && <MenuItem icon="external" label="Open with default app" onClick={run(acts.openWith)} />}
        {acts.reveal && <MenuItem icon="folder-open" label="Show in folder" onClick={run(acts.reveal)} />}
        {a.path && <MenuItem icon="copy" label="Copy path" onClick={run(() => copyPath(a.path!))} />}
        <MenuItem icon="download" label="Save a copy…" onClick={run(acts.save)} />
        {from && <MenuItem icon="panel-right" label={`Open “${from.title}”`} onClick={run(() => openCanvas(from))} />}
        {!inViewer && a.source === 'file' && (
          <>
            <MenuSep />
            <MenuItem icon="edit" label="Rename" onClick={run(() => setRenaming(a.key))} />
          </>
        )}
      </>
    );
  };

  const onListKey = (ev: React.KeyboardEvent): void => {
    const target = ev.target as HTMLElement;
    if (!target.matches('[data-artifact-row]')) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-artifact-row]') ?? [])];
    const i = rows.indexOf(target);
    let next: HTMLElement | undefined;
    if (ev.key === 'Home') next = rows[0];
    else if (ev.key === 'End') next = rows[rows.length - 1];
    else if (layout === 'grid' && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      // In the grid, up and down go to the tile above or below, not the next in reading order.
      const r = target.getBoundingClientRect();
      const down = ev.key === 'ArrowDown';
      const candidates = rows.filter(el => { const t = el.getBoundingClientRect().top; return down ? t > r.top + 4 : t < r.top - 4; });
      const lineTop = candidates.reduce((best, el) => { const t = el.getBoundingClientRect().top; return down ? Math.min(best, t) : Math.max(best, t); }, down ? Infinity : -Infinity);
      next = candidates.filter(el => Math.abs(el.getBoundingClientRect().top - lineTop) < 4)
        .sort((x, y) => Math.abs(x.getBoundingClientRect().left - r.left) - Math.abs(y.getBoundingClientRect().left - r.left))[0];
    } else if (ev.key === 'ArrowDown' || (layout === 'grid' && ev.key === 'ArrowRight')) next = rows[i + 1];
    else if (ev.key === 'ArrowUp' || (layout === 'grid' && ev.key === 'ArrowLeft')) next = rows[i - 1];
    else return;
    ev.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
  };

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const viewing = Boolean(current);
    const startX = e.clientX;
    const startW = viewing ? viewerWidth : listWidth;
    let last = startW;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: MouseEvent): void => { last = clampWidth(startW - (ev.clientX - startX)); (viewing ? setViewerWidth : setListWidth)(last); };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      remember(viewing ? VIEWER_WIDTH_KEY : WIDTH_KEY, String(last));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const row = (e: ArtifactEntry, tile = false): React.ReactElement => {
    const a = e.item;
    const acts = e.kind === 'canvas' ? null : fileActions(a);
    const tip = `${a.title}${a.path ? `\n${a.path}` : ''}`;
    if (renaming === a.key) {
      return (
        <li key={a.key} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
          <Thumb entry={e} sessionId={sessionId} />
          <input autoFocus defaultValue={a.title} className="input h-8 py-0 text-[13px]" aria-label={`New name for ${a.title}`}
            onBlur={ev => void rename(a, ev.target.value)}
            onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') { setRenaming(null); focusRow(a.key); } }} />
        </li>
      );
    }
    const badges = (
      <>
        {e.variant && <span className="shrink-0 rounded-md bg-aico-hover px-1.5 text-[11px] font-medium tabular-nums text-aico-secondary" title={`${e.variant.of} different files share this name — this is #${e.variant.index} (higher is newer). ${when(a.updatedAt)}`}>#{e.variant.index}</span>}
        {e.copies.length > 0 && <span className="shrink-0 rounded-md bg-aico-accent-soft px-1.5 text-[11px] font-medium tabular-nums text-aico-accent" title={`${e.copies.length + 1} identical copies (same name and size) — showing the newest`}>×{e.copies.length + 1}</span>}
      </>
    );
    const actions = (
      <div className={cls('flex shrink-0 items-center gap-0.5 transition-opacity',
        'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [&:has([aria-expanded=true])]:opacity-100',
        tile && 'absolute right-1.5 top-1.5 rounded-lg bg-aico-bg/90 shadow-sm')}>
        {acts?.openWith && (
          <button className="icon-btn-sm" onClick={acts.openWith} title="Open with default app" aria-label={`Open ${e.name} with the default app`}><Icon name="external" size={15} /></button>
        )}
        <MenuButton className="icon-btn-sm" placement="bottom-end" width={240} title="More actions" ariaLabel={`More actions for ${e.name}`}
          button={<Icon name="more" size={16} />}>
          {done => menu(e, done, false)}
        </MenuButton>
      </div>
    );
    if (tile) {
      return (
        <li key={a.key} className="group relative">
          <button data-artifact-row={a.key} title={tip} onClick={() => activate(e)}
            className="flex w-full flex-col gap-1.5 rounded-xl p-1.5 text-left transition-colors hover:bg-aico-hover">
            <Thumb entry={e} sessionId={sessionId} large />
            <span className="flex min-w-0 items-center gap-1 px-0.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-aico-primary">{e.name}</span>{badges}
            </span>
          </button>
          {actions}
        </li>
      );
    }
    return (
      <li key={a.key} className="group relative flex items-center gap-1 rounded-xl pr-1.5 transition-colors hover:bg-aico-hover">
        <button data-artifact-row={a.key} title={tip} onClick={() => activate(e)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left"
          aria-label={`${e.name}, ${typeLabel(e)}${e.copies.length ? `, ${e.copies.length + 1} copies` : ''}. ${e.kind === 'canvas' ? 'Opens beside the chat' : 'Opens a preview'}`}>
          <Thumb entry={e} sessionId={sessionId} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[13.5px] font-medium text-aico-primary">{e.name}</span>{badges}
            </span>
            <span className="block truncate text-[11.5px] text-aico-muted">{metaLine(e)}</span>
          </span>
        </button>
        {actions}
      </li>
    );
  };

  const count = entries.length;
  const width = current ? viewerWidth : listWidth;

  const viewerFrame = (e: ArtifactEntry, inModal: boolean): React.ReactElement => {
    const a = e.item;
    const acts = fileActions(a);
    const meta = [typeLabel(e), e.detail, a.bytes !== undefined ? bytes(a.bytes) : undefined, when(a.updatedAt), a.topic,
      e.copies.length ? `${e.copies.length + 1} identical copies` : undefined, e.variant ? `#${e.variant.index} of ${e.variant.of} with this name` : undefined].filter(Boolean).join(' · ');
    return (
      <div className="flex min-h-0 flex-1 flex-col outline-none" tabIndex={-1} ref={inModal ? undefined : viewerRef}
        onKeyDown={(ev) => {
          const t = ev.target as HTMLElement;
          if (t.closest('input, textarea, select, video, audio, [role="menu"]')) return;
          if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
          if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
        }}>
        <div className="flex shrink-0 items-center gap-1 border-b border-aico-border-subtle px-2 pb-2 pt-2.5">
          {!inModal && (
            <button className="icon-btn-sm" onClick={back} title="All artifacts (Esc)" aria-label="Back to all artifacts">
              <Icon name="arrow-left" size={16} />
            </button>
          )}
          <div className={cls('min-w-0 flex-1', inModal ? 'px-3' : 'px-1')}>
            <h3 className="truncate text-[14px] font-semibold text-aico-primary" title={a.title}>{e.name}</h3>
            <div className="truncate text-[11.5px] text-aico-muted" title={a.path ?? a.title}>{a.title}</div>
          </div>
          {ordered.length > 1 && (
            <div className="flex items-center" role="group" aria-label="Browse artifacts">
              <button className="icon-btn-sm" onClick={() => step(-1)} title="Previous (←)" aria-label="Previous artifact"><Icon name="chevron-left" size={16} /></button>
              <span className="min-w-[44px] text-center text-[11.5px] tabular-nums text-aico-muted" aria-live="polite">{position >= 0 ? position + 1 : '–'} / {ordered.length}</span>
              <button className="icon-btn-sm" onClick={() => step(1)} title="Next (→)" aria-label="Next artifact"><Icon name="chevron-right" size={16} /></button>
            </div>
          )}
          {!inModal && e.kind !== 'canvas' && (
            <button className="icon-btn-sm" onClick={() => setFull(true)} title="Full size" aria-label="Show full size"><Icon name="expand" size={15} /></button>
          )}
          {acts.openWith && e.kind !== 'canvas' && (
            <button className="icon-btn-sm" onClick={acts.openWith} title="Open with default app" aria-label="Open with default app"><Icon name="external" size={15} /></button>
          )}
          <MenuButton className="icon-btn-sm" placement="bottom-end" width={240} title="More actions" ariaLabel={`More actions for ${e.name}`}
            button={<Icon name="more" size={16} />}>
            {done => menu(e, done, true)}
          </MenuButton>
          <button className="icon-btn-sm" onClick={inModal ? () => setFull(false) : close} title={inModal ? 'Close (Esc)' : 'Close the panel'}
            aria-label={inModal ? 'Close full size' : 'Close artifacts'}><Icon name="x" size={16} /></button>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ArtifactViewer sessionId={sessionId} entry={e} actions={acts} />
        </div>
        <div className="selectable shrink-0 truncate border-t border-aico-border-subtle px-4 py-1.5 text-[11.5px] text-aico-muted" title={meta}>{meta}</div>
      </div>
    );
  };

  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg animate-fade-in"
      style={{ width }} aria-label="Artifacts" data-artifacts-panel="">
      <div className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-aico-hover" onMouseDown={startResize}
        onDoubleClick={() => { if (current) { setViewerWidth(clampWidth(VIEWER_WIDTH)); remember(VIEWER_WIDTH_KEY, String(VIEWER_WIDTH)); } else { setListWidth(clampWidth(LIST_WIDTH)); remember(WIDTH_KEY, String(LIST_WIDTH)); } }}
        role="separator" aria-orientation="vertical" aria-label="Resize the artifacts panel (double-click to reset)" title="Drag to resize · double-click to reset" />
      {current ? viewerFrame(current, false) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5 px-4 pb-2 pt-3.5">
            <h2 className="text-[15px] font-semibold">Artifacts</h2>
            {count > 0 && <span className="rounded-full bg-aico-hover px-2 py-px text-[11.5px] font-medium tabular-nums text-aico-secondary">{count}</span>}
            <span className="flex-1" />
            <div className={cls('flex items-center', !entries.some(e => e.kind === 'image') && 'hidden')} role="group" aria-label="Pictures as">

              <button className={cls('icon-btn-sm', layout === 'list' && 'bg-aico-hover text-aico-primary')} aria-pressed={layout === 'list'} onClick={() => setView('list')} title="List" aria-label="Show as a list"><Icon name="list" size={15} /></button>
              <button className={cls('icon-btn-sm', layout === 'grid' && 'bg-aico-hover text-aico-primary')} aria-pressed={layout === 'grid'} onClick={() => setView('grid')} title="Pictures as a grid" aria-label="Show pictures as a grid"><Icon name="grid" size={15} /></button>
            </div>
            <button className="icon-btn-sm" onClick={load} title="Refresh" aria-label="Refresh"><Icon name="refresh" size={15} /></button>
            <button className="icon-btn-sm" onClick={close} title="Close (Esc)" aria-label="Close artifacts"><Icon name="x" size={16} /></button>
          </div>
          <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
            <label className="relative min-w-0 flex-1">
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-aico-muted" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search artifacts" aria-label="Search artifacts"
                className="input h-8 py-0 pl-8 text-[12.5px]"
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); }
                  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(null); }
                }} />
            </label>
            <div className="segmented shrink-0" role="group" aria-label="Group by">
              {(['type', 'time', 'topic'] as const).map(g => (
                <button key={g} aria-pressed={grouping === g} className="!px-2.5 !text-[12px]" onClick={() => setGroup(g)}
                  title={g === 'type' ? 'Group by type' : g === 'time' ? 'Group by day' : 'Group by topic — exports under their canvas'}>
                  {g === 'type' ? 'Type' : g === 'time' ? 'Date' : 'Topic'}
                </button>
              ))}
            </div>
          </div>
          <div ref={listRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4" onKeyDown={onListKey}>
            {error && <p className="px-3 py-2 text-[12.5px] text-aico-danger">{error}</p>}
            {!items && !error && (
              <div className="space-y-2 px-2 pt-2" aria-label="Loading">
                {[0, 1, 2, 3].map(i => <div key={i} className="flex items-center gap-3"><div className="skeleton h-10 w-10" /><div className="flex-1 space-y-1.5"><div className="skeleton h-3 w-2/3" /><div className="skeleton h-2.5 w-1/2" /></div></div>)}
              </div>
            )}
            {items && count === 0 && (
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-aico-hover text-aico-secondary"><Icon name="layers" size={22} /></span>
                <p className="text-[13.5px] font-medium text-aico-primary">Nothing yet</p>
                <p className="text-[12.5px] text-aico-muted">Documents, sheets, web pages, exports and images this chat makes appear here.</p>
              </div>
            )}
            {items && count > 0 && ordered.length === 0 && (
              <p className="px-3 py-8 text-center text-[12.5px] text-aico-muted">No artifacts match “{query}”.</p>
            )}
            {groups.map(g => (
              <section key={g.name} aria-label={g.name}>
                <h3 className="sticky top-0 z-[1] flex items-center gap-1.5 bg-aico-bg px-2 pb-1 pt-3 text-[11.5px] font-semibold uppercase tracking-wide text-aico-muted">
                  {g.name}<span className="font-normal tabular-nums">{g.entries.length}</span>
                </h3>
                {/* The grid is for pictures; anything without a thumbnail stays a row (a big tinted tile says less than a line of text). */}
                {layout === 'grid' && g.entries.some(e => e.kind === 'image') && (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-1">{g.entries.filter(e => e.kind === 'image').map(e => row(e, true))}</ul>
                )}
                <ul className="space-y-px">{g.entries.filter(e => layout !== 'grid' || e.kind !== 'image').map(e => row(e))}</ul>
              </section>
            ))}
          </div>
        </>
      )}
      <Modal open={full && Boolean(current)} onClose={() => setFull(false)} hideClose width="min(1400px, 94vw)" className="h-[92vh]">
        {current && viewerFrame(current, true)}
      </Modal>
    </aside>
  );
}
