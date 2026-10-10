/**
 * The delivery board over HTTP (ADR 0038). Registered projects only.
 *
 *   GET   /api/delivery/board?project=              the BoardState
 *   POST  /api/delivery/tasks                       create a task (backlog)
 *   PATCH /api/delivery/tasks/:id                   edit; status backlog | ready | blocked | cancelled
 *   POST  /api/delivery/plan {project, brief}       a planning turn that fills the backlog -> {sessionId}
 *   POST  /api/delivery/dispatch {project, action}  start | pause the dispatcher            [person to start]
 *   POST  /api/delivery/tasks/:id/approve           land it on the trunk                    [person]
 *   POST  /api/delivery/tasks/:id/request-changes   {comment}                               [person]
 *   GET   /api/delivery/tasks/:id/diff?project=     {diff, files, live, truncated, note?}: live (uncommitted work included) while the task runs
 *   GET   /api/delivery/tasks/:id/activity?project= {activity}: the task's history, up to 200 lines
 *   PATCH /api/delivery/settings {project, autonomy?, wip?, budgetUsdPerDay?, pauseAfterFailures?, views?, maxParallel?}  [person to widen]
 *   POST  /api/delivery/tasks/:id/promote-prerequisites   Backlog prerequisites -> Ready, in one click -> {moved, stuck}   [person]
 *   POST  /api/delivery/tasks/:id/resolve-landing {choice}  after a refused landing: keep-mine | take-task                 [person]
 *   POST  /api/delivery/tasks/:id/duplicate         a copy in the backlog
 *   POST  /api/delivery/tasks/reorder {project, status, ids}  a column's new order
 *   PATCH /api/delivery/tasks/bulk {project, ids, patch}      one patch for many tasks -> {tasks, failed}
 *   GET   /api/delivery/events?project=             SSE: `delivery/board` frames (BoardState), a full one first
 *   POST  /api/delivery/approve-batch {project, ids}  land several low-risk, green tasks with one yes [person]
 *   POST  /api/delivery/tasks/:id/comment {text}    a person's note on the task's thread          [person]
 *   GET   /api/delivery/releases?project=[&version=]  {releases, plan}: what was released, what a release would be
 *   POST  /api/delivery/releases {project, version?, changelog?}  version bump + notes + local tag  [person]
 *   POST  /api/delivery/releases/:version/deploy    run the project's deploy command                [person]
 *   POST  /api/delivery/releases/:version/rollback  a task that reverts the release's commits       [person]
 *   GET   /api/delivery/attention                   compact state of every board, for notifications (no project)
 *   POST  /api/delivery/tasks/:id/merge-pr {method?}  ask the remote to merge the task's pull request (PR mode; the remote may refuse) [person]
 *
 * WHO MAY SAY YES. The model can `curl` the loopback port and may learn the token, so
 * the acts that matter ask the decision gate for a person (`checkHuman`, the same
 * as Fix all and long-job approval): starting the dispatcher (it lets the board spend
 * money; raising `maxParallel` counts as starting), approving, alone or as a batch (it
 * moves the trunk), requesting changes (it restarts a run), a person's comment (it goes
 * into an agent's prompt as the person's word), and the three release acts: making the
 * release (it moves the trunk and creates a tag), deploying it (it runs a command) and
 * rolling it back (it creates a task that reverts it). Pausing needs only the token:
 * refusing to spend is always safe. The desktop mints a grant for exactly these routes (HUMAN_ROUTES).
 *
 * The folder must be a project the server already knows (`isKnownProject`), as for
 * every route that takes one: without that it would run git in any directory on the
 * machine. Task ids are 8 hex characters and are checked before they reach a path.
 *
 * @module server/delivery-routes
 */

import type http from 'node:http';
import path from 'node:path';
import * as D from '../delivery/index.js';
import { withConnection } from '../connections/sync.js';
import { kickProject } from '../connections/poller.js';
import { handleScrumRoute } from './scrum-routes.js';

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export interface DeliveryRouteDeps {
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
  isKnownProject: (dir: string) => Promise<boolean>;
  /** Is a person behind this request? Given the parsed body (the client nonce may ride in it). */
  human: (req: http.IncomingMessage, body: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
  /** Start the planning chat turn; resolves with its session id. */
  startPlan: (project: string, brief: string, kind?: 'plan' | 'refine') => Promise<{ sessionId: string }>;
  /** Attach an SSE response to the project's board topic; returns the detach. */
  subscribe: (project: string, res: http.ServerResponse) => () => void;
}

const TASK_ID = /^[a-f0-9]{8}$/;
const HUMAN_REQUIRED = 'This needs a person in the AICO window; the API token alone cannot do it.';

export async function handleDeliveryRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: DeliveryRouteDeps,
): Promise<boolean> {
  if (!route.startsWith('delivery/')) return false;
  // Sprints, estimates and suggestions (ADR 0039 section 4) have their own file; the same gate and project rules apply there.
  if (await handleScrumRoute(route, req, res, url, deps)) return true;
  const { send } = deps;
  const method = req.method ?? 'GET';
  const known = route === 'delivery/board' || route === 'delivery/tasks' || route === 'delivery/plan' || route === 'delivery/dispatch'
    || route === 'delivery/events' || route === 'delivery/approve-batch' || route === 'delivery/settings' || route === 'delivery/releases' || route === 'delivery/attention'
    || route.startsWith('delivery/tasks/') || route.startsWith('delivery/releases/');
  if (!known) { send(res, 404, { error: 'not found' }); return true; }
  try {
    const body = (method === 'GET' ? {} : await deps.readJson(req)) as Record<string, unknown>;
    if (route === 'delivery/attention') {
      // Not about one project: the compact state of every registered board, for a client that raises notifications.
      if (method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
      const allowed = new Set<string>();
      for (const p of D.journaledProjects()) if (await deps.isKnownProject(path.resolve(p))) allowed.add(p);
      send(res, 200, D.attention(p => allowed.has(p)));
      return true;
    }
    const raw = method === 'GET' ? url.searchParams.get('project') : body.project;
    if (typeof raw !== 'string' || !raw.trim()) { send(res, 400, { error: 'project required' }); return true; }
    const project = path.resolve(raw);
    if (!await deps.isKnownProject(project)) { send(res, 403, { error: 'not a registered project' }); return true; }
    const needPerson = async (): Promise<boolean> => {
      const person = await deps.human(req, body);
      if (person.ok) return true;
      send(res, 403, { ok: false, code: 'human-required', error: person.reason ?? HUMAN_REQUIRED });
      return false;
    };

    if (route === 'delivery/board') {
      if (method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
      send(res, 200, withConnection(await D.getBoard(project), project));
      return true;
    }
    if (route === 'delivery/events') {
      if (method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
      const detach = deps.subscribe(project, res);
      kickProject(project);   // a board was opened: look at the remote now (ADR 0039)
      req.on('close', detach);
      try { res.write(`event: delivery/board\ndata: ${JSON.stringify({ type: 'delivery/board', topic: 'delivery', data: withConnection(await D.getBoard(project), project) })}\n\n`); } catch { /* closed already */ }
      return true;
    }
    if (route === 'delivery/tasks') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      send(res, 200, await D.createTask(project, body));
      return true;
    }
    if (route === 'delivery/settings') {
      if (method !== 'PATCH') { send(res, 405, { error: 'PATCH only' }); return true; }
      // Widening what the board may do or spend on its own (a level above manual, a bigger budget, more agents) is a person's act;
      // narrowing needs only the token. The engine re-checks the range of every value and the organisation's ceiling.
      const person = D.settingsNeedPerson(project, body) ? await needPerson() : true;
      if (!person) return true;
      send(res, 200, await D.updateSettings(project, body, D.settingsNeedPerson(project, body) ? 'person' : 'token'));
      return true;
    }
    // Whole-column operations, named by the segment after tasks/ (not as literal routes: they are covered by the `delivery/tasks/*` entry of the route registry).
    const seg = route.split('/');
    if (seg.length === 3 && seg[2] === 'reorder') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      const status = body.status;
      const ids = Array.isArray(body.ids) ? body.ids : undefined;
      if (typeof status !== 'string' || !ids || !ids.every((x): x is string => typeof x === 'string' && TASK_ID.test(x))) { send(res, 400, { error: 'status and ids (task ids) required' }); return true; }
      send(res, 200, D.reorderTasks(project, status as never, ids));
      return true;
    }
    if (seg.length === 3 && seg[2] === 'bulk') {
      if (method !== 'PATCH') { send(res, 405, { error: 'PATCH only' }); return true; }
      const ids = Array.isArray(body.ids) ? body.ids : undefined;
      if (!ids || !ids.every((x): x is string => typeof x === 'string' && TASK_ID.test(x))) { send(res, 400, { error: 'ids must be a list of task ids' }); return true; }
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) { send(res, 400, { error: 'patch must be an object' }); return true; }
      send(res, 200, await D.bulkUpdate(project, ids, body.patch as Record<string, unknown>, 'person'));
      return true;
    }
    if (route === 'delivery/plan') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
      if (!brief) { send(res, 400, { error: 'brief required' }); return true; }
      if (brief.length > 20_000) { send(res, 413, { error: 'brief is too long (20,000 characters at most)' }); return true; }
      send(res, 200, await deps.startPlan(project, brief));
      return true;
    }
    if (route === 'delivery/dispatch') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      const action = body.action;
      if (action !== 'start' && action !== 'pause') { send(res, 400, { error: 'action must be "start" or "pause"' }); return true; }
      const mp = body.maxParallel === undefined ? undefined : Number(body.maxParallel);
      if (mp !== undefined && !(Number.isFinite(mp) && mp >= 1)) { send(res, 400, { error: 'maxParallel must be a number from 1 to 4' }); return true; }
      // Starting, or raising how much runs at once, is spending: a person.
      if ((action === 'start' || mp !== undefined) && !await needPerson()) return true;
      send(res, 200, await D.setDispatch(project, action, mp));
      return true;
    }

    if (route === 'delivery/approve-batch') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      const ids = Array.isArray(body.ids) ? body.ids : undefined;
      if (!ids || !ids.every((x): x is string => typeof x === 'string' && TASK_ID.test(x))) { send(res, 400, { error: 'ids must be a list of task ids' }); return true; }
      if (!await needPerson()) return true;
      send(res, 200, await D.approveBatch(project, ids));
      return true;
    }
    if (route === 'delivery/releases') {
      if (method === 'GET') {
        const wanted = url.searchParams.get('version') ?? undefined;
        if (wanted !== undefined && !VERSION.test(wanted)) { send(res, 400, { error: 'version must look like 1.4.0' }); return true; }
        send(res, 200, { releases: (await D.getBoard(project)).releases, plan: await D.planRelease(project, wanted) });
        return true;
      }
      if (method !== 'POST') { send(res, 405, { error: 'GET or POST only' }); return true; }
      if (body.version !== undefined && !(typeof body.version === 'string' && VERSION.test(body.version))) { send(res, 400, { error: 'version must look like 1.4.0' }); return true; }
      if (!await needPerson()) return true;
      send(res, 200, await D.createRelease(project, {
        ...(typeof body.version === 'string' ? { version: body.version } : {}),
        ...(body.changelog === false ? { changelog: false } : {}),
      }));
      return true;
    }
    if (route.startsWith('delivery/releases/')) {
      const [, , version, verb, ...more] = route.split('/');
      if (!version || !VERSION.test(version) || more.length > 0) { send(res, 400, { error: 'invalid version' }); return true; }
      if (verb !== 'deploy' && verb !== 'rollback') { send(res, 404, { error: 'not found' }); return true; }
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      if (!await needPerson()) return true;
      send(res, 200, verb === 'deploy' ? await D.deployRelease(project, version) : await D.rollbackRelease(project, version));
      return true;
    }

    // delivery/tasks/:id[/approve|/request-changes|/comment|/diff]
    const [, , id, verb, ...extra] = route.split('/');
    if (!id || !TASK_ID.test(id) || extra.length > 0) { send(res, 400, { error: 'invalid task id' }); return true; }
    if (!verb) {
      if (method !== 'PATCH') { send(res, 405, { error: 'PATCH only' }); return true; }
      send(res, 200, await D.updateTask(project, id, body, 'person'));
      return true;
    }
    if (verb === 'diff') {
      if (method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
      send(res, 200, await D.taskDiffInfo(project, id));
      return true;
    }
    if (verb === 'activity') {
      if (method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
      send(res, 200, { activity: D.taskActivity(project, id) });
      return true;
    }
    if (verb === 'duplicate') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      send(res, 200, await D.duplicateTask(project, id, 'person'));
      return true;
    }
    if (verb === 'promote-prerequisites') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      if (!await needPerson()) return true;
      send(res, 200, await D.promotePrerequisites(project, id, 'person'));
      return true;
    }
    if (verb === 'resolve-landing') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      if (!await needPerson()) return true;
      const choice = body.choice;
      if (choice !== 'keep-mine' && choice !== 'take-task') { send(res, 400, { error: 'choice must be "keep-mine" or "take-task"' }); return true; }
      send(res, 200, await D.resolveLanding(project, id, choice));
      return true;
    }
    if (verb === 'merge-pr') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      if (!await needPerson()) return true;
      const m = body.method;
      send(res, 200, await D.mergePullRequest(project, id, m === 'merge' || m === 'squash' || m === 'rebase' ? { method: m } : {}));
      return true;
    }
    if (verb === 'approve' || verb === 'request-changes' || verb === 'comment') {
      if (method !== 'POST') { send(res, 405, { error: 'POST only' }); return true; }
      if (!await needPerson()) return true;
      if (verb === 'comment') { send(res, 200, D.commentTask(project, id, typeof body.text === 'string' ? body.text : '', 'person')); return true; }
      if (verb === 'approve') { send(res, 200, await D.approveTask(project, id)); return true; }
      send(res, 200, await D.requestChanges(project, id, typeof body.comment === 'string' ? body.comment : ''));
      return true;
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    // `code` and `data` (a landing collision's files and choices) let a client offer the way forward instead of showing a sentence.
    if (err instanceof D.DeliveryError) send(res, err.status, { error: err.message, message: err.message, ...(err.code ? { code: err.code } : {}), ...(err.data ?? {}) });
    else throw err;
  }
  return true;
}
