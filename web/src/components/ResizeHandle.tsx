/**
 * Dragging the sidebar wider or narrower.
 *
 * Width is remembered in `localStorage` rather than on the server, because it
 * is a fact about this screen rather than about the installation — the same
 * account on a laptop and a wide monitor wants two different answers, and
 * syncing them would make one of them wrong.
 *
 * The drag listens on `window`, not on the handle. A pointer moving faster
 * than React re-renders leaves the handle behind, and a handler bound to the
 * element itself simply stops receiving moves — the panel sticks halfway and
 * only recovers when the pointer wanders back. Capturing the pointer keeps
 * every move coming to us until the button is released.
 *
 * @module components/ResizeHandle
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'aico.sidebar.width';
export const MIN_WIDTH = 210;
export const MAX_WIDTH = 560;
export const DEFAULT_WIDTH = 280;

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

/** The remembered width, or the default when there is none or it is nonsense. */
export function storedWidth(): number {
  try {
    const raw = Number(localStorage.getItem(KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function useSidebarWidth(): [number, (next: number) => void] {
  const [width, setWidth] = useState(storedWidth);
  const set = useCallback((next: number) => {
    const value = clamp(next);
    setWidth(value);
    try { localStorage.setItem(KEY, String(value)); } catch { /* private mode */ }
  }, []);
  return [width, set];
}

export function ResizeHandle({ onResize }: { onResize: (width: number) => void }): React.ReactElement {
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent): void => {
      // Coalesced to one update per frame: a pointer emits far more moves than
      // the screen can show, and re-rendering the whole sidebar on each one is
      // how a resize starts to feel heavy.
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => onResize(event.clientX));
    };
    const stop = (): void => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    // Without this the drag selects the sidebar's text as it passes over it.
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      cancelAnimationFrame(frame.current);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = previous;
      document.body.style.cursor = '';
    };
  }, [dragging, onResize]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabIndex={0}
      onPointerDown={e => { e.preventDefault(); setDragging(true); }}
      // Keyboard resizing, because a drag handle is unusable without a pointer
      // and the arrow keys are what someone will try.
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(storedWidth() - 16); }
        if (e.key === 'ArrowRight') { e.preventDefault(); onResize(storedWidth() + 16); }
      }}
      className={`absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize md:block
                  after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2
                  after:transition-colors ${dragging
                    ? 'after:bg-aico-accent'
                    : 'after:bg-transparent hover:after:bg-aico-border'}`}
    />
  );
}
