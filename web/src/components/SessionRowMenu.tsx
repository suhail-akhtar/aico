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
import { Portal } from './Portal';
import { Icon, type Glyph } from './Icon';

export interface SessionRowMenuProps {
  archived: boolean;
  onRename: () => void;
  onFork: () => void;
  onArchive: () => void;
  /** Groups this session can be filed under. */
  groups: Array<{ id: string; name: string; color?: string }>;
  currentGroup?: string;
  onMoveToGroup: (group: string | null) => void;
}

export function SessionRowMenu(
  { archived, onRename, onFork, onArchive, groups, currentGroup, onMoveToGroup }: SessionRowMenuProps,
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
    const height = 132 + (groups.length + (currentGroup ? 1 : 0)) * 30;
    const below = window.innerHeight - box.bottom;
    setAt({
      top: below < height ? box.top - height : box.bottom + 4,
      left: Math.min(box.left, window.innerWidth - 190),
    });
  }, [open, groups.length, currentGroup]);

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
        <Icon name="ellipsis" size={17} />
      </button>

      {open && (
        <Portal>
        <div
          ref={menuRef}
          role="menu"
          style={{ top: at.top, left: at.left }}
          className="fixed z-50 w-[186px] overflow-hidden rounded-xl border border-aico-border
                     bg-aico-bg py-1 shadow-2xl"
        >
          <Item icon="edit" onClick={run(onRename)}>Rename</Item>

          {/* Inline rather than a submenu. Three groups is the common case and
              a submenu costs a hover, a delay and a second chance to miss. */}
          {(groups.length > 0 || currentGroup) && (
            <div className="my-1 border-y border-aico-border-subtle py-1">
              <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-aico-muted">
                Move to group
              </div>
              {groups.map(group => (
                <button
                  key={group.id}
                  role="menuitem"
                  onClick={run(() => onMoveToGroup(group.id))}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px]
                             text-aico-primary transition-colors hover:bg-aico-hover"
                >
                  <Icon
                    name="stack"
                    size={15}
                    filled={Boolean(group.color)}
                    {...(group.color
                      ? { style: { color: group.color } }
                      : { className: 'text-aico-muted' })}
                  />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  {currentGroup === group.id && <Icon name="check" size={14} className="text-aico-accent" />}
                </button>
              ))}
              {currentGroup && (
                <button
                  role="menuitem"
                  onClick={run(() => onMoveToGroup(null))}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px]
                             text-aico-secondary transition-colors hover:bg-aico-hover"
                >
                  <Icon name="undo" size={15} className="text-aico-muted" />
                  Back to its folder
                </button>
              )}
            </div>
          )}
          <Item icon="fork" onClick={run(onFork)}>Fork session</Item>
          <Item icon="archive" onClick={run(onArchive)}>
            {archived ? 'Restore session' : 'Archive session'}
          </Item>
        </div>
        </Portal>
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
      <Icon name={icon} size={17} className="text-aico-muted" />
      {children}
    </button>
  );
}
