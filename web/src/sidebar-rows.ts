/**
 * The session list as one flat sequence of rows.
 *
 * Two things want the list flat. Windowing needs a single array to slice — a
 * nested tree of sections cannot be told "rows 40 to 80". And keyboard
 * navigation needs a single order to move through, where Down from the last
 * row of one section lands on the header of the next.
 *
 * Pure, so the rules that decide what a reader sees — Recent hidden while
 * filtering, a folded section contributing only its header, filtering forcing
 * every matching section open — are tested as rules rather than observed on
 * screen.
 *
 * @module sidebar-rows
 */

import type { SessionSummary } from './api';
import type { Section } from './grouping';

export type Row =
  | { kind: 'recent-header'; folded: boolean; total: number }
  | { kind: 'section-header'; section: Section; collapsed: boolean; matches: number }
  | { kind: 'session'; session: SessionSummary; within: 'recent' | string }
  | { kind: 'empty'; section: Section };

export interface FlattenInput {
  recent: { items: SessionSummary[]; total: number };
  /** Whether Recent is shown at all — hidden while filtering and for short lists. */
  showRecent: boolean;
  recentFolded: boolean;
  sections: Section[];
  collapsed: Set<string>;
  /** A non-empty filter opens every matching section; a fold is about browsing, not searching. */
  filtering: boolean;
}

export function flattenRows(input: FlattenInput): Row[] {
  const rows: Row[] = [];

  if (input.showRecent && input.recent.items.length > 0) {
    rows.push({ kind: 'recent-header', folded: input.recentFolded, total: input.recent.total });
    if (!input.recentFolded) {
      for (const session of input.recent.items) rows.push({ kind: 'session', session, within: 'recent' });
    }
  }

  for (const section of input.sections) {
    const collapsed = !input.filtering && input.collapsed.has(section.path);
    rows.push({ kind: 'section-header', section, collapsed, matches: section.items.length });
    if (collapsed) continue;
    if (section.items.length === 0) {
      // A folder with nothing in it still says so — while filtering, an empty
      // section means "no match here", which the header alone would not say.
      rows.push({ kind: 'empty', section });
      continue;
    }
    for (const session of section.items) rows.push({ kind: 'session', session, within: section.path });
  }

  return rows;
}

/**
 * A stable identity per row.
 *
 * A session shown in Recent and again under its folder is two rows with one
 * id, so the key carries where it is shown; React must not see them as one.
 */
export function rowKey(row: Row): string {
  switch (row.kind) {
    case 'recent-header': return 'recent';
    case 'section-header': return `head:${row.section.kind}:${row.section.path}`;
    case 'empty': return `empty:${row.section.kind}:${row.section.path}`;
    case 'session': return `${row.within === 'recent' ? 'recent' : row.within}:${row.session.id}`;
  }
}

/** Rows a keyboard user can land on: headers and sessions, not the empty-state lines. */
export function isFocusable(row: Row): boolean {
  return row.kind !== 'empty';
}
