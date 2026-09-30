/**
 * Comment threads on an AICO Docs page — their shape, and finding the text a
 * comment is about after the document has changed around it.
 *
 * ## Why quote + prefix + suffix, matched on rendered text
 *
 * A comment is stored beside the Markdown, never in it (the contract in
 * `docs/engineering/canvas-docs-contract.md`), so it cannot hold an offset —
 * every edit, by the person or the agent, would move it. It holds the words
 * the person selected plus a little context either side, the W3C "text quote
 * selector" shape. The words are what the person *saw*: rendered text without
 * Markdown marks, because that is what a selection on the page gives and what
 * a reader recognises. Matching ignores whitespace differences (a re-wrapped
 * paragraph is the same text) and, when the quote occurs more than once,
 * prefers the occurrence whose surroundings match best. A quote that no
 * longer occurs is orphaned: listed at the bottom, never pinned to a guess.
 *
 * @module shared/ui/canvas/comments
 */

import type { CanvasAuthor } from './host';

export interface CommentAnchor { quote: string; prefix: string; suffix: string }

export interface CommentReply { id: string; body: string; author: CanvasAuthor; createdAt: number }

export interface CanvasComment {
  id: string;
  tabId: string;
  anchor: CommentAnchor;
  body: string;
  author: CanvasAuthor;
  createdAt: number;
  replies: CommentReply[];
  resolved: boolean;
  orphaned?: boolean;
  askAgent?: boolean;
}

/** How much text either side of a quote is kept to tell repeated quotes apart. */
export const CONTEXT_CHARS = 32;

/** The anchor for `[start, end)` of `text`. */
export function makeAnchor(text: string, start: number, end: number): CommentAnchor {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.min(text.length, Math.max(start, end));
  return {
    quote: text.slice(a, b),
    prefix: text.slice(Math.max(0, a - CONTEXT_CHARS), a),
    suffix: text.slice(b, b + CONTEXT_CHARS),
  };
}

/** `text` with whitespace runs collapsed, plus a map from each kept character back to its offset. */
function squash(text: string): { s: string; map: number[] } {
  let s = '';
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (!space && s.length) { s += ' '; map.push(i); }
      space = true;
      continue;
    }
    space = false;
    s += c;
    map.push(i);
  }
  return { s, map };
}

const squashStr = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** How many characters two strings share at their ends (suffix of `a`, prefix of `b` — or reversed). */
function sharedTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function sharedHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where an anchor's quote is in `text` now, as `[start, end)` offsets into
 * `text`, or null when it is gone. Whitespace-insensitive; among several
 * occurrences, the one whose prefix and suffix match most wins.
 */
export function locateAnchor(text: string, anchor: CommentAnchor): { start: number; end: number } | null {
  const quote = squashStr(anchor.quote);
  if (!quote) return null;
  const { s, map } = squash(text);
  const prefix = squashStr(anchor.prefix);
  const suffix = squashStr(anchor.suffix);
  let best: { at: number; score: number } | null = null;
  for (let at = s.indexOf(quote); at >= 0; at = s.indexOf(quote, at + 1)) {
    const before = s.slice(Math.max(0, at - prefix.length - 1), at).trim();
    const after = s.slice(at + quote.length, at + quote.length + suffix.length + 1).trim();
    const score = sharedTail(before, prefix) + sharedHead(after, suffix);
    if (!best || score > best.score) best = { at, score };
  }
  if (!best) return null;
  const start = map[best.at]!;
  const end = map[best.at + quote.length - 1]! + 1;
  return { start, end };
}

/** Does a comment (or reply) address the agent? `@AICO`, case-insensitive, as its own word. */
export function mentionsAgent(body: string): boolean {
  return /(^|[^\w@])@aico\b/i.test(body);
}

/** Open threads first in document order, then resolved; orphans are split out. */
export function arrangeComments(
  comments: readonly CanvasComment[], positionOf: (c: CanvasComment) => number | null,
): { placed: Array<{ comment: CanvasComment; at: number }>; orphans: CanvasComment[] } {
  const placed: Array<{ comment: CanvasComment; at: number }> = [];
  const orphans: CanvasComment[] = [];
  for (const c of comments) {
    const at = c.orphaned ? null : positionOf(c);
    if (at === null) orphans.push(c); else placed.push({ comment: c, at });
  }
  placed.sort((a, b) => a.at - b.at || a.comment.createdAt - b.comment.createdAt);
  return { placed, orphans };
}

/**
 * Stack cards in the margin: each wants to sit at its anchor's height, but
 * never overlaps the one above. Returns the top of each card, in order.
 */
export function stackCards(wanted: readonly number[], heights: readonly number[], gap = 8): number[] {
  const out: number[] = [];
  let floor = -Infinity;
  wanted.forEach((w, i) => {
    const top = Math.max(w, floor);
    out.push(top);
    floor = top + (heights[i] ?? 0) + gap;
  });
  return out;
}

/** Does this comment still wait for the agent? It asked, and no agent reply has come. */
export function awaitingAgent(c: CanvasComment): boolean {
  if (c.resolved) return false;
  const asked = c.askAgent || mentionsAgent(c.body) || c.replies.some(r => r.author === 'user' && mentionsAgent(r.body));
  if (!asked) return false;
  const lastUserAsk = Math.max(
    mentionsAgent(c.body) || c.askAgent ? c.createdAt : 0,
    ...c.replies.filter(r => r.author === 'user' && mentionsAgent(r.body)).map(r => r.createdAt),
  );
  return !c.replies.some(r => r.author === 'agent' && r.createdAt >= lastUserAsk);
}
