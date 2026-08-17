import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Skill, SkillFrontmatter } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse a skill markdown file with YAML frontmatter.
 * Uses regex-based parsing — no extra dependencies.
 *
 * Format:
 * ```markdown
 * ---
 * name: commit
 * description: Generate a conventional commit message
 * aliases: [cm]
 * ---
 * Prompt template body here. {args} is replaced with user-provided arguments.
 * ```
 */
export function parseSkillFile(content: string, filePath: string, isBuiltin: boolean): Skill | null {
  // Normalize CRLF → LF so the frontmatter regex works regardless of the
  // file's line endings (Windows checkout converts LF to CRLF via git).
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;

  const fmRaw = fmMatch[1];
  const promptTemplate = fmMatch[2].trim();

  // Parse simple YAML key: value pairs
  const fm: Record<string, unknown> = {};
  for (const line of fmRaw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Handle YAML inline arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      // Strip surrounding quotes if present
      fm[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  if (!fm['name'] || !fm['description']) return null;

  const frontmatter: SkillFrontmatter = {
    name: String(fm['name']),
    description: String(fm['description']),
    trigger: fm['trigger'] ? String(fm['trigger']) : undefined,
    aliases: Array.isArray(fm['aliases']) ? (fm['aliases'] as string[]) : undefined,
    author: fm['author'] ? String(fm['author']) : undefined,
    version: fm['version'] ? String(fm['version']) : undefined,
  };

  return { frontmatter, promptTemplate, filePath, isBuiltin };
}

/**
 * Locate the built-in skills directory.
 *
 * The path depends on how the code was loaded, and a single hard-coded guess
 * was wrong for the shipped build: the bundler flattens modules into the output
 * root, so `__dirname` is `dist/` rather than `dist/skills/`, and the built-ins
 * copied to `dist/skills/builtin` were never found. Nothing reported it —
 * missing skills look exactly like an installation with no skills.
 *
 * So the candidates are tried in order and the first that exists wins. Running
 * from source is included last so `tsx src/index.ts` behaves like the build.
 */
export function getBuiltinDir(): string {
  const candidates = [
    path.join(__dirname, 'builtin'),               // bundled: dist/builtin
    path.join(__dirname, 'skills', 'builtin'),     // bundled with the copy step
    path.join(__dirname, '..', 'skills', 'builtin'),
    path.join(__dirname, '..', '..', 'src', 'skills', 'builtin'),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

/** Discover all .md skill files in a directory (non-recursive) */
export async function discoverSkillFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Load all skills from a directory */
export async function loadSkillsFromDir(dir: string, isBuiltin: boolean): Promise<Skill[]> {
  const files = await discoverSkillFiles(dir);
  const skills: Skill[] = [];

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, 'utf8');
      const skill = parseSkillFile(content, filePath, isBuiltin);
      if (skill) skills.push(skill);
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

/** Load all skills from builtin + user + project dirs */
export async function loadAllSkills(opts: {
  disableBuiltins?: boolean;
  extraDirs?: string[];
}): Promise<Skill[]> {
  const all: Skill[] = [];

  if (!opts.disableBuiltins) {
    const builtinSkills = await loadSkillsFromDir(getBuiltinDir(), true);
    all.push(...builtinSkills);
  }

  // Extra dirs from settings (e.g. ~/.aico/skills/)
  for (const dir of opts.extraDirs ?? []) {
    const extra = await loadSkillsFromDir(dir, false);
    all.push(...extra);
  }

  return all;
}
