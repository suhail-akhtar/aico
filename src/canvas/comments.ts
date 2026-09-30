/**
 * Comment anchors on a canvas: finding the passage a comment is about, and
 * finding it again after the text changes.
 *
 * ## Why quote/prefix/suffix and not offsets
 *
 * Comments are stored beside the Markdown, not inside it (a marker in the text
 * would break find/replace and show up in every export). Offsets would go
 * stale with the first edit above the comment; a quote with a little context
 * either side survives any edit that does not touch the passage itself — the
 * same idea as the W3C Web Annotation "text quote selector".
 *
 * ## Why a plain-text projection
 *
 * The person selects on the *rendered* page, so the quote for `**bold** word`
 * arrives as `bold word`. Matching is therefore done against a projection of
 * the Markdown with inline marks, link targets, heading/list/quote markers
 * stripped and whitespace collapsed, with an index map back to the raw text.
 *
 * ## Re-anchoring
 *
 * After an edit: the exact quote, scored by how well prefix and suffix still
 * match, wins; failing that, if prefix and suffix are still there with a short
 * stretch between them, the comment moves to that stretch (the passage was
 * reworded in place); otherwise the comment is orphaned — kept, shown as
 * detached, never silently pinned to the wrong words.
 *
 * @module canvas/comments
 */

export interface CommentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface CommentReply {
  id: string;
  body: string;
  author: 'user' | 'agent';
  createdAt: number;
}

export interface CanvasComment {
  id: string;
  tabId: string;
  anchor: CommentAnchor;
  body: string;
  author: 'user' | 'agent';
  createdAt: number;
  replies: CommentReply[];
  resolved: boolean;
  orphaned?: boolean;
  askAgent?: boolean;
}

/** How much context either side of a quote is kept. */
export const CONTEXT_CHARS = 32;

interface Projection {
  text: string;
  /** `map[i]` = raw index of projected char i. */
  map: number[];
}

const MARKS = new Set(['*', '_', '`', '~']);

/** Plain text of Markdown, with an index map back into it. */
export function project(raw: string): Projection {
  const text: string[] = [];
  const map: number[] = [];
  let atLineStart = true;
  let lastSpace = true;
  const push = (ch: string, at: number): void => {
    if (/\s/.test(ch)) {
      if (lastSpace) return;
      text.push(' '); map.push(at); lastSpace = true;
      return;
    }
    text.push(ch); map.push(at); lastSpace = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (atLineStart) {
      // Block markers at the start of a line: headings, quotes, list bullets,
      // ordered numbers, task boxes, pending/HTML comments.
      const rest = raw.slice(i);
      const m = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(rest);
      if (m && m[0].length > 0) { i += m[0].length - 1; atLineStart = false; continue; }
      const comment = /^[ \t]*<!--[\s\S]*?-->/.exec(rest);
      if (comment) { i += comment[0].length - 1; continue; }
    }
    if (ch === '\n') { push(' ', i); atLineStart = true; continue; }
    atLineStart = false;
    if (MARKS.has(ch)) continue;
    if (ch === '!' && raw[i + 1] === '[') continue;
    if (ch === '[' || (ch === ']' && raw[i + 1] !== '(')) continue;
    if (ch === ']' && raw[i + 1] === '(') {
      const close = raw.indexOf(')', i + 2);
      if (close > 0) { i = close; continue; }
    }
    if (ch === '|') { push(' ', i); continue; }
    push(ch, i);
  }
  return { text: text.join(''), map };
}

/** Normalise a rendered-text quote the same way. */
export function normalize(value: string): string {
  return project(String(value ?? '')).text.trim();
}

export interface Located {
  /** Raw start (inclusive) and end (exclusive) in the Markdown. */
  start: number;
  end: number;
  anchor: CommentAnchor;
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** Longest common suffix of a and b (for prefix scoring). */
function tailMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function headMatch(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function located(raw: string, p: Projection, pStart: number, pEnd: number): Located {
  const start = p.map[pStart]!;
  const end = pEnd > pStart ? p.map[pEnd - 1]! + 1 : start;
  return {
    start, end,
    anchor: {
      quote: p.text.slice(pStart, pEnd),
      prefix: p.text.slice(Math.max(0, pStart - CONTEXT_CHARS), pStart),
      suffix: p.text.slice(pEnd, pEnd + CONTEXT_CHARS),
    },
  };
}

/**
 * Where an anchor sits in `raw`, refreshed; or undefined when the passage is gone.
 */
export function locate(raw: string, anchor: CommentAnchor): Located | undefined {
  const p = project(raw);
  const quote = normalize(anchor.quote);
  const prefix = normalize(anchor.prefix ?? '');
  const suffix = normalize(anchor.suffix ?? '');
  if (!quote) return undefined;

  const hits = occurrences(p.text, quote);
  if (hits.length > 0) {
    let best = hits[0]!;
    let bestScore = -1;
    for (const at of hits) {
      const score = tailMatch(p.text.slice(Math.max(0, at - prefix.length - 1), at).trimEnd(), prefix.trimEnd())
        + headMatch(p.text.slice(at + quote.length).trimStart(), suffix.trimStart());
      if (score > bestScore) { bestScore = score; best = at; }
    }
    return located(raw, p, best, best + quote.length);
  }

  // Reworded in place: the context survived, the words between changed.
  // One side must be distinctive; the other only has to still be there.
  if ((prefix.length >= 8 && suffix.length >= 1) || (prefix.length >= 1 && suffix.length >= 8)) {
    const limit = quote.length * 3 + 400;
    for (const pa of occurrences(p.text, prefix)) {
      const from = pa + prefix.length;
      const sa = p.text.indexOf(suffix, from);
      if (sa < 0 || sa - from > limit) continue;
      let s = from;
      let e = sa;
      while (s < e && p.text[s] === ' ') s++;
      while (e > s && p.text[e - 1] === ' ') e--;
      if (e > s) return located(raw, p, s, e);
    }
  }
  return undefined;
}

/** An anchor for a fresh selection, with its context filled in from the text. */
export function anchorFor(raw: string, input: Partial<CommentAnchor>): CommentAnchor | undefined {
  const hit = locate(raw, { quote: input.quote ?? '', prefix: input.prefix ?? '', suffix: input.suffix ?? '' });
  return hit?.anchor;
}

/**
 * Re-anchor every open comment on one tab after its text changed. Returns the
 * comments (new objects where something moved) and whether anything changed.
 */
export function reanchor(comments: CanvasComment[], tabId: string, raw: string):
  { comments: CanvasComment[]; changed: boolean } {
  let changed = false;
  const next = comments.map((c) => {
    if (c.tabId !== tabId || c.resolved) return c;
    const hit = locate(raw, c.anchor);
    if (!hit) {
      if (c.orphaned) return c;
      changed = true;
      return { ...c, orphaned: true };
    }
    const same = hit.anchor.quote === c.anchor.quote && hit.anchor.prefix === c.anchor.prefix
      && hit.anchor.suffix === c.anchor.suffix && !c.orphaned;
    if (same) return c;
    changed = true;
    const { orphaned: _gone, ...rest } = c;
    return { ...rest, anchor: hit.anchor };
  });
  return { comments: next, changed };
}

/** Does this text address the agent? */
export function addressesAgent(body: string): boolean {
  return /(^|[^\w@])@aico\b/i.test(String(body ?? ''));
}
