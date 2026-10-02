/**
 * The canvas beside the chat: the document the agent is writing, editable,
 * in the right-hand slot the Sources panel uses — wider, and resizable.
 *
 * One right panel at a time: opening a canvas closes Sources and the other way
 * round. The width is remembered; the canvas is not, because a canvas belongs
 * to the chat it came from and switching chats closes it.
 *
 * Documents open as AICO Docs (`shared/ui/canvas`), which wants a page's
 * width: the default is wider than it was for the source editor, and the
 * editor's full-screen mode is told to start below the window's own title
 * bar (the Windows/Linux caption buttons are drawn over the page there).
 * Exports use the native save dialog through the preload bridge the shared
 * code already knows (`dialog:saveFile`), so nothing else is wired here.
 *
 * Two canvases can sit side by side (a document and the sheet it quotes,
 * opened from the Artifacts panel's "Open beside"): `second` is the right
 * half, the panel widens to hold both, and closing either leaves the other.
 *
 * @module desktop/renderer/chat/CanvasPanel
 */

import React, { Suspense, lazy, useCallback, useState } from 'react';
import { create } from 'zustand';
import type { CanvasCodeEditorProps, CanvasRef } from '@aico/ui';
import { useSourcesPanel } from './SourcesPanel';

const CanvasEditor = lazy(() => import('@aico/shared/ui/canvas/CanvasEditor').then(m => ({ default: m.CanvasEditor })));
const Monaco = lazy(() => import('./CanvasMonaco').then(m => ({ default: m.CanvasMonaco })));

interface CanvasPanelState {
  open: CanvasRef | null;
  /** The right half of a split view. */
  second: CanvasRef | null;
  show: (ref: CanvasRef) => void;
  /** Open `ref` next to what is open (or alone when nothing is). */
  showBeside: (ref: CanvasRef) => void;
  close: () => void;
  closeOne: (id: string) => void;
}

export const useCanvasPanel = create<CanvasPanelState>((set, get) => ({
  open: null,
  second: null,
  show: (ref) => {
    useSourcesPanel.getState().close();
    const { second } = get();
    set({ open: ref, second: second?.id === ref.id ? null : second });
  },
  showBeside: (ref) => {
    useSourcesPanel.getState().close();
    const { open } = get();
    if (!open || open.id === ref.id) set({ open: ref, second: null });
    else set({ second: ref });
  },
  close: () => set({ open: null, second: null }),
  closeOne: (id) => {
    const { open, second } = get();
    if (second?.id === id) set({ second: null });
    else if (open?.id === id) set({ open: second, second: null });
  },
}));

/** Monaco for code canvases, loaded the first time one opens. */
export function CanvasCode(props: CanvasCodeEditorProps): React.ReactElement {
  return (
    <Suspense fallback={<div className="p-4 text-[12px] text-aico-muted">Loading the editor…</div>}>
      <Monaco {...props} />
    </Suspense>
  );
}

const WIDTH_KEY = 'aico.desk.canvasWidth';
const DEFAULT_WIDTH = 720;
const MIN_WIDTH = 420;
/** Each half of a split view gets at least this much. */
const SPLIT_MIN_HALF = 520;
/** The height of the window's own title bar (main.ts `titleBarOverlay.height`); full screen starts below it. */
const TITLE_BAR_PX = 40;

function clampWidth(w: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - 420)));
}

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= MIN_WIDTH ? clampWidth(n) : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

export function CanvasPanel(): React.ReactElement | null {
  const open = useCanvasPanel(s => s.open);
  const second = useCanvasPanel(s => s.second);
  const closeOne = useCanvasPanel(s => s.closeOne);
  const [width, setWidth] = useState(storedWidth);

  const remember = (w: number): void => { try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* not remembered */ } };

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: MouseEvent): void => { last = clampWidth(startW - (ev.clientX - startX)); setWidth(last); };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      remember(last);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [width]);

  if (!open) return null;
  // A split view needs room for two pages; it takes it from the chat, never below the chat's own minimum.
  const shown = second ? Math.max(width, Math.min(SPLIT_MIN_HALF * 2, window.innerWidth - 420)) : width;
  const editor = (ref: CanvasRef): React.ReactElement => (
    <Suspense fallback={<div className="p-4 text-[12px] text-aico-muted">Opening the canvas…</div>}>
      <CanvasEditor key={ref.id} id={ref.id} initial={ref} variant="panel" onClose={() => closeOne(ref.id)} />
    </Suspense>
  );
  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg animate-fade-in"
      style={{ width: shown, ['--adoc-focus-top' as string]: `${TITLE_BAR_PX}px` }}
      aria-label={second ? `Canvases: ${open.title ?? open.id} and ${second.title ?? second.id}` : `Canvas: ${open.title ?? open.id}`}>
      <div
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-aico-hover"
        onMouseDown={startResize}
        onDoubleClick={() => { setWidth(DEFAULT_WIDTH); remember(DEFAULT_WIDTH); }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the canvas (double-click to reset)"
        title="Drag to resize · double-click to reset"
      />
      {second ? (
        <div className="flex min-h-0 flex-1" data-canvas-split="">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-aico-border-subtle">{editor(open)}</div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{editor(second)}</div>
        </div>
      ) : editor(open)}
    </aside>
  );
}
