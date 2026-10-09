/**
 * One board screen as a single, self-contained document — what the viewer
 * frames, what Play navigates and what "Download screen" saves (ADR 0037).
 *
 * ## Why compose instead of pointing a frame at the file
 *
 * A screen links a shared stylesheet, maybe a script, fonts and pictures, and
 * other screens. A frame pointed at the file would need an origin that serves
 * the board's folder. The desktop has one (`aico://preview`, ADR 0020) but the
 * browser portal does not, and serving model-written HTML from the engine's
 * own origin is exactly what ADR 0020 refused. So every client builds the same
 * document instead: local stylesheets and scripts inlined, local pictures and
 * fonts turned into data: URLs, and — for the live views — a small script
 * that turns a click on a link to another screen into a message to the board
 * (`{aicoBoard: 'nav', href}`), which the viewer resolves against the board
 * and answers by showing that screen. The result goes into a `srcdoc` frame
 * (browser) or an in-memory preview page (desktop), always with
 * `sandbox="allow-scripts"` and never `allow-same-origin`.
 *
 * The document also carries a restrictive CSP (no fetch, no forms, no
 * <base>, images only from data:/blob:, scripts and styles inline or from the
 * three CDNs ADR 0020 allows), the same second layer `wrapDocument` adds to a
 * chat's HTML block.
 *
 * ## What it deliberately does not do
 *
 * Fetch anything itself: the caller passes `read`, which returns a file's text
 * or bytes from the board folder (the client uses the artifacts route, which
 * checks containment). It does not follow `@import` chains past one level or
 * rewrite `srcset`; a screen that needs either still renders, minus that asset.
 * And it never inlines anything from outside the board: paths are resolved
 * with `resolveHref`, which refuses `..` past the board folder.
 *
 * @module shared/ui/board/board-compose
 */

import { BOARD_CDNS, cssUrls, resolveHref } from './board-model';

export interface BoardFileReader {
  /** A text file (CSS, JS) of the board, by board-relative path; undefined when missing. */
  text(path: string): Promise<string | undefined>;
  /** A binary file as a data: URL; undefined when missing or too large. */
  dataUrl(path: string): Promise<string | undefined>;
}

export interface ComposeOptions {
  /** Add the link-to-message script (live frames and Play). Off for downloads. */
  navigation: boolean;
  /** Add the CSP meta. On for frames; off for a download, which is opened on its own. */
  csp: boolean;
}

const CDN_ORIGINS = BOARD_CDNS.map(h => `https://${h}`).join(' ');

export const BOARD_FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN_ORIGINS}`,
  `style-src 'unsafe-inline' ${CDN_ORIGINS}`,
  'img-src data: blob:',
  `font-src data: ${CDN_ORIGINS}`,
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
].join('; ');

/**
 * The navigation shim. Capture phase, so a page's own handlers cannot swallow
 * the click first; a link with a scheme (http, mailto…) does nothing, since
 * there is no network and a mockup leaving itself is never what was meant.
 * Forms are stopped too (`form-action 'none'` would refuse them anyway, but
 * silently).
 */
export const NAV_SHIM = `<script>(function(){
function send(h){try{parent.postMessage({aicoBoard:'nav',href:h},'*')}catch(e){}}
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;
  var h=a.getAttribute('href')||'';if(!h||h.charAt(0)==='#')return;
  e.preventDefault();if(/^[a-z][a-z0-9+.-]*:/i.test(h)||h.indexOf('//')===0)return;send(h);
},true);
document.addEventListener('submit',function(e){e.preventDefault()},true);
document.addEventListener('keydown',function(e){if(e.key==='Escape'||((e.key==='ArrowRight'||e.key==='ArrowLeft')&&!/^(INPUT|TEXTAREA|SELECT)$/.test((e.target&&e.target.tagName)||'')&&!(e.target&&e.target.isContentEditable)))try{parent.postMessage({aicoBoard:'key',key:e.key},'*')}catch(x){}});
})();</script>`;

const LOCAL = (u: string): boolean => Boolean(u) && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

function attrValue(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : undefined;
}

async function replaceAsync(text: string, re: RegExp, fn: (m: RegExpExecArray) => Promise<string>): Promise<string> {
  const parts: Array<string | Promise<string>> = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    parts.push(text.slice(last, m.index), fn(m));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  parts.push(text.slice(last));
  return (await Promise.all(parts)).join('');
}

/** Inline `url(…)` references of CSS found at `cssFile` (board-relative) as data: URLs. */
export async function inlineCssUrls(css: string, cssFile: string, read: BoardFileReader, depth = 0): Promise<string> {
  let out = await replaceAsync(css, /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')\s*\)?\s*;?/gi, async (m) => {
    const href = (m[1] ?? m[2] ?? '').trim();
    if (!LOCAL(href) || depth > 0) return m[0];
    const target = resolveHref(cssFile, href);
    const text = target ? await read.text(target) : undefined;
    return text === undefined ? '' : inlineCssUrls(text, target!, read, depth + 1);
  });
  out = await replaceAsync(out, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, async (m) => {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!LOCAL(href) || /^data:/i.test(href)) return m[0];
    const target = resolveHref(cssFile, href);
    const data = target ? await read.dataUrl(target) : undefined;
    return data ? `url("${data}")` : m[0];
  });
  return out;
}

/**
 * Build the self-contained document for the screen at `file` (board-relative)
 * whose source is `html`.
 */
export async function composeScreen(html: string, file: string, read: BoardFileReader, options: ComposeOptions): Promise<string> {
  let doc = html;
  // <link rel=stylesheet href=local.css> → <style>…</style>
  doc = await replaceAsync(doc, /<link\b[^>]*>/gi, async (m) => {
    const tag = m[0];
    const rel = (attrValue(tag, 'rel') ?? '').toLowerCase();
    const href = attrValue(tag, 'href') ?? '';
    if (!LOCAL(href)) return tag;
    if (rel.split(/\s+/).includes('stylesheet')) {
      const target = resolveHref(file, href);
      const css = target ? await read.text(target) : undefined;
      if (css === undefined) return `<!-- missing stylesheet: ${href.replace(/--/g, '')} -->`;
      const media = attrValue(tag, 'media');
      return `<style${media ? ` media="${media.replace(/"/g, '')}"` : ''}>${(await inlineCssUrls(css, target!, read)).replace(/<\/style/gi, '<\\/style')}</style>`;
    }
    if (rel.split(/\s+/).includes('icon')) {
      const target = resolveHref(file, href);
      const data = target ? await read.dataUrl(target) : undefined;
      return data ? tag.replace(href, data) : '';
    }
    return tag;
  });
  // <script src=local.js></script> → inline script
  doc = await replaceAsync(doc, /<script\b([^>]*)>\s*<\/script>/gi, async (m) => {
    const src = attrValue(m[0], 'src');
    if (!src || !LOCAL(src)) return m[0];
    const target = resolveHref(file, src);
    const js = target ? await read.text(target) : undefined;
    if (js === undefined) return `<!-- missing script: ${src.replace(/--/g, '')} -->`;
    const attrs = (m[1] ?? '').replace(/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '');
    return `<script${attrs}>${js.replace(/<\/script/gi, '<\\/script')}</script>`;
  });
  // <img src=local.png> (and source/video/audio) → data: URL
  doc = await replaceAsync(doc, /<(img|source|video|audio)\b[^>]*>/gi, async (m) => {
    const tag = m[0];
    const src = attrValue(tag, 'src');
    if (!src || !LOCAL(src)) return tag;
    const target = resolveHref(file, src);
    const data = target ? await read.dataUrl(target) : undefined;
    return data ? tag.replace(src, data) : tag;
  });
  // Inline <style> blocks and style="" attributes may use url() too.
  doc = await replaceAsync(doc, /<style\b([^>]*)>([\s\S]*?)<\/style>/gi, async (m) => {
    if (!cssUrls(m[2] ?? '').some(LOCAL)) return m[0];
    return `<style${m[1] ?? ''}>${await inlineCssUrls(m[2] ?? '', file, read)}</style>`;
  });
  doc = await replaceAsync(doc, /\bstyle\s*=\s*"([^"]*url\([^"]*)"/gi, async (m) => `style="${(await inlineCssUrls(m[1] ?? '', file, read)).replace(/"/g, '&quot;')}"`);

  const head: string[] = [];
  if (options.csp) head.push(`<meta http-equiv="Content-Security-Policy" content="${BOARD_FRAME_CSP}">`);
  const tail = options.navigation ? NAV_SHIM : '';
  if (!/<html[\s>]/i.test(doc)) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head.join('')}</head><body>${doc}${tail}</body></html>`;
  }
  // Any <base> would redirect every relative link; the CSP refuses it, and so does this.
  doc = doc.replace(/<base\b[^>]*>/gi, '');
  if (head.length) {
    doc = /<head\b[^>]*>/i.test(doc) ? doc.replace(/<head\b[^>]*>/i, h => `${h}${head.join('')}`) : doc.replace(/<html\b[^>]*>/i, h => `${h}<head>${head.join('')}</head>`);
  }
  if (tail) doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tail}</body>`) : `${doc}${tail}`;
  return doc;
}

/** Base64 of bytes, for data: URLs, without a Node Buffer (runs in every client). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
};

export function boardMime(path: string): string {
  return MIME[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
