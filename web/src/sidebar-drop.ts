/**
 * What dropping a session on a section header means.
 *
 * Onto a group: file it there. Onto its own project header while it sits in a
 * group: take it back out (the session never left the folder; the group was a
 * label). Onto anything else: nothing — a project header for a *different*
 * folder cannot take a session, because a session belongs to exactly one
 * directory for its whole life, and pretending otherwise would be a move that
 * moved nothing.
 *
 * Pure so the three cases are tested as cases.
 *
 * @module sidebar-drop
 */

import type { SessionSummary } from './api';
import type { Section } from './grouping';

export type DropAction =
  | { type: 'move'; group: string }
  | { type: 'unfile' }
  | null;

export function dropAction(target: Section, session: SessionSummary): DropAction {
  if (target.kind === 'group') {
    return session.group === target.path ? null : { type: 'move', group: target.path };
  }
  if (target.kind === 'project' && session.group && session.project === target.path) {
    return { type: 'unfile' };
  }
  return null;
}

/** The drag payload's MIME type, so only our own rows are accepted as drops. */
export const SESSION_DRAG_TYPE = 'application/x-aico-session';
