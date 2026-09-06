/**
 * Render only the rows that are on screen.
 *
 * The same idea the Trajectory ledger uses for its thousands of events, made
 * generic: one spacer of the full height keeps the scrollbar honest, and an
 * absolutely positioned slice holds the rows the viewport can see plus an
 * overscan on each side. Rows must be a uniform height — that is what makes
 * "which rows are visible" arithmetic rather than measurement.
 *
 * Menus and inline editors inside a row keep working because they are rendered
 * by the same `renderRow` whether the list is windowed or not; anything
 * positioned with `fixed` (the row menus use a Portal) is unaffected by the
 * slice moving under it.
 *
 * @module components/WindowedList
 */

import React, { useEffect, useRef, useState } from 'react';

export interface WindowedListProps<T> {
  rows: T[];
  rowHeight: number;
  renderRow: (row: T, index: number) => React.ReactNode;
  rowKey: (row: T, index: number) => string;
  overscan?: number;
  /** A row to bring into view, e.g. the one that holds keyboard focus. */
  scrollToIndex?: number | null;
  className?: string;
  /** Attributes for the scrolling element — role, aria, data hooks. */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
}

export function WindowedList<T>({
  rows, rowHeight, renderRow, rowKey, overscan = 12, scrollToIndex = null, className = '', containerProps = {},
}: WindowedListProps<T>): React.ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => setViewportHeight(el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the focused row in view without yanking the list around: scroll only
  // when it is above or below the viewport, and only as far as needed.
  useEffect(() => {
    const el = scroller.current;
    if (!el || scrollToIndex === null || scrollToIndex < 0) return;
    const top = scrollToIndex * rowHeight;
    const bottom = top + rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [scrollToIndex, rowHeight]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const slice = rows.slice(first, first + visible);

  return (
    <div
      {...containerProps}
      ref={scroller}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      className={`overflow-y-auto ${className}`}
    >
      <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>
          {slice.map((row, i) => (
            <div key={rowKey(row, first + i)} style={{ height: rowHeight }}>
              {renderRow(row, first + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
