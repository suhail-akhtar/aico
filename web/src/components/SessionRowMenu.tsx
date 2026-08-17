/**
 * The per-session menu behind the ellipsis.
 *
 * Three actions, and the ordering is deliberate: the reversible one first, the
 * creative one second, the one that removes something from view last. A menu
 * that puts "archive" where "rename" is expected gets mis-clicked.
 *
 * It opens on click rather than on hover. A hover menu over a list you scroll
 * through opens and closes under the pointer on the way past, and this list is
 * scrolled far more often than it is acted on.
 *
 * Positioned `fixed` from the button's own rectangle rather than absolutely
 * inside the row. The sidebar list is a scroll container with `overflow-y`,
 * which clips absolutely-positioned children — the menu would be cut off at
 * the row boundary for every session near the bottom.
 *
 * @module components/SessionRowMenu
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type Glyph } from './Icon';

export interface SessionRowMenuProps {
  archived: boolean;
  onRename: () => void;
  onFork: () => void;
  onArchive: () => void;
}

export function SessionRowMenu(
  { archived, onRename, onFork, onArchive }: SessionRowMenuProps,
): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const box = buttonRef.current.getBoundingClientRect();
    // Flipped upward when there is no room below, so a session at the bottom of
    // a long list still shows its whole menu.
    const height = 132;
    const below = window.innerHeight - box.bottom;
    setAt({
      top: below < height ? box.top - height : box.bottom + 4,
      left: Math.min(box.left, window.innerWidth - 190),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (buttonRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    // Capture, so a click that also selects a session still closes this first.
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onKey);
    // The menu is anchored to a rectangle that scrolling invalidates.
    window.addEventListener('scroll', () => setOpen(false), true);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (action: () => void) => (event: React.MouseEvent): void => {
    event.stopPropagation();
    setOpen(false);
    action();
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`shrink-0 rounded px-1 text-aico-muted transition-opacity hover:text-aico-primary
                    ${open ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover/row:opacity-100'}`}
      >
        <Icon name="ellipsis" size={15} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          style={{ top: at.top, left: at.left }}
          className="fixed z-50 w-[186px] overflow-hidden rounded-xl border border-aico-border
                     bg-aico-bg py-1 shadow-2xl"
        >
          <Item icon="edit" onClick={run(onRename)}>Rename</Item>
          <Item icon="fork" onClick={run(onFork)}>Fork session</Item>
          <Item icon="archive" onClick={run(onArchive)}>
            {archived ? 'Restore session' : 'Archive session'}
          </Item>
        </div>
      )}
    </>
  );
}

function Item(
  { icon, onClick, children }: {
    icon: Glyph; onClick: (event: React.MouseEvent) => void; children: React.ReactNode;
  },
): React.ReactElement {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-aico-primary
                 transition-colors hover:bg-aico-hover"
    >
      <Icon name={icon} size={15} className="text-aico-muted" />
      {children}
    </button>
  );
}
