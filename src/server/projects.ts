/**
 * The directories a client may work in, and how it finds them.
 *
 * A *project* is a directory AICO has been pointed at. Sessions were always
 * keyed by their directory — `~/.aico/projects/<hash>/sessions/` — so this adds
 * no storage concept, only a way for the browser to name one of those
 * directories and start a session in it. The server's launch directory is
 * always available whether or not anyone listed it, because that is the one the
 * process was started for.
 *
 * **Why the filesystem is browsable at all.** A browser cannot open a native
 * directory picker that yields a usable server-side path, so the server has to
 * enumerate directories on its behalf. That is worth being clear-eyed about:
 * it exposes directory *names* to whoever holds the token. The token already
 * authorises running arbitrary shell commands as this user, so listing
 * directories is not an escalation — anyone who can reach these routes could
 * already `ls` anything. The guard that matters is the token, and it is applied
 * before any of this runs.
 *
 * What is *not* offered: file contents, hidden directories, or anything outside
 * a real directory. Browsing lists folders and nothing else.
 *
 * @module server/projects
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSettings, saveUserSetting } from '../settings.js';
import { listSessionSummaries } from '../session/persistence.js';

export interface ProjectSummary {
  path: string;
  name: string;
  /** The directory the server was launched in. Cannot be removed. */
  isLaunch: boolean;
  /** False when the directory has since been deleted or renamed. */
  exists: boolean;
  sessions: number;
  /** Most recent session activity, for ordering. */
  updatedAt: number;
}

/** The directory's own name, which is what people call a project. */
function defaultName(dir: string): string {
  return path.basename(path.resolve(dir)) || dir;
}

/** Absolute, normalized, and comparable — the identity of a project. */
export function normalizeProjectPath(input: string): string {
  return path.resolve(input.trim());
}

/**
 * Every project this server will accept a session for.
 *
 * The launch directory first, then configured projects in the order they were
 * added. Order matters only as a tiebreak; the client sorts by activity.
 */
export async function listProjects(launchCwd: string): Promise<ProjectSummary[]> {
  const settings = await loadSettings();
  const launch = normalizeProjectPath(launchCwd);

  const configured = (settings.projects ?? []).map(entry => ({
    path: normalizeProjectPath(entry.path),
    name: entry.name?.trim() || defaultName(entry.path),
  }));

  const seen = new Map<string, { path: string; name: string }>();
  seen.set(launch, { path: launch, name: defaultName(launch) });
  for (const entry of configured) if (!seen.has(entry.path)) seen.set(entry.path, entry);

  return Promise.all([...seen.values()].map(async (entry): Promise<ProjectSummary> => {
    let exists = false;
    try { exists = fs.statSync(entry.path).isDirectory(); } catch { /* gone */ }
    // Counted from the session store rather than from settings: a project's
    // sessions are whatever is on disk for that path, including ones started
    // by the CLI in the same directory.
    const sessions = exists ? await listSessionSummaries(entry.path).catch(() => []) : [];
    return {
      path: entry.path,
      name: entry.name,
      isLaunch: entry.path === launch,
      exists,
      sessions: sessions.length,
      updatedAt: sessions[0]?.updatedAt ?? 0,
    };
  }));
}

/**
 * Whether a session may run in this directory.
 *
 * Anything the client asks to work in has to be a project the server already
 * knows. Without this the `project` parameter would be an instruction to run an
 * agent anywhere on the filesystem, chosen by whatever sent the request — a
 * meaningfully larger surface than "drive the directory the user opened", even
 * given that the token holder could shell out anyway.
 */
export async function isKnownProject(launchCwd: string, candidate: string): Promise<boolean> {
  const target = normalizeProjectPath(candidate);
  const projects = await listProjects(launchCwd);
  return projects.some(project => project.path === target);
}

export async function addProject(dir: string, name?: string): Promise<ProjectSummary> {
  const target = normalizeProjectPath(dir);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`No such directory: ${target}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${target}`);

  const settings = await loadSettings();
  const existing = settings.projects ?? [];
  if (!existing.some(entry => normalizeProjectPath(entry.path) === target)) {
    await saveUserSetting('projects', [
      ...existing,
      { path: target, ...(name?.trim() ? { name: name.trim() } : {}), addedAt: Date.now() },
    ]);
  }

  return {
    path: target,
    name: name?.trim() || defaultName(target),
    isLaunch: false,
    exists: true,
    sessions: (await listSessionSummaries(target).catch(() => [])).length,
    updatedAt: 0,
  };
}

/**
 * Give a project a different display name.
 *
 * Only the label changes. The path is the identity — sessions are filed under
 * it — so renaming is a note to yourself about a folder, not a move.
 */
export async function renameProject(dir: string, name: string): Promise<boolean> {
  const target = normalizeProjectPath(dir);
  const settings = await loadSettings();
  const existing = settings.projects ?? [];
  const trimmed = name.trim();
  if (!existing.some(entry => normalizeProjectPath(entry.path) === target)) return false;
  await saveUserSetting('projects', existing.map(entry =>
    (normalizeProjectPath(entry.path) === target
      // Blank clears the override and the directory's own name comes back.
      ? { ...entry, ...(trimmed ? { name: trimmed } : { name: undefined }) }
      : entry)));
  return true;
}

/**
 * Forget a project.
 *
 * Removes it from the list and nothing else. Sessions recorded for that
 * directory stay on disk, because "stop showing me this folder" and "delete my
 * conversation history" are different intentions and only one of them was
 * expressed.
 */
export async function removeProject(dir: string): Promise<boolean> {
  const target = normalizeProjectPath(dir);
  const settings = await loadSettings();
  const existing = settings.projects ?? [];
  const next = existing.filter(entry => normalizeProjectPath(entry.path) !== target);
  if (next.length === existing.length) return false;
  await saveUserSetting('projects', next);
  return true;
}

export interface BrowseResult {
  /** The directory listed, absolute. */
  path: string;
  /** Its parent, or null at a filesystem root. */
  parent: string | null;
  /** Subdirectories, name-sorted. Files are not listed — you pick a folder. */
  entries: Array<{ name: string; path: string }>;
  /** Somewhere sensible to start: home, and on Windows the drives. */
  roots: Array<{ name: string; path: string }>;
  /** True when the directory could not be read, with `entries` empty. */
  denied?: boolean;
}

/** Home, plus whatever passes for a root on this platform. */
function browseRoots(): Array<{ name: string; path: string }> {
  const roots = [{ name: 'Home', path: os.homedir() }];
  if (process.platform === 'win32') {
    // Probing is the only reliable enumeration without a native call, and a
    // missing drive letter simply is not offered.
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        if (fs.statSync(drive).isDirectory()) roots.push({ name: `${letter}:`, path: drive });
      } catch { /* no such drive */ }
    }
  } else {
    roots.push({ name: '/', path: '/' });
  }
  return roots;
}

/**
 * List the subdirectories of one directory.
 *
 * Unreadable directories answer with an empty list and `denied`, not an error:
 * a picker that throws when the pointer passes over a system folder is a picker
 * nobody can navigate.
 */
export function browse(target?: string): BrowseResult {
  const dir = target?.trim() ? normalizeProjectPath(target) : os.homedir();
  const parent = path.dirname(dir);

  let entries: Array<{ name: string; path: string }> = [];
  let denied = false;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      // Hidden directories are noise in a project picker — `.git`, `.cache`,
      // `node_modules` is not hidden but is offered, since people do open it.
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, path: path.join(dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    denied = true;
  }

  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries,
    roots: browseRoots(),
    ...(denied ? { denied } : {}),
  };
}
