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
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { EventHub } from './events.js';
import { RunManager } from './runs.js';
import { deriveMessages } from '../session/derive.js';
import { forkSession, listSessionSummaries, loadEventLog } from '../session/persistence.js';
import { trajectory as projectTrajectory } from '../session/projections.js';
import { loadSettings } from '../settings.js';
import { activeProviderType } from '../providers/instances.js';
import type { ImageRef } from '../providers/types.js';
import {
  addProject, browse, findProjectForSession, isKnownProject, listProjects,
  normalizeProjectPath, removeProject, updateProject,
} from './projects.js';
import { createGroup, deleteGroup, listGroups, updateGroup } from './groups.js';
import { PROVIDER_DEFAULT_MODELS } from '../providers/index.js';
import { handleSystemRoute } from './api-system.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import { initializeFeatures, shutdownFeatures } from '../bootstrap.js';
import { startMiniAppServer, type MiniAppServer } from '../miniapps/server.js';
import { deleteMiniApp, listMiniApps } from '../miniapps/store.js';

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
  /**
   * The model a turn uses when the client names none.
   *
   * Re-read rather than captured, for the same reason the run's settings are:
   * the settings screen writes to disk, and a value frozen at boot makes the
   * screen a liar until the process is restarted.
   */
  async function currentDefaultModel(): Promise<string> {
    try {
      const live = await loadSettings();
      return live.model
        ?? PROVIDER_DEFAULT_MODELS[live.activeProvider ?? live.provider ?? 'openrouter']
        ?? defaultModel;
    } catch {
      return defaultModel;
    }
  }

  const runs = new RunManager(hub, settings);

  /**
   * Which directory each session belongs to.
   *
   * Derived rather than stored: sessions are already filed on disk under their
   * directory, so enumerating projects tells us the mapping. The cache is a
   * memo of that enumeration so every subsequent request for a known session
   * does not have to rescan, and it is populated on the first `/api/sessions`
   * call the client makes — which the client makes before it can name a session
   * at all.
   */
  const sessionCwd = new Map<string, string>();

  /**
   * The directory a request should run in.
   *
   * An explicit `project` wins, but only if the server already knows it. That
   * check is the difference between "drive the folder the user opened" and
   * "start an agent anywhere on the filesystem, chosen by the caller".
   */
  /**
   * A session's run, but only if one already exists.
   *
   * Reading a transcript must not *open* a session. `ensure` fixes a run's
   * directory for its whole life, so any request that creates one is deciding
   * which folder the agent will work in — and a metadata read has no idea. The
   * client fires `GET /api/session` concurrently with the event subscription,
   * so whichever arrived first won that decision, and the read had no `project`
   * to go on. A session opened in a folder the user had just chosen was filed
   * under the directory the server was launched in, roughly half the time.
   *
   * Returns null when nothing is open, and callers answer from the log on disk
   * or with an empty snapshot — which is the honest answer for a session that
   * has never run anything.
   */
  function peek(sessionId: string): ReturnType<typeof runs.get> {
    return runs.get(sessionId);
  }

  /**
   * Where a web session works when nobody has said otherwise.
   *
   * The launch directory is the right default for the CLI — you typed `aico`
   * inside a repository, so that repository is the subject. It is the wrong
   * one for the portal, which you may have left running for days and which is
   * reached from a browser that has no idea where the server was started. A
   * session opened there was silently pointed at whatever folder the process
   * happened to be launched in, which is how "it ignores my workspace" happens.
   *
   * So the portal falls back to the workspace — the configured path if there
   * is one, and the per-project workspace under ~/.aico otherwise. Both are
   * places the agent is meant to write. Picking a project in the sidebar still
   * wins; this only decides what happens when nothing was picked.
   */
  const webDefaultDir = resolveWorkspaceRoot(settings, cwd);
  try {
    // Created up front: a default directory that does not exist turns the
    // first tool call into an error about a path nobody chose.
    fs.mkdirSync(webDefaultDir, { recursive: true });
  } catch {
    // If it cannot be made, resolveCwd falls back to the launch directory
    // below rather than leaving sessions with nowhere to run.
  }

  async function resolveCwd(sessionId: string, requested?: string | null): Promise<string> {
    if (requested && await isKnownProject(cwd, requested)) {
      const target = normalizeProjectPath(requested);
      sessionCwd.set(sessionId, target);
      return target;
    }
    const remembered = sessionCwd.get(sessionId);
    if (remembered) return remembered;

    // Nothing told us, so look. A session already on disk names its own
    // directory by where its log lives, and finding it is the only thing
    // standing between a reload and an empty transcript.
    const found = await findProjectForSession(cwd, sessionId);
    if (found) {
      sessionCwd.set(sessionId, found);
      return found;
    }
    // The workspace, not the launch directory. See webDefaultDir above.
    return fs.existsSync(webDefaultDir) ? webDefaultDir : cwd;
  }

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
      const run = await runs.ensure(sessionId, await resolveCwd(sessionId, url.searchParams.get('project')));
      const missed = run.session.events.filter(e => e.seq > since);
      for (const event of missed) {
        res.write(`event: log\ndata: ${JSON.stringify({
          type: 'log', sessionId, seq: event.seq, data: { type: event.type, ...event.data as object },
        })}\n\n`);
      }
      // Tells the client where to resume from if this connection drops.
      res.write(`event: caught-up\ndata: ${JSON.stringify({
        type: 'caught-up',
        sessionId,
        seq: run.session.length,
        // The agent and the model ride along here rather than needing fetches
        // of their own: this frame already says "here is where you stand", and
        // a reconnect that restored the transcript but forgot who you were
        // talking to — or on what — would silently put you back on the
        // defaults without saying so.
        data: {
          busy: run.busy,
          agent: runs.agentOf(sessionId) ?? null,
          model: runs.modelOf(sessionId) ?? null,
        },
      })}\n\n`);
      return;
    }

    if (route === 'projects' && req.method === 'GET') {
      send(res, 200, { projects: await listProjects(cwd), launch: normalizeProjectPath(cwd) });
      return;
    }

    if (route === 'groups' && req.method === 'GET') {
      send(res, 200, { groups: await listGroups() });
      return;
    }

    if (route === 'miniapps' && req.method === 'GET') {
      // `host` is null when the plugin is off, and the panel says so rather
      // than listing apps behind links that would not resolve. Read live so
      // turning the switch on and restarting is enough — no rebuild.
      const live = await loadSettings();
      send(res, 200, {
        enabled: live.miniApps?.enabled === true,
        host: miniApps?.url ?? null,
        apps: await listMiniApps(live, cwd),
      });
      return;
    }

    if (route === 'miniapps/delete' && req.method === 'POST') {
      const body = await readJson(req) as { slug?: string };
      if (!body.slug) { send(res, 400, { error: 'slug required' }); return; }
      const live = await loadSettings();
      send(res, 200, { deleted: await deleteMiniApp(body.slug, live, cwd) });
      return;
    }

    if (route === 'fs/browse' && req.method === 'GET') {
      send(res, 200, browse(url.searchParams.get('path') ?? undefined));
      return;
    }

    if (route === 'sessions' && req.method === 'GET') {
      // Every known project, not just the launch directory: the sidebar groups
      // by project, and a project with no visible sessions is indistinguishable
      // from one that was never added.
      const projects = await listProjects(cwd);
      const stored = (await Promise.all(projects.map(async project => {
        const rows = project.exists ? await listSessionSummaries(project.path).catch(() => []) : [];
        return rows.map(row => ({ ...row, project: project.path }));
      }))).flat();
      stored.sort((a, b) => b.updatedAt - a.updatedAt);
      for (const row of stored) sessionCwd.set(row.id, row.project);
      const open = new Map(runs.list().map(r => [r.sessionId, r]));
      // A session opened this process but not yet written to disk still belongs
      // in the list — otherwise a brand-new conversation is invisible in the
      // sidebar until its first event lands.
      for (const run of open.values()) {
        if (!stored.some(s => s.id === run.sessionId)) {
          stored.unshift({ id: run.sessionId, updatedAt: Date.now(), turns: 0, project: run.cwd });
        }
      }
      const groups = await listGroups();
      send(res, 200, {
        projects,
        groups,
        sessions: stored.map(summary => {
          // The in-process record is fresher than the log scan: a title written
          // moments ago may not have been flushed to disk yet.
          const live = runs.titleOf(summary.id);
          const archived = runs.archivedOf(summary.id);
          const group = runs.groupOf(summary.id);
          return {
            ...summary,
            ...(live ? { title: live.title, titleSource: live.source } : {}),
            ...(archived === undefined ? {} : { archived }),
            // `null` is a real answer — taken out of a group — and has to
            // beat the value the log scan found, hence the explicit check.
            ...(group === undefined ? {} : { group: group ?? undefined }),
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
      if (!peek(sessionId)) {
        const stored = await loadEventLog(sessionId, await resolveCwd(sessionId)).catch(() => null);
        if (!stored) { send(res, 404, { error: 'no such session' }); return; }
        send(res, 200, projectTrajectory(stored));
        return;
      }
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

    if (route === 'changes' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) { send(res, 400, { error: 'id required' }); return; }
      const cwd = await resolveCwd(sessionId);
      // Marked, not filtered: a conflicting edit of the reader's own sitting in
      // the same tree is exactly the case where a revert is dangerous, so it is
      // listed too.
      const opened = peek(sessionId)?.session
        ?? await loadEventLog(sessionId, cwd).catch(() => null);
      const { deliverables } = await import('../session/projections.js');
      const written = opened
        ? deliverables(opened).map(d => path.resolve(cwd, d.path))
        : [];
      const { listChanges } = await import('./changes.js');
      send(res, 200, await listChanges(cwd, written));
      return;
    }

    if (route === 'changes/diff' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      const file = url.searchParams.get('path');
      if (!sessionId || !file) { send(res, 400, { error: 'id and path required' }); return; }
      const { diffOf } = await import('./changes.js');
      try {
        send(res, 200, { diff: await diffOf(await resolveCwd(sessionId), file) });
      } catch (err) {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (route === 'session/export' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) { send(res, 400, { error: 'id required' }); return; }
      const format = url.searchParams.get('format') === 'txt' ? 'txt' : 'md';
      const opened = peek(sessionId)?.session
        ?? await loadEventLog(sessionId, await resolveCwd(sessionId)).catch(() => null);
      if (!opened) { send(res, 404, { error: 'no such session' }); return; }
      const { toMarkdown, toPlainText, exportFilename } = await import('../session/export.js');
      const body = format === 'txt' ? toPlainText(opened) : toMarkdown(opened);
      // Content-Disposition makes the browser save it rather than render it,
      // which is the whole point of an export rather than a view.
      res.writeHead(200, {
        'Content-Type': format === 'txt'
          ? 'text/plain; charset=utf-8'
          : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(opened, format)}"`,
      });
      res.end(body);
      return;
    }

    if (route === 'session/rename' && req.method === 'POST') {
      const { sessionId, title } = await readJson(req) as { sessionId?: string; title?: string };
      if (!sessionId || !title) { send(res, 400, { error: 'sessionId and title required' }); return; }
      await runs.ensure(sessionId, await resolveCwd(sessionId));
      send(res, 200, { renamed: runs.rename(sessionId, title) });
      return;
    }

    if (route === 'session/archive' && req.method === 'POST') {
      const { sessionId, archived } = await readJson(req) as
        { sessionId?: string; archived?: boolean };
      if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
      await runs.ensure(sessionId, await resolveCwd(sessionId));
      send(res, 200, { archived: runs.setArchived(sessionId, archived !== false) });
      return;
    }

    if (route === 'session/fork' && req.method === 'POST') {
      const { sessionId, throughTurn } = await readJson(req) as {
        sessionId?: string; throughTurn?: number;
      };
      if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
      // A branch point, when the reader picked one. Validated rather than
      // trusted: a negative or fractional turn would silently produce an empty
      // session, and `forkSession` compares it against real turn numbers.
      if (throughTurn !== undefined
          && (!Number.isInteger(throughTurn) || throughTurn < 0)) {
        send(res, 400, { error: 'throughTurn must be a non-negative integer' });
        return;
      }
      const sourceCwd = await resolveCwd(sessionId);
      // A running turn is still writing the history being copied, so the fork
      // would be a transcript cut off mid-sentence. Refused rather than
      // silently snapshotted.
      if (runs.get(sessionId)?.busy) {
        send(res, 409, { error: 'Wait for the current turn to finish before forking' });
        return;
      }
      // Flushed and released first: the log on disk is what gets copied, and a
      // session with events still in memory would fork a transcript missing its
      // own last words.
      await runs.release(sessionId);
      try {
        const forked = await forkSession(
          sessionId, sourceCwd, `fork-${Date.now().toString(36)}`,
          throughTurn === undefined ? {} : { throughTurn },
        );
        sessionCwd.set(forked.id, sourceCwd);
        send(res, 200, { ...forked, project: sourceCwd });
      } catch (err) {
        send(res, 400, { error: (err as Error).message });
      }
      return;
    }

    if (route === 'session' && req.method === 'GET') {
      const sessionId = url.searchParams.get('id');
      if (!sessionId) { send(res, 400, { error: 'id required' }); return; }
      const run = peek(sessionId);
      if (!run) {
        // Never opened in this process. Read the log if there is one; a session
        // that has never run reports nothing, which is what it has.
        const stored = await loadEventLog(sessionId, await resolveCwd(sessionId)).catch(() => null);
        send(res, 200, {
          sessionId,
          seq: stored?.length ?? 0,
          busy: false,
          messages: stored ? deriveMessages(stored.events) : [],
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        });
        return;
      }
      send(res, 200, {
        sessionId,
        seq: run.session.length,
        busy: run.busy,
        agent: runs.agentOf(sessionId) ?? null,
        // Null means this session never expressed a preference, which is not
        // the same as having chosen whatever the default currently is — the
        // default can move, and a session that picked deliberately should not.
        model: runs.modelOf(sessionId) ?? null,
        messages: deriveMessages(run.session.events),
        // Cost is not part of the raw usage record because it depends on the
        // model, which the tracker does not own. Included here so a reopened
        // session shows what it has cost rather than starting from zero.
        usage: {
          ...run.tokenTracker.getUsage(),
          costUsd: run.tokenTracker.estimateCost(settings.model ?? defaultModel, settings),
          costEstimated: run.tokenTracker.isEstimated(
            settings.model ?? defaultModel, settings, activeProviderType(settings),
          ),
          usageEstimated: run.tokenTracker.hasEstimatedUsage(),
        },
      });
      return;
    }

    // Settings, provider onboarding, and system state. Consulted before the
    // POST guard because several of these are reads.
    const systemBody = req.method === 'POST' ? await readJson(req) : {};
    const handled = await handleSystemRoute(route, req.method ?? 'GET', systemBody as Record<string, unknown>, url.searchParams);
    if (handled) { send(res, handled.status, handled.body); return; }

    if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
    const body = systemBody;

    switch (route) {
      case 'projects/add': {
        const { path: dir, name } = body as { path?: string; name?: string };
        if (!dir) { send(res, 400, { error: 'path required' }); return; }
        try {
          send(res, 200, { project: await addProject(dir, name) });
        } catch (err) {
          send(res, 400, { error: (err as Error).message });
        }
        return;
      }
      case 'groups/create': {
        const { name, cwd: groupCwd } = body as { name?: string; cwd?: string };
        if (!name?.trim()) { send(res, 400, { error: 'name required' }); return; }
        try {
          send(res, 200, { group: await createGroup(name, groupCwd) });
        } catch (err) {
          send(res, 400, { error: (err as Error).message });
        }
        return;
      }
      case 'groups/update': {
        const { id, ...patch } = body as {
          id?: string; name?: string; color?: string; pinned?: boolean;
          description?: string; instructions?: string; cwd?: string;
        };
        if (!id) { send(res, 400, { error: 'id required' }); return; }
        send(res, 200, { updated: await updateGroup(id, patch) });
        return;
      }
      case 'groups/delete': {
        const { id } = body as { id?: string };
        if (!id) { send(res, 400, { error: 'id required' }); return; }
        send(res, 200, { deleted: await deleteGroup(id) });
        return;
      }
      case 'session/group': {
        const { sessionId, group } = body as { sessionId?: string; group?: string | null };
        if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
        await runs.ensure(sessionId, await resolveCwd(sessionId));
        send(res, 200, { moved: runs.setGroup(sessionId, group ?? null) });
        return;
      }
      case 'projects/rename':
      case 'projects/update': {
        const { path: dir, ...patch } = body as {
          path?: string; name?: string; pinned?: boolean; color?: string;
          description?: string; instructions?: string;
        };
        if (!dir) { send(res, 400, { error: 'path required' }); return; }
        send(res, 200, { updated: await updateProject(dir, patch) });
        return;
      }
      case 'projects/remove': {
        const { path: dir } = body as { path?: string };
        if (!dir) { send(res, 400, { error: 'path required' }); return; }
        if (normalizeProjectPath(dir) === normalizeProjectPath(cwd)) {
          send(res, 400, { error: 'the directory the server was launched in cannot be removed' });
          return;
        }
        send(res, 200, { removed: await removeProject(dir) });
        return;
      }
      case 'submit': {
        const { sessionId, task, model } = body as { sessionId?: string; task?: string; model?: string };
        if (!sessionId || !task) { send(res, 400, { error: 'sessionId and task required' }); return; }
        // Answer immediately and let the work stream. A ten-minute turn must
        // not be held open on a request that any proxy or browser will time out.
        send(res, 202, { accepted: true });
        const runCwd = await resolveCwd(sessionId, (body as { project?: string }).project);
        // Resolved now, not at boot. Choosing a different model in settings
        // has to affect the next turn rather than the next restart.
        //
        // Three sources, most specific first: what this request asked for, what
        // this session was set to, and the configured default. The middle one
        // is what makes a session keep its model — without it a turn submitted
        // from a client that forgot to name one silently reverted to the
        // default, which is how the choice looked like it had been applied and
        // then quietly had not.
        await runs.ensure(sessionId, runCwd);
        if (model) runs.setModel(sessionId, model);
        const chosen = model ?? runs.modelOf(sessionId) ?? await currentDefaultModel();

        // Resolved to real paths and appended to the task, so the model is told
        // what it has and where, and reads any of it only if the question needs
        // it. Failing to resolve must not lose the message: the turn runs
        // without the manifest and the reason is said out loud.
        let task2 = task;
        let pictures: ImageRef[] = [];
        const attachmentIds = (body as { attachmentIds?: string[] }).attachmentIds ?? [];
        if (attachmentIds.length > 0) {
          try {
            const { resolveAttachments, attachmentManifest, isImage, IMAGE_MEDIA_TYPES } =
              await import('./attachments.js');
            const settings = await loadSettings();
            const files = await resolveAttachments({
              settings, cwd: runCwd, sessionId, ids: attachmentIds,
            });

            // Two kinds of attachment, handled two ways. A document is named in
            // the manifest and read on demand, because most questions do not
            // need all of a hundred-page PDF. A picture is the opposite: an
            // image nobody looked at is an image that did nothing, and there is
            // no cheap summary of one to offer first.
            const documents = files.filter(file => !isImage(file.extension));
            const images = files.filter(file => isImage(file.extension));
            task2 = task + attachmentManifest(documents);

            // References, not bytes. The log records these, and the run reads
            // the bytes back through `resolveImages` below — which is what lets
            // a session reopened tomorrow still show the model the screenshot.
            pictures = images.map(file => ({
              id: file.id,
              mediaType: IMAGE_MEDIA_TYPES[file.extension]!,
              name: file.name,
            }));
          } catch (err) {
            task2 = `${task}

[Attachments could not be attached: ${
              err instanceof Error ? err.message : String(err)}]`;
          }
        }

        // Settled before the turn starts, so the completion gate reads a list
        // that already reflects the instruction the model is about to be given.
        // Done here rather than by matching the message text: the wording is
        // written for the model, and prose written to be read gets reworded.
        const retire = (body as { retireTasks?: 'done' | 'cancelled' }).retireTasks;
        if (retire === 'done' || retire === 'cancelled') {
          try {
            const { retireTodos } = await import('../tools/todo.js');
            await retireTodos(retire, sessionId);
          } catch {
            // The message still goes through. A list that failed to settle
            // makes the gate noisier, not the turn wrong.
          }
        }

        void runs.submit(sessionId, runCwd, task2, chosen, {
          planMode: (body as { planMode?: boolean }).planMode ?? false,
          autoApprove: (body as { autoApprove?: boolean }).autoApprove ?? true,
          ...(pictures.length ? { images: pictures } : {}),
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
        await runs.ensure(sessionId, await resolveCwd(sessionId));
        send(res, 200, { ok: runs.setGoal(sessionId, text?.trim() ?? '', next) });
        return;
      }
      /**
       * Files the user attached in the composer.
       *
       * Held per session rather than sent with the message: a document is
       * context for a conversation, not for one turn, and re-uploading a
       * specification to ask a second question about it is the kind of thing
       * people stop doing rather than tolerate.
       */
      case 'attachments/upload': {
        const { sessionId, name, base64, mimeType } = body as {
          sessionId?: string; name?: string; base64?: string; mimeType?: string;
        };
        if (!sessionId || !name || !base64) {
          send(res, 400, { error: 'sessionId, name and base64 required' });
          return;
        }
        try {
          const { storeAttachment } = await import('./attachments.js');
          const settings = await loadSettings();
          const stored = await storeAttachment({
            settings, cwd: await resolveCwd(sessionId), sessionId, name, base64,
            ...(mimeType ? { mimeType } : {}),
          });
          send(res, 200, { ok: true, attachment: stored });
        } catch (err) {
          send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      case 'attachments/remove': {
        const { sessionId, id } = body as { sessionId?: string; id?: string };
        if (!sessionId || !id) { send(res, 400, { error: 'sessionId and id required' }); return; }
        try {
          const { removeAttachment } = await import('./attachments.js');
          const settings = await loadSettings();
          const removed = await removeAttachment({
            settings, cwd: await resolveCwd(sessionId), sessionId, id,
          });
          send(res, 200, { ok: removed });
        } catch (err) {
          send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      case 'model': {
        const { sessionId, model } = body as { sessionId?: string; model?: string | null };
        if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
        await runs.ensure(sessionId, await resolveCwd(sessionId));
        // An explicit null is "stop pinning this session" — the same shape the
        // agent route uses for going back to the orchestrator. A missing or
        // blank model means the same thing rather than being an error, because
        // there is no other sensible reading of it.
        const result = runs.setModel(sessionId, model?.trim() ? model.trim() : null);
        send(res, result.ok ? 200 : 400, result);
        return;
      }
      case 'agent': {
        const { sessionId, name } = body as { sessionId?: string; name?: string | null };
        if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
        await runs.ensure(sessionId, await resolveCwd(sessionId));
        const result = await runs.setAgent(sessionId, name?.trim() ? name.trim() : null);
        send(res, result.ok ? 200 : 400, result);
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
        await runs.ensure(sessionId, await resolveCwd(sessionId));
        send(res, 200, { ok: runs.rate(sessionId, targetSeq, rating, note) });
        return;
      }
      case 'cancel': {
        const { sessionId } = body as { sessionId?: string };
        send(res, 200, { cancelled: sessionId ? runs.cancel(sessionId) : false });
        return;
      }
      case 'changes/revert': {
        // Destructive, and deliberately narrow: one named path, and deleting a
        // new file has to be asked for separately because "revert" and "delete"
        // are not the same promise.
        const { sessionId, path: file, deleteUntracked } = body as {
          sessionId?: string; path?: string; deleteUntracked?: boolean;
        };
        if (!sessionId || !file) { send(res, 400, { error: 'sessionId and path required' }); return; }
        const { revertFile } = await import('./changes.js');
        const outcome = await revertFile(await resolveCwd(sessionId), file,
          { deleteUntracked: deleteUntracked === true });
        send(res, outcome.ok ? 200 : 400, outcome);
        return;
      }
      case 'answer': {
        // The agent asked something and is blocked. Separate from steer because
        // it resolves a specific waiting promise rather than joining the queue —
        // steering an answer would deliver it at the next step boundary, which
        // is a boundary the turn cannot reach while it is waiting.
        const { sessionId, content } = body as { sessionId?: string; content?: string };
        if (!sessionId || content === undefined) {
          send(res, 400, { error: 'sessionId and content required' }); return;
        }
        send(res, 200, { ok: runs.answer(sessionId, content) });
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
    // the root, and this is the check that notices. Compared against
    // `root + separator` rather than `root`, because a bare prefix test also
    // accepts a sibling — `web-dist-backup` starts with `web-dist`.
    if (file !== root && !file.startsWith(root + path.sep)) {
      send(res, 403, { error: 'forbidden' });
      return;
    }

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

  /**
   * The Mini Apps host, when the plugin is on.
   *
   * Started after the main socket is bound so it can default to one port above
   * whatever we actually got — asking for 7317 and being given 7319 should not
   * put the apps on a port belonging to something else.
   *
   * A failure here is reported and survived. Mini Apps are an extra; the port
   * being taken is not a reason the portal should refuse to start.
   */
  let miniApps: MiniAppServer | undefined;
  async function startMiniApps(boundPort: number): Promise<void> {
    if (!settings.miniApps?.enabled) return;
    try {
      miniApps = await startMiniAppServer({ settings, cwd, sisterPort: boundPort });
      console.log(`  Mini Apps  ${miniApps.url}`);
    } catch (err) {
      console.warn(`  Mini Apps failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  // Port 0 asks the OS for any free port, so the real one has to be read back
  // rather than echoed. Without this the printed URL would say ":0" and the
  // Origin check would compare against a port nothing is listening on.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : requestedPort;
  port = boundPort;
  const url = `http://127.0.0.1:${boundPort}/?token=${token}`;

  await startMiniApps(boundPort);

  if (opts.open) openBrowser(url);

  return {
    url,
    close: async () => {
      clearInterval(heartbeat);
      hub.closeAll();
      await runs.closeAll();
      await miniApps?.close();
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
  // `fileURLToPath`, not manual URL surgery. The hand-rolled version stripped
  // the leading slash from a drive letter and stopped there, leaving every
  // percent-escape in place — so a user called "Suhail Akhtar" got
  // `C:/Users/Suhail%20Akhtar/...`, which matches no directory on earth, and
  // the portal answered "web client not built" while sitting next to a
  // perfectly good build. Most Windows home directories have a space in them.
  const here = path.dirname(fileURLToPath(import.meta.url));
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
