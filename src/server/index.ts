/**
 * `aico serve` — the engine over HTTP, for a browser client.
 *
 * Built on Node's own `http` module rather than a framework. The surface is a
 * handful of JSON routes plus one SSE stream; a framework would add a
 * dependency and a supply-chain surface to save perhaps forty lines, on a
 * server whose entire job is to hold a socket open.
 *
 * ## Security posture
 *
 * This process can run shell commands and write files as you. Exposing that on
 * a network is not a configuration choice to be made casually, so:
 *
 *   - it binds to **127.0.0.1** only. Not 0.0.0.0, not configurable by accident.
 *   - every request needs a **token** minted at startup and printed once. Any
 *     other process on the machine can reach a loopback port; the token means
 *     reaching it is not the same as driving it.
 *   - browser requests are checked for **Origin**, so a page you happen to have
 *     open cannot post to the port and drive the agent through your browser.
 *
 * None of that makes it safe to expose remotely. Remote operation needs real
 * authentication and a sandbox that actually confines subprocesses — ours
 * reports that as `partial` and says so on purpose.
 *
 * @module server
 */

import http from 'http';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventHub } from './events.js';
import { RunManager } from './runs.js';
import { deriveMessages } from '../session/derive.js';
import { listSessionSummaries } from '../session/persistence.js';
import { loadSettings } from '../settings.js';
import { PROVIDER_DEFAULT_MODELS } from '../providers/index.js';
import { handleSystemRoute } from './api-system.js';
import { initializeFeatures, shutdownFeatures } from '../bootstrap.js';

export interface ServeOptions {
  port?: number;
  cwd?: string;
  /**
   * Open the tokenised URL in a browser once listening.
   *
   * Off by default, and opt-in from the CLI. Launching a browser is something a
   * person asked for by typing `aico serve`; a library call — a test harness, an
   * embedding process — did not, and a suite that opens a tab per run is a
   * suite people stop running.
   */
  open?: boolean;
}

/**
 * Open the tokenised URL in the default browser.
 *
 * This option existed from the start and was never implemented, which is why
 * launching `aico serve` and then navigating to the bare address landed people
 * on the token prompt: the one link that carries the token was printed to a
 * terminal and never followed. Opening it is the difference between a security
 * measure and an obstacle.
 *
 * Best effort by design. A machine with no browser — a container, a remote
 * shell — must not have its server fail because a helper is missing; the URL is
 * printed either way.
 */
function openBrowser(url: string): void {
  const [command, args] = process.platform === 'win32'
    // `start` is a cmd builtin, and its first quoted argument is the window
    // title — omitting it makes cmd treat the URL as the title and open nothing.
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no browser here; the printed URL is the fallback */ });
    child.unref();
  } catch {
    // Same reasoning: never let this stop the server.
  }
}

const HEARTBEAT_MS = 20_000;

export async function serve(opts: ServeOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const cwd = opts.cwd ?? process.cwd();
  const requestedPort = opts.port ?? 7317;
  // Filled once the socket is bound; the Origin check reads it, so it must be
  // the port actually listening rather than the one asked for.
  let port = requestedPort;
  const token = crypto.randomBytes(24).toString('base64url');
  const settings = await loadSettings();
  const defaultModel = settings.model
    ?? PROVIDER_DEFAULT_MODELS[settings.provider ?? 'openrouter']
    ?? 'deepseek-v4-flash';

  // Skills, MCP tools and the scheduler are process singletons that something
  // has to start. Doing it here rather than relying on the CLI's startup path
  // is what makes `serve()` usable as a library entry point — and is why the
  // web client sees the same skill set the terminal does.
  await initializeFeatures({
    settings,
    model: defaultModel,
    autoApprove: settings.autoApprove ?? false,
  });

  const hub = new EventHub();
  const runs = new RunManager(hub, settings);

  const heartbeat = setInterval(() => hub.heartbeat(), HEARTBEAT_MS);
  // The server should not be the reason the process refuses to exit.
  heartbeat.unref?.();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    // Reject cross-origin drivers outright. A same-origin page has no Origin
    // header on same-origin requests, so presence of a foreign one is the signal.
    const origin = req.headers.origin;
    if (origin && !origin.startsWith(`http://127.0.0.1:${port}`) && !origin.startsWith(`http://localhost:${port}`)) {
      send(res, 403, { error: 'cross-origin request refused' });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // Token may ride in a header (fetch) or the query string (EventSource,
      // which cannot set headers).
      const supplied = req.headers['x-aico-token'] ?? url.searchParams.get('token');
      if (supplied !== token) { send(res, 401, { error: 'bad or missing token' }); return; }
      await api(req, res, url);
      return;
    }

    serveStatic(url.pathname, res);
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = url.pathname.slice('/api/'.length);

    // ── SSE stream ────────────────────────────────────────────────────
    if (route === 'events' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session');
      if (!sessionId) { send(res, 400, { error: 'session required' }); return; }
      const since = Number(url.searchParams.get('since') ?? '0');

      const detach = hub.subscribe(sessionId, res);
      req.on('close', detach);

      // Replay the gap from the log before going live. The log is the history,
      // so this is a read rather than a buffer the server had to maintain.
      const run = await runs.ensure(sessionId, cwd);
      const missed = run.session.events.filter(e => e.seq > since);
      for (const event of missed) {
        res.write(`event: log\ndata: ${JSON.stringify({
          type: 'log', sessionId, seq: event.seq, data: { type: event.type, ...event.data as object },
        })}\n\n`);
      }
      // Tells the client where to resume from if this connection drops.
      res.write(`event: caught-up\ndata: ${JSON.stringify({
        type: 'caught-up', sessionId, seq: run.session.length, data: { busy: run.busy },
      })}\n\n`);
      return;
    }

    if (route === 'sessions' && req.method === 'GET') {
      const stored = await listSessionSummaries(cwd);
      const open = new Map(runs.list().map(r => [r.sessionId, r]));
      // A session opened this process but not yet written to disk still belongs
      // in the list — otherwise a brand-new conversation is invisible in the
      // sidebar until its first event lands.
      for (const run of open.values()) {
        if (!stored.some(s => s.id === run.sessionId)) {
          stored.unshift({ id: run.sessionId, updatedAt: Date.now(), turns: 0 });
        }
      }
      send(res, 200, {
        sessions: stored.map(summary => {
          // The in-process record is fresher than the log scan: a title written
          // moments ago may not have been flushed to disk yet.
          const live = runs.titleOf(summary.id);
          return {
            ...summary,
            ...(live ? { title: live.title, titleSource: live.source } : {}),
            running: open.get(summary.id)?.busy === true,
            open: open.has(summary.id),
          };
        }),
        active: [...open.keys()],
      });
      return;
    }

    // ── trajectory ────────────────────────────────────────────────────
    if (route === 'trajectory' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) { send(res, 400, { error: 'id required' }); return; }
      await runs.ensure(sessionId, cwd);
      const view = runs.trajectoryOf(sessionId);
      if (!view) { send(res, 404, { error: 'no such session' }); return; }

      // Paged from the tail: a long session holds tens of thousands of events
      // and the view opens on the most recent ones. `before` walks backwards.
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '500'), 2000);
      const before = Number(url.searchParams.get('before') ?? String(Number.MAX_SAFE_INTEGER));
      const page = view.events.filter(e => e.seq < before).slice(-limit);

      send(res, 200, {
        events: page,
        steps: view.steps,
        deliverables: view.deliverables,
        total: view.events.length,
        // Whether an older page exists, so the client can offer to load it
        // rather than guessing from a short page.
        hasMore: page.length > 0 && page[0]!.seq > (view.events[0]?.seq ?? 0),
        goal: runs.goalOf(sessionId) ?? null,
        feedback: runs.feedbackOf(sessionId),
      });
      return;
    }

    if (route === 'session/export' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) { send(res, 400, { error: 'id required' }); return; }
      const format = url.searchParams.get('format') === 'txt' ? 'txt' : 'md';
      const run = await runs.ensure(sessionId, cwd);
      const { toMarkdown, toPlainText, exportFilename } = await import('../session/export.js');
      const body = format === 'txt' ? toPlainText(run.session) : toMarkdown(run.session);
      // Content-Disposition makes the browser save it rather than render it,
      // which is the whole point of an export rather than a view.
      res.writeHead(200, {
        'Content-Type': format === 'txt'
          ? 'text/plain; charset=utf-8'
          : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(run.session, format)}"`,
      });
      res.end(body);
      return;
    }

    if (route === 'session/rename' && req.method === 'POST') {
      const { sessionId, title } = await readJson(req) as { sessionId?: string; title?: string };
      if (!sessionId || !title) { send(res, 400, { error: 'sessionId and title required' }); return; }
      await runs.ensure(sessionId, cwd);
      send(res, 200, { renamed: runs.rename(sessionId, title) });
      return;
    }

    if (route === 'session' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) { send(res, 400, { error: 'id required' }); return; }
      const run = await runs.ensure(sessionId, cwd);
      send(res, 200, {
        sessionId,
        seq: run.session.length,
        busy: run.busy,
        messages: deriveMessages(run.session.events),
        // Cost is not part of the raw usage record because it depends on the
        // model, which the tracker does not own. Included here so a reopened
        // session shows what it has cost rather than starting from zero.
        usage: {
          ...run.tokenTracker.getUsage(),
          costUsd: run.tokenTracker.estimateCost(settings.model ?? defaultModel),
        },
      });
      return;
    }

    // Settings, provider onboarding, and system state. Consulted before the
    // POST guard because several of these are reads.
    const systemBody = req.method === 'POST' ? await readJson(req) : {};
    const handled = await handleSystemRoute(route, req.method ?? 'GET', systemBody as Record<string, unknown>);
    if (handled) { send(res, handled.status, handled.body); return; }

    if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
    const body = systemBody;

    switch (route) {
      case 'submit': {
        const { sessionId, task, model } = body as { sessionId?: string; task?: string; model?: string };
        if (!sessionId || !task) { send(res, 400, { error: 'sessionId and task required' }); return; }
        // Answer immediately and let the work stream. A ten-minute turn must
        // not be held open on a request that any proxy or browser will time out.
        send(res, 202, { accepted: true });
        void runs.submit(sessionId, cwd, task, model ?? defaultModel, {
          planMode: (body as { planMode?: boolean }).planMode ?? false,
          autoApprove: (body as { autoApprove?: boolean }).autoApprove ?? true,
        }).catch(() => { /* already reported on the stream as turn-end */ });
        return;
      }
      case 'goal': {
        const { sessionId, text, status } = body as {
          sessionId?: string; text?: string; status?: 'active' | 'paused' | 'cleared';
        };
        if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
        const next = status ?? 'active';
        if (next !== 'cleared' && !text?.trim()) {
          send(res, 400, { error: 'text required unless clearing' });
          return;
        }
        await runs.ensure(sessionId, cwd);
        send(res, 200, { ok: runs.setGoal(sessionId, text?.trim() ?? '', next) });
        return;
      }
      case 'feedback': {
        const { sessionId, targetSeq, rating, note } = body as {
          sessionId?: string; targetSeq?: number; rating?: 'up' | 'down' | 'none'; note?: string;
        };
        if (!sessionId || typeof targetSeq !== 'number') {
          send(res, 400, { error: 'sessionId and targetSeq required' });
          return;
        }
        if (rating !== 'up' && rating !== 'down' && rating !== 'none') {
          send(res, 400, { error: 'rating must be up, down or none' });
          return;
        }
        await runs.ensure(sessionId, cwd);
        send(res, 200, { ok: runs.rate(sessionId, targetSeq, rating, note) });
        return;
      }
      case 'cancel': {
        const { sessionId } = body as { sessionId?: string };
        send(res, 200, { cancelled: sessionId ? runs.cancel(sessionId) : false });
        return;
      }
      case 'steer':
      case 'followup': {
        const { sessionId, content } = body as { sessionId?: string; content?: string };
        if (!sessionId || !content) { send(res, 400, { error: 'sessionId and content required' }); return; }
        const ok = route === 'steer'
          ? runs.steer(sessionId, content)
          : runs.followup(sessionId, content);
        send(res, 200, { ok });
        return;
      }
      default:
        send(res, 404, { error: `unknown route ${route}` });
    }
  }

  /** Serve the built web client, when one has been built. */
  function serveStatic(pathname: string, res: http.ServerResponse): void {
    const root = webRoot();
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(root, rel);
    // Contain path traversal: a request for ../../etc/passwd resolves outside
    // the root, and this is the check that notices.
    if (!file.startsWith(root)) { send(res, 403, { error: 'forbidden' }); return; }

    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      const index = path.join(root, 'index.html');
      if (fs.existsSync(index)) { streamFile(index, res); return; }
      send(res, 404, {
        error: 'web client not built',
        hint: 'run `npm run build:web`, or use the API directly with the token',
      });
      return;
    }
    streamFile(file, res);
  }

  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  // Port 0 asks the OS for any free port, so the real one has to be read back
  // rather than echoed. Without this the printed URL would say ":0" and the
  // Origin check would compare against a port nothing is listening on.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : requestedPort;
  port = boundPort;
  const url = `http://127.0.0.1:${boundPort}/?token=${token}`;

  if (opts.open) openBrowser(url);

  return {
    url,
    close: async () => {
      clearInterval(heartbeat);
      hub.closeAll();
      await runs.closeAll();
      shutdownFeatures();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Locate the built web client by walking up from this module.
 *
 * A fixed `../../web-dist` was wrong, and wrong differently depending on how
 * the code was loaded: the bundler emits a single `dist/index.js` (one level
 * down), the TypeScript sources sit at `src/server/` (two levels), and a test
 * build lands somewhere else again. Each layout needs a different number of
 * `..`, so the number is discovered rather than assumed.
 *
 * Bounded at six levels — deep enough for any of those layouts, shallow enough
 * that a missing build fails fast instead of scanning toward the filesystem
 * root.
 */
function webRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  let dir = here;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'web-dist');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing built yet. Return the conventional location so the 404 below can
  // name it in its hint rather than pointing at wherever the search stopped.
  return path.resolve(here, '../../web-dist');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function streamFile(file: string, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Read a JSON body, capped so a malformed client cannot exhaust memory. */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const MAX = 8 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}
