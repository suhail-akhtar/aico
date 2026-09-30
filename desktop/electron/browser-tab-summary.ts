/**
 * Always-on tab awareness: a compact, current, one-line summary of every open
 * tab — title, address, what kind of page it is (the copilot's own classifier,
 * shared/page-classify.ts), a gist from the page's description or first
 * paragraph, and the key facts the page publishes (price, rating) — kept in
 * main as pages load, so the copilot can answer "which of my tabs is
 * cheapest?" or "compare what I have open" from its page header without
 * switching to and reading every tab.
 *
 * Why it exists: the copilot's header used to list other tabs by title only
 * (and only when there were ≤ 4), so any question across tabs meant the agent
 * switching tabs and reading each one — slow, and visible to the person as the
 * browser flicking through their tabs. Here each tab is looked at once, when
 * it finishes loading, in an isolated world (the page cannot see or change the
 * reader), with the same cheap facts the chips already use. No model calls,
 * nothing stored on disk, nothing sent anywhere: the summaries live in memory
 * for as long as the tab is open, and reach a model only inside a copilot
 * message the person sends (and only while "share open tabs" is on).
 *
 * Deliberately not done: reading page bodies (the agent still has browser_read
 * for detail), summarising with a model, and describing pages Protected
 * Browsing flagged (their title is shown, nothing from the page).
 *
 * @module desktop/electron/browser-tab-summary
 */

import type { WebContents } from 'electron';
import type { PageSignals } from '../shared/page-signals';
import { PAGE_SIGNALS_JS } from '../shared/page-signals';
import { classifyPage, type PageKind } from '../shared/page-classify';
import { guardPageText } from '../../shared/injection-guard';

/** What the gist script reads from a page (besides the page signals). */
export interface TabGistRaw {
  description?: string;
  firstPara?: string;
  h1?: string;
  /** The first price shown on the page, as text ("$189.00"), when the structured data has none. */
  price?: string;
}

export interface TabSummary {
  id: string;
  url: string;
  title: string;
  site: string;
  kind: PageKind;
  /** "Product", "Article"… */
  label: string;
  gist?: string;
  /** "$189.00 · 4.5★" — from the page's structured data, else the first price shown. */
  facts?: string;
  /** When it was last the tab in front (0 = not since AICO started). */
  lastActive: number;
  /** When this summary was taken. */
  at: number;
  flagged?: boolean;
}

/** Read in the page's isolated world: its own description, first real paragraph, h1 and first price. */
export const TAB_GIST_JS = String.raw`(() => {
  const d = document;
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const meta = (p) => { const m = d.querySelector('meta[name="' + p + '"], meta[property="' + p + '"]'); return m ? clean(m.getAttribute('content')) : ''; };
  const main = d.querySelector('article, main, [role="main"]') || d.body;
  let firstPara = '';
  if (main) for (const p of main.querySelectorAll('p')) { const t = clean(p.textContent); if (t.length >= 60) { firstPara = t.slice(0, 400); break; } }
  const h1 = d.querySelector('h1');
  let price = '';
  const ip = d.querySelector('[itemprop="price"]');
  if (ip) price = clean(ip.getAttribute('content') || ip.textContent).slice(0, 40);
  if (!price && main) {
    const m = String(main.innerText || '').slice(0, 20000).match(/(?:[$€£¥₹]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|INR))/);
    if (m) price = m[0];
  }
  return { description: (meta('description') || meta('og:description')).slice(0, 400), firstPara, h1: h1 ? clean(h1.textContent).slice(0, 200) : '', price };
})()`;

const clip = (s: string | undefined, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export function siteOf(url: string): string {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : ''; } catch { return ''; }
}

/** One tab's summary from what the page said about itself. Pure. */
export function buildTabSummary(o: {
  id: string; url: string; title: string; signals: PageSignals | null; gist: TabGistRaw | null; now: number; lastActive?: number; flagged?: boolean;
}): TabSummary {
  const base = { id: o.id, url: o.url, title: clip(o.title || o.url, 140), site: siteOf(o.url), lastActive: o.lastActive ?? 0, at: o.now };
  if (o.flagged) return { ...base, kind: 'page', label: 'Flagged', flagged: true };
  const c = classifyPage(o.signals);
  const g = o.gist ?? {};
  // A description that only repeats the title says nothing.
  const desc = g.description && g.description.toLowerCase() !== o.title.toLowerCase() ? g.description : '';
  const gist = clip(desc || g.firstPara || (g.h1 && g.h1.toLowerCase() !== o.title.toLowerCase() ? g.h1 : ''), 160);
  let facts = c.detail ?? '';
  if (!facts && (c.kind === 'product' || c.kind === 'cart') && g.price) facts = clip(g.price, 30);
  return { ...base, kind: c.kind, label: c.label, ...(gist ? { gist } : {}), ...(facts ? { facts } : {}) };
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/**
 * The lines for the copilot's header: at most `max` tabs, one short line each,
 * the tab in front first, then the most recently looked at. Pure.
 */
export function tabsContextLines(tabs: TabSummary[], o: { activeId?: string | null; now: number; max?: number }): string[] {
  const max = o.max ?? 12;
  const web = tabs.filter(t => /^https?:/i.test(t.url));
  const sorted = [...web].sort((a, b) => (a.id === o.activeId ? -1 : b.id === o.activeId ? 1 : b.lastActive - a.lastActive));
  const lines = sorted.slice(0, max).map((t) => {
    const parts = [
      `[${t.id}]${t.id === o.activeId ? ' (in front)' : ''} ${t.label}`,
      `“${clip(t.title, 80)}”`,
      t.site || clip(t.url, 50),
      t.facts ?? '',
    ].filter(Boolean);
    const tail = t.flagged ? 'flagged as possibly deceptive — nothing read from it' : t.gist ? clip(t.gist, 110) : '';
    const seen = t.id === o.activeId ? '' : t.lastActive ? ` · looked at ${ago(o.now - t.lastActive)}` : '';
    return `- ${parts.join(' · ')}${tail ? ` — ${tail}` : ''}${seen}`;
  });
  if (web.length > max) lines.push(`- …and ${web.length - max} more (browser_tabs_overview lists them all)`);
  return lines;
}

// ── Wiring (browser.ts hands over what it owns) ──

export interface TabAwarenessHooks {
  tabs(): Array<{ id: string; url: string; title: string }>;
  activeId(): string | null;
  flagged(tabId: string): boolean;
  /** Runs a script in the page's isolated world. */
  run<T>(wc: WebContents, code: string, ms: number): Promise<T | null>;
}

export interface TabAwareness {
  attachTab(tabId: string, wc: WebContents): void;
  summaries(): TabSummary[];
  /** The header block for the copilot (guarded here: it is not a tool result), and the tabs behind the chip. */
  view(): { tabs: TabSummary[]; lines: string[]; activeId: string | null };
  /** The same lines unguarded, for a tool result (mcp.ts guards every browser_* result itself). */
  lines(): string[];
}

export function createTabAwareness(h: TabAwarenessHooks): TabAwareness {
  const byId = new Map<string, TabSummary>();
  const lastActive = new Map<string, number>();
  let front: string | null = null;
  // Cheap: who is in front, for "looked at 5 min ago".
  const stamp = (): void => {
    const id = h.activeId();
    if (front && front !== id) lastActive.set(front, Date.now());
    if (id) lastActive.set(id, Date.now());
    front = id;
  };
  setInterval(stamp, 5000).unref?.();

  const refresh = async (tabId: string, wc: WebContents): Promise<void> => {
    if (wc.isDestroyed()) return;
    const url = wc.getURL();
    const now = Date.now();
    if (!/^https?:/i.test(url)) { byId.delete(tabId); return; }
    const flagged = h.flagged(tabId);
    const [signals, gist] = flagged ? [null, null] : await Promise.all([
      h.run<PageSignals>(wc, PAGE_SIGNALS_JS, 3000),
      h.run<TabGistRaw>(wc, TAB_GIST_JS, 3000),
    ]);
    if (wc.isDestroyed() || wc.getURL() !== url) return;
    byId.set(tabId, buildTabSummary({ id: tabId, url, title: wc.getTitle(), signals, gist, now, lastActive: lastActive.get(tabId), flagged }));
  };

  const attachTab = (tabId: string, wc: WebContents): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (ms = 1200): void => { clearTimeout(timer); timer = setTimeout(() => void refresh(tabId, wc).catch(() => {}), ms); };
    wc.on('did-stop-loading', () => later());
    wc.on('did-navigate-in-page', (_e, _u, isMain) => { if (isMain) later(1500); });
    wc.on('page-title-updated', (_e, title) => { const s = byId.get(tabId); if (s && s.url === wc.getURL()) s.title = clip(title, 140); });
    wc.on('destroyed', () => { clearTimeout(timer); byId.delete(tabId); lastActive.delete(tabId); });
  };

  const summaries = (): TabSummary[] => {
    stamp();
    // In the tabs' own order; a tab not summarised yet (still loading, or restored and not woken) is listed by title.
    return h.tabs().map(t => {
      const s = byId.get(t.id);
      const la = lastActive.get(t.id) ?? 0;
      if (s && s.url === t.url) return { ...s, title: clip(t.title || s.title, 140), lastActive: la };
      return { id: t.id, url: t.url, title: clip(t.title || t.url, 140), site: siteOf(t.url), kind: 'page' as PageKind, label: 'Page', lastActive: la, at: 0 };
    });
  };

  return {
    attachTab,
    summaries,
    lines: () => tabsContextLines(summaries(), { activeId: h.activeId(), now: Date.now() }),
    view() {
      const tabs = summaries();
      const activeId = h.activeId();
      // Titles and gists are the pages' own words: guarded like any page text before they reach a model.
      const g = guardPageText(tabsContextLines(tabs, { activeId, now: Date.now() }).join('\n'), { what: 'tab list' });
      const lines = g.text ? g.text.split('\n') : [];
      return { tabs, lines: g.notice ? [g.notice, ...lines] : lines, activeId };
    },
  };
}
