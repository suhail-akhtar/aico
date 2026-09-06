/**
 * Ordering and bucketing the session list.
 *
 * Pure, and in its own module so it can be tested without a DOM.
 *
 * The ordering rule is one sentence: **the session something last happened in
 * is the first row, always.** That has to hold live, not only at the moment the
 * list was fetched. The list used to be sorted once by the server and then left
 * alone for the rest of the session, so the chat you were actively working in
 * kept the position it had when the page loaded and sank down the list as
 * nothing about it was ever re-read. `promote` and `merge` below are what make
 * the rule hold between fetches.
 *
 * The old calendar buckets (Today, Yesterday, …) are gone: nothing had rendered
 * them since the list became grouped by folder, and a filter implemented three
 * times over is a filter that disagrees with itself sooner or later.
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

// ── Searching ────────────────────────────────────────────────────────

/** What a search can see besides the session itself. */
export interface MatchContext {
  /** Project name by path. */
  projects: Map<string, { name: string }>;
  /** Group name by id. */
  groups: Map<string, { name: string }>;
}

export const EMPTY_CONTEXT: MatchContext = { projects: new Map(), groups: new Map() };

/**
 * A query, as the words that all have to be present.
 *
 * Space-separated terms with AND semantics — "auth api" finds the sessions
 * about both — matching the behaviour of the settings search, so the two boxes
 * in the product agree about what a space means.
 */
export function searchTerms(filter: string): string[] {
  return filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Whether a session matches every term.
 *
 * Looks at the title, the id, the project's name and path, and the group's
 * name — because "the one in the payments repo" and "the one in my Q3 group"
 * are how people actually remember a conversation, not by its title alone.
 */
export function matchesSession(s: SessionSummary, terms: string[], ctx: MatchContext = EMPTY_CONTEXT): boolean {
  if (terms.length === 0) return true;
  const project = s.project ? ctx.projects.get(s.project) : undefined;
  const group = s.group ? ctx.groups.get(s.group) : undefined;
  const haystack = [
    s.title ?? '',
    s.id,
    project?.name ?? '',
    s.project ?? '',
    s.project ? basename(s.project) : '',
    group?.name ?? '',
  ].join('\n').toLowerCase();
  return terms.every(term => haystack.includes(term));
}

/** Whether a section's own name matches, so an empty project can still be found. */
export function matchesSectionLabel(label: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const lower = label.toLowerCase();
  return terms.every(term => lower.includes(term));
}

// ── Sections ─────────────────────────────────────────────────────────

/**
 * One heading in the list.
 *
 * A *project* is a folder; a *group* is a bucket someone made; *apps* is the
 * one synthetic section, holding the conversations bound to an App — they are
 * filed under the scratch directory on disk, and showing them there made the
 * scratch folder look like where the work was.
 */
export interface Section {
  label: string;
  /** Folder path, group id, or {@link APPS_SECTION} for the synthetic one. Unique across all three. */
  path: string;
  kind: 'project' | 'group' | 'apps';
  pinned?: boolean;
  items: SessionSummary[];
}

export const APPS_SECTION = '__apps__';

/** Sessions bound to an App carry a fixed id prefix; the server derives it. */
export function isAppSession(s: SessionSummary): boolean {
  return /^miniapp-/.test(s.id);
}

/**
 * Sections, which are folders, the groups you made, and the app conversations.
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
  const terms = searchTerms(filter);
  const ctx: MatchContext = {
    projects: new Map(projects.map(p => [p.path, { name: p.name }])),
    groups: new Map(groups.map(g => [g.id, { name: g.name }])),
  };
  const matching = byRecency(terms.length ? sessions.filter(s => matchesSession(s, terms, ctx)) : sessions);

  const sections = new Map<string, Section>();
  // Seeded from the project list so a project with no sessions still appears —
  // a folder you just opened and cannot see is indistinguishable from one that
  // failed to open. Groups first: they are the ones someone made on purpose.
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
    // An app conversation goes to the apps section, whatever folder it is filed
    // under — unless someone deliberately put it in a group, which wins as it
    // does for every other session. A group that has been deleted leaves the
    // membership event behind in the log, and the session correctly falls back.
    const inGroup = Boolean(session.group && sections.has(session.group));
    const key = inGroup
      ? session.group!
      : isAppSession(session)
        ? APPS_SECTION
        : (session.project ?? '');
    let section = sections.get(key);
    if (!section) {
      section = key === APPS_SECTION
        ? { label: 'App conversations', path: APPS_SECTION, kind: 'apps', items: [] }
        // A session whose directory is no longer a known project still has to go
        // somewhere; dropping it would hide history rather than tidy it.
        : { label: key ? basename(key) : 'Other', path: key, kind: 'project', items: [] };
      sections.set(key, section);
    }
    section.items.push(session);
  }

  // While filtering, a section whose own name matches stays even when none of
  // its sessions do — that is how an empty project is found by name. Every
  // other empty section is dropped, because "no match here" seventy times is
  // not a search result.
  const kept = terms.length
    ? [...sections.values()].filter(s => s.items.length > 0 || matchesSectionLabel(s.label, terms))
    : [...sections.values()];

  // Pinned first, then by activity. A folder you just added has no activity at
  // all, so plain recency buries it at the bottom — which is the opposite of
  // what adding a folder means. `order` on the project list carries that:
  // projects arrive newest-added first, and ties fall back to it.
  const addedRank = new Map([
    ...groups.map((g, index) => [g.id, index] as const),
    ...projects.map((p, index) => [p.path, groups.length + index] as const),
  ]);
  return kept.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    const activity = (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0);
    if (activity !== 0) return activity;
    return (addedRank.get(a.path) ?? 1e9) - (addedRank.get(b.path) ?? 1e9);
  });
}

/** Pinned sections apart from the rest, so the list can draw a band above them. */
export function splitPinned(sections: Section[]): { pinned: Section[]; rest: Section[] } {
  return {
    pinned: sections.filter(s => s.pinned),
    rest: sections.filter(s => !s.pinned),
  };
}

/** The section a session is shown under, named — for the Recent rows' suffix. */
export function sectionLabelFor(
  session: SessionSummary,
  projects: Array<{ path: string; name: string }>,
  groups: Array<{ id: string; name: string }>,
): string {
  if (session.group) {
    const group = groups.find(g => g.id === session.group);
    if (group) return group.name;
  }
  if (isAppSession(session)) return 'App';
  if (session.project) {
    const project = projects.find(p => p.path === session.project);
    return project?.name ?? basename(session.project);
  }
  return '';
}

// ── Recent ───────────────────────────────────────────────────────────

/**
 * How many rows Recent shows. Five, fixed.
 *
 * It used to start at ten and grow by twenty on request, and a Recent list that
 * grows is the sidebar twice — the folders below already hold everything. Five
 * covers the handful a person actually moves between in a working session.
 */
export const RECENT_LIMIT = 5;

/** Below this many sessions the folders fit on screen and Recent would only duplicate them. */
export const RECENT_MIN_SESSIONS = 8;

/**
 * The most recent conversations, whatever folder they live in.
 *
 * Grouping by folder is right for finding something you know the home of, and
 * wrong for the commonest case by far: carrying on with what you were just
 * doing. That chat is one row in one of eight collapsed folders, and finding
 * it means remembering which — a question nobody should have to answer about
 * their own last five minutes.
 */
export function recentSessions(
  sessions: SessionSummary[],
  filter = '',
  limit = RECENT_LIMIT,
  ctx: MatchContext = EMPTY_CONTEXT,
): { items: SessionSummary[]; total: number } {
  const terms = searchTerms(filter);
  const matching = byRecency(terms.length ? sessions.filter(s => matchesSession(s, terms, ctx)) : sessions);
  return { items: matching.slice(0, limit), total: matching.length };
}

/** Whether Recent is worth drawing: not while searching, not for a short list. */
export function showRecent(filter: string, sessionCount: number): boolean {
  return searchTerms(filter).length === 0 && sessionCount >= RECENT_MIN_SESSIONS;
}

/** Last path segment, for either separator. */
export function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
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
