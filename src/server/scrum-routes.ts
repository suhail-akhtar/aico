/**
 * Scrum on the delivery board over HTTP (ADR 0039 section 4). Registered projects only.
 *
 *   GET   /api/delivery/scrum?project=[&tz=]         mode, sprints, suggestions, velocity, the active sprint's burndown, the daily summary
 *   POST  /api/delivery/scrum/mode {project, mode}   kanban | scrum (switching never loses data)
 *   PATCH /api/delivery/scrum/tasks/:id {project, estimate}   set (a number) or clear (null) a task's story points
 *   POST  /api/delivery/scrum/proposals/:id/accept   a person accepts an agent's suggestion      [person]
 *   POST  /api/delivery/scrum/proposals/:id/dismiss  put a suggestion away
 *   POST  /api/delivery/scrum/refine {project}       one planning turn that may only suggest estimates, splits and criteria -> {sessionId}
 *   POST  /api/delivery/sprints {project, name?, goal?, start, end, capacityPoints?}   a planned sprint
 *   POST  /api/delivery/sprints/:id/commit {project, add?, remove?}   commit tasks to the sprint [person]
 *   POST  /api/delivery/sprints/:id/start            start it: its backlog tasks become ready   [person]
 *   POST  /api/delivery/sprints/:id/close            close it: unfinished work returns to the backlog [person]
 *   GET   /api/delivery/sprints/:id/summary|review|retro?project=[&tz=]   the daily summary, review draft, retro facts + draft
 *   POST  /api/delivery/sprints/:id/notes {project, kind, text}   save the edited review or retro
 *
 * WHO MAY SAY YES. The model can `curl` the loopback port and may learn the token, so the
 * acts that decide a sprint ask the decision gate for a person (`checkHuman`): committing
 * (it fixes what the team promised, and joining a running sprint readies the work for the
 * agents), starting, closing (it moves work), and accepting a suggestion (it is how an
 * agent's proposal becomes a task or an estimate; without a person there would be nothing
 * left for the person to decide). Creating a planned sprint, estimating, dismissing, saving
 * notes and switching the mode need only the token: none of them starts spend or moves work,
 * and the dispatcher only starts tasks a person made ready. The desktop mints a grant for
 * the gated routes (HUMAN_ROUTES / HUMAN_ROUTE_PATTERNS).
 *
 * @module server/scrum-routes
 */

import type http from 'node:http';
import path from 'node:path';
import * as Scrum from '../delivery/scrum.js';
import { DeliveryError } from '../delivery/index.js';
import type { DeliveryRouteDeps } from './delivery-routes.js';

const HEX8 = /^[a-f0-9]{8}$/;
const HUMAN_REQUIRED = 'This needs a person in the AICO window; the API token alone cannot do it.';

/** The client's own offset (minutes east of UTC) when it sends one; the server's otherwise. */
function offsetOf(url: URL): number {
  const raw = url.searchParams.get('tz');
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : Scrum.localOffsetMin();
}

export async function handleScrumRoute(
  route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: DeliveryRouteDeps,
): Promise<boolean> {
  const own = route === 'delivery/scrum' || route === 'delivery/sprints' || route.startsWith('delivery/scrum/') || route.startsWith('delivery/sprints/');
  if (!own) return false;
  const { send } = deps;
  const method = req.method ?? 'GET';
  try {
    const body = (method === 'GET' ? {} : await deps.readJson(req)) as Record<string, unknown>;
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
    const only = (m: string): boolean => { if (method === m) return true; send(res, 405, { error: `${m} only` }); return false; };
    const ids = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x): x is string => typeof x === 'string' && HEX8.test(x)) ? v : undefined);

    if (route === 'delivery/scrum') {
      if (!only('GET')) return true;
      send(res, 200, Scrum.scrumView(project, Date.now(), offsetOf(url)));
      return true;
    }
    if (route === 'delivery/sprints') {
      if (!only('POST')) return true;
      send(res, 200, await Scrum.createSprint(project, body));
      return true;
    }

    const parts = route.split('/'); // delivery / scrum|sprints / ...
    if (parts[1] === 'scrum') {
      const [, , what, id, verb, ...extra] = parts;
      if (what === 'mode' && !id) {
        if (!only('POST')) return true;
        send(res, 200, { mode: await Scrum.setMode(project, body.mode) });
        return true;
      }
      if (what === 'tasks' && id && HEX8.test(id) && !verb && extra.length === 0) {
        if (!only('PATCH')) return true;
        if (!('estimate' in body)) { send(res, 400, { error: 'estimate required: a number, or null to clear it' }); return true; }
        send(res, 200, await Scrum.setEstimate(project, id, body.estimate));
        return true;
      }
      if (what === 'proposals' && id && HEX8.test(id) && (verb === 'accept' || verb === 'dismiss') && extra.length === 0) {
        if (!only('POST')) return true;
        if (verb === 'accept') {
          if (!await needPerson()) return true;
          send(res, 200, await Scrum.acceptProposal(project, id));
        } else send(res, 200, await Scrum.dismissProposal(project, id));
        return true;
      }
      if (what === 'refine' && !id) {
        // One planning turn that may only SUGGEST (the Delivery tool's propose_* actions); spends like delivery/plan does.
        if (!only('POST')) return true;
        send(res, 200, await deps.startPlan(project, '', 'refine'));
        return true;
      }
      send(res, 404, { error: 'not found' });
      return true;
    }

    // delivery/sprints/:id/<verb>
    const [, , sprintId, verb, ...extra] = parts;
    if (!sprintId || !HEX8.test(sprintId) || !verb || extra.length > 0) { send(res, 400, { error: 'invalid sprint id' }); return true; }
    if (verb === 'summary' || verb === 'review' || verb === 'retro') {
      if (!only('GET')) return true;
      if (verb === 'review') send(res, 200, Scrum.sprintReview(project, sprintId, offsetOf(url)));
      else if (verb === 'retro') send(res, 200, Scrum.sprintRetro(project, sprintId));
      else {
        const view = Scrum.scrumView(project, Date.now(), offsetOf(url));
        if (view.active?.sprint.id !== sprintId) { send(res, 409, { error: 'only the running sprint has a daily summary' }); return true; }
        send(res, 200, { summary: view.daily, markdown: view.dailyMarkdown, burndown: view.active.burndown });
      }
      return true;
    }
    if (verb === 'notes') {
      if (!only('POST')) return true;
      send(res, 200, await Scrum.saveNotes(project, sprintId, body.kind, body.text));
      return true;
    }
    if (verb === 'commit' || verb === 'start' || verb === 'close') {
      if (!only('POST')) return true;
      if (!await needPerson()) return true;
      if (verb === 'start') send(res, 200, await Scrum.startSprint(project, sprintId));
      else if (verb === 'close') send(res, 200, await Scrum.closeSprint(project, sprintId));
      else {
        const add = body.add === undefined ? [] : ids(body.add);
        const remove = body.remove === undefined ? [] : ids(body.remove);
        if (!add || !remove) { send(res, 400, { error: 'add and remove must be lists of task ids' }); return true; }
        send(res, 200, await Scrum.commitSprint(project, sprintId, add, remove));
      }
      return true;
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof DeliveryError) send(res, err.status, { error: err.message });
    else throw err;
  }
  return true;
}
