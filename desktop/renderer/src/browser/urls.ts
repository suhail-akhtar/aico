/**
 * The address bar's rules: is this an address or a search, and which
 * suggestions to offer while typing. Pure, so it is unit-tested without a DOM.
 *
 * @module desktop/renderer/browser/urls
 */

import type { Bookmark, HistoryEntry } from './types';

export const SEARCH_URL = 'https://www.google.com/search?q=';
export const SEARCH_NAME = 'Google';

/** Pages the chrome draws itself rather than loading. */
export function isBlankUrl(url: string | undefined | null): boolean {
  const u = (url ?? '').trim().toLowerCase();
  return u === '' || u === 'about:blank' || u === 'about:newtab' || u === 'aico://newtab' || u === 'aico://newtab/';
}

export function searchUrl(query: string): string {
  return SEARCH_URL + encodeURIComponent(query.trim());
}

const SCHEME = /^(https?|file|about|data|view-source|chrome|devtools|blob):/i;
const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d{1,5})?(\/\S*)?$/i;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}(:\d{1,5})?(\/\S*)?$/;
const DOMAIN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}|xn--[a-z0-9-]{2,20})\.?(:\d{1,5})?([/?#]\S*)?$/i;

/**
 * Decide what typing `input` and pressing Enter means.
 *
 * An address when it has a scheme, is localhost or an IP, or looks like a
 * domain with an alphabetic top-level part ("example.com/x", "sub.site.io").
 * Anything with a space, a leading "?", or no dot is a search — "what is
 * rust" and "rust" both search; "rust-lang.org" goes there.
 */
export function parseOmnibox(input: string): { kind: 'url' | 'search'; url: string; text: string } | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith('?')) return { kind: 'search', url: searchUrl(text.slice(1)), text: text.slice(1).trim() };
  // "https://x.com/a b" is still an address a person pasted; "about rust" is not.
  if (/^(https?|file):\/\/\S/i.test(text) || (SCHEME.test(text) && !/\s/.test(text))) return { kind: 'url', url: text.replace(/\s/g, '%20'), text };
  if (/\s/.test(text)) return { kind: 'search', url: searchUrl(text), text };
  if (LOCAL.test(text)) return { kind: 'url', url: `http://${text}`, text };
  if (IPV4.test(text) && text.split(/[:/]/)[0]!.split('.').every(n => Number(n) <= 255)) return { kind: 'url', url: `http://${text}`, text };
  if (DOMAIN.test(text)) return { kind: 'url', url: `https://${text}`, text };
  return { kind: 'search', url: searchUrl(text), text };
}

/** The address as the bar shows it when you are not editing: no "https://", no trailing slash. */
export function displayUrl(url: string): string {
  if (isBlankUrl(url)) return '';
  let s = url.replace(/^https:\/\//i, '');
  if (/^[^/?#]+\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; }
}

export function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

/** The search terms, when the page is a search results page of a known engine. */
export function searchTermsOf(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const key = /(^|\.)google\./.test(host) ? 'q' : /duckduckgo\.com$/.test(host) ? 'q' : /bing\.com$/.test(host) ? 'q' : null;
    if (!key || !/search|^\/$|^\/html/.test(u.pathname)) return null;
    return u.searchParams.get(key);
  } catch { return null; }
}

export interface Suggestion {
  kind: 'search' | 'go' | 'history' | 'bookmark';
  url: string;
  title: string;
  favicon?: string;
  /** For display: what was typed that this completes. */
  detail?: string;
}

function norm(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '').toLowerCase();
}

/**
 * Suggestions for what is typed: first what Enter would do (go there, or
 * search for it), then bookmarks and history that match — a match at the
 * start of the host or of a word in the title counts most, then often and
 * recently visited, and a bookmark beats a history entry of the same page.
 */
export function rankSuggestions(
  query: string,
  history: HistoryEntry[],
  bookmarks: Bookmark[],
  opts: { limit?: number; now?: number } = {},
): Suggestion[] {
  const limit = opts.limit ?? 8;
  const now = opts.now ?? Date.now();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const parsed = parseOmnibox(query);
  const out: Suggestion[] = [];
  if (parsed?.kind === 'url') out.push({ kind: 'go', url: parsed.url, title: parsed.text, detail: 'Go to' });

  const terms = q.split(/\s+/).filter(Boolean);
  const scoreOf = (url: string, title: string, visits: number, lastVisit: number, bookmark: boolean): number => {
    const n = norm(url);
    const t = title.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (n.startsWith(term)) score += 60;
      else if (n.split(/[./?#&=-]/).some(p => p.startsWith(term))) score += 30;
      else if (n.includes(term)) score += 12;
      if (t.split(/[\s|:·—–-]+/).some(w => w.startsWith(term))) score += 25;
      else if (t.includes(term)) score += 8;
      if (!n.includes(term) && !t.includes(term)) return 0;
    }
    if (bookmark) score += 30;
    score += Math.min(30, Math.log2(1 + visits) * 8);
    const days = (now - lastVisit) / 86_400_000;
    score += Math.max(0, 20 - days * 2);
    return score;
  };

  const best = new Map<string, Suggestion & { score: number }>();
  for (const b of bookmarks) {
    const s = scoreOf(b.url, b.title, 0, b.addedAt, true);
    if (s > 0) best.set(norm(b.url), { kind: 'bookmark', url: b.url, title: b.title || hostOf(b.url), favicon: b.favicon, score: s });
  }
  for (const h of history) {
    const key = norm(h.url);
    const s = scoreOf(h.url, h.title, h.visits, h.lastVisit, false);
    if (s <= 0) continue;
    const had = best.get(key);
    if (had) { had.score += s * 0.5; continue; }
    best.set(key, { kind: 'history', url: h.url, title: h.title || hostOf(h.url), favicon: h.favicon, score: s });
  }
  const goKey = parsed?.kind === 'url' ? norm(parsed.url) : null;
  const ranked = [...best.entries()].filter(([k]) => k !== goKey).map(([, v]) => v).sort((a, b) => b.score - a.score);
  const room = Math.max(0, limit - out.length - 1);
  for (const r of ranked.slice(0, room)) out.push({ kind: r.kind, url: r.url, title: r.title, favicon: r.favicon });
  // The search is always offered, last when the text is an address, first when it is not.
  const search: Suggestion = { kind: 'search', url: searchUrl(query), title: query.trim(), detail: `Search ${SEARCH_NAME} for` };
  if (parsed?.kind === 'url') out.push(search); else out.unshift(search);
  return out.slice(0, limit);
}
