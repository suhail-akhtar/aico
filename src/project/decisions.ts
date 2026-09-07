/**
 * `.aico/decisions.md` — the choices a build settled, kept where compaction
 * cannot lose them.
 *
 * A design decision made in turn three is exactly the thing the summary of
 * turns one to ten flattens into "implemented the feature". The file is the
 * fix: one line per decision, appended by the ordinary Write/Edit tools when
 * the model settles something, seeded by every template, and named in the
 * compaction summary so a later turn knows where to look. No tool, no model
 * call: a prefix bullet says to append, and the file is what survives.
 *
 * @module project/decisions
 */

import fs from 'fs';
import path from 'path';

export const DECISIONS_FILE = path.join('.aico', 'decisions.md');

export function decisionsPath(root: string): string {
  return path.join(root, DECISIONS_FILE);
}

/** The decision lines on file — bullets, not headings or prose. */
export function readDecisions(root: string): string[] {
  try {
    return fs.readFileSync(decisionsPath(root), 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l.startsWith('- '));
  } catch {
    return [];
  }
}

export function countDecisions(root: string): number {
  return readDecisions(root).length;
}

/** Create the file with its one-paragraph contract, if absent. Returns whether it was created. */
export function seedDecisions(root: string, title = path.basename(path.resolve(root))): boolean {
  const file = decisionsPath(root);
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `# Decisions — ${title}`,
    '',
    'One line per decision: what, and why. Append; do not edit old lines. Compaction',
    'keeps this file when it drops the transcript, so a decision written here survives',
    'a long build.',
    '',
  ].join('\n'), 'utf8');
  return true;
}

/** Append one decision line. Seeds the file first when it is missing. */
export function appendDecision(root: string, line: string): void {
  seedDecisions(root);
  const text = line.trim().replace(/^-\s*/, '');
  if (!text) return;
  fs.appendFileSync(decisionsPath(root), `- ${text}\n`, 'utf8');
}

/** The sentence the compaction summary carries, or empty when there is no file. */
export function decisionsNote(root: string): string {
  const n = countDecisions(root);
  return n > 0 ? `Decisions on file: ${DECISIONS_FILE.replace(/\\/g, '/')} (${n} line${n === 1 ? '' : 's'}). Read it before changing structure.` : '';
}

/** The one prefix bullet that makes the file get written. About forty tokens. */
export const DECISIONS_BULLET =
  '- When you settle a design choice while building — a table over a column, a library over the built-in, a boundary — append one line to `.aico/decisions.md` saying what and why. Compaction keeps that file when it drops the transcript.';
