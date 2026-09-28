/**
 * `aico://app/` — the one origin the interface runs on.
 *
 * Three kinds of request arrive here:
 *
 *   aico://app/api/…         → the engine, with its token and the Origin it
 *                              expects attached. Streamed both ways, so the
 *                              event stream arrives as it is written.
 *   aico://app/plugins/<id>/ → a plugin's own files, served with a sandboxing
 *                              content-security policy.
 *   aico://app/…             → the renderer's files; unknown paths fall back to
 *                              index.html so in-app routes survive a reload.
 *
 * Why a scheme and not a localhost page: the engine refuses requests from any
 * origin but its own (that check is what stops a stray browser tab driving the
 * agent), and a `file://` page has no origin at all. Serving the interface from
 * a privileged scheme and proxying the API keeps the engine's check intact and
 * means the token never reaches renderer code.
 *
 * @module desktop/electron/protocol
 */

import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { EngineHost } from './engine-host';

export const SCHEME = 'aico';
export const APP_ORIGIN = `${SCHEME}://app`;

/** Must run before `app` is ready. */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      codeCache: true,
    },
  }]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve `rel` under `root`, or null if it would escape it. */
function inside(root: string, rel: string): string | null {
  const target = path.resolve(root, '.' + path.sep + rel);
  const r = path.resolve(root);
  return target === r || target.startsWith(r + path.sep) ? target : null;
}

function fileResponse(file: string, extraHeaders: Record<string, string> = {}): Response {
  const body = fs.readFileSync(file);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': mimeOf(file), 'cache-control': 'no-cache', ...extraHeaders },
  });
}

/** The renderer's own content-security policy. */
const APP_CSP = [
  "default-src 'self' aico:",
  "script-src 'self' aico: 'wasm-unsafe-eval'",
  // Mermaid, KaTeX and ECharts write inline styles.
  "style-src 'self' aico: 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' aico: data: https://fonts.gstatic.com",
  "img-src 'self' aico: data: blob: https: http:",
  "media-src 'self' aico: data: blob:",
  "connect-src 'self' aico:",
  // Plugin views and HTML previews are sandboxed frames.
  "frame-src 'self' aico: blob: data:",
  "worker-src 'self' aico: blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/**
 * A plugin's files: scripts may run, but inside an opaque-origin sandbox — no
 * access to the app's origin, its storage or its bridge.
 */
const PLUGIN_CSP = [
  "default-src 'self' aico: data: blob:",
  "script-src 'self' aico: 'unsafe-inline'",
  "style-src 'self' aico: 'unsafe-inline'",
  "img-src * data: blob:",
  "connect-src 'none'",
  'sandbox allow-scripts allow-forms allow-popups',
].join('; ');

export interface ProtocolOptions {
  rendererDir: string;
  pluginDir: () => string;
  engine: EngineHost;
}

export function handleProtocol({ rendererDir, pluginDir, engine }: ProtocolOptions): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith('/api/')) return proxy(request, url, engine);

    if (pathname.startsWith('/plugins/')) {
      const rel = pathname.slice('/plugins/'.length);
      const file = inside(pluginDir(), rel);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      return fileResponse(file, { 'content-security-policy': PLUGIN_CSP });
    }

    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    let file = inside(rendererDir, rel);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // An in-app route, not a file.
      file = path.join(rendererDir, 'index.html');
    }
    const headers: Record<string, string> = file.endsWith('.html') ? { 'content-security-policy': APP_CSP } : {};
    return fileResponse(file, headers);
  });
}

async function proxy(request: Request, url: URL, engine: EngineHost): Promise<Response> {
  let endpoint;
  try {
    endpoint = await engine.ready(60_000);
  } catch (err) {
    return json(503, { error: (err as Error).message });
  }
  const target = new URL(url.pathname + url.search, endpoint.origin);
  // The renderer never holds the token; replace whatever it sent.
  target.searchParams.delete('token');
  const headers = new Headers(request.headers);
  headers.set('x-aico-token', endpoint.token);
  headers.set('origin', endpoint.origin);
  headers.delete('host');
  headers.delete('referer');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      redirect: 'manual',
    });
    const out = new Headers(upstream.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return new Response(null, { status: 499 });
    return json(502, { error: `The engine did not answer: ${(err as Error).message}` });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
