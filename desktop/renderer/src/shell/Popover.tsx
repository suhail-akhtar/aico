/**
 * Anchored menus and popovers that never run off the screen.
 *
 * Placed in a portal at the anchor's position, then measured: if it would
 * cross the bottom (or right) edge it flips to the other side, and if it is
 * taller than the space either way it scrolls. That last case is the one the
 * web client's "…" menu got wrong in 0.21 — its delete confirmation fell below
 * the fold with no way to reach the buttons.
 *
 * @module desktop/renderer/shell/Popover
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { useOverlay } from '@/lib/overlay';

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end';

export function Popover({
  anchor, open, onClose, placement = 'bottom-start', children, className, width, offset = 6,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  children: React.ReactNode;
  className?: string;
  width?: number;
  offset?: number;
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useOverlay(open);

  useLayoutEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    const place = (): void => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? width ?? 220;
      const h = el?.scrollHeight ?? 200;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      let top: number; let left: number;
      const [side, align] = placement.split('-') as ['bottom' | 'top' | 'right', 'start' | 'end'];
      if (side === 'right') {
        left = a.right + offset;
        top = align === 'start' ? a.top : a.bottom - h;
        if (left + w > vw - margin) left = a.left - w - offset;
      } else {
        left = align === 'start' ? a.left : a.right - w;
        const below = vh - a.bottom - offset - margin;
        const above = a.top - offset - margin;
        const wantTop = side === 'top';
        if ((wantTop && (h <= above || above > below)) || (!wantTop && h > below && above > below)) {
          top = Math.max(margin, a.top - offset - h);
        } else {
          top = a.bottom + offset;
        }
      }
      left = Math.max(margin, Math.min(left, vw - w - margin));
      top = Math.max(margin, Math.min(top, vh - Math.min(h, vh - 2 * margin) - margin));
      setPos({ top, left, maxHeight: vh - top - margin });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [open, anchor, placement, width, offset]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={cls('menu fixed z-[70] overflow-y-auto thin-scroll', className)}
      style={{
        top: pos?.top ?? -9999, left: pos?.left ?? -9999,
        maxHeight: pos?.maxHeight, width,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon, label, hint, onClick, danger, disabled, checked, trailing, title,
}: {
  icon?: string; label: React.ReactNode; hint?: string; onClick?: () => void; danger?: boolean;
  disabled?: boolean; checked?: boolean; trailing?: React.ReactNode; title?: string;
}): React.ReactElement {
  return (
    <button role="menuitem" className={cls('menu-item', danger && 'text-aico-danger')} onClick={onClick} disabled={disabled} title={title}>
      {icon !== undefined && <Icon name={icon} size={16} className={danger ? '' : 'text-aico-secondary'} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[11.5px] text-aico-muted">{hint}</span>}
      {checked && <Icon name="check" size={15} className="text-aico-accent" />}
      {trailing}
    </button>
  );
}

export function MenuSep(): React.ReactElement { return <div className="menu-sep" />; }

/** A button that owns its popover — the common case. */
export function MenuButton({
  children, button, placement, className, width, title, ariaLabel,
}: {
  children: (close: () => void) => React.ReactNode;
  button: React.ReactNode;
  placement?: Placement;
  className?: string;
  width?: number;
  title?: string;
  ariaLabel?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={setAnchor}
        className={className ?? 'icon-btn'}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        aria-label={ariaLabel ?? title}
      >
        {button}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement={placement} width={width}>
        {children(() => setOpen(false))}
      </Popover>
    </>
  );
}
