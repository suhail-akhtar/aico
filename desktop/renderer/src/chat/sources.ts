/**
 * The sources behind an answer — what the agent searched and read on the way.
 *
 * Derived from the turn's own tool calls rather than asked of the model: a
 * list the model writes is a list of what it says it used; this is what it
 * actually opened. Pages it read (WebFetch, the built-in browser) come first,
 * then search results it saw but did not open, each URL once.
 *
 * Pure, so it is unit-tested directly.
 *
 * @module desktop/renderer/chat/sources
 */

export interface Source {
  url: string;
  host: string;
  title?: string;
  snippet?: string;
  /** read = the agent opened the page; search = it appeared in results it saw. */
  via: 'read' | 'search';
}

interface ToolLike { type?: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: unknown }

function hostOf(url: string): string | null {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null; }
  catch { return null; }
}

function parse(result: unknown): unknown {
  if (typeof result !== 'string') return result;
  const t = result.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return result;
  try { return JSON.parse(t); } catch { return result; }
}

/** A page title from a fetched result, when the text carries one. */
function titleFrom(result: unknown): string | undefined {
  const r = parse(result);
  if (r && typeof r === 'object' && typeof (r as { title?: unknown }).title === 'string') return (r as { title: string }).title;
  if (typeof r !== 'string') return undefined;
  const m = r.match(/^(?:Title:\s*(.+)|#\s+(.+))$/m);
  return (m?.[1] ?? m?.[2])?.trim().slice(0, 200) || undefined;
}

/**
 * A readable stand-in when a page gave no title: a search page reads as what
 * was searched ("Search: kabuli pulao recipe"), anything else as its last
 * meaningful path segment — never a raw, percent-encoded URL.
 */
export function readableTitle(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ['q', 'query', 'search_query', 'p', 'text', 'k']) {
      const v = u.searchParams.get(k);
      if (v && v.trim()) return `Search: ${v.trim()}`;
    }
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg).replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').trim() || u.hostname;
    return u.hostname.replace(/^www\./, '');
  } catch { return url; }
}

export function extractSources(messages: ToolLike[]): Source[] {
  const read = new Map<string, Source>();
  const seen = new Map<string, Source>();
  for (const m of messages) {
    if (m.type !== 'tool' || !m.toolName) continue;
    const name = m.toolName.toLowerCase();
    const args = m.toolArgs ?? {};
    const url = typeof args.url === 'string' ? args.url : typeof args.href === 'string' ? args.href : undefined;
    if (url && (name === 'webfetch' || name.includes('browser_open') || name.includes('navigate'))) {
      const host = hostOf(url);
      if (host && !read.has(url)) read.set(url, { url, host, title: name === 'webfetch' ? titleFrom(m.toolResult) : undefined, via: 'read' });
      continue;
    }
    if (name === 'websearch') {
      const r = parse(m.toolResult) as { results?: Array<{ title?: string; url?: string; snippet?: string }> } | string;
      const list = typeof r === 'object' && r && Array.isArray(r.results) ? r.results : [];
      for (const item of list) {
        if (!item.url) continue;
        const host = hostOf(item.url);
        if (host && !seen.has(item.url)) seen.set(item.url, { url: item.url, host, title: item.title, snippet: item.snippet, via: 'search' });
      }
    }
  }
  // A result the agent then opened is listed once, as read, with the search's title and snippet.
  for (const [url, s] of seen) {
    const r = read.get(url);
    if (r) read.set(url, { ...s, ...r, title: r.title ?? s.title, snippet: s.snippet, via: 'read' });
  }
  return [...read.values(), ...[...seen.values()].filter(s => !read.has(s.url))]
    .map(s => (s.title ? s : { ...s, title: readableTitle(s.url) }));
}

/** A short site name for a chip: "foodpanda.pk" → "Foodpanda". */
export function siteName(host: string): string {
  const parts = host.split('.');
  const core = parts.length > 2 && parts[parts.length - 2]!.length <= 3 ? parts[parts.length - 3]! : parts[Math.max(0, parts.length - 2)]!;
  return core.charAt(0).toUpperCase() + core.slice(1);
}
