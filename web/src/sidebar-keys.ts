/**
 * Keyboard movement through the flattened session list.
 *
 * A tree, in the accessibility sense: Up and Down move between rows, Right
 * opens a folded header, Left folds an open one or jumps from a session to its
 * header, Home and End go to the ends, Enter and Space act on the row. The
 * decisions are made here and returned as an `action`; the component applies
 * them. Nothing about focus management is tested by rendering.
 *
 * @module sidebar-keys
 */

import { isFocusable, type Row } from './sidebar-rows';

export type KeyAction =
  | { type: 'toggle'; path: string }       // fold or unfold a section (or Recent, path 'recent')
  | { type: 'open'; sessionId: string }     // open a session
  | { type: 'none' };

export interface KeyMove {
  /** The row that should hold focus after the key. */
  index: number;
  action: KeyAction;
}

/** The next focusable row at or after `from` in direction `step`, or `from` when none. */
function nextFocusable(rows: Row[], from: number, step: 1 | -1): number {
  let i = from + step;
  while (i >= 0 && i < rows.length) {
    if (isFocusable(rows[i]!)) return i;
    i += step;
  }
  return from;
}

function firstFocusable(rows: Row[]): number {
  const i = rows.findIndex(isFocusable);
  return i < 0 ? 0 : i;
}

function lastFocusable(rows: Row[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (isFocusable(rows[i]!)) return i;
  return 0;
}

/** The header row a session row sits under. */
function headerOf(rows: Row[], index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.kind === 'section-header' || row.kind === 'recent-header') return i;
  }
  return index;
}

export function moveFocus(rows: Row[], index: number, key: string): KeyMove {
  if (rows.length === 0) return { index: 0, action: { type: 'none' } };
  const current = rows[index];
  const none: KeyAction = { type: 'none' };

  switch (key) {
    case 'ArrowDown': return { index: nextFocusable(rows, index, 1), action: none };
    case 'ArrowUp': return { index: nextFocusable(rows, index, -1), action: none };
    case 'Home': return { index: firstFocusable(rows), action: none };
    case 'End': return { index: lastFocusable(rows), action: none };

    case 'ArrowRight': {
      // Right unfolds a folded header; on an open header or a session it steps
      // down, which is how a tree walks into its children.
      if (current?.kind === 'section-header' && current.collapsed) {
        return { index, action: { type: 'toggle', path: current.section.path } };
      }
      if (current?.kind === 'recent-header' && current.folded) {
        return { index, action: { type: 'toggle', path: 'recent' } };
      }
      return { index: nextFocusable(rows, index, 1), action: none };
    }

    case 'ArrowLeft': {
      // Left folds an open header; on a session it goes to the header, so two
      // presses fold the section you were reading.
      if (current?.kind === 'section-header' && !current.collapsed) {
        return { index, action: { type: 'toggle', path: current.section.path } };
      }
      if (current?.kind === 'recent-header' && !current.folded) {
        return { index, action: { type: 'toggle', path: 'recent' } };
      }
      if (current?.kind === 'session') return { index: headerOf(rows, index), action: none };
      return { index, action: none };
    }

    case 'Enter':
    case ' ': {
      if (current?.kind === 'session') return { index, action: { type: 'open', sessionId: current.session.id } };
      if (current?.kind === 'section-header') return { index, action: { type: 'toggle', path: current.section.path } };
      if (current?.kind === 'recent-header') return { index, action: { type: 'toggle', path: 'recent' } };
      return { index, action: none };
    }

    default:
      return { index, action: none };
  }
}

/** Keys this module acts on — the component stops the browser's default for exactly these. */
export const HANDLED_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']);
