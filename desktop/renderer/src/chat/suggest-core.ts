/**
 * The pure half of the composer's "/" and "@" menus: what counts as a trigger,
 * how items are ranked and de-duplicated. Kept free of React so it is tested
 * directly.
 *
 * @module desktop/renderer/chat/suggest-core
 */

export interface SuggestItem {
  id: string;
  group: string;
  icon: string;
  title: string;
  hint?: string;
  /** Extra words the filter matches but the menu does not show. */
  keywords?: string;
  checked?: boolean;
  /** Runs when picked. A returned string is shown as the confirmation. */
  run: () => void | string | Promise<void | string>;
}

/** What the caret is in the middle of typing, if it is a trigger. */
export type Trigger =
  | { kind: 'slash'; query: string; from: number; to: number }
  | { kind: 'mention'; query: string; from: number; to: number };

/**
 * "/" counts only as the first thing in the box (a path or a fraction later in
 * a sentence is not a command); "@" counts after a space or at the start, and
 * runs to the caret with no whitespace in it (`name@host` is not a mention).
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  if (before.startsWith('/') && !/\s/.test(before)) return { kind: 'slash', query: before.slice(1), from: 0, to: caret };
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { kind: 'mention', query, from: at, to: caret };
}

/**
 * Ranked, not merely filtered: what starts with the typed text comes first,
 * then what contains it, then what contains its letters in order ("nwc" finds
 * "New chat").
 */
export function rankItems<T extends { title: string; keywords?: string; hint?: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const scored: Array<[number, number, T]> = [];
  items.forEach((item, i) => {
    const title = item.title.toLowerCase();
    const extra = `${item.keywords ?? ''} ${item.hint ?? ''}`.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.split(/[\s/·(-]+/).some(w => w.startsWith(q))) score = 1;
    else if (title.includes(q)) score = 2;
    // Keywords match from the start of a word: "pl" must not find everything filed under "Application".
    else if (extra.split(/[\s/·(-]+/).some(w => w.startsWith(q))) score = 3;
    // Letters in order only for three or more typed, starting on a word:
    // "nwc" finds New chat, but "pl" does not drag in "Restart the engine".
    else if (q.length >= 3 && title.split(/[\s/·(-]+/).some(w => w.startsWith(q[0]!)) && subsequence(q, title)) score = 4;
    if (score >= 0) scored.push([score, i, item]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(s => s[2]);
}

function subsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

/** Keeps each title once, first occurrence wins. */
export function dedupe<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(i => {
    const k = i.title.toLowerCase().replace(/\s*\((toggle|on|off)\)\s*$/, '').trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A path as a mention: relative to the project when inside it, forward slashes, quoted if it has spaces. */
export function mentionPath(p: string, root: string | null): string {
  const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const full = norm(p);
  let out = full;
  if (root) {
    const r = norm(root);
    if (full.toLowerCase().startsWith(`${r.toLowerCase()}/`)) out = full.slice(r.length + 1);
  }
  return /\s/.test(out) ? `"${out}"` : out;
}

/**
 * Ranking reorders across groups; drawn as-is, a heading would repeat each time
 * its group came round again. Groups are ordered by their best-ranked item and
 * items keep their rank inside their group.
 */
export function groupRanked<T extends { group: string }>(ranked: T[]): T[] {
  const order: string[] = [];
  const by = new Map<string, T[]>();
  for (const item of ranked) {
    if (!by.has(item.group)) { by.set(item.group, []); order.push(item.group); }
    by.get(item.group)!.push(item);
  }
  return order.flatMap(g => by.get(g)!);
}
