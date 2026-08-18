/**
 * Ordering and bucketing the session list.
 *
 * Pure, and in its own module so it can be tested without a DOM: the date
 * boundaries are the kind of thing that is quietly wrong for a week before
 * anyone notices, and "is 11pm last night Yesterday at 9am" is a real question
 * with a right answer.
 *
 * The ordering rule is one sentence: **the session something last happened in
 * is the first row, always.** That has to hold live, not only at the moment the
 * list was fetched. The list used to be sorted once by the server and then left
 * alone for the rest of the session, so the chat you were actively working in
 * kept the position it had when the page loaded and sank down the list as
 * nothing about it was ever re-read. `promote` and `merge` below are what make
 * the rule hold between fetches.
 *
 * @module grouping
 */

import type { SessionSummary } from './api';

/** Newest first. The only order this list is ever in. */
export function byRecency(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Record that something just happened in a session, and re-sort.
 *
 * Never lowers a timestamp: an event that arrives out of order, or a server
 * listing that has not yet seen the write, must not pull a row back down. When
 * the session is not in the list at all — a brand-new one whose log file does
 * not exist yet — it is inserted, because the alternative is a chat you are
 * typing into that has no row until the next refetch.
 */
export function promote(
  sessions: SessionSummary[],
  id: string,
  at: number,
  seed: Partial<SessionSummary> = {},
): SessionSummary[] {
  const existing = sessions.find(s => s.id === id);
  if (existing && existing.updatedAt >= at) return sessions;

  const next = existing
    ? sessions.map(s => (s.id === id ? { ...s, updatedAt: at } : s))
    : [...sessions, { id, updatedAt: at, turns: 0, ...seed }];
  return byRecency(next);
}

/**
 * Fold a freshly fetched listing into what the client already knows.
 *
 * The server reads timestamps off the log on disk, so a refetch issued the
 * instant a message is sent can legitimately report an *older* `updatedAt` than
 * the client has already observed on the stream. Taking the larger of the two
 * is what stops the row the user is looking at from visibly dropping down the
 * list a moment after they hit send.
 *
 * Local-only rows survive for the same reason: a session with no events written
 * yet is absent from the listing entirely, and dropping it would make the
 * current chat disappear from the sidebar mid-turn.
 */
export function merge(local: SessionSummary[], incoming: SessionSummary[]): SessionSummary[] {
  const byId = new Map(incoming.map(s => [s.id, s]));

  for (const mine of local) {
    const theirs = byId.get(mine.id);
    if (!theirs) {
      // Only worth keeping if it is genuinely ours-and-not-theirs rather than a
      // session deleted on disk. A row with no turns has never been written, so
      // its absence from the listing is expected rather than a deletion.
      if (!mine.turns) byId.set(mine.id, mine);
      continue;
    }
    if (mine.updatedAt > theirs.updatedAt) {
      byId.set(mine.id, { ...theirs, updatedAt: mine.updatedAt });
    }
  }

  return byRecency([...byId.values()]);
}

/**
 * Bucket sessions by the directory they belong to.
 *
 * Used instead of the date buckets once more than one project is open, because
 * at that point *where* a conversation happened is the stronger memory than
 * *when* — you remember you were working on the API, not that it was Tuesday.
 * With a single project the question never arises and dates are the better
 * axis, so {@link groupByAge} stays the default.
 *
 * Projects are ordered by their most recent activity and sessions within them
 * by recency, so the same rule holds at both levels: the thing you touched last
 * is at the top.
 */
export interface Section {
  label: string;
  /** Folder path, or group id. Unique across both — a path is never an id. */
  path: string;
  kind: 'project' | 'group';
  pinned?: boolean;
  items: SessionSummary[];
}

/**
 * Sections, which are folders and the groups you made.
 *
 * A session in a group appears under the group *instead of* its folder. It is
 * still running in that folder — a group is a label, not a location — but a
 * session shown in two places at once is a list nobody can count, and the
 * group is the more deliberate of the two facts: the folder is where the code
 * happens to be, the group is a decision someone made.
 */
export function groupByProject(
  sessions: SessionSummary[],
  projects: Array<{ path: string; name: string; pinned?: boolean; addedAt?: number }>,
  filter = '',
  groups: Array<{ id: string; name: string; pinned?: boolean }> = [],
): Section[] {
  const needle = filter.trim().toLowerCase();
  const matching = byRecency(needle
    ? sessions.filter(s =>
      (s.title ?? '').toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle))
    : sessions);

  const sections = new Map<string, Section>();
  // Seeded from the project list so a project with no sessions still appears —
  // a folder you just opened and cannot see is indistinguishable from one that
  // failed to open.
  // Groups first: they are the ones someone made on purpose.
  for (const group of groups) {
    sections.set(group.id, {
      label: group.name,
      path: group.id,
      kind: 'group',
      ...(group.pinned ? { pinned: true } : {}),
      items: [],
    });
  }
  for (const project of projects) {
    sections.set(project.path, {
      label: project.name,
      path: project.path,
      kind: 'project',
      ...(project.pinned ? { pinned: true } : {}),
      items: [],
    });
  }

  for (const session of matching) {
    // The group wins when the session is in one that still exists. A group that
    // has been deleted leaves the membership event behind in the log, and the
    // session correctly falls back to the folder it has been running in.
    const key = (session.group && sections.has(session.group))
      ? session.group
      : (session.project ?? '');
    let section = sections.get(key);
    if (!section) {
      // A session whose directory is no longer a known project still has to go
      // somewhere; dropping it would hide history rather than tidy it.
      section = { label: key ? basename(key) : 'Other', path: key, kind: 'project', items: [] };
      sections.set(key, section);
    }
    section.items.push(session);
  }

  // Pinned first, then by activity. A folder you just added has no activity at
  // all, so plain recency buries it at the bottom — which is the opposite of
  // what adding a folder means. `order` on the project list carries that:
  // projects arrive newest-added first, and ties fall back to it.
  const addedRank = new Map([
    ...groups.map((g, index) => [g.id, index] as const),
    ...projects.map((p, index) => [p.path, groups.length + index] as const),
  ]);
  return [...sections.values()].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const activity = (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0);
    if (activity !== 0) return activity;
    return (addedRank.get(a.path) ?? 1e9) - (addedRank.get(b.path) ?? 1e9);
  });
}

/** Last path segment, for either separator. */
function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/**
 * Bucket sessions by age.
 *
 * Boundaries are calendar days, not elapsed hours: something from 11pm last
 * night is "Yesterday" at 9am, not "ten hours ago". People navigate by the day
 * a thing happened on.
 *
 * Sorts rather than trusting the caller. Every path that reaches here is
 * supposed to hand over a recency-ordered list, and relying on that held right
 * up until one of them did not.
 */
export function groupByAge(
  sessions: SessionSummary[],
  filter = '',
  now = Date.now(),
): Array<{ label: string; items: SessionSummary[] }> {
  const needle = filter.trim().toLowerCase();
  const matching = byRecency(needle
    ? sessions.filter(s =>
      (s.title ?? '').toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle))
    : sessions);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 86_400_000;
  const week = today - 6 * 86_400_000;
  const month = today - 29 * 86_400_000;

  const groups: Array<{ label: string; items: SessionSummary[] }> = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Previous 30 days', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const session of matching) {
    const at = session.updatedAt;
    const bucket =
      at >= today ? 0
      : at >= yesterday ? 1
      : at >= week ? 2
      : at >= month ? 3
      : 4;
    groups[bucket]!.items.push(session);
  }

  return groups;
}

/** Compact relative age, as the row's right-hand marker. */
export function relativeAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}

