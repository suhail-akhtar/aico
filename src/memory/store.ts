/**
 * Memories you can point at one at a time.
 *
 * Memory already existed here as *files* — AICO.md and its siblings, read whole
 * and appended to. That shape answers "what should the agent always know about
 * this project" and cannot answer any of the things people actually ask for:
 * list what you remember, forget that one thing, remember this only for this
 * chat. You cannot delete a sentence from a file you only ever append to.
 *
 * So this is a store of discrete entries, and the file memory stays exactly as
 * it is. The two are different questions and merging them would make the
 * simple one worse.
 *
 * **Three scopes, because "remember this" means three different things.**
 * Globally ("I prefer tabs"), per project ("this repo deploys on Fridays"), or
 * per chat ("the file we're working on is src/api.ts"). Getting this wrong in
 * either direction is bad in a way people notice: a preference that only
 * applies to one repository is an annoyance, and a chat detail leaking into
 * every future conversation is worse.
 *
 * **A memory is a file, not a row.** One entry per file, frontmatter plus text,
 * in a directory you can open. That makes the store inspectable, hand-editable,
 * greppable, and portable — and means a corrupt entry costs one memory rather
 * than the whole store.
 *
 * @module memory/store
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export type MemoryScope = 'global' | 'project' | 'session';

export interface StoredMemory {
  id: string;
  scope: MemoryScope;
  text: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** The project path or session id this belongs to, when scoped. */
  belongsTo?: string;
  file: string;
}

export function memoryRoot(): string {
  return path.join(os.homedir(), '.aico', 'memories');
}

/**
 * A stable directory name for a project path.
 *
 * Hashed rather than encoded because project paths are long, contain
 * separators and drive letters, and differ in case on Windows — and a
 * directory name that sometimes collides is worse than one nobody can read.
 * The path is written inside each entry, so nothing is actually lost.
 */
function projectKey(cwd: string): string {
  const normalised = path.resolve(cwd).toLowerCase();
  return crypto.createHash('sha1').update(normalised).digest('hex').slice(0, 16);
}

/** Where a scope's memories live. */
export function scopeDir(scope: MemoryScope, belongsTo?: string): string {
  switch (scope) {
    case 'global': return path.join(memoryRoot(), 'global');
    case 'project': return path.join(memoryRoot(), 'projects', projectKey(belongsTo ?? process.cwd()));
    case 'session': return path.join(memoryRoot(), 'sessions', (belongsTo ?? 'unknown').replace(/[^\w.-]/g, '-'));
  }
}

/** An id that is a filename, unique within its scope. */
function makeId(text: string, dir: string): string {
  const base = text.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').slice(0, 6).join('-')
    .slice(0, 48) || 'memory';
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, `${id}.md`))) id = `${base}-${n++}`;
  return id;
}

function parse(file: string, scope: MemoryScope): StoredMemory | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;
    const meta: Record<string, string> = {};
    for (const line of match[1]!.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return {
      id: meta['id'] ?? path.basename(file, '.md'),
      scope,
      text: match[2]!.trim(),
      tags: meta['tags'] ? meta['tags'].split(',').map(t => t.trim()).filter(Boolean) : [],
      createdAt: Number(meta['createdAt'] ?? 0),
      updatedAt: Number(meta['updatedAt'] ?? 0),
      belongsTo: meta['belongsTo'] || undefined,
      file,
    };
  } catch {
    return null;
  }
}

function serialise(memory: Omit<StoredMemory, 'file'>): string {
  return [
    '---',
    `id: ${memory.id}`,
    `scope: ${memory.scope}`,
    memory.belongsTo ? `belongsTo: ${memory.belongsTo}` : '',
    memory.tags.length ? `tags: ${memory.tags.join(', ')}` : '',
    `createdAt: ${memory.createdAt}`,
    `updatedAt: ${memory.updatedAt}`,
    '---',
    memory.text,
    '',
  ].filter(Boolean).join('\n');
}

/** Every memory in one scope. */
export function listScope(scope: MemoryScope, belongsTo?: string): StoredMemory[] {
  const dir = scopeDir(scope, belongsTo);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parse(path.join(dir, f), scope))
    .filter((m): m is StoredMemory => m !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Everything that applies right now, narrowest scope last.
 *
 * Order matters when these are shown to the model: a session memory is the most
 * specific thing known and should be the last thing read, because when two
 * memories disagree the more specific one is almost always the current truth.
 */
export function applicable(cwd: string, sessionId?: string): StoredMemory[] {
  return [
    ...listScope('global'),
    ...listScope('project', cwd),
    ...(sessionId ? listScope('session', sessionId) : []),
  ];
}

export function remember(
  text: string,
  scope: MemoryScope,
  opts: { belongsTo?: string; tags?: string[] } = {},
): StoredMemory {
  const dir = scopeDir(scope, opts.belongsTo);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const id = makeId(text, dir);
  const memory: Omit<StoredMemory, 'file'> = {
    id, scope, text: text.trim(), tags: opts.tags ?? [],
    createdAt: now, updatedAt: now,
    belongsTo: scope === 'global' ? undefined : (opts.belongsTo ?? undefined),
  };
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, serialise(memory), 'utf8');
  return { ...memory, file };
}

/** Find one by id, looking through every scope that applies. */
export function findMemory(id: string, cwd: string, sessionId?: string): StoredMemory | undefined {
  const wanted = id.trim().toLowerCase();
  return applicable(cwd, sessionId).find(m => m.id.toLowerCase() === wanted);
}

export function updateMemory(memory: StoredMemory, text: string, tags?: string[]): StoredMemory {
  const next: Omit<StoredMemory, 'file'> = {
    ...memory, text: text.trim(), tags: tags ?? memory.tags, updatedAt: Date.now(),
  };
  fs.writeFileSync(memory.file, serialise(next), 'utf8');
  return { ...next, file: memory.file };
}

export function forgetMemory(memory: StoredMemory): void {
  fs.rmSync(memory.file, { force: true });
}

/** Memories whose text or tags mention every one of these words. */
export function searchMemories(query: string, cwd: string, sessionId?: string): StoredMemory[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return applicable(cwd, sessionId).filter(m => {
    const haystack = `${m.text} ${m.tags.join(' ')} ${m.id}`.toLowerCase();
    return words.every(w => haystack.includes(w));
  });
}
