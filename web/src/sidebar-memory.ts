/**
 * What the sidebar remembers between reloads.
 *
 * Which sections are folded, whether Recent is folded, and whether archived
 * sessions are shown. Until now all three lived in component state, so a
 * reload re-expanded every project and reset the list to its first-paint
 * shape — on a machine with seventy project directories that is a wall of
 * headers every morning.
 *
 * Same discipline as {@link module:panel-memory}: `localStorage` behind an
 * injectable store so it can be tested, one key, the shape checked on read and
 * discarded whole when it fails. A lost preference is a small problem; a page
 * that trusts a malformed value is a large one.
 *
 * @module sidebar-memory
 */

import type { SessionStore } from './session-memory';

const KEY = 'aico.sidebar';

export interface SidebarMemory {
  /** Section paths (folder paths and group ids) the reader folded. */
  collapsed: string[];
  recentFolded: boolean;
  showArchived: boolean;
  /**
   * Whether the reader has ever folded or unfolded a section. Until they have,
   * the first paint chooses for them — see {@link defaultCollapsed}.
   */
  touched: boolean;
}

export const EMPTY_MEMORY: SidebarMemory = {
  collapsed: [], recentFolded: false, showArchived: false, touched: false,
};

/** How many sections stay open on a first paint with nothing remembered. */
export const OPEN_BY_DEFAULT = 3;

function defaultStore(): SessionStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSidebarMemory(store: SessionStore | null = defaultStore()): SidebarMemory {
  let raw: string | null = null;
  try { raw = store?.getItem(KEY) ?? null; } catch { return EMPTY_MEMORY; }
  if (!raw) return EMPTY_MEMORY;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_MEMORY;
    const p = parsed as Record<string, unknown>;
    const collapsed = Array.isArray(p.collapsed)
      ? p.collapsed.filter((x): x is string => typeof x === 'string')
      : null;
    // A record with the wrong shape in any field is discarded whole rather than
    // half-trusted: partially valid state is how a bad key survives for months.
    if (collapsed === null
      || typeof p.recentFolded !== 'boolean'
      || typeof p.showArchived !== 'boolean'
      || typeof p.touched !== 'boolean') {
      return EMPTY_MEMORY;
    }
    return { collapsed, recentFolded: p.recentFolded, showArchived: p.showArchived, touched: p.touched };
  } catch {
    return EMPTY_MEMORY;
  }
}

export function saveSidebarMemory(
  memory: SidebarMemory,
  store: SessionStore | null = defaultStore(),
): void {
  if (!store) return;
  try { store.setItem(KEY, JSON.stringify(memory)); } catch { /* see the module note */ }
}

/**
 * Which sections start folded.
 *
 * Once the reader has touched the list, their folds are the answer. Before
 * that, the most recently active few stay open and the rest fold: a first
 * paint with every folder expanded is a wall, and one with every folder
 * collapsed hides the conversation they came back for.
 *
 * Sections are given most-active first, which is the order the list draws them.
 */
export function defaultCollapsed(
  sections: ReadonlyArray<{ path: string; items: ReadonlyArray<{ updatedAt: number }> }>,
  memory: SidebarMemory,
  openByDefault = OPEN_BY_DEFAULT,
): Set<string> {
  if (memory.touched) return new Set(memory.collapsed);
  // A short list is left entirely open: two projects, both folded, is a column
  // that shows nothing and explains nothing.
  if (sections.length <= openByDefault) return new Set();
  const byActivity = [...sections]
    .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0));
  const open = new Set(byActivity.slice(0, openByDefault).map(s => s.path));
  // Everything else folds, empty sections included — seventy opened-once
  // folders each showing "No sessions here yet" is the wall this exists to
  // prevent. A folded empty section is one row that says 0.
  return new Set(sections.filter(s => !open.has(s.path)).map(s => s.path));
}
