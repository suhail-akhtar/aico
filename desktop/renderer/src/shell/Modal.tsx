/**
 * A centred dialog: dimmed backdrop, Escape closes, focus stays inside.
 * @module desktop/renderer/shell/Modal
 */

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { useOverlay } from '@/lib/overlay';

export function Modal({
  open, onClose, children, className, title, width = 560, hideClose, labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  title?: React.ReactNode;
  width?: number | string;
  hideClose?: boolean;
  labelledBy?: string;
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement;
    const t = setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-close])');
      first?.focus();
    }, 20);
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0]!; const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', key, true);
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-6 animate-fade-in" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cls('relative flex max-h-full flex-col overflow-hidden rounded-2xl border border-aico-border-subtle bg-aico-bg shadow-[var(--desk-shadow)] animate-pop-in', className)}
        style={{ width, maxWidth: '100%' }}
      >
        {(title || !hideClose) && (
          <div className="flex items-center gap-3 px-5 pb-1 pt-4">
            {title && <h2 id={labelledBy} className="min-w-0 flex-1 truncate text-[16px] font-semibold">{title}</h2>}
            {!title && <div className="flex-1" />}
            {!hideClose && (
              <button data-close className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Ask a yes/no question in-app (the native one is for destructive system actions). */
export function ConfirmDialog({
  open, title, body, confirm = 'Confirm', danger, onConfirm, onCancel, busy,
}: {
  open: boolean; title: string; body?: React.ReactNode; confirm?: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void; busy?: boolean;
}): React.ReactElement | null {
  return (
    <Modal open={open} onClose={onCancel} title={title} width={440}>
      <div className="px-5 pb-5 pt-2 text-[13.5px] text-aico-secondary">{body}</div>
      <div className="flex justify-end gap-2 border-t border-aico-border-subtle px-5 py-3">
        <button className="btn-outline" onClick={onCancel}>Cancel</button>
        <button className={danger ? 'btn bg-aico-danger text-white hover:opacity-90' : 'btn-primary'} onClick={onConfirm} disabled={busy} autoFocus>
          {busy && <span className="spinner h-3.5 w-3.5" />}{confirm}
        </button>
      </div>
    </Modal>
  );
}
