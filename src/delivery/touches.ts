/**
 * Which files a task will touch, guessed before it starts and corrected as it runs,
 * and the one rule that uses the answer: two tasks that touch the same file do not
 * run at the same time (ADR 0038).
 *
 * WHY THIS AND NOTHING ELSE. GitHub's account of agent-scale development is "coordinate
 * only what needs agreement": parallel writers on independent tasks need to agree about
 * exactly one thing, whether they will edit the same files. Everything else — style,
 * design, who does what — is left alone. A prediction is enough because a wrong one is
 * cheap in both directions: a false overlap only delays a task; a missed overlap is
 * still caught by the rebase conflict at the merge queue, which sends it back for a fix.
 *
 * The prediction reads the task's own text with the code graph (ADR 0028): paths named
 * in the title, body, acceptance criteria and labels (a label that is a folder means
 * every file under it), and identifiers that are exported symbols of an indexed file
 * (the symbol's file counts). Without a graph (not a code project, or it cannot be
 * built) only paths that exist on disk are used. It is marked `predicted: true` so a
 * client can say "expected", not "will". As a run edits, actual files from git replace
 * it (`actualTouches`).
 *
 * Deliberately not here: any use of the model. A prediction the engine can make from
 * the graph is free and deterministic.
 *
 * @module delivery/touches
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Task } from './types.js';

const FILE_LIKE = /(?:[\w@.-]+[\\/])*[\w@.-]+\.[A-Za-z0-9]{1,6}\b/g;
const IDENT = /\b[A-Za-z_$][\w$]{3,}\b/g;
const MAX_FILES = 200;
const MAX_SYMBOLS = 40;

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** The text a prediction reads: everything a person wrote about the task. */
function textOf(t: Pick<Task, 'title' | 'body' | 'acceptance' | 'labels'>): string {
  return [t.title, t.body, ...t.acceptance, ...t.labels].join('\n');
}

/** Labels that name a place (`src/auth`, `web/src/App.tsx`) rather than a topic (`bug`). */
function pathLabels(labels: readonly string[]): string[] {
  return labels.map(norm).filter(l => l.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(l));
}

export async function predictTouches(
  project: string,
  task: Pick<Task, 'title' | 'body' | 'acceptance' | 'labels'>,
  opts: { graph?: boolean } = {},
): Promise<NonNullable<Task['touches']>> {
  const text = textOf(task);
  const files = new Set<string>();
  const symbols = new Set<string>();

  let graph: import('../codegraph/types.js').CodeGraph | undefined;
  if (opts.graph !== false) {
    try {
      const { getCodeGraph } = await import('../codegraph/index.js');
      graph = await getCodeGraph(project);
    } catch { /* no graph: paths that exist on disk still count */ }
  }
  const known = graph ? graph.files.map(f => ({ id: f.id, path: norm(f.path), exports: f.exports })) : [];

  const named = new Set<string>();
  for (const m of text.matchAll(FILE_LIKE)) named.add(norm(m[0]));
  for (const l of pathLabels(task.labels)) named.add(l);

  for (const candidate of named) {
    const bare = candidate.replace(/\/+$/, '');
    // A folder (label or mention): every indexed file under it.
    const under = known.filter(f => f.path === bare || f.path.startsWith(`${bare}/`));
    if (under.length > 0) { for (const f of under) files.add(f.path); continue; }
    // A file named by a suffix of its path ("App.tsx", "auth/session.ts").
    const suffix = known.filter(f => f.path === bare || f.path.endsWith(`/${bare}`));
    if (suffix.length > 0 && suffix.length <= 5) { for (const f of suffix) files.add(f.path); continue; }
    // No graph or not indexed: it counts if it is there.
    try {
      const abs = path.resolve(project, bare);
      const rel = path.relative(project, abs);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(abs)) {
        if (fs.statSync(abs).isDirectory()) continue;
        files.add(norm(rel));
      }
    } catch { /* unreadable: not a touch */ }
  }

  if (known.length > 0) {
    const byName = new Map<string, string[]>();
    for (const f of known) for (const e of f.exports) {
      if (e.internal || e.name.length < 4) continue;
      const list = byName.get(e.name) ?? [];
      list.push(f.path);
      byName.set(e.name, list);
    }
    for (const m of text.matchAll(IDENT)) {
      const where = byName.get(m[0]);
      // An identifier many files export is a word, not a pointer.
      if (!where || where.length > 3 || symbols.size >= MAX_SYMBOLS) continue;
      symbols.add(m[0]);
      for (const p of where) files.add(p);
    }
  }

  return { files: [...files].sort().slice(0, MAX_FILES), symbols: [...symbols].sort(), predicted: true };
}

/** The files a branch changed against its base — what a run actually touched. */
export function actualTouches(files: readonly string[], symbols: readonly string[] = []): NonNullable<Task['touches']> {
  return { files: [...new Set(files.map(norm))].sort().slice(0, 500), symbols: [...symbols], predicted: false };
}

/** The first file two touch sets share, or undefined. An empty set overlaps nothing. */
export function overlap(a: Task['touches'] | undefined, b: Task['touches'] | undefined): string | undefined {
  if (!a?.files.length || !b?.files.length) return undefined;
  const set = new Set(a.files.map(f => f.toLowerCase()));
  return b.files.find(f => set.has(f.toLowerCase()));
}
