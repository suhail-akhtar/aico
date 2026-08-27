/**
 * Where knowledge entries live, and how they are read and written.
 *
 * Two directories, and the split matters. `~/.aico/knowledge/` holds entries
 * that travel with the person — house style, things they always want. A
 * project's `.aico/knowledge/` holds entries that travel with the code, and so
 * can be committed and shared with everyone working on it. An entry in the
 * wrong one is a convention followed in the wrong place, which is a failure
 * nobody can see from the transcript.
 *
 * Markdown with frontmatter, because that is what the rest of AICO uses for
 * authored content — skills, agents, memory — and because a knowledge base
 * that can only be edited through a tool is one that quietly stops being
 * maintained.
 *
 * @module knowledge/store
 */

import { readFile, readdir, writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { KnowledgeEntry } from './types.js';

const GLOBAL_DIR = path.join(os.homedir(), '.aico', 'knowledge');
const PROJECT_SUBDIR = path.join('.aico', 'knowledge');

/** Guard against a single runaway file crowding out everything else. */
const MAX_ENTRY_BYTES = 8_000;

function projectDir(root: string): string {
  return path.join(root, PROJECT_SUBDIR);
}

/**
 * Parse one file into an entry, or nothing.
 *
 * A file with no trigger is skipped rather than treated as always-on. Silently
 * promoting it would make it a rule nobody wrote, applied everywhere, which is
 * the opposite of what this store is for — and `AICO.md` is where an always-on
 * rule belongs anyway.
 */
export function parseEntry(id: string, filePath: string, raw: string): KnowledgeEntry | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return undefined;

  const frontmatter = match[1] ?? '';
  const content = (match[2] ?? '').trim();
  if (!content) return undefined;

  const field = (name: string): string | undefined => {
    const found = new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(frontmatter);
    return found?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  };

  const trigger = field('trigger');
  if (!trigger) return undefined;

  const scope = field('scope');
  return {
    id,
    trigger,
    content,
    path: filePath,
    ...scope && scope !== 'all' ? { scope } : {},
  };
}

async function readDirectory(dir: string): Promise<KnowledgeEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries: KnowledgeEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.join(dir, name);
    try {
      const raw = await readFile(filePath, 'utf8');
      if (raw.length > MAX_ENTRY_BYTES) continue;
      const entry = parseEntry(name.replace(/\.md$/, ''), filePath, raw);
      if (entry) entries.push(entry);
    } catch {
      // One unreadable file is not worth failing the whole store over.
    }
  }
  return entries;
}

/**
 * Every entry available here.
 *
 * Project entries come last so that, where two share an id, the project's wins
 * — the more specific statement about a place should beat the general one.
 */
export async function loadKnowledge(projectRoot?: string): Promise<KnowledgeEntry[]> {
  const global = await readDirectory(GLOBAL_DIR);
  const local = projectRoot ? await readDirectory(projectDir(projectRoot)) : [];
  const byId = new Map<string, KnowledgeEntry>();
  for (const entry of [...global, ...local]) byId.set(entry.id, entry);
  return [...byId.values()];
}

/** Write an entry, in the global store or a project's. */
export async function saveKnowledge(input: {
  id: string;
  trigger: string;
  content: string;
  projectRoot?: string;
}): Promise<string> {
  const safeId = input.id.replace(/[^\w-]/g, '-').slice(0, 60) || 'entry';
  const dir = input.projectRoot ? projectDir(input.projectRoot) : GLOBAL_DIR;
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeId}.md`);
  const body = [
    '---',
    `trigger: ${input.trigger.replace(/\r?\n/g, ' ').trim()}`,
    ...input.projectRoot ? [`scope: ${input.projectRoot}`] : [],
    '---',
    '',
    input.content.trim(),
    '',
  ].join('\n');
  await writeFile(filePath, body, 'utf8');
  return filePath;
}

/** Remove an entry by id. Returns whether one was there to remove. */
export async function deleteKnowledge(id: string, projectRoot?: string): Promise<boolean> {
  for (const dir of [projectRoot ? projectDir(projectRoot) : undefined, GLOBAL_DIR]) {
    if (!dir) continue;
    try {
      await rm(path.join(dir, `${id.replace(/[^\w-]/g, '-')}.md`));
      return true;
    } catch {
      // Not in this directory; try the next.
    }
  }
  return false;
}
