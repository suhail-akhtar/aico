/**
 * What is known about the user — stable preferences with evidence, never
 * inferences about the person.
 *
 * `~/.aico/USER.md`: at most twelve bullets and 1,200 characters, rendered into
 * the cached prefix as its own memory section. Written only by adoption — a
 * proposal the user kept — and by the user's own editor. Capped at write *and*
 * at render, because a file that grows without bound is a prefix that grows
 * without bound, and the whole point of this section is that it is small.
 *
 * `fromUserSignals` looks across projects, once per session start, for the
 * things that repeat: a knowledge entry adopted in two projects with the same
 * trigger is a habit, not a project convention; a stack chosen in three
 * profiles is a preference. Each becomes a *global* proposal, not a line —
 * the user still decides.
 *
 * @module learning/user-model
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { aicoHome } from '../home.js';
import { loadProfile } from '../project/profile.js';
import { overlap, PROPOSAL_TTL_MS, type Proposal } from './extract.js';

export const USER_MODEL_MAX_LINES = 12;
export const USER_MODEL_MAX_CHARS = 1_200;

export function userModelPath(): string {
  return path.join(aicoHome(), 'USER.md');
}

/** The bullets on file, in order. Non-bullet lines are ignored on read. */
export function readUserModel(): string[] {
  try {
    return fs.readFileSync(userModelPath(), 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Apply the caps: newest last, oldest dropped first, total under the character budget. */
export function capUserModel(lines: string[]): string[] {
  let kept = lines.slice(-USER_MODEL_MAX_LINES);
  while (kept.length > 0 && kept.reduce((n, l) => n + l.length + 3, 0) > USER_MODEL_MAX_CHARS) kept = kept.slice(1);
  return kept;
}

export function writeUserModel(lines: string[]): string {
  const file = userModelPath();
  const capped = capUserModel(lines);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# About the user\n\n${capped.map(l => `- ${l}`).join('\n')}${capped.length ? '\n' : ''}`, 'utf8');
  return file;
}

/** Add one line, unless one nearly identical is there. Returns the file path. */
export function addUserModelLine(line: string): string {
  const current = readUserModel();
  const text = line.trim().replace(/^- /, '');
  if (!text) return userModelPath();
  if (current.some(l => overlap(l, text) >= 0.8)) return userModelPath();
  return writeUserModel([...current, text]);
}

/** The section as the prompt carries it, capped again in case the file was edited by hand. */
export function renderUserModel(lines = readUserModel()): string {
  const capped = capUserModel(lines);
  return capped.length ? capped.map(l => `- ${l}`).join('\n') : '';
}

// ── Cross-project signals ────────────────────────────────────────────────────

export interface KnowledgeSeen { projectRoot: string; trigger: string; content: string }

/**
 * Global proposals from what repeats across projects. Pure over what it is
 * given, so the harness can hand it three fake projects.
 */
export function fromUserSignals(
  projectRoots: string[],
  adoptedKnowledge: KnowledgeSeen[],
  now = Date.now(),
  existingLines: string[] = readUserModel(),
): Proposal[] {
  const out: Proposal[] = [];
  const make = (key: string, content: string, why: string): void => {
    if (existingLines.some(l => overlap(l, content) >= 0.8)) return;
    out.push({
      id: `user-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`,
      kind: 'user',
      content,
      why,
      needsEdit: false,
      evidence: { sessionId: 'global', seqs: [] },
      scope: 'global',
      status: 'open',
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
    });
  };

  // A stack chosen in two or more projects, per family of manifest.
  const stacks = new Map<string, Set<string>>();
  for (const root of projectRoots) {
    const p = loadProfile(root);
    if (!p.stack?.value) continue;
    const label = p.stack.value.replace(/\s*\([^)]*\)\s*$/, '').trim();
    stacks.set(label, (stacks.get(label) ?? new Set()).add(root));
  }
  for (const [label, roots] of stacks) {
    if (roots.size >= 2) {
      make(`stack:${label}`, `Prefers ${label} for new projects (seen in ${roots.size} projects).`,
        `${roots.size} projects' profiles record the same stack.`);
    }
  }

  // The same correction adopted in two or more projects is a habit.
  const byTrigger: Array<{ entry: KnowledgeSeen; roots: Set<string> }> = [];
  for (const k of adoptedKnowledge) {
    const group = byTrigger.find(g => overlap(`${g.entry.trigger} ${g.entry.content}`, `${k.trigger} ${k.content}`) >= 0.8);
    if (group) group.roots.add(k.projectRoot);
    else byTrigger.push({ entry: k, roots: new Set([k.projectRoot]) });
  }
  for (const g of byTrigger) {
    if (g.roots.size >= 2) {
      make(`rule:${g.entry.trigger}`, `${g.entry.content.replace(/\s+/g, ' ').trim().slice(0, 160)} (kept in ${g.roots.size} projects)`,
        'The same correction was kept as knowledge in more than one project; as a line about you it applies everywhere.');
    }
  }
  return out;
}
