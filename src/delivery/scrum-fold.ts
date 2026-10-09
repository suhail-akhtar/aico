/**
 * Scrum's share of the Delivery journal: the event shapes and the pure fold that
 * turns them into sprints, estimates, memberships and suggestions (ADR 0039 section 4).
 *
 * WHY A SEPARATE FILE. `store.ts` already folds every other fact; Scrum is a mode, and
 * a board that never switches it on must fold exactly as before. So the store carries
 * one generic event (`t: 'scrum'`) and hands it here, and this file imports nothing from
 * the store: the dispatcher (index.ts) can ask "may this task start in this mode?"
 * without a cycle, and the service (`scrum.ts`) can import both.
 *
 * Estimates and sprint membership are NOT kept on the task events. They live in this
 * fold and are laid over the tasks at the end of the replay, so a later whole-task
 * event (an import, a replan) can never silently drop a person's estimate, and "what
 * was the scope on Tuesday" stays answerable from the scope log.
 *
 * Deliberately not here: who may append these events (the routes and `scrum.ts` check
 * the decision gate), validation of user input (the service), and any clock.
 *
 * @module delivery/scrum-fold
 */

import {
  computeResult, memberAt, ms, type BoardMode, type Proposal, type Sprint,
} from '../../shared/delivery/scrum.js';
import type { Task } from './types.js';

export type ScrumEvent =
  | { k: 'mode'; mode: BoardMode }
  | { k: 'sprint'; id: string; name: string; goal: string; start: string; end: string; capacityPoints?: number }
  | { k: 'commit'; sprint: string; add: string[]; remove: string[] }
  | { k: 'start'; sprint: string }
  | { k: 'close'; sprint: string }
  | { k: 'estimate'; task: string; points: number | null }
  | { k: 'proposal'; proposal: Proposal }
  | { k: 'resolve'; id: string; status: 'accepted' | 'dismissed' }
  | { k: 'notes'; sprint: string; kind: 'review' | 'retro'; text: string };

export interface ScrumFold {
  mode: BoardMode;
  sprints: Map<string, Sprint>;
  proposals: Map<string, Proposal>;
  estimates: Map<string, number>;
  /** Task id to the open (planned or active) sprint it belongs to now. */
  sprintOf: Map<string, string>;
}

export function emptyScrum(): ScrumFold {
  return { mode: 'kanban', sprints: new Map(), proposals: new Map(), estimates: new Map(), sprintOf: new Map() };
}

export const activeSprint = (s: ScrumFold): Sprint | undefined => [...s.sprints.values()].find(x => x.status === 'active');

/**
 * Whether the dispatcher may START this task under the board's mode. In Scrum only a
 * ready task of the active sprint starts; rework (`changes`) of something already begun
 * is not gated, because stranding half-done work behind a closed sprint helps nobody.
 */
export function mayStartInMode(s: ScrumFold, t: Pick<Task, 'status' | 'sprintId'>): boolean {
  if (s.mode !== 'scrum' || t.status !== 'ready') return true;
  const a = activeSprint(s);
  return a !== undefined && t.sprintId === a.id;
}

function withEstimates(tasks: ReadonlyMap<string, Task>, s: ScrumFold): Task[] {
  return [...tasks.values()].map(t => (s.estimates.has(t.id) ? { ...t, estimate: s.estimates.get(t.id)! } : t));
}

function addEntry(sp: Sprint, at: string, taskId: string, points: number, kind: 'commit' | 'add' | 'remove' | 'estimate'): void {
  sp.scope.push({ at, taskId, points, kind });
}

/** Apply one event. Unknown sprints or tasks are ignored: a torn or stale event must not break the replay. */
export function applyScrum(s: ScrumFold, tasks: ReadonlyMap<string, Task>, ev: ScrumEvent, at: string): void {
  switch (ev.k) {
    case 'mode':
      s.mode = ev.mode === 'scrum' ? 'scrum' : 'kanban';
      return;
    case 'sprint':
      if (s.sprints.has(ev.id)) return;
      s.sprints.set(ev.id, {
        id: ev.id, name: ev.name, goal: ev.goal, start: ev.start, end: ev.end,
        ...(ev.capacityPoints !== undefined ? { capacityPoints: ev.capacityPoints } : {}),
        status: 'planned', createdAt: at, scope: [],
      });
      return;
    case 'commit': {
      const sp = s.sprints.get(ev.sprint);
      if (!sp || sp.status === 'closed') return;
      for (const id of ev.remove) {
        if (s.sprintOf.get(id) !== sp.id || !memberAt(sp, id)) continue;
        const net = sp.scope.filter(e => e.taskId === id).reduce((n, e) => n + e.points, 0);
        addEntry(sp, at, id, -net, 'remove');
        s.sprintOf.delete(id);
      }
      for (const id of ev.add) {
        if (!tasks.has(id) || s.sprintOf.has(id)) continue;
        addEntry(sp, at, id, s.estimates.get(id) ?? 0, sp.status === 'active' ? 'add' : 'commit');
        s.sprintOf.set(id, sp.id);
      }
      if (!sp.committedAt) sp.committedAt = at;
      return;
    }
    case 'start': {
      const sp = s.sprints.get(ev.sprint);
      if (sp && sp.status === 'planned') { sp.status = 'active'; sp.startedAt = at; }
      return;
    }
    case 'close': {
      const sp = s.sprints.get(ev.sprint);
      if (!sp || sp.status !== 'active') return;
      sp.status = 'closed';
      sp.closedAt = at;
      sp.result = computeResult(sp, withEstimates(tasks, s), ms(at));
      // Unfinished work leaves the sprint and returns to the product backlog; finished work keeps its link.
      for (const id of sp.result.carried) if (s.sprintOf.get(id) === sp.id) s.sprintOf.delete(id);
      return;
    }
    case 'estimate': {
      const before = s.estimates.get(ev.task) ?? 0;
      if (ev.points === null) s.estimates.delete(ev.task); else s.estimates.set(ev.task, ev.points);
      const now = ev.points ?? 0;
      const sp = s.sprints.get(s.sprintOf.get(ev.task) ?? '');
      if (sp && sp.status !== 'closed' && now !== before) addEntry(sp, at, ev.task, now - before, 'estimate');
      return;
    }
    case 'proposal':
      s.proposals.set(ev.proposal.id, structuredClone(ev.proposal));
      return;
    case 'resolve': {
      const p = s.proposals.get(ev.id);
      if (p && p.status === 'open') { p.status = ev.status; p.resolvedAt = at; }
      return;
    }
    case 'notes': {
      const sp = s.sprints.get(ev.sprint);
      if (sp) sp.notes = { ...sp.notes, [ev.kind]: { text: ev.text, at } };
      return;
    }
  }
}

/** Lay estimates and memberships over the folded tasks. Called once, after the replay. */
export function overlayScrum(tasks: Map<string, Task>, s: ScrumFold): void {
  for (const t of tasks.values()) {
    const e = s.estimates.get(t.id);
    if (e !== undefined) t.estimate = e; else delete t.estimate;
    const sp = s.sprintOf.get(t.id);
    if (sp !== undefined) t.sprintId = sp; else delete t.sprintId;
  }
}

/** Sprints as clients read them: oldest first, a copy. */
export function sprintList(s: ScrumFold): Sprint[] {
  return [...s.sprints.values()].sort((a, b) => a.start.localeCompare(b.start) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(x => structuredClone(x));
}

export const openProposals = (s: ScrumFold): Proposal[] =>
  [...s.proposals.values()].filter(p => p.status === 'open').sort((a, b) => b.at.localeCompare(a.at)).map(p => structuredClone(p));
