/**
 * The board's autonomy levels: their order, their names and what each one means in a
 * sentence a person can read before they choose it (ADR 0038, "Autonomy levels").
 *
 * WHY SHARED AND DATA-ONLY. The engine decides what a level may do (`src/delivery/autonomy.ts`,
 * which has the rules and the tests); the clients only need the names, the order (to show
 * "up to what your organisation allows") and the plain-language promise, so the words a
 * person agrees to are the same words the engine was written against. No rule lives here:
 * a client that re-implemented one would drift from the engine, and the engine is the
 * only place that can enforce it.
 *
 * @module shared/delivery/autonomy
 */

import type { Autonomy } from './types.js';

/** Lowest to highest. A level may do everything the ones before it may. */
export const AUTONOMY_LEVELS: readonly Autonomy[] = ['manual', 'assisted', 'autonomous', 'full'];

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  manual: 'Manual', assisted: 'Assisted', autonomous: 'Autonomous', full: 'Full autonomous',
};

export const AUTONOMY_SUMMARY: Record<Autonomy, string> = {
  manual: 'You move tasks to Ready and approve every landing.',
  assisted: 'Also starts the prerequisites of Ready tasks, and lands low-risk work whose checks are green.',
  autonomous: 'Also pulls the next tasks from the backlog, and lands low- and medium-risk work whose checks are green and that has no safety finding. High risk always waits for you.',
  full: 'Also lands high-risk work when every gate is green and your organisation allows it. Never lands a change with a secret or a weakened test, and never pushes to a protected branch.',
};

export const autonomyRank = (a: Autonomy): number => AUTONOMY_LEVELS.indexOf(a);

export const isAutonomy = (v: unknown): v is Autonomy => typeof v === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(v);

/** The lower of two levels. */
export const minAutonomy = (a: Autonomy, b: Autonomy): Autonomy => (autonomyRank(a) <= autonomyRank(b) ? a : b);

/** Whether `level` is above what a person's token alone may set (anything above `manual`). */
export const needsPersonToSet = (level: Autonomy): boolean => level !== 'manual';
