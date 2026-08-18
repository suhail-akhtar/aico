/**
 * Groups: containers you make, rather than ones the filesystem made for you.
 *
 * A project is a directory — it exists because you have code there. A group
 * exists because you decided two conversations belong together, and that is a
 * different kind of fact. "Everything about the payments migration" spans three
 * repositories; "scratch questions" spans none.
 *
 * **A group never replaces a session's directory.** An agent has to run
 * *somewhere*, so every session keeps the working directory it was created in;
 * a group only changes where the session appears in the list. That is what lets
 * a group hold sessions from several projects at once, which is the only
 * version of this feature worth having — if a group were just another folder,
 * the folders you already have would do.
 *
 * Membership is recorded in the session's own log as a `session/group` event,
 * for the same reason archiving is: the log is the only durable state a session
 * has, so there is no second index to keep in step and no migration when this
 * changes.
 *
 * @module server/groups
 */

import { loadSettings, saveUserSetting } from '../settings.js';

export interface GroupSummary {
  id: string;
  name: string;
  /** Swatch tinting the group's icon. */
  color?: string;
  /** A note about what the group is for. Never sent to a model. */
  description?: string;
  /** Instructions every session in this group follows. */
  instructions?: string;
  /** Kept above recency in the list. */
  pinned?: boolean;
  /**
   * Where a session started from this group runs.
   *
   * A group is not a directory, so it has to borrow one. Unset means "wherever
   * the client currently is", which is the right answer for a group that spans
   * projects and a fine one for a group that does not.
   */
  cwd?: string;
  createdAt?: number;
}

/** Readable, unique, and safe in a URL. */
function mintId(name: string, taken: string[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    || 'group';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const clean = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export async function listGroups(): Promise<GroupSummary[]> {
  const settings = await loadSettings();
  return (settings.groups ?? [])
    .filter(entry => entry.id && entry.name)
    .map(entry => ({
      id: entry.id,
      name: entry.name,
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.instructions ? { instructions: entry.instructions } : {}),
      ...(entry.pinned ? { pinned: true } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
    }))
    // Newest first, for the same reason a freshly added project sorts up: a
    // group you just made has no sessions, so activity alone would bury it.
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function createGroup(name: string, cwd?: string): Promise<GroupSummary> {
  const label = name.trim();
  if (!label) throw new Error('A group needs a name');

  const settings = await loadSettings();
  const existing = settings.groups ?? [];
  const group = {
    id: mintId(label, existing.map(g => g.id)),
    name: label,
    ...(clean(cwd) ? { cwd: clean(cwd) } : {}),
    createdAt: Date.now(),
  };
  await saveUserSetting('groups', [...existing, group]);
  return group;
}

export interface GroupPatch {
  name?: string;
  color?: string;
  description?: string;
  instructions?: string;
  pinned?: boolean;
  cwd?: string;
}

export async function updateGroup(id: string, patch: GroupPatch): Promise<boolean> {
  const settings = await loadSettings();
  const existing = settings.groups ?? [];
  if (!existing.some(entry => entry.id === id)) return false;

  await saveUserSetting('groups', existing.map((entry) => {
    if (entry.id !== id) return entry;
    const next = { ...entry };
    if (patch.name !== undefined) next.name = clean(patch.name) ?? entry.name;
    if (patch.color !== undefined) next.color = clean(patch.color);
    if (patch.description !== undefined) next.description = clean(patch.description);
    if (patch.instructions !== undefined) next.instructions = clean(patch.instructions);
    if (patch.cwd !== undefined) next.cwd = clean(patch.cwd);
    if (patch.pinned !== undefined) next.pinned = patch.pinned || undefined;
    return next;
  }));
  return true;
}

/**
 * Delete a group.
 *
 * The sessions in it are untouched. Their logs still carry the membership
 * event, and they simply fall back to appearing under their own directory —
 * which is where they have been running all along. Deleting a container should
 * not delete what was in it, and here it cannot even by accident.
 */
export async function deleteGroup(id: string): Promise<boolean> {
  const settings = await loadSettings();
  const existing = settings.groups ?? [];
  const next = existing.filter(entry => entry.id !== id);
  if (next.length === existing.length) return false;
  await saveUserSetting('groups', next);
  return true;
}

/** Instructions attached to one group, if it has any. */
export async function groupInstructions(id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const groups = await listGroups();
  return groups.find(g => g.id === id)?.instructions;
}
