/**
 * The Mini Apps host: a second HTTP server, on its own port, serving generated
 * pages and nothing else.
 *
 * ## Why a second server rather than a route on the first
 *
 * The main server runs shell commands. It authorises by origin — a request
 * carrying a foreign `Origin` is refused (`server/index.ts`) — and its token
 * lives in the portal's `localStorage`. A Mini App is a page written by a
 * model. Serve it from the same origin and it inherits both: same-origin fetch
 * to `/api/`, same-origin read of the token, and from there a `Bash` call. Not
 * because the model is hostile, but because "fetch the thing at /api/" is a
 * reasonable line for a generated page to contain.
 *
 * A different port is a different origin, and the browser enforces that for
 * free. The separation is the whole security model, so it is structural: there
 * is no code path here that can reach the agent, because this file does not
 * import it.
 *
 * ## What this server will not do
 *
 * Run app-supplied server code. Every Mini App gets the same server — static
 * files plus the table CRUD in `data.ts` — and the app is the page. That rules
 * out custom endpoints, and it also rules out an app becoming a way to execute
 * model-authored JavaScript in the aico process, which is the thing worth
 * ruling out.
 *
 * ## Loopback, and no authentication
 *
 * Bound to 127.0.0.1. There is no login, because an app that could authenticate
 * would need somewhere to keep credentials and a way to be wrong about them.
 * Reachability is the boundary instead: if you can reach the port, you are
 * already on the machine. `miniApps.host` can widen that, which is why it
 * defaults to loopback and says so in the settings comment.
 *
 * @module miniapps/server
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { AicoSettings } from '../settings.js';
import { getMiniApp, isSafeSlug, listMiniApps, miniAppDir } from './store.js';
import { RUNTIME_CSS, RUNTIME_JS } from './runtime.js';
import * as data from './data.js';

export interface MiniAppServer {
  /** Where apps are reachable, e.g. `http://127.0.0.1:4174`. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface MiniAppServerOptions {
  settings?: AicoSettings;
  cwd?: string;
  /** The main server's port; the default here is one above it. */
  sisterPort?: number;
}

/** Everything the runtime serves under `/_aico/`, which no slug can collide with. */
const RUNTIME_PREFIX = '_aico';

/**
 * Alpine, from `node_modules`.
 *
 * Resolved rather than copied so the version in `package.json` is the version
 * on the page. Resolution is attempted once and the answer kept, including the
 * failure — a missing dependency is not going to appear between requests, and
 * retrying it on every page load would just be a slower way to fail.
 */
let alpinePath: string | null | undefined;
function resolveAlpine(): string | null {
  if (alpinePath !== undefined) return alpinePath;
  try {
    const require = createRequire(import.meta.url);
    alpinePath = require.resolve('alpinejs/dist/cdn.min.js');
  } catch {
    alpinePath = null;
  }
  return alpinePath;
}

export async function startMiniAppServer(
  opts: MiniAppServerOptions = {},
): Promise<MiniAppServer> {
  const settings = opts.settings;
  const cwd = opts.cwd ?? process.cwd();
  const host = settings?.miniApps?.host ?? '127.0.0.1';
  const requestedPort = settings?.miniApps?.port
    ?? (opts.sisterPort ? opts.sisterPort + 1 : 0);

  let port = requestedPort;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // Same reasoning as the main server, pointed the other way: a page on the
    // aico portal must not be able to drive an app's database either. Two
    // origins that both refuse the other is the point of having two.
    const origin = req.headers.origin;
    if (origin && !isOwnOrigin(origin, port)) {
      send(res, 403, { error: 'cross-origin request refused' });
      return;
    }

    const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
    if (segments.some(s => s === null)) { send(res, 400, { error: 'bad path' }); return; }
    const parts = segments as string[];

    if (parts.length === 0) { await serveIndex(res); return; }
    if (parts[0] === RUNTIME_PREFIX) { serveRuntime(parts.slice(1), res); return; }

    const slug = parts[0];
    if (!isSafeSlug(slug)) { send(res, 404, { error: 'no such app' }); return; }
    const dir = miniAppDir(slug, settings, cwd);
    if (!fs.existsSync(dir)) { send(res, 404, { error: `no app "${slug}"` }); return; }

    if (parts[1] === 'api') { await serveApi(req, res, url, dir, parts.slice(2)); return; }

    // `/slug` and `/slug/` resolve relative URLs differently, and an app whose
    // stylesheet loads at one address and 404s at the other is a bug nobody
    // enjoys finding. One canonical form, redirected to.
    if (parts.length === 1 && !url.pathname.endsWith('/')) {
      res.writeHead(302, { Location: `/${slug}/${url.search}` });
      res.end();
      return;
    }

    servePublic(dir, parts.slice(1), res);
  }

  // ── the app's data ────────────────────────────────────────────────

  async function serveApi(
    req: http.IncomingMessage, res: http.ServerResponse,
    url: URL, dir: string, rest: string[],
  ): Promise<void> {
    try {
      if (rest[0] === 'tables' && req.method === 'GET') {
        send(res, 200, await data.describe(dir));
        return;
      }

      const table = rest[0];
      if (!table) { send(res, 404, { error: 'unknown endpoint' }); return; }
      const id = rest[1];

      if (req.method === 'GET' && !id) {
        // Filters arrive as `where.<column>=value` so they cannot be confused
        // with `limit`, `orderBy` and friends — a table with a column called
        // `limit` is unusual but not illegal, and the flat form would silently
        // treat it as paging.
        const where: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams) {
          if (key.startsWith('where.')) where[key.slice('where.'.length)] = value;
        }
        send(res, 200, await data.list(dir, table, {
          where,
          orderBy: url.searchParams.get('orderBy') ?? undefined,
          direction: url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc',
          limit: Number(url.searchParams.get('limit')) || undefined,
          offset: Number(url.searchParams.get('offset')) || undefined,
        }));
        return;
      }

      if (req.method === 'POST' && !id) {
        send(res, 201, await data.insert(dir, table, await readJson(req)));
        return;
      }

      if ((req.method === 'PATCH' || req.method === 'PUT') && id) {
        const row = await data.update(dir, table, id, await readJson(req));
        if (!row) { send(res, 404, { error: 'no such row' }); return; }
        send(res, 200, row);
        return;
      }

      if (req.method === 'DELETE' && id) {
        const gone = await data.remove(dir, table, id);
        send(res, gone ? 200 : 404, gone ? { deleted: true } : { error: 'no such row' });
        return;
      }

      send(res, 405, { error: `${req.method} not allowed here` });
    } catch (err) {
      // A rejected column name, a failed constraint and a bad body are all the
      // caller's fault, and the message is the app author's best debugging
      // tool. 400 rather than 500 so a page can tell "you sent something wrong"
      // from "the server broke".
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── the app's page ────────────────────────────────────────────────

  function servePublic(dir: string, rest: string[], res: http.ServerResponse): void {
    const root = path.join(dir, 'public');
    const file = rest.length === 0 || rest[rest.length - 1] === ''
      ? path.join(root, 'index.html')
      : path.join(root, ...rest);

    if (!contains(root, file)) { send(res, 403, { error: 'forbidden' }); return; }

    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      send(res, 404, { error: 'not built yet', hint: 'this app has no public/index.html' });
      return;
    }
    streamFile(file, res, path.extname(file) === '.html' ? contentSecurityPolicy() : undefined);
  }

  function serveRuntime(rest: string[], res: http.ServerResponse): void {
    const name = rest.join('/');
    if (name === 'aico.js') { sendText(res, 'text/javascript; charset=utf-8', RUNTIME_JS); return; }
    if (name === 'aico.css') { sendText(res, 'text/css; charset=utf-8', RUNTIME_CSS); return; }
    if (name === 'alpine.js') {
      const file = resolveAlpine();
      if (!file) { send(res, 500, { error: 'alpinejs is not installed' }); return; }
      streamFile(file, res);
      return;
    }
    send(res, 404, { error: 'no such runtime asset' });
  }

  /** A plain list of what is installed, for when you arrive at the bare port. */
  async function serveIndex(res: http.ServerResponse): Promise<void> {
    const apps = await listMiniApps(settings, cwd);
    const items = apps.length === 0
      ? '<div class="empty"><h3>No Mini Apps yet</h3>'
        + '<p class="muted">Ask aico to build one and it will appear here.</p></div>'
      : `<div class="grid">${apps.map(app => `
          <a class="card stat" href="/${app.slug}/">
            <div class="value" style="font-size:1.05rem">${escapeHtml(app.title)}</div>
            <div class="delta">${escapeHtml(app.description ?? '')}</div>
            ${app.built ? '' : '<div class="pill warn" style="margin-top:.5rem">not built yet</div>'}
          </a>`).join('')}</div>`;

    sendText(res, 'text/html; charset=utf-8', `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mini Apps</title>
<link rel="stylesheet" href="/${RUNTIME_PREFIX}/aico.css">
</head><body>
<header class="app-header"><div class="app-title"><h1>Mini Apps</h1><small>served by aico</small></div></header>
<main class="app-main">${items}</main>
</body></html>`, contentSecurityPolicy());
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : requestedPort;

  return {
    url: `http://${host}:${port}`,
    port,
    close: async () => {
      data.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────

function isOwnOrigin(origin: string, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/**
 * The second line of defence, after the port.
 *
 * `connect-src 'self'` is the load-bearing one: even if a generated page were
 * to hard-code the aico API's address, the browser will not make the request.
 * `unsafe-eval` is there because Alpine compiles `x-` expressions with
 * `new Function` — the CSP-safe Alpine build exists but only understands a
 * restricted expression subset, which is a poor trade when the origin is
 * already the boundary.
 */
function contentSecurityPolicy(): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

/** Percent-decode one path segment, refusing anything that is not decodable. */
function decodeSegment(segment: string): string | null {
  try { return decodeURIComponent(segment); } catch { return null; }
}

/**
 * Is `file` inside `root`?
 *
 * `startsWith(root)` is the version everyone writes and it is wrong: with a
 * root of `…/public`, the sibling `…/public-backup` starts with it and passes.
 * Comparing against `root + sep` is what actually asks the question.
 */
function contains(root: string, file: string): boolean {
  const base = path.resolve(root);
  const target = path.resolve(file);
  return target === base || target.startsWith(base + path.sep);
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
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function streamFile(
  file: string, res: http.ServerResponse, extra?: Record<string, string>,
): void {
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    ...extra,
  });
  fs.createReadStream(file).pipe(res);
}

function sendText(
  res: http.ServerResponse, type: string, body: string, extra?: Record<string, string>,
): void {
  res.writeHead(200, { 'Content-Type': type, ...extra });
  res.end(body);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** Read a JSON body, capped so a malformed client cannot exhaust memory. */
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}
