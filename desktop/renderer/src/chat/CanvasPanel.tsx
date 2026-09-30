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
 * @module desktop/renderer/chat/CanvasPanel
 */

import React, { Suspense, lazy, useCallback, useState } from 'react';
import { create } from 'zustand';
import type { CanvasCodeEditorProps, CanvasRef } from '@aico/ui';
import { useSourcesPanel } from './SourcesPanel';

const CanvasEditor = lazy(() => import('@aico/shared/ui/canvas/CanvasEditor').then(m => ({ default: m.CanvasEditor })));
const Monaco = lazy(() => import('./CanvasMonaco').then(m => ({ default: m.CanvasMonaco })));

export const useCanvasPanel = create<{ open: CanvasRef | null; show: (ref: CanvasRef) => void; close: () => void }>(set => ({
  open: null,
  show: (ref) => {
    useSourcesPanel.getState().close();
    set({ open: ref });
  },
  close: () => set({ open: null }),
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
  const close = useCanvasPanel(s => s.close);
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
  return (
    <aside className="relative flex min-h-0 shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg animate-fade-in"
      style={{ width, ['--adoc-focus-top' as string]: `${TITLE_BAR_PX}px` }} aria-label={`Canvas: ${open.title ?? open.id}`}>
      <div
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-aico-hover"
        onMouseDown={startResize}
        onDoubleClick={() => { setWidth(DEFAULT_WIDTH); remember(DEFAULT_WIDTH); }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the canvas (double-click to reset)"
        title="Drag to resize · double-click to reset"
      />
      <Suspense fallback={<div className="p-4 text-[12px] text-aico-muted">Opening the canvas…</div>}>
        <CanvasEditor key={open.id} id={open.id} initial={open} variant="panel" onClose={close} />
      </Suspense>
    </aside>
  );
}
