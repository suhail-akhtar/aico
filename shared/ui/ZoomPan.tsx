/**
 * A surface you can zoom and drag, with the controls that go with it.
 *
 * Built for diagrams, which is where it is actually needed: mermaid lays a
 * twenty-node architecture out at whatever width it likes, and the result is
 * either legible and off the side of the column, or scaled to fit and too small
 * to read. Neither is fixable by the author of the diagram, so it has to be
 * fixable by the reader.
 *
 * ## The wheel does not zoom
 *
 * Plain wheel scrolls the page, as it does everywhere else. A diagram that
 * swallows the wheel traps the reader: they scroll past it, the page stops
 * moving, and the diagram silently grows instead. Zoom is on the buttons and on
 * ctrl/⌘+wheel, which is the gesture browsers and maps already use.
 *
 * ## Drag pans, and only when there is something to pan to
 *
 * At 1× the content fits, so dragging would slide it around inside its own box
 * for no reason. The cursor only becomes a grab handle once zoomed in, so the
 * affordance appears exactly when the action does something.
 *
 * @module shared/ui/ZoomPan
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from './icons';
import { useWidgetExpanded } from './Widget';

const MIN = 0.4;
const MAX = 6;
/** One notch. Multiplicative, so each press feels the same at any scale. */
const STEP = 1.25;

export interface ZoomPanProps {
  children: React.ReactNode;
  /** Extra controls, shown to the left of the zoom cluster. */
  actions?: React.ReactNode;
  /** Height of the viewport while inline. Ignored when the frame is expanded. */
  className?: string;
}

export function ZoomPan({ children, actions, className = '' }: ZoomPanProps): React.ReactElement {
  // Full screen means full screen. Inline, the viewport is capped so a tall
  // diagram does not push the rest of the conversation off the page; expanded,
  // the cap is the entire point of what the reader just asked for, and keeping
  // it leaves the diagram clipped in the top third with the rest blank.
  const expanded = useWidgetExpanded();
  const viewportHeight = expanded ? 'h-full flex-1 min-h-0' : className;
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const zoomTo = useCallback((next: number): void => {
    const clamped = Math.min(MAX, Math.max(MIN, next));
    setScale(clamped);
    // Back to the middle when we land on 1×, so "reset" is reachable by zooming
    // out as well as by the button. Without this a reader who zoomed in, panned
    // away and zoomed back out is left looking at empty space.
    if (clamped === 1) setOffset({ x: 0, y: 0 });
  }, []);

  const reset = useCallback((): void => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Wheel is bound imperatively because React attaches wheel handlers as
  // passive, and a passive listener cannot call preventDefault — so the page
  // would scroll *and* the diagram would zoom.
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setScale(current => Math.min(MAX, Math.max(MIN, current * (event.deltaY < 0 ? STEP : 1 / STEP))));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (scale === 1) return;
    // Captured so a drag that leaves the box still tracks — releasing outside
    // otherwise leaves the diagram stuck to the cursor.
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const from = dragging.current;
    if (!from) return;
    setOffset({
      x: from.ox + (event.clientX - from.x),
      y: from.oy + (event.clientY - from.y),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) event.currentTarget.releasePointerCapture(event.pointerId);
    dragging.current = null;
  };

  const zoomed = scale !== 1;

  return (
    <div className={`relative ${expanded ? 'flex h-full min-h-0 flex-1 flex-col' : ''}`}>
      <div
        ref={viewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`flex items-center justify-center overflow-hidden ${
          zoomed ? 'cursor-grab active:cursor-grabbing' : ''} ${viewportHeight}`}
      >
        <div
          // Full width, or a flex child shrink-wraps its content — and mermaid
          // writes `width="100%"` on its svg, which then resolves against a box
          // that has collapsed to nothing. The diagram came out a third of the
          // size it should be, centred in an empty frame.
          className="w-full"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            // Only while still. Animating every pointermove makes a drag lag
            // behind the cursor by the length of the transition.
            transition: dragging.current ? 'none' : 'transform 120ms ease-out',
          }}
        >
          {children}
        </div>
      </div>

      {/*
        Over the content rather than in the frame's header. A reader reaching
        for zoom is looking at the diagram, and the frame's own row already
        carries the actions that belong to the block rather than to the view.
      */}
      <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-lg
                      border border-aico-border-subtle bg-aico-bg/85 p-0.5 backdrop-blur">
        {actions}
        <IconButton icon="zoom-out" label="Zoom out" onClick={() => zoomTo(scale / STEP)} />
        <span className="min-w-[2.4rem] text-center text-[10px] tabular-nums text-aico-muted">
          {Math.round(scale * 100)}%
        </span>
        <IconButton icon="zoom-in" label="Zoom in" onClick={() => zoomTo(scale * STEP)} />
        <IconButton icon="fit" label="Reset zoom and position" onClick={reset} />
      </div>
    </div>
  );
}
