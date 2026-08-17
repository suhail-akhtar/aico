import { readFile as fsReadFile, appendFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { MemoryType, MemoryEntry, MemoryReadOptions, MemoryReadResult } from './types.js';
import { getCached, setCached, getCacheStats } from './cache.js';
import { watchMemoryFile } from './watcher.js';
import { currentCwd } from '../run-context.js';

const DEFAULT_MAX_SIZE = 50_000;

async function tryRead(filePath: string): Promise<string | null> {
  try {
    const content = await fsReadFile(filePath, 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function loadEntry(
  type: MemoryType,
  filePath: string,
  opts: MemoryReadOptions,
  watchFiles: boolean,
): Promise<MemoryEntry | null> {
  if (!opts.forceRefresh) {
    const cached = getCached(filePath);
    if (cached) return cached;
  }

  const content = await tryRead(filePath);
  if (!content) return null;

  const maxSize = opts.maxSizePerType ?? DEFAULT_MAX_SIZE;
  const trimmedContent = content.length > maxSize
    ? content.slice(0, maxSize) + `\n... [truncated — ${Math.round((content.length - maxSize) / 1024)}KB removed]`
    : content;

  const entry: MemoryEntry = { type, path: filePath, content: trimmedContent, loadedAt: Date.now() };
  setCached(filePath, entry);

  if (watchFiles && existsSync(filePath)) {
    watchMemoryFile(filePath);
  }

  return entry;
}

async function loadParentEntries(
  cwd: string,
  opts: MemoryReadOptions,
  watchFiles: boolean,
): Promise<MemoryEntry[]> {
  const results: MemoryEntry[] = [];
  let current = path.dirname(cwd);
  const root = path.parse(current).root;

  while (current !== root) {
    const filePath = path.join(current, 'CLAUDE.md');
    const entry = await loadEntry('parent', filePath, opts, watchFiles);
    if (entry) results.unshift(entry);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return results;
}

async function loadRulesEntries(
  cwd: string,
  opts: MemoryReadOptions,
  watchFiles: boolean,
): Promise<MemoryEntry[]> {
  const rulesDir = path.join(cwd, '.aico', 'rules');
  try {
    const files = await readdir(rulesDir);
    const mdFiles = files.filter((f) => f.endsWith('.md')).sort();
    const results: MemoryEntry[] = [];
    for (const file of mdFiles) {
      const filePath = path.join(rulesDir, file);
      const entry = await loadEntry('rules', filePath, opts, watchFiles);
      if (entry) results.push(entry);
    }
    return results;
  } catch {
    return [];
  }
}

function formatSections(sections: MemoryEntry[], cwd: string): string {
  const lines: string[] = [];
  for (const s of sections) {
    let label: string;
    switch (s.type) {
      case 'user':    label = `## User Memory (~/.aico/AICO.md)`; break;
      case 'parent': {
        const rel = path.relative(os.homedir(), s.path);
        label = `## Parent Directory Memory (${rel})`;
        break;
      }
      case 'rules': {
        const rel = path.relative(cwd, s.path);
        label = `## Project Rule (${rel})`;
        break;
      }
      case 'project': label = `## Project Memory (AICO.md)`; break;
      case 'local':   label = `## Local Memory (AICO.local.md)`; break;
    }
    lines.push(`${label}\n${s.content}`);
  }
  return lines.join('\n\n');
}

export async function loadMemory(opts: MemoryReadOptions = {}): Promise<MemoryReadResult> {
  const cwd = currentCwd();
  const watchFiles = true; // always watch when loading
  const allowedTypes = new Set<MemoryType>(opts.types ?? ['user', 'parent', 'rules', 'project', 'local']);

  const sections: MemoryEntry[] = [];

  // 1. User global instructions
  if (allowedTypes.has('user')) {
    const homeAicoMd = path.join(os.homedir(), '.aico', 'AICO.md');
    const homeLegacyMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
    const userEntry =
      await loadEntry('user', homeAicoMd, opts, watchFiles) ??
      await loadEntry('user', homeLegacyMd, opts, watchFiles);
    if (userEntry) sections.push(userEntry);
  }

  // 2. Parent directories
  if (allowedTypes.has('parent')) {
    const parentEntries = await loadParentEntries(cwd, opts, watchFiles);
    sections.push(...parentEntries);
  }

  // 3. .aico/rules/*.md
  if (allowedTypes.has('rules')) {
    const ruleEntries = await loadRulesEntries(cwd, opts, watchFiles);
    sections.push(...ruleEntries);
  }

  // 4. Project memory (AICO.md / CLAUDE.md)
  if (allowedTypes.has('project')) {
    const projectEntry =
      await loadEntry('project', path.join(cwd, 'AICO.md'), opts, watchFiles) ??
      await loadEntry('project', path.join(cwd, 'CLAUDE.md'), opts, watchFiles);
    if (projectEntry) sections.push(projectEntry);
  }

  // 5. Local memory (AICO.local.md)
  if (allowedTypes.has('local')) {
    const localEntry = await loadEntry('local', path.join(cwd, 'AICO.local.md'), opts, watchFiles);
    if (localEntry) sections.push(localEntry);
  }

  const formatted = formatSections(sections, cwd);
  const cacheStats = getCacheStats();

  return { sections, formatted, cacheStats };
}

/** Drop-in replacement for old readMemory() — same string return */
export async function readMemory(opts?: MemoryReadOptions): Promise<string> {
  const result = await loadMemory(opts);
  return result.formatted;
}

export async function appendToMemory(content: string, type: 'user' | 'project'): Promise<void> {
  let filePath: string;
  if (type === 'user') {
    const dir = path.join(os.homedir(), '.aico');
    await mkdir(dir, { recursive: true });
    filePath = path.join(dir, 'AICO.md');
  } else {
    filePath = path.join(currentCwd(), 'AICO.md');
  }
  await appendFile(filePath, `\n${content}\n`);
}
