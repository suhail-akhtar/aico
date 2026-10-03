/**
 * Before/after for a scoped AI edit's review: a word-level diff for text and
 * a cell-level comparison for tables. ADR 0024.
 *
 * The person accepts an AI edit only after seeing exactly what it changes, so
 * the preview must be honest at the level people read: words, not lines (a
 * one-comma fix in a long paragraph is one mark, not a red and a green wall),
 * and cells, not table source (re-padding a Markdown table changes every
 * line; the cells that changed are what matters).
 *
 * Hand-written LCS rather than the `diff` package: the web, desktop and VS
 * Code bundles do not carry it, the inputs are one part of a document
 * (bounded by `MAX_PART_CHARS`), and a token diff is forty lines. Above
 * {@link MAX_CELLS} token pairs it degrades to "all removed, all added"
 * rather than spending seconds on a pathological input.
 *
 * @module shared/ui/canvas/scoped-diff
 */

import type { TableModel } from './visual';

export interface DiffPart { op: '=' | '+' | '-'; text: string }

/** Largest LCS table computed (tokens × tokens). */
const MAX_CELLS = 2_500_000;

/** Words, the spaces between them and punctuation, as separate tokens — joined, they give back the text exactly. */
export function tokens(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

/** A word-level diff; consecutive parts with the same op are merged. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const x = tokens(a);
  const y = tokens(b);
  // Common prefix and suffix first: most edits touch a few words.
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const xm = x.slice(p, x.length - s);
  const ym = y.slice(p, y.length - s);
  const out: DiffPart[] = [];
  const push = (op: DiffPart['op'], text: string): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ op, text });
  };
  push('=', x.slice(0, p).join(''));
  if (xm.length * ym.length > MAX_CELLS) {
    push('-', xm.join(''));
    push('+', ym.join(''));
  } else {
    const n = xm.length;
    const m = ym.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = xm[i] === ym[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) { push('=', xm[i]!); i++; j++; } else if (L[i + 1]![j]! >= L[i]![j + 1]!) { push('-', xm[i]!); i++; } else { push('+', ym[j]!); j++; }
    }
    while (i < n) push('-', xm[i++]!);
    while (j < m) push('+', ym[j++]!);
  }
  push('=', x.slice(x.length - s).join(''));
  // A lone space between two changes reads better as part of them.
  return tidy(out);
}

function tidy(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (let k = 0; k < parts.length; k++) {
    const cur = parts[k]!;
    const prev = out[out.length - 1];
    const next = parts[k + 1];
    if (cur.op === '=' && /^\s+$/.test(cur.text) && prev && prev.op !== '=' && next && next.op !== '=') {
      // "- a" " " "+ b" " " "- c" → fold the space into both sides.
      out.push({ op: '-', text: cur.text }, { op: '+', text: cur.text });
      continue;
    }
    out.push({ ...cur });
  }
  // Re-merge and order each changed run as removed-then-added.
  const merged: DiffPart[] = [];
  let run: DiffPart[] = [];
  const flush = (): void => {
    const del = run.filter(r => r.op === '-').map(r => r.text).join('');
    const add = run.filter(r => r.op === '+').map(r => r.text).join('');
    if (del) merged.push({ op: '-', text: del });
    if (add) merged.push({ op: '+', text: add });
    run = [];
  };
  for (const part of out) {
    if (part.op === '=') { flush(); merged.push(part); } else run.push(part);
  }
  flush();
  return merged;
}

/** How much changed, for a one-line summary: words removed and added. */
export function diffStats(parts: readonly DiffPart[]): { removed: number; added: number } {
  const words = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  return {
    removed: parts.filter(p => p.op === '-').reduce((n, p) => n + words(p.text), 0),
    added: parts.filter(p => p.op === '+').reduce((n, p) => n + words(p.text), 0),
  };
}

export type CellState = 'same' | 'changed' | 'added';

export interface TableDiff {
  header: Array<{ text: string; state: CellState; was?: string }>;
  rows: Array<{ cells: Array<{ text: string; state: CellState; was?: string }>; state: 'same' | 'changed' | 'added' | 'moved' }>;
  removedRows: string[][];
  removedColumns: string[];
}

/**
 * Compare two tables cell by cell. Columns are matched by header text (so an
 * added column is one column, not a shift of every cell), rows by identical
 * content first (a sort shows rows as moved, not rewritten), then by position.
 */
export function tableDiff(a: TableModel, b: TableModel): TableDiff {
  const norm = (s: string): string => s.trim().toLowerCase();
  const usedCols = new Set<number>();
  const colOf = b.header.map((h, j) => {
    let i = a.header.findIndex((x, k) => !usedCols.has(k) && norm(x) === norm(h));
    if (i < 0 && a.header.length === b.header.length && !usedCols.has(j)) i = j;
    if (i >= 0) usedCols.add(i);
    return i;
  });
  const header = b.header.map((h, j) => {
    const i = colOf[j]!;
    if (i < 0) return { text: h, state: 'added' as const };
    return a.header[i] === h ? { text: h, state: 'same' as const } : { text: h, state: 'changed' as const, was: a.header[i]! };
  });
  const project = (r: string[]): string => JSON.stringify(colOf.map(i => (i < 0 ? null : (r[i] ?? '').trim())));
  const keyB = (r: string[]): string => JSON.stringify(colOf.map((i, j) => (i < 0 ? null : (r[j] ?? '').trim())));
  const used = new Set<number>();
  const rows = b.rows.map((r, j) => {
    const k = keyB(r);
    let i = a.rows.findIndex((x, n) => !used.has(n) && project(x) === k);
    if (i >= 0) {
      used.add(i);
      const cells = r.map((c, n) => ({ text: c, state: (colOf[n]! < 0 ? 'added' : 'same') as CellState }));
      return { cells, state: (i === j ? 'same' : 'moved') as 'same' | 'moved' };
    }
    i = !used.has(j) && j < a.rows.length ? j : -1;
    if (i < 0) return { cells: r.map(c => ({ text: c, state: 'added' as CellState })), state: 'added' as const };
    used.add(i);
    const old = a.rows[i]!;
    const cells = r.map((c, n) => {
      const ci = colOf[n]!;
      if (ci < 0) return { text: c, state: 'added' as CellState };
      const was = old[ci] ?? '';
      return was.trim() === c.trim() ? { text: c, state: 'same' as CellState } : { text: c, state: 'changed' as CellState, was };
    });
    return { cells, state: cells.some(c => c.state === 'changed') ? 'changed' as const : 'same' as const };
  });
  return {
    header, rows,
    removedRows: a.rows.filter((_, i) => !used.has(i)),
    removedColumns: a.header.filter((_, i) => !usedCols.has(i)),
  };
}
