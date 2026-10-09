/**
 * The design board viewer (ADR 0037): a chat's mockup screens as frames on a
 * zoomable, pannable canvas, grouped under section headings — with Play (one
 * screen full size, its links opening the others), Present (every screen in
 * order), per-screen download, the board as PDF or zip, and sticky notes the
 * agent reads back.
 *
 * One component for the browser portal and the desktop (which imports it from
 * here, like the other shared panes); the only difference is how a document
 * is framed (`FrameHost`, see board-docs).
 *
 * ## How it draws
 *
 * The layout and camera are pure (`shared/ui/board/board-model`: sections
 * stacked, frames in a row, `{x, y, k}` with the world point at the centre),
 * the same shape as the Code map's camera. Frames sit in one world layer
 * moved by a CSS transform, each a real page at its device size, so a 1440 px
 * screen at 25% is the actual screen, scaled. Labels — section headings,
 * frame titles and their Play/download buttons, notes — are drawn in screen
 * space at a constant size, so they stay readable at 10% and do not balloon
 * at 200%.
 *
 * Only frames in or near the view get a live page (`framesToMount`, at most
 * twelve, nearest first); the rest are placeholders with their title, so a
 * forty-screen board costs what is on screen. On the board a page is a
 * picture: `pointer-events: none`, out of the tab order. Play is where it is
 * interactive.
 *
 * ## Tools
 *
 * Select (V: click selects, double-click plays), Hand (H, or hold Space, or
 * the middle button: drag pans) and Note (N: click to pin a note). Wheel and
 * pinch zoom toward the pointer; − / + step through fixed zoom levels; Fit
 * (Shift+1) shows the whole board, 0 goes to 100%. Pen, shapes and free text
 * are deliberately absent: the screens are the design.
 *
 * @module web/components/board/DesignBoardView
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import {
  LAYOUT, dirOf, fitRect, frameAt, framesToMount, layoutBoard, orderedFrames, panBy, stepZoom, toScreen, toWorld, zoomAt,
  type Board, type BoardFrame, type BoardNote, type Camera,
} from '../../../../shared/ui/board/board-model';
import { boardDocs, downloadBlob, type FrameHost } from './board-docs';
import { BoardPlayer, ScreenFrame } from './BoardPlayer';
import { BoardIcon, type BoardGlyph } from './icons';

type Tool = 'select' | 'hand' | 'note';

export interface DesignBoardViewProps {
  sessionId: string;
  /** The board's board.json, relative to the chat's artifacts folder (the artifact's id). */
  path: string;
  /** Changes when the board was written again; the view reloads. */
  version?: number | string;
  /** How this client frames a document; absent = srcdoc. */
  frameHost?: FrameHost;
  /** How this client saves a file; absent = the browser's download. */
  save?: (name: string, blob: Blob) => void;
  /** Shown as a close button when the view is an overlay. */
  onClose?: () => void;
}

const LABEL_H = 30;
/** Room the floating toolbar takes at the bottom of the canvas. */
const TOOLBAR_H = 72;

export function DesignBoardView({ sessionId, path, version, frameHost, save = downloadBlob, onClose }: DesignBoardViewProps): React.ReactElement {
  const dir = dirOf(path);
  const [board, setBoard] = useState<Board | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const docs = useMemo(() => boardDocs(sessionId, dir), [sessionId, dir, version, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api.boardGet(sessionId, path).then(
      r => { if (alive) { setBoard(r.board); setProblems(r.problems); } },
      (e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { alive = false; };
  }, [sessionId, path, version, reload]);

  const layout = useMemo(() => (board ? layoutBoard(board) : null), [board]);
  const frames = useMemo(() => (board ? orderedFrames(board) : []), [board]);
  const frameById = useMemo(() => new Map(frames.map(f => [f.id, f])), [frames]);

  // ── Camera ──
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, k: 0.25 });
  const camRef = useRef(cam);
  camRef.current = cam;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fitted = useRef(false);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [board !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = useCallback(() => {
    if (!layout || !sizeRef.current.w) return;
    // Fit above the floating toolbar, not under it.
    const c = fitRect(layout.bounds, sizeRef.current.w, sizeRef.current.h - TOOLBAR_H, 56, 1);
    setCam({ ...c, y: c.y + TOOLBAR_H / 2 / c.k });
  }, [layout]);
  useEffect(() => {
    if (!fitted.current && layout && size.w > 0) { fitted.current = true; fit(); }
  }, [layout, size.w, fit]);
  const zoomTo = useCallback((k: number, at?: { x: number; y: number }) => {
    const { w, h } = sizeRef.current;
    setCam(c => zoomAt(c, w, h, at?.x ?? w / 2, at?.y ?? h / 2, k));
  }, []);

  // Wheel and trackpad pinch (ctrlKey) zoom toward the pointer.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const { w, h } = sizeRef.current;
      const c = camRef.current;
      setCam(zoomAt(c, w, h, e.clientX - r.left, e.clientY - r.top, c.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [board !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tools and pointer ──
  const [tool, setTool] = useState<Tool>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [play, setPlay] = useState<{ id: string; present: boolean } | null>(null);
  const [notes, setNotes] = useState<BoardNote[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => { setNotes(board?.notes ?? []); }, [board]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const drag = useRef<{ x: number; y: number; cam: Camera; moved: boolean; pan: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; k: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = viewport.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('[data-board-ui]')) return;
    viewport.current?.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, k: camRef.current.k };
      drag.current = null;
      return;
    }
    const pan = tool === 'hand' || spaceHeld || e.button === 1;
    drag.current = { x: e.clientX, y: e.clientY, cam: camRef.current, moved: false, pan };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pan) setPanning(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const r = viewport.current!.getBoundingClientRect();
      zoomTo(pinch.current.k * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.current.dist), { x: (a!.x + b!.x) / 2 - r.left, y: (a!.y + b!.y) / 2 - r.top });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) { d.moved = true; setPanning(true); }
    // Select and Note pan too when dragged on the canvas: there is nothing on a board to drag but the view.
    if (d.moved) setCam(panBy(d.cam, dx, dy));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) { if (pointers.current.size < 2) pinch.current = null; drag.current = null; return; }
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    if (!d || d.moved || d.pan || !layout) return;
    const p = local(e);
    const [wx, wy] = toWorld(camRef.current, sizeRef.current.w, sizeRef.current.h, p.x, p.y);
    const hit = frameAt(layout, wx, wy);
    if (tool === 'note') {
      const note: BoardNote = { id: `n${Date.now().toString(36)}`, text: '', x: Math.round(wx), y: Math.round(wy), ...(hit ? { frame: hit } : {}), at: Date.now() };
      setNotes(n => [...n, note]);
      setEditing(note.id);
      setTool('select');
      return;
    }
    setSelected(hit ?? null);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!layout || (e.target as HTMLElement).closest('[data-board-ui]')) return;
    const p = local(e);
    const [wx, wy] = toWorld(camRef.current, sizeRef.current.w, sizeRef.current.h, p.x, p.y);
    const hit = frameAt(layout, wx, wy);
    if (hit) setPlay({ id: hit, present: false });
  };

  const saveNotes = useCallback((next: BoardNote[]) => {
    const kept = next.filter(n => n.text.trim());
    setNotes(kept);
    api.boardNotes(sessionId, path, kept).then(r => setNotes(r.notes), (e: unknown) => setToast(`Note not saved: ${e instanceof Error ? e.message : String(e)}`));
  }, [sessionId, path]);

  // ── Keys ──
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('textarea, input')) return;
    const { w, h } = sizeRef.current;
    if (e.key === ' ') { e.preventDefault(); setSpaceHeld(true); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'v': case 'V': setTool('select'); break;
      case 'h': case 'H': setTool('hand'); break;
      case 'n': case 'N': setTool('note'); break;
      case '+': case '=': zoomTo(stepZoom(camRef.current.k, 1)); break;
      case '-': case '_': zoomTo(stepZoom(camRef.current.k, -1)); break;
      case '0': zoomTo(1); break;
      case '!': case '1': if (e.shiftKey || e.key === '1') fit(); break;
      case 'Enter': if (selected) setPlay({ id: selected, present: false }); break;
      case 'p': case 'P': if (frames.length) setPlay({ id: selected ?? frames[0]!.id, present: true }); break;
      case 'Escape': setSelected(null); setMenu(false); break;
      case 'ArrowLeft': setCam(c => panBy(c, 80, 0)); break;
      case 'ArrowRight': setCam(c => panBy(c, -80, 0)); break;
      case 'ArrowUp': setCam(c => panBy(c, 0, 80)); break;
      case 'ArrowDown': setCam(c => panBy(c, 0, -80)); break;
      default: return;
    }
    e.preventDefault();
    void w; void h;
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => { if (e.key === ' ') setSpaceHeld(false); };

  // ── Downloads ──
  const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label); setMenu(false);
    try { await fn(); } catch (e) { setToast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(null); }
  };
  const downloadScreen = (f: BoardFrame): void => void run('Download', async () => {
    save(f.file.split('/').pop() ?? `${f.id}.html`, new Blob([await docs.standalone(f)], { type: 'text/html' }));
  });
  const exportAs = (format: 'png' | 'pdf' | 'zip', frame?: BoardFrame): void => void run(format === 'zip' ? 'Download' : `${format.toUpperCase()} export`, async () => {
    const { blob, name } = await api.boardExport(sessionId, path, format, frame?.id);
    save(name, blob);
  });

  // ── Render ──
  if (loadError) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <div className="text-[14px] font-semibold text-aico-primary">Could not open this board</div>
          <p className="mt-1 text-[12.5px] text-aico-muted">{loadError}</p>
          <button type="button" className="mt-3 rounded-md border border-aico-border px-3 py-1.5 text-[12.5px] text-aico-primary hover:bg-aico-hover" onClick={() => setReload(r => r + 1)}>Try again</button>
        </div>
      </div>
    );
  }

  const mounted = layout && size.w ? new Set(framesToMount(layout, cam, size.w, size.h)) : new Set<string>();
  const tx = size.w / 2 - cam.x * cam.k;
  const ty = size.h / 2 - cam.y * cam.k;
  const cursor = panning ? 'grabbing' : tool === 'hand' || spaceHeld ? 'grab' : tool === 'note' ? 'crosshair' : 'default';

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-aico-bg" data-design-board="">
      {/* Header: title, problems, downloads, close. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-aico-border-subtle px-3" data-board-ui="">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-aico-primary">{board?.title ?? 'Design board'}</div>
        </div>
        {board && <span className="hidden text-[12px] tabular-nums text-aico-muted sm:inline">{frames.length} screen{frames.length === 1 ? '' : 's'} · {board.sections.length} section{board.sections.length === 1 ? '' : 's'}</span>}
        {problems.length > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-aico-warning/12 px-2 py-0.5 text-[11.5px] text-aico-warning" title={problems.join('\n')}>
            <BoardIcon name="alert" size={13} />{problems.length}
          </span>
        )}
        <button type="button" onClick={() => frames.length && setPlay({ id: frames[0]!.id, present: true })} disabled={!frames.length}
          className="flex items-center gap-1.5 rounded-md bg-aico-accent px-2.5 py-1.5 text-[12.5px] font-medium text-aico-on-accent hover:bg-aico-accent-hover disabled:opacity-40" title="Present every screen from the first (P presents from the selected one)">
          <BoardIcon name="present" size={15} />Present
        </button>
        <div className="relative">
          <button type="button" onClick={() => setMenu(m => !m)} aria-expanded={menu} aria-haspopup="menu" disabled={!frames.length || Boolean(busy)}
            className="flex items-center gap-1.5 rounded-md border border-aico-border px-2.5 py-1.5 text-[12.5px] text-aico-primary hover:bg-aico-hover disabled:opacity-40" title="Download or export the board">
            {busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-aico-border border-t-aico-accent" role="status" aria-label={`${busy}…`} /> : <BoardIcon name="download" size={15} />}
            {busy ? `${busy}…` : 'Export'}
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-[230px] overflow-hidden rounded-lg border border-aico-border bg-aico-elevated py-1 shadow-xl">
              <MenuRow label="Board as PDF" hint="a page per screen" onClick={() => exportAs('pdf')} />
              <MenuRow label="Board as .zip" hint="the HTML folder, opens offline" onClick={() => exportAs('zip')} />
              {selected && frameById.get(selected) && (
                <>
                  <div className="my-1 border-t border-aico-border-subtle" />
                  <MenuRow label={`“${frameById.get(selected)!.title}” as PNG`} onClick={() => exportAs('png', frameById.get(selected)!)} />
                  <MenuRow label={`“${frameById.get(selected)!.title}” as HTML`} onClick={() => downloadScreen(frameById.get(selected)!)} />
                </>
              )}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setReload(r => r + 1)} className="rounded-md p-1.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary" title="Reload the board" aria-label="Reload the board"><BoardIcon name="refresh" size={15} /></button>
        {onClose && <button type="button" onClick={onClose} className="rounded-md p-1.5 text-aico-muted hover:bg-aico-hover hover:text-aico-primary" title="Close (Esc)" aria-label="Close the board"><BoardIcon name="close" size={16} /></button>}
      </div>

      {/* The canvas. */}
      <div
        ref={viewport}
        tabIndex={0}
        role="application"
        aria-label={`Design board ${board?.title ?? ''}: ${frames.length} screens. V select, H hand, N note, plus and minus zoom, Shift+1 fit, Enter plays the selected screen, P presents.`}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden outline-none"
        style={{
          cursor,
          backgroundColor: 'var(--aico-surface)',
          backgroundImage: 'radial-gradient(circle, var(--aico-border) 1px, transparent 1.2px)',
          backgroundSize: `${Math.max(8, 24 * cam.k * 4) }px ${Math.max(8, 24 * cam.k * 4)}px`,
          backgroundPosition: `${tx}px ${ty}px`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => setSpaceHeld(false)}
      >
        {!board || !layout ? (
          <div className="grid h-full place-items-center"><span className="h-6 w-6 animate-spin rounded-full border-2 border-aico-border border-t-aico-accent" role="status" aria-label="Loading the board" /></div>
        ) : frames.length === 0 ? (
          <div className="grid h-full place-items-center text-[13px] text-aico-muted">No screens on this board yet.</div>
        ) : (
          <>
            {/* World layer: the screens, at their real size, scaled. */}
            <div className="absolute left-0 top-0" style={{ transform: `translate(${tx}px, ${ty}px) scale(${cam.k})`, transformOrigin: '0 0' }}>
              {layout.frames.map(r => {
                const f = frameById.get(r.id)!;
                return (
                  <div key={f.id} className="absolute overflow-hidden bg-white"
                    style={{
                      left: r.x, top: r.y, width: r.w, height: r.h,
                      borderRadius: 4 / Math.max(cam.k, 0.25),
                      boxShadow: selected === f.id
                        ? `0 0 0 ${2 / cam.k}px var(--aico-accent), 0 ${8 / cam.k}px ${28 / cam.k}px rgba(0,0,0,0.18)`
                        : `0 0 0 ${1 / cam.k}px var(--aico-border), 0 ${4 / cam.k}px ${18 / cam.k}px rgba(0,0,0,0.10)`,
                    }}>
                    {mounted.has(f.id) ? <LiveFrame frame={f} docs={docs} host={frameHost} /> : <Placeholder frame={f} k={cam.k} />}
                  </div>
                );
              })}
            </div>

            {/* Screen layer: headings, frame titles and actions, notes — constant size at any zoom. */}
            {layout.sections.map(s => {
              const [sx, sy] = toScreen(cam, size.w, size.h, s.x, s.y);
              const first = layout.frames.find(f => f.section === s.index);
              const [, fy] = first ? toScreen(cam, size.w, size.h, first.x, first.y) : [0, sy];
              // Just above the frame titles at any zoom: the world gap between sections shrinks with it.
              const top = fy - LABEL_H - 28;
              return (
                <div key={`s${s.index}`} className="pointer-events-none absolute whitespace-nowrap" style={{ left: sx, top }}>
                  <div className="text-[15px] font-semibold tracking-[-0.01em] text-aico-primary">{s.title}</div>
                </div>
              );
            })}
            {layout.frames.map(r => {
              const f = frameById.get(r.id)!;
              const [sx, sy] = toScreen(cam, size.w, size.h, r.x, r.y);
              const w = r.w * cam.k;
              if (sx > size.w || sx + w < 0 || sy < -LABEL_H || sy - LABEL_H > size.h + r.h * cam.k) return null;
              // A narrow frame (a phone at 20%) may borrow the gap to its right for its title.
              const labelW = w >= 160 ? w : Math.min(160, w + (LAYOUT.gap * cam.k) - 10);
              return (
                <React.Fragment key={`l${f.id}`}>
                  <div data-board-ui="" className="group absolute flex items-center gap-1" style={{ left: sx, top: sy - LABEL_H, width: Math.max(labelW, 28), height: LABEL_H - 4 }}>
                    {labelW >= 60 && (
                      <button type="button" onClick={() => setSelected(f.id)} onDoubleClick={() => setPlay({ id: f.id, present: false })}
                        className={`min-w-0 flex-1 truncate text-left text-[12.5px] ${selected === f.id ? 'font-medium text-aico-accent' : 'text-aico-secondary hover:text-aico-primary'}`} title={`${f.title} · ${f.file} · ${f.width}×${f.height}`}>
                        {f.title}
                      </button>
                    )}
                    {w > 200 && <FrameButton icon="download" label={`Download ${f.file}`} onClick={() => downloadScreen(f)} />}
                    <FrameButton icon="play" label={`Play ${f.title}`} onClick={() => setPlay({ id: f.id, present: false })} strong text={w > 260 ? 'Play' : undefined} />
                  </div>
                  {f.note && w > 180 && cam.k >= 0.3 && (
                    <div className="pointer-events-none absolute truncate text-[12px] text-aico-muted" style={{ left: sx, top: sy + r.h * cam.k + 8, width: w }}>{f.note}</div>
                  )}
                </React.Fragment>
              );
            })}
            {notes.map(n => {
              const [sx, sy] = toScreen(cam, size.w, size.h, n.x, n.y);
              if (sx < -240 || sy < -200 || sx > size.w + 20 || sy > size.h + 20) return null;
              return (
                <StickyNote key={n.id} note={n} editing={editing === n.id} left={sx} top={sy} compact={cam.k < 0.35 && editing !== n.id}
                  about={n.frame ? frameById.get(n.frame)?.title : undefined}
                  onEdit={() => setEditing(n.id)}
                  onDone={text => { setEditing(null); saveNotes(notes.map(x => (x.id === n.id ? { ...x, text } : x))); }}
                  onDelete={() => { setEditing(null); saveNotes(notes.filter(x => x.id !== n.id)); }} />
              );
            })}
          </>
        )}

        {/* Toolbar. */}
        {board && frames.length > 0 && (
          <div data-board-ui="" className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-aico-border bg-aico-elevated/95 p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur" role="toolbar" aria-label="Board tools">
            <ToolButton icon="pointer" label="Select (V)" active={tool === 'select' && !spaceHeld} onClick={() => setTool('select')} />
            <ToolButton icon="hand" label="Hand — drag to pan (H, or hold Space)" active={tool === 'hand' || spaceHeld} onClick={() => setTool('hand')} />
            <ToolButton icon="note" label="Note — click to pin a note for the agent (N)" active={tool === 'note'} onClick={() => setTool('note')} />
            <div className="mx-1 h-5 w-px bg-aico-border" />
            <ToolButton icon="minus" label="Zoom out (−)" onClick={() => zoomTo(stepZoom(cam.k, -1))} />
            <button type="button" onClick={() => zoomTo(1)} className="min-w-[52px] rounded-md px-1.5 py-1 text-center text-[12px] tabular-nums text-aico-secondary hover:bg-aico-hover" title="Zoom to 100% (0)">{Math.round(cam.k * 100)}%</button>
            <ToolButton icon="plus" label="Zoom in (+)" onClick={() => zoomTo(stepZoom(cam.k, 1))} />
            <ToolButton icon="fit" label="Fit the board (Shift+1)" onClick={fit} />
            <div className="mx-1 h-5 w-px bg-aico-border" />
            <ToolButton icon="play" label="Play the selected screen (Enter)" disabled={!selected} onClick={() => selected && setPlay({ id: selected, present: false })} />
          </div>
        )}
        {toast && <div className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full bg-aico-elevated px-4 py-2 text-[12.5px] text-aico-primary shadow-lg ring-1 ring-aico-border" role="status" data-board-ui="">{toast}</div>}
      </div>

      {play && board && (
        <BoardPlayer board={board} docs={docs} host={frameHost} startId={play.id} present={play.present}
          onClose={last => { setPlay(null); setSelected(last); requestAnimationFrame(() => viewport.current?.focus({ preventScroll: true })); }}
          onDownload={downloadScreen} />
      )}
    </div>
  );
}

function LiveFrame({ frame, docs, host }: { frame: BoardFrame; docs: ReturnType<typeof boardDocs>; host?: FrameHost }): React.ReactElement {
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    docs.live(frame).then(d => { if (alive) setDoc(d); }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [frame, docs]);
  if (error) return <div className="grid h-full w-full place-items-center bg-white p-8 text-center text-[28px] text-neutral-500">{error}</div>;
  if (!doc) return <div className="h-full w-full animate-pulse bg-neutral-100" />;
  return <ScreenFrame frame={frame} doc={doc} host={host} live={false} title={frame.title} />;
}

function Placeholder({ frame, k }: { frame: BoardFrame; k: number }): React.ReactElement {
  return (
    <div className="grid h-full w-full place-items-center bg-neutral-50">
      <div className="text-neutral-400" style={{ fontSize: Math.min(64, 14 / k) }}>{frame.title}</div>
    </div>
  );
}

function ToolButton({ icon, label, onClick, active = false, disabled = false }: { icon: BoardGlyph; label: string; onClick: () => void; active?: boolean; disabled?: boolean }): React.ReactElement {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} aria-pressed={active}
      className={`grid h-8 w-8 place-items-center rounded-md transition-colors disabled:opacity-35 ${active ? 'bg-aico-accent-soft text-aico-accent' : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`}>
      <BoardIcon name={icon} size={16} />
    </button>
  );
}

function FrameButton({ icon, label, onClick, strong = false, text }: { icon: BoardGlyph; label: string; onClick: () => void; strong?: boolean; text?: string }): React.ReactElement {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label}
      className={`flex h-6 shrink-0 items-center justify-center gap-1 rounded-md transition-colors ${text ? 'px-2' : 'w-6'} ${strong
        ? 'bg-aico-accent-soft text-[12px] font-medium text-aico-accent hover:bg-aico-accent hover:text-aico-on-accent'
        : 'text-aico-muted opacity-0 hover:bg-aico-hover hover:text-aico-primary focus:opacity-100 group-hover:opacity-100'}`}>
      <BoardIcon name={icon} size={icon === 'play' ? 12 : 14} />{text}
    </button>
  );
}

function MenuRow({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }): React.ReactElement {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-aico-hover">
      <span className="truncate text-[12.5px] text-aico-primary">{label}</span>
      {hint && <span className="text-[11px] text-aico-muted">{hint}</span>}
    </button>
  );
}

function StickyNote({ note, editing, left, top, compact, about, onEdit, onDone, onDelete }: {
  note: BoardNote; editing: boolean; left: number; top: number; compact: boolean; about?: string;
  onEdit: () => void; onDone: (text: string) => void; onDelete: () => void;
}): React.ReactElement {
  const [text, setText] = useState(note.text);
  useEffect(() => setText(note.text), [note.text]);
  if (compact) {
    // Zoomed out, a note is a small tab that does not cover the screens; click to read or edit it.
    return (
      <button type="button" data-board-ui="" onClick={onEdit} title={note.text}
        className="absolute flex max-w-[170px] items-center gap-1.5 rounded-md border border-amber-300/70 bg-amber-50 px-1.5 py-1 text-left text-[11.5px] text-amber-950 shadow-sm dark:border-amber-400/30 dark:bg-amber-900/80 dark:text-amber-50"
        style={{ left, top }}>
        <BoardIcon name="note" size={12} className="shrink-0 opacity-70" /><span className="truncate">{note.text}</span>
      </button>
    );
  }
  return (
    <div data-board-ui="" className="absolute w-[220px] rounded-lg border border-amber-300/70 bg-amber-50 p-2 text-[12.5px] text-amber-950 shadow-[0_6px_20px_rgba(0,0,0,0.12)] dark:border-amber-400/30 dark:bg-amber-900/80 dark:text-amber-50"
      style={{ left, top }}>
      {editing ? (
        <textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder="A note for the agent — it reads these with the board."
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onDone(text); if (e.key === 'Escape') onDone(text); }}
          onBlur={() => onDone(text)} rows={3} maxLength={600}
          className="w-full resize-none bg-transparent outline-none placeholder:text-amber-900/50 dark:placeholder:text-amber-100/50" />
      ) : (
        <button type="button" onClick={onEdit} className="block w-full whitespace-pre-wrap break-words text-left">{note.text}</button>
      )}
      <div className="mt-1 flex items-center justify-between text-[10.5px] text-amber-900/60 dark:text-amber-100/60">
        <span className="truncate">{about ? `on “${about}”` : 'on the board'}</span>
        <button type="button" onMouseDown={e => e.preventDefault()} onClick={onDelete} className="rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-800" title="Delete the note" aria-label="Delete the note"><BoardIcon name="trash" size={13} /></button>
      </div>
    </div>
  );
}

/** The board as a full-window overlay (the browser portal, which has no side slot for it). */
export function DesignBoardOverlay(props: DesignBoardViewProps & { onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('[data-design-board] [role="dialog"]') && !(e.target as HTMLElement)?.closest?.('textarea')) props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-aico-bg" role="dialog" aria-modal="true" aria-label="Design board">
      <DesignBoardView {...props} />
    </div>
  );
}
