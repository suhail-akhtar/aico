/**
 * Scripted HTML previews — the pure half (no Electron), unit-tested in
 * `scripts/test-unit.mjs`. See ADR 0020 and `preview.ts` for the wiring.
 *
 * Why this exists: an HTML artifact (a dashboard the agent built) or a
 * ```html block with "scripts" ticked was shown in a `srcdoc` frame, and a
 * srcdoc document inherits the window's CSP (`script-src 'self' aico:`), so
 * its inline scripts were refused whatever the sandbox said — the charts never
 * drew. Running them needs a document served from somewhere else with a policy
 * of its own, the way plugin views are. That somewhere is `aico://preview/`:
 * a different origin from `aico://app/` (the scheme is "standard", so the
 * host is part of the origin), which never sees the engine token, has no
 * preload and no IPC, and is framed with `sandbox="allow-scripts"` and never
 * `allow-same-origin`.
 *
 * The rules this file owns, each of them a test:
 *   - a preview is reachable only by an unguessable token the window
 *     registered, and a token names one directory (or one in-memory page);
 *     a path that leaves it (`..`, absolute, drive letters, backslashes,
 *     encoded dots, NUL) resolves to nothing;
 *   - the document's CSP: nothing by default; inline script and style plus the
 *     token's own directory; the three script CDNs only when the page names
 *     them; images from the directory, data: and blob:; `connect-src 'none'`
 *     (no fetch, XHR, WebSocket or beacon); no forms, no frames, no workers,
 *     no <base>; framed only by the app; `sandbox allow-scripts` repeated in
 *     the header so the page is sandboxed even if opened on its own;
 *   - a preview frame may only navigate within its own token.
 *
 * Deliberately not here: `'unsafe-eval'` (Chart.js, ECharts and D3 do not need
 * it; a library that does fails visibly rather than widening every preview),
 * and any route to the engine — `preview.ts` fetches the file with the token
 * itself and hands back bytes under these headers.
 *
 * @module desktop/electron/preview-core
 */

export const PREVIEW_HOST = 'preview';
export const PREVIEW_ORIGIN = `aico://${PREVIEW_HOST}`;
export const APP_FRAME_ANCESTOR = 'aico://app';

/** Script and style CDNs a generated page commonly loads chart libraries from; allowed only when the page names them. */
export const PREVIEW_CDNS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'] as const;

export type PreviewTarget =
  | { kind: 'file'; session: string; dir: string }
  | { kind: 'html'; html: string };

export type Resolved =
  | { kind: 'file'; session: string; path: string; name: string }
  | { kind: 'html'; html: string; name: string };

const SESSION = /^[\w.-]{1,160}$/;
const MAX_ENTRIES = 200;
/** The in-memory page a ```html block becomes; its only path. */
export const INLINE_PAGE = 'index.html';

/** Tokens → what they serve, newest kept; the oldest are forgotten past MAX_ENTRIES. */
export class PreviewRegistry {
  private entries = new Map<string, PreviewTarget>();
  constructor(private mint: () => string) {}

  /**
   * A file in a chat's artifacts folder, by its path relative to that folder:
   * the token serves that file's directory. Returns the token and the URL of
   * the file itself, or an error a person can read.
   */
  registerFile(session: unknown, path: unknown): { token: string; url: string } | { error: string } {
    if (typeof session !== 'string' || !SESSION.test(session)) return { error: 'a session id is required' };
    const segments = typeof path === 'string' ? cleanSegments(path) : null;
    if (!segments || segments.length === 0) return { error: 'a path inside the chat\'s artifacts folder is required' };
    const name = segments[segments.length - 1]!;
    if (!/\.html?$/i.test(name)) return { error: 'only .html files are previewed this way' };
    const token = this.add({ kind: 'file', session, dir: segments.slice(0, -1).join('/') });
    return { token, url: `${PREVIEW_ORIGIN}/${token}/${encodeURIComponent(name)}` };
  }

  /** A page held in memory (a chat's ```html block): served once as /<token>/index.html. */
  registerHtml(html: unknown): { token: string; url: string } | { error: string } {
    if (typeof html !== 'string' || !html) return { error: 'html is required' };
    if (html.length > 5_000_000) return { error: 'the page is too large to preview' };
    const token = this.add({ kind: 'html', html });
    return { token, url: `${PREVIEW_ORIGIN}/${token}/${INLINE_PAGE}` };
  }

  /** What `aico://preview/<token>/<rest>` serves, or null — never anything outside the token's directory. */
  resolve(pathname: string): Resolved | null {
    const parts = pathname.replace(/^\/+/, '').split('/');
    const token = parts.shift() ?? '';
    const target = this.entries.get(token);
    if (!target) return null;
    const segments = cleanSegments(parts.join('/'));
    if (!segments || segments.length === 0) return null;
    const name = segments[segments.length - 1]!;
    if (target.kind === 'html') return segments.length === 1 && name === INLINE_PAGE ? { kind: 'html', html: target.html, name } : null;
    return { kind: 'file', session: target.session, path: [target.dir, ...segments].filter(Boolean).join('/'), name };
  }

  get size(): number { return this.entries.size; }

  private add(target: PreviewTarget): string {
    const token = this.mint();
    if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) throw new Error('preview tokens must be long and URL-safe');
    this.entries.set(token, target);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return token;
  }
}

/**
 * Split a relative path into safe, decoded segments, or null when any part
 * could step outside: `..`, `.`, empty segments, backslashes, drive letters,
 * colons, NUL — checked after percent-decoding, so `%2e%2e` is `..` here too.
 */
export function cleanSegments(rel: string): string[] | null {
  if (!rel || rel.startsWith('/')) return null;
  const out: string[] = [];
  for (const raw of rel.split('/')) {
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    if (!seg || seg === '.' || seg === '..' || /[\\:\0]/.test(seg) || seg.includes('/')) return null;
    out.push(seg);
  }
  return out;
}

/** The CDNs (of PREVIEW_CDNS) a page refers to. */
export function cdnsReferenced(html: string): string[] {
  return PREVIEW_CDNS.filter(origin => html.includes(origin.replace('https:', '')));
}

/** The content-security policy every response under a token carries. */
export function previewCsp(token: string, cdns: readonly string[] = []): string {
  const own = `${PREVIEW_ORIGIN}/${token}/`;
  const extra = cdns.filter(c => (PREVIEW_CDNS as readonly string[]).includes(c));
  return [
    "default-src 'none'",
    ["script-src 'unsafe-inline'", own, ...extra].join(' '),
    ["style-src 'unsafe-inline'", own, ...extra].join(' '),
    `img-src ${own} data: blob:`,
    `font-src ${own} data: ${extra.join(' ')}`.trim(),
    `media-src ${own} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    `frame-ancestors ${APP_FRAME_ANCESTOR}`,
    'sandbox allow-scripts',
  ].join('; ');
}

/** The token a preview URL belongs to, or null for any other URL. */
export function previewToken(url: string | undefined | null): string | null {
  if (!url || !url.startsWith(`${PREVIEW_ORIGIN}/`)) return null;
  return url.slice(PREVIEW_ORIGIN.length + 1).split(/[/?#]/)[0] || null;
}

/**
 * Whether a navigation may proceed. A navigation started by a preview frame
 * (a link, `location = …`) stays inside its own token; anything else — the app
 * pointing an iframe at a preview, every other page — is not this guard's
 * business.
 */
export function previewNavigationAllowed(initiatorUrl: string | undefined | null, targetUrl: string): boolean {
  const from = previewToken(initiatorUrl);
  if (!from) return true;
  return previewToken(targetUrl) === from;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
};

export function previewMime(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}
