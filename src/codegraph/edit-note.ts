/**
 * "You changed an exported symbol; these files use it and have not been
 * touched yet" — appended to the `Edit`/`Write` result, in the loop.
 *
 * ## Why in the loop
 *
 * The failure the Phase 0 benchmark kept circling was not finding callers in
 * the first place — it was *missing some*: the ones behind a `money` alias, a
 * barrel, a namespace import. A tool the model has to remember to call does
 * not catch that (graph tools were called in a minority of runs); a prompt
 * rule saying "check your callers" is a request. The moment the risk exists
 * is the moment an exported signature changes, and the write path is where
 * that moment is visible. So the check runs there (AGENTS.md §4.6).
 *
 * ## What counts
 *
 * Before the write, the file's exported declarations are parsed (one file,
 * milliseconds); after it, again. A symbol that disappeared, or whose
 * declaration header (parameters, return type) changed, is a changed API.
 * Its users come from the graph — resolved through aliases and re-exports,
 * same-named symbols elsewhere excluded — and a user counts as handled if this
 * run has written it or it changed on disk since the turn began (a `sed` or a
 * codemod through Bash counts too).
 *
 * ## What it deliberately does not do
 *
 * - Block anything. It is a note; a multi-step change is legitimately
 *   incomplete between steps.
 * - Repeat itself: once per symbol and signature per run.
 * - Wait for a graph. If none is ready within a short budget the note is
 *   skipped and the graph keeps building for the next time.
 * - Speak for re-exports on a signature change: an `export *` barrel needs no
 *   edit when a parameter is added; on a rename or removal, named re-exports
 *   are listed too.
 *
 * @module codegraph/edit-note
 */

import fs from 'node:fs';
import path from 'node:path';
import { runScoped } from '../run-scoped.js';
import { currentCwd } from '../run-context.js';
import { danglingUsers, getCodeGraph, findFile, peekCodeGraph, symbolUsers } from './index.js';
import { langOf, parseSource } from './parse/index.js';
import { keyOf } from './paths.js';
import type { CodeGraph, ExportDecl } from './types.js';

const GRAPH_BUDGET_MS = 4_000;
const MAX_LISTED = 12;

interface NoteState {
  startedAt: number;
  touched: Set<string>;
  noted: Set<string>;
  before: Map<string, ExportDecl[]>;
}

const state = runScoped<NoteState>(() => ({ startedAt: Date.now(), touched: new Set(), noted: new Set(), before: new Map() }));

/** Start of a turn: nothing touched, nothing noted. */
export function resetEditNotes(): void {
  state.reset();
}

const absKey = (file: string): string => keyOf(path.resolve(currentCwd(), file));

function exportedDecls(file: string): ExportDecl[] | undefined {
  const lang = langOf(file);
  if (!lang) return undefined;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1_000_000) return undefined;
    return parseSource(fs.readFileSync(file, 'utf8'), lang).exports.filter(e => !e.internal);
  } catch {
    return undefined;
  }
}

/** Before a write: remember the file's exported declarations. */
export function beforeWrite(file: string): void {
  const abs = path.resolve(currentCwd(), file);
  const decls = exportedDecls(abs);
  if (decls) state.get().before.set(keyOf(abs), decls);
}

/** Any file this run wrote (Edit, Write, a refactor apply…). */
export function noteTouched(file: string): void {
  state.get().touched.add(absKey(file));
}

export interface ChangedSymbol { name: string; change: 'signature' | 'removed'; before: string; after?: string }

/** Exported declarations that disappeared or changed header between two parses. Pure. */
export function changedSymbols(before: ExportDecl[], after: ExportDecl[]): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  for (const b of before) {
    const a = after.find(x => x.name === b.name);
    if (!a) out.push({ name: b.name, change: 'removed', before: b.sig });
    else if (a.sig !== b.sig) out.push({ name: b.name, change: 'signature', before: b.sig, after: a.sig });
  }
  return out;
}

async function graphWithin(root: string, ms: number): Promise<CodeGraph | undefined> {
  // A graph already in memory was read before this write — exactly the state whose users
  // matter — so it answers at once; a refresh runs behind it for next time.
  const held = peekCodeGraph(root);
  const pending = getCodeGraph(root).catch(() => undefined);
  if (held) return held;
  return Promise.race([pending, new Promise<undefined>(r => setTimeout(() => r(undefined), ms).unref?.())]);
}

/** Co-change partners worth a hint: often and mostly changed together, no import between them. */
const COCHANGE_MIN_COUNT = 3;
const COCHANGE_MIN_CONFIDENCE = 0.6;

/** After a write: the note to append, or undefined. Never throws. */
export async function afterWrite(file: string): Promise<string | undefined> {
  try {
    const st = state.get();
    const abs = path.resolve(currentCwd(), file);
    const key = keyOf(abs);
    st.touched.add(key);
    const before = st.before.get(key);
    st.before.delete(key);
    const root = currentCwd();
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !langOf(abs)) return undefined;
    const after = before?.length ? exportedDecls(abs) ?? [] : [];
    const changed = before?.length
      ? changedSymbols(before, after).filter(c => !st.noted.has(`${key}#${c.name}#${c.after ?? 'removed'}`))
      : [];

    // Only a changed API is worth waiting for a graph; the co-change hint uses one if it is ready.
    // Only a changed API is worth waiting for a graph. An ordinary write uses one if it is in
    // memory, and otherwise starts one only in a git repository — the co-change hint needs
    // history, and a folder with none is often a scratch or test folder that is about to be
    // deleted (on Windows a git child sitting in it keeps it from being removed).
    const g = changed.length ? await graphWithin(root, GRAPH_BUDGET_MS) : peekOrWarm(root);
    if (!g) return undefined;
    const id = findFile(g, rel.split(path.sep).join('/')).id;
    if (id === undefined) return undefined;
    const untouched = (fileId: number): boolean => {
      const userAbs = path.join(g.root, g.files[fileId]!.path);
      if (st.touched.has(keyOf(userAbs))) return false;
      try { return fs.statSync(userAbs).mtimeMs <= st.startedAt; } catch { return false; }
    };

    const notes: string[] = [];
    for (const c of changed) {
      st.noted.add(`${key}#${c.name}#${c.after ?? 'removed'}`);
      // A graph read before the write still has the symbol; one read after it has the
      // bindings that now name nothing.
      const known = symbolUsers(g, id, c.name);
      const users = (known.length ? known : c.change === 'removed' ? danglingUsers(g, id, c.name) : [])
        .filter(u => c.change === 'removed' || u.via !== 'reexport');
      const pending = users.filter(u => untouched(u.file));
      if (!pending.length) continue;
      const shown = pending.slice(0, MAX_LISTED).map(u => {
        const f = g.files[u.file]!.path;
        const alias = u.local !== c.name ? ` as ${u.local}` : '';
        return `${f}${u.lines[0] ? `:${u.lines[0]}` : ''}${alias}`;
      });
      const what = c.change === 'removed' ? 'was removed or renamed' : 'changed its signature';
      notes.push(`\`${c.name}\` ${what}; ${users.length} file(s) use it and ${pending.length} have not been changed in this turn: ${shown.join(', ')}${pending.length > shown.length ? `, … ${pending.length - shown.length} more` : ''}.`);
    }
    const parts: string[] = [];
    if (notes.length) {
      parts.push(`Code graph check (imports resolved through aliases and re-exports; same-named symbols elsewhere excluded):\n${notes.join('\n')}\nCodeGraph {"action":"impact","target":"${g.files[id]!.path}#<name>"} lists every user with its line.`);
    }

    // Files that history says change with this one, though nothing imports between them —
    // the relation no import graph and no text search shows (ADR 0028).
    const coKey = `${key}#cochange`;
    if (!st.noted.has(coKey)) {
      st.noted.add(coKey);
      const linked = new Set(g.edges.filter(e => e.from === id || e.to === id).map(e => (e.from === id ? e.to : e.from)));
      const partners = g.cochange
        .filter(c => (c.a === id || c.b === id) && c.count >= COCHANGE_MIN_COUNT && c.confidence >= COCHANGE_MIN_CONFIDENCE)
        .map(c => ({ other: c.a === id ? c.b : c.a, c }))
        .filter(x => !linked.has(x.other) && untouched(x.other))
        .slice(0, 3);
      if (partners.length) {
        parts.push(`Git history: ${partners.map(x => `${g.files[x.other]!.path} changed in ${x.c.count} of the commits that changed ${g.files[id]!.path} (${Math.round(x.c.confidence * 100)}%)`).join('; ')} — and no import links them. If this change has a counterpart there, it has not been made yet.`);
      }
    }
    return parts.length ? `\n\n${parts.join('\n\n')}` : undefined;
  } catch {
    // A note is advice. Failing to compute it must never fail the write.
    return undefined;
  }
}

/** The graph in memory; if none and this is a git repository, start one for the next write. */
function peekOrWarm(root: string): CodeGraph | undefined {
  const held = peekCodeGraph(root);
  if (!held && fs.existsSync(path.join(root, '.git'))) void getCodeGraph(root).catch(() => undefined);
  return held;
}

/**
 * After a Read of a source file: in a git repository with no graph in memory, start one.
 * Reading comes before editing (tools/observation enforces it), so this is the moment that
 * makes the graph ready for the first edit's co-change hint without delaying anything.
 */
export function afterRead(file: string): void {
  try {
    const root = currentCwd();
    const abs = path.resolve(root, file);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !langOf(abs)) return;
    peekOrWarm(root);
  } catch { /* advice only */ }
}
