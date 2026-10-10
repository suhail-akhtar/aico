/**
 * `aico://app/` — the one origin the interface runs on.
 *
 * Three kinds of request arrive here:
 *
 *   aico://app/api/…         → the engine, with its token and the Origin it
 *                              expects attached. Streamed both ways, so the
 *                              event stream arrives as it is written. Two
 *                              exceptions: the vault routes that return a
 *                              value are refused (main alone calls them), and
 *                              a tool-permission answer is forwarded over the
 *                              engine's private port instead of HTTP.
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
import { onRequestHeaders } from './web-request';
import { PREVIEW_HOST, previewResponse } from './preview';
import { APP_CSP, humanIntent, PLUGIN_CSP } from './protocol-policy';

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

// The content-security policies and the human-intent rule: protocol-policy.ts (unit-tested there).

export interface ProtocolOptions {
  rendererDir: string;
  pluginDir: () => string;
  engine: EngineHost;
  /**
   * Forward a person's tool-permission decision over the engine's private
   * port (vault-host.ts). The engine refuses an HTTP "allow" while the desktop
   * is attached (decision-gate.ts), so this is the only way one lands.
   */
  decidePermission?: (sessionId: string, id: string, allow: boolean) => Promise<boolean>;
  /**
   * Mint a one-time "a person did this" grant over the engine's private port
   * and return it. Attached to the settings actions the token alone may not
   * take (HUMAN_ROUTES); the engine spends it once (decision-gate.ts).
   */
  mintHumanGrant?: () => string;
}

/**
 * Settings actions that need a person, not just the token: installing and
 * enabling an imported skill after its review screen (design §5.1), and the
 * person's own skill saved from the editor, and approving a call parked in
 * the inbox (Phase 7), and approving or resuming a long job (longjob/), and
 * putting a learned preference rule in force (learning/preferences.ts),
 * and confirming, editing or adding an About-you fact, running the learner
 * or widening what it reads (profile/service.ts), and adding an MCP server,
 * writing a skill, adopting a learned rule, and a submit that widens a chat's
 * approval mode (full autonomy, L4) — security review 2026-10, api-system.ts, and the morning brief's Fix all (brief/fix).
 * A submit's grant is spent only when the engine asks for it (a mode above the
 * chat's last), and unspent grants expire after two minutes.
 * The renderer is the AICO window —
 * a request from it is the person's click — so main attaches a grant here;
 * plugin frames are sandboxed with `connect-src 'none'` and `form-action 'none'`,
 * and a grant needs the app transport's JSON + `x-aico-intent` request
 * (protocol-policy.ts humanIntent), which a form or a frame cannot make.
 */
const HUMAN_ROUTES = new Set(['/api/manage', '/api/skills/install', '/api/skills/upload', '/api/skills/import', '/api/inbox/decide', '/api/longjob/decide', '/api/longjob/control', '/api/learning/preferences/act', '/api/profile/act', '/api/profile/add', '/api/profile/run', '/api/profile/settings', '/api/settings', '/api/settings/path', '/api/mcp/add', '/api/skills/create', '/api/learning/adopt', '/api/submit', '/api/editor/open', '/api/brief/fix-all', '/api/delivery/dispatch', '/api/delivery/approve-batch', '/api/delivery/releases', '/api/connections/create', '/api/connections/credential', '/api/connections/update', '/api/connections/remove', '/api/connections/map', '/api/connections/unmap', '/api/connections/pack-connect', '/api/connections/pack-disable', '/api/connections/pack-enable', '/api/control/login', '/api/control/logout']);

/**
 * Human routes with an id in the path (HUMAN_ROUTES matches whole paths): the delivery board's
 * approve (lands a task on the trunk), request-changes (restarts a run), a person's comment (it
 * reaches an agent's prompt as the person's word), and a release's deploy (runs a command) and
 * rollback (creates a reverting task), ADR 0038; and Scrum's commit, start and close of a sprint
 * and the acceptance of an agent's suggestion, ADR 0039.
 */
const HUMAN_ROUTE_PATTERNS = [/^\/api\/delivery\/(?:tasks\/[a-f0-9]{8}\/(?:approve|request-changes|comment|merge-pr)|releases\/\d+\.\d+\.\d+\/(?:deploy|rollback)|sprints\/[a-f0-9]{8}\/(?:commit|start|close)|scrum\/proposals\/[a-f0-9]{8}\/accept)$/];

/**
 * Vault routes the interface may never call: they return a value, or mint
 * the grant that lets one out. The Credential Manager reaches them only
 * through main (credential-manager.ts), after a native confirmation.
 */
const BLOCKED_FROM_RENDERER = /^\/api\/vault\/(reveal|grant|export)$/;

/**
 * Third-party media the chat embeds that insists on knowing who embeds it.
 *
 * A page on `aico://` sends no Referer (it is not an http origin), and two
 * services refuse such requests: YouTube's embedded player fails with "Error
 * 153 — video player configuration error", and OpenStreetMap's tile policy
 * asks every app to identify itself. So requests to exactly these hosts carry
 * the project's public page as their Referer. Nothing else is touched, and the
 * built-in browser (its own session partition) is not affected at all.
 */
const EMBED_REFERER = 'https://suhail-akhtar.github.io/aico/';
export const EMBED_HOSTS = [
  'https://www.youtube-nocookie.com/*',
  'https://www.youtube.com/*',
  'https://*.openstreetmap.org/*',
];

export function attachEmbedReferer(ses: Electron.Session): void {
  // Through the shared dispatcher: a session has one onBeforeSendHeaders listener (web-request.ts).
  onRequestHeaders(ses, EMBED_HOSTS, (_details, headers) => (headers.Referer || headers.referer ? undefined : { ...headers, Referer: EMBED_REFERER }));
}

export function handleProtocol({ rendererDir, pluginDir, engine, decidePermission, mintHumanGrant }: ProtocolOptions): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // Scripted HTML previews: their own origin and CSP, never the API (preview.ts, ADR 0020).
    if (url.host === PREVIEW_HOST) return previewResponse(url, engine);
    const pathname = decodeURIComponent(url.pathname);
    // The engine (and its token) only for the app's own origin.
    if (url.host !== 'app' && pathname.startsWith('/api/')) return json(404, { error: 'not found' });

    if (BLOCKED_FROM_RENDERER.test(pathname)) {
      return json(403, { error: 'Values leave the vault only through AICO’s own confirmation (Settings → Credentials & passwords).' });
    }
    // A tool-permission answer from the interface: a yes goes over the private
    // port, never as HTTP (the engine would refuse it); a no may go either way.
    if (pathname === '/api/permission' && request.method === 'POST' && decidePermission) {
      let body: { sessionId?: unknown; id?: unknown; allow?: unknown } = {};
      try { body = await request.json() as typeof body; } catch { /* not JSON */ }
      if (typeof body.sessionId !== 'string' || typeof body.id !== 'string' || typeof body.allow !== 'boolean') {
        return json(400, { error: 'sessionId, id and allow required' });
      }
      return json(200, { ok: await decidePermission(body.sessionId, body.id, body.allow) });
    }
    if (pathname.startsWith('/api/')) {
      // A grant only for the app's own JSON request with the intent header: a plugin frame's form post,
      // or any simple request, cannot set it (protocol-policy.ts humanIntent).
      const grant = mintHumanGrant && (HUMAN_ROUTES.has(pathname) && humanIntent(request, APP_ORIGIN) || HUMAN_ROUTE_PATTERNS.some(re => re.test(pathname)) && humanIntent(request, APP_ORIGIN)) ? mintHumanGrant() : undefined;
      return proxy(request, url, engine, grant);
    }

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

async function proxy(request: Request, url: URL, engine: EngineHost, grant?: string): Promise<Response> {
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
  // Only main sets this; whatever the renderer sent is dropped.
  headers.delete('x-aico-grant');
  if (grant) headers.set('x-aico-grant', grant);
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
