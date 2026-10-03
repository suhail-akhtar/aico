/**
 * The layout decisions an export makes from the *content* of a document —
 * table column widths, what kind of table a table is, heading numbers, typed
 * numbers to remove — as pure functions over plain strings, shared by the Word
 * writer, the HTML/PDF writer and the editor page.
 *
 * ## Why column widths are computed, not split evenly
 *
 * The owner's 55-page proposal had every table's columns the same width: an
 * "ID" column holding "FR-03" was as wide as the requirement text beside it,
 * and "Office Online Server" wrapped onto three lines in a narrow role column.
 * Word's own autofit fixes that only when someone opens the file and asks it
 * to, and a PDF printer never does. So widths follow the classic automatic
 * table layout (the one browsers use): each column needs at least its longest
 * word and would like its longest cell; columns get their wish when everything
 * fits, otherwise their minimum plus a share of the rest in proportion to how
 * much more they wanted. Short-code columns end up narrow, prose columns wide.
 *
 * ## Why table "variants"
 *
 * A requirements grid, a "Setting | Value" specification and a RACI matrix are
 * different instruments and a reader expects them to look different: the
 * label column of a key-value table is shaded, a matrix's single-letter cells
 * are centred, money columns are right-aligned, a "Total" row is ruled. These
 * are recognised from the cells, so neither the author nor the model has to
 * mark them up.
 *
 * ## Why typed heading numbers are removed
 *
 * Models (and people) type "2.4 Non-functional requirements" into a heading.
 * Exported with real Word numbering that reads "2.4 2.4 Non-functional…"; left
 * as text it is numbering Word cannot renumber when a section moves. A typed
 * number is only removed when it has a dot ("1.", "2.4") — "3 Pillars of
 * Growth" and "2026 Roadmap" are titles, not numbers.
 *
 * DOM-free and Node-importable.
 *
 * @module shared/ui/canvas/doc-layout
 */

import type { NumberingScheme } from './doc-blueprints';

// ── Headings ─────────────────────────────────────────────────────────

const TYPED_NUMBER = /^\s*(?:(?:section|clause)\s+)?(\d{1,2}(?:\.\d{1,2}){0,4}\.?|\d{1,2}(?:\.\d{1,2}){1,4})[)\s]\s*/i;
const APPENDIX = /^\s*(?:appendix|annex|schedule)\s+([A-Z]|\d{1,2})\b\s*[:.—–-]?\s*/i;

/** A heading's text with a typed section number removed ("2.4 Scope" → "Scope"); unchanged when there is none. */
export function stripHeadingNumber(text: string): string {
  const m = TYPED_NUMBER.exec(text);
  if (!m) return text;
  const num = m[1]!;
  // "3 Pillars" and "2026 Roadmap" are titles: a section number has a dot.
  if (!num.includes('.')) return text;
  const rest = text.slice(m[0].length);
  return rest.trim() ? rest : text;
}

/** Does the heading carry a typed number? */
export function hasHeadingNumber(text: string): boolean {
  return stripHeadingNumber(text) !== text;
}

/** "Appendix A — Bill of materials" → { label: 'A', rest: 'Bill of materials' }. */
export function appendixHeading(text: string): { letter: string; rest: string } | undefined {
  const m = APPENDIX.exec(text);
  if (!m) return undefined;
  const raw = m[1]!;
  const letter = /^\d+$/.test(raw) ? String.fromCharCode(64 + Math.min(26, Math.max(1, Number(raw)))) : raw.toUpperCase();
  return { letter, rest: text.slice(m[0].length).trim() };
}

/**
 * Most of the top-level headings carry typed numbers — the author numbered the
 * document by hand, so the export should number it (and drop the typed ones).
 */
export function typedNumbering(topLevelTexts: string[]): boolean {
  const body = topLevelTexts.filter(t => !appendixHeading(t));
  if (body.length < 2) return false;
  const typed = body.filter(hasHeadingNumber).length;
  return typed / body.length >= 0.6;
}

export interface HeadingSlot {
  /** Logical level, 1 = a top-level section. */
  level: number;
  /** A top-level "Appendix X" heading (X is the letter). */
  appendix?: string;
  /** Shown without a number and not counted (an academic Abstract or References). */
  unnumbered?: boolean;
}

/** Sections that stand outside the numbering in a paper: Abstract, References, Acknowledgements. */
export const UNNUMBERED_SECTIONS = /^\s*(abstract|references|bibliography|works cited|acknowledge?ments?)\s*$/i;

/**
 * The number each heading shows, by scheme: `decimal` 1 · 1.1 · 1.1.1,
 * `legal` 1. · 1.1 · (a), appendices A · A.1. Levels deeper than 4 (decimal)
 * or 3 (legal) are not numbered — Word's own numbering is built to the same
 * depth (`src/canvas/docx.ts`), so the two agree.
 */
export function headingLabels(slots: HeadingSlot[], scheme: NumberingScheme): (string | undefined)[] {
  if (scheme === 'none') return slots.map(() => undefined);
  const counters = [0, 0, 0, 0];
  const app = [0, 0, 0];
  let inAppendix: string | undefined;
  let outside = false;
  return slots.map((s) => {
    if (s.level === 1 && s.appendix) {
      inAppendix = s.appendix;
      outside = false;
      app.fill(0);
      return `Appendix ${s.appendix}`;
    }
    if (s.level === 1) { inAppendix = undefined; outside = Boolean(s.unnumbered); }
    // An unnumbered section's subsections are unnumbered too (Word: numbering removed on each).
    if (s.unnumbered || outside) return undefined;
    if (inAppendix) {
      if (s.level > 3) return undefined;
      app[s.level - 1]!++;
      app.fill(0, s.level);
      return [inAppendix, ...app.slice(1, s.level)].join('.');
    }
    const depth = scheme === 'legal' ? 3 : 4;
    if (s.level > depth) return undefined;
    counters[s.level - 1]!++;
    counters.fill(0, s.level);
    if (scheme === 'legal') {
      if (s.level === 1) return `${counters[0]}.`;
      if (s.level === 2) return `${counters[0]}.${counters[1]}`;
      return `(${String.fromCharCode(96 + Math.min(26, counters[2]!))})`;
    }
    return counters.slice(0, s.level).join('.');
  });
}

// ── Tables ───────────────────────────────────────────────────────────

export type TableVariant = 'grid' | 'keyvalue' | 'matrix';

const NUMERIC = /^[-−+]?\s*[£$€¥₹]?\s*[-−+]?\d[\d,.\s]*(%|k|m|bn|[a-z]{0,3})?$/i;
const MATRIX_CELL = /^(?:[RACIVS](?:\s*[/,]\s*[RACIVS])*|[✓✔✗✘×●○◐•–—-]|yes|no|y|n|x|n\/a)$/i;

const len = (s: string): number => [...s.trim()].length;

/**
 * Width of text in "average lowercase letters": capitals and digits are wider
 * than the lowercase a character count assumes ("NFR-01" needs room for six
 * wide glyphs — counted as six letters it wrapped to "NFR-/01" in Word),
 * i, l, t, punctuation and spaces narrower.
 */
export function textUnits(s: string): number {
  let u = 0;
  for (const ch of s) {
    if (/[mwMW@%]/.test(ch)) u += 1.5;
    else if (/[A-Z]/.test(ch)) u += 1.3;
    else if (/[0-9£$€#&]/.test(ch)) u += 1.12;
    else if (/[ilj.,:;'|!()[\]\-/ft\s]/.test(ch)) u += 0.62;
    else u += 1;
  }
  return u;
}

/** The widest piece a line cannot break inside: a word, or (for a number, money, a date) the whole cell. */
function unbreakable(s: string): number {
  const t = s.trim();
  if (NUMERIC.test(t) && /\d/.test(t)) return textUnits(t);
  return Math.max(0, ...t.split(/\s+/).map(w => textUnits(w)));
}

/**
 * What kind of table this is (`rows[0]` is the header):
 * - `matrix` — three or more columns whose body cells (after the first column)
 *   are mostly single marks: R/A/C/I, ✓, ✗, Y/N.
 * - `keyvalue` — two columns: short labels on the left, longer values on the right.
 * - `grid` — everything else.
 */
export function tableVariant(rows: string[][]): TableVariant {
  const body = rows.slice(1);
  const cols = Math.max(0, ...rows.map(r => r.length));
  if (!body.length) return 'grid';
  if (cols >= 3) {
    const cells = body.flatMap(r => r.slice(1)).map(c => c.trim()).filter(Boolean);
    if (cells.length && cells.filter(c => MATRIX_CELL.test(c)).length / cells.length >= 0.7) return 'matrix';
  }
  if (cols === 2) {
    const avg = (i: number): number => body.reduce((a, r) => a + len(r[i] ?? ''), 0) / body.length;
    const maxKey = Math.max(...body.map(r => len(r[0] ?? '')));
    if (maxKey <= 40 && avg(0) <= 26 && avg(1) >= avg(0) * 1.3) return 'keyvalue';
  }
  return 'grid';
}

/** Columns whose body cells are (almost) all numbers, money or percentages — set right-aligned. */
export function numericColumns(rows: string[][]): boolean[] {
  const cols = Math.max(0, ...rows.map(r => r.length));
  const body = rows.slice(1);
  return Array.from({ length: cols }, (_, c) => {
    const cells = body.map(r => (r[c] ?? '').trim()).filter(Boolean);
    return cells.length > 0 && cells.filter(x => NUMERIC.test(x) && /\d/.test(x)).length / cells.length >= 0.8;
  });
}

/** A closing "Total" / "Grand total" / "Subtotal" row. */
export function isTotalRow(cells: string[]): boolean {
  return /^\s*(\*\*)?\s*(grand\s+)?(sub-?)?total\b/i.test(cells[0] ?? '');
}

/**
 * Column widths as fractions of the table width (summing to 1).
 * `rows[0]` is the header; cell text is plain (no Markdown). `capacity` is how
 * many characters of body text fit across the full table width.
 */
export function columnWidths(rows: string[][], opts: { capacity?: number; variant?: TableVariant } = {}): number[] {
  const cols = Math.max(1, ...rows.map(r => r.length));
  const capacity = Math.max(cols * 4, opts.capacity ?? 95);
  const PAD = 3; // cell padding and a little slack, in letters
  const min: number[] = [];
  const max: number[] = [];
  for (let c = 0; c < cols; c++) {
    let lo = 3;
    let hi = 3;
    rows.forEach((r, i) => {
      const t = (r[c] ?? '').trim();
      // A header wraps happily at its spaces, but never inside a word ("Qty" over "Qt/y"): its longest
      // word is a floor (bold, so a little wider), its length is not a wish. Long unbreakable tokens
      // (URLs, paths) may break, so one asks for at most 22 letters.
      lo = Math.max(lo, Math.min(22, unbreakable(t)) * (i === 0 ? 1.1 : 1));
      if (i > 0) hi = Math.max(hi, Math.min(160, textUnits(t)));
    });
    hi = Math.max(hi, lo);
    min.push(lo + PAD);
    max.push(hi + PAD);
  }
  if (opts.variant === 'matrix' && cols >= 3) {
    // The first column names the activity; the marks share the rest evenly.
    const first = Math.min(0.45, Math.max(0.22, max[0]! / capacity));
    return [first, ...Array(cols - 1).fill((1 - first) / (cols - 1))];
  }
  const sumMin = min.reduce((a, x) => a + x, 0);
  const sumMax = max.reduce((a, x) => a + x, 0);
  let w: number[];
  if (sumMax <= capacity) {
    // Everything fits on one line: share the spare room by what each column holds.
    w = max.map(x => x + (capacity - sumMax) * (x / sumMax));
  } else if (sumMin <= capacity) {
    const spare = capacity - sumMin;
    const want = max.map((x, i) => x - min[i]!);
    const sumWant = want.reduce((a, x) => a + x, 0) || 1;
    w = min.map((x, i) => x + spare * (want[i]! / sumWant));
  } else {
    w = min.map(x => x * capacity / sumMin);
  }
  const total = w.reduce((a, x) => a + x, 0);
  return w.map(x => x / total);
}

/** Fractions → integer units (twips, percent×100…) that add up exactly to `total`. */
export function apportion(fractions: number[], total: number): number[] {
  const raw = fractions.map(f => f * total);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (let k = 0; rest > 0 && order.length; k = (k + 1) % order.length, rest--) out[order[k]!.i]!++;
  return out;
}
