/**
 * `Delivery`: the agent's side of the task board (ADR 0038).
 *
 * Two kinds of caller, told apart by where the call is made, not by what it claims:
 *
 *  - **A planner / chat** in a project folder: `create`, `list`, `get`, `update`.
 *    New tasks land in the backlog. It cannot promote a task to `ready` (that is what
 *    lets the dispatcher spend money, and it is a person's act), cannot approve or land
 *    anything, and cannot start the dispatcher: none of those are actions here.
 *  - **A task's run**, whose directory is inside that task's worktree: `progress`,
 *    `touched`, `submit`, `localise` (private dependency folders before an install),
 *    `handoff` (a note for a task that depends on this one), plus the reads. It can submit only the task its own worktree
 *    belongs to; the id it passes is checked against the directory, so one run cannot
 *    submit, edit or read-modify another task however it asks.
 *
 * Deferred (group `delivery`, tools/deferred.ts): the schema costs nothing until a
 * request about a backlog, board, tasks or sprint loads it; the run prompt names
 * "delivery task" so a task's run has it from its first message.
 *
 * It does not run git, approve, merge or start anything: the engine does that
 * (`src/delivery`), and the person approves.
 *
 * @module tools/delivery
 */

import { currentRunContext, projectRoot } from '../run-context.js';
import { actualTouches } from '../delivery/touches.js';
import * as D from '../delivery/index.js';
import * as S from '../delivery/store.js';
import type { Task } from '../delivery/types.js';

export interface DeliveryInput {
  action?: string;
  id?: string;
  title?: string;
  body?: string;
  acceptance?: string[];
  priority?: number;
  dependsOn?: string[];
  labels?: string[];
  status?: string;
  summary?: string;
  note?: string;
  /** handoff: the task that depends on yours. */
  to?: string;
  files?: string[];
  filter?: string;
}

const line = (t: Task): string =>
  `${t.id} [${t.status}] P${t.priority} ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}${t.labels.length ? ` {${t.labels.join(', ')}}` : ''}${t.costUsd ? ` $${t.costUsd.toFixed(2)}` : ''}`;

function describe(t: Task): string {
  return [
    line(t), t.body ? `\n${t.body}` : '',
    t.acceptance.length ? `\nAcceptance:\n${t.acceptance.map(a => `- ${a}`).join('\n')}` : '',
    t.touches?.files.length ? `\nTouches (${t.touches.predicted ? 'predicted' : 'actual'}): ${t.touches.files.slice(0, 30).join(', ')}` : '',
    t.risk ? `\nRisk: ${t.risk.level} (${t.risk.score}) - ${t.risk.reasons.slice(0, 4).join('; ')}` : '',
    t.review?.comments.length ? `\nComments:\n${t.review.comments.slice(-6).map(c => `- [${c.by}] ${c.text}`).join('\n')}` : '',
  ].join('');
}

export async function deliveryTool(input: DeliveryInput = {}): Promise<string> {
  const action = String(input.action ?? '');
  const cwd = currentRunContext()?.cwd ?? projectRoot();
  const here = D.taskAt(cwd);
  try {
    // ── a task's own run ──
    if (here) {
      const { project, task } = here;
      if (input.id && input.id !== task.id && ['progress', 'touched', 'submit', 'localise', 'update', 'create'].includes(action)) {
        return `[error] You are delivering task ${task.id}; you cannot ${action} task ${input.id}. Only that task's own run can act on it.`;
      }
      switch (action) {
        case 'progress': {
          if (!input.note?.trim()) return '[error] note required: what you have done so far, in a sentence.';
          S.addComment(project, task.id, 'agent', `Progress: ${input.note.trim().slice(0, 2000)}`);
          return 'Noted.';
        }
        case 'touched': {
          const files = (input.files ?? []).filter(f => typeof f === 'string' && f.trim()).slice(0, 200);
          if (files.length === 0) return '[error] files required: the project-relative paths you changed.';
          const cur = S.getTask(project, task.id)?.touches;
          const merged = [...new Set([...(cur && !cur.predicted ? cur.files : []), ...files])];
          S.patchTask(project, task.id, { touches: actualTouches(merged, cur?.symbols ?? []) });
          return `Recorded ${files.length} touched file${files.length === 1 ? '' : 's'}.`;
        }
        case 'submit': {
          const r = await D.submitTask(project, task.id, { summary: input.summary });
          return r.ok
            ? `Submitted task ${task.id} for review. The merge queue rebases it onto the trunk, runs the project's checks and prepares the evidence; a person approves. If it comes back with a conflict or a failing check you will be started again with the reason. You are done: end your turn with a short summary.`
            : `[error] Not submitted: ${r.reason}`;
        }
        case 'localise': return D.localiseTask(project, task.id);
        case 'handoff': {
          const to = input.to ?? input.id;
          if (!to) return '[error] to required: the id of the task that depends on yours.';
          if (!input.note?.trim()) return '[error] note required: what the other task\'s agent needs to know.';
          const t = D.handoff(project, task.id, to, input.note);
          return `Left a note on "${t.title}". Its agent reads it when it starts.`;
        }
        case 'get': return describe(S.getTask(project, task.id) ?? task);
        case 'list': return S.boardState(project).tasks.map(line).join('\n') || '(no tasks)';
        case 'create': case 'update':
          return '[error] A task\'s run cannot create or edit tasks. Do your task and submit it.';
        default:
          return `[error] In a task's worktree the actions are progress, touched, submit, localise, handoff, get and list (got "${action}").`;
      }
    }

    // ── planning, from the project folder ──
    const project = projectRoot();
    switch (action) {
      case 'create': {
        const t = await D.createTask(project, {
          title: input.title, body: input.body, acceptance: input.acceptance, priority: input.priority,
          dependsOn: input.dependsOn, labels: input.labels,
        });
        return `Created task ${t.id} in the backlog: ${t.title}. A person promotes it to ready; nothing runs until the dispatcher is started.`;
      }
      case 'list': {
        const f = (input.filter ?? input.status ?? '').toLowerCase();
        const tasks = S.boardState(project).tasks.filter(t => !f || t.status === f);
        return tasks.length ? tasks.map(line).join('\n') : '(no tasks)';
      }
      case 'get': {
        const t = input.id ? S.getTask(project, input.id) : undefined;
        return t ? describe(t) : `[error] No task ${input.id ?? '(id missing)'} on this board.`;
      }
      case 'update': {
        if (!input.id) return '[error] id required.';
        if (input.status === 'ready') return '[error] Only a person promotes a task to ready (it lets the dispatcher spend money). Leave it in the backlog.';
        const t = await D.updateTask(project, input.id, {
          title: input.title, body: input.body, acceptance: input.acceptance, priority: input.priority,
          dependsOn: input.dependsOn, labels: input.labels, status: input.status,
        }, 'agent');
        return `Updated: ${line(t)}`;
      }
      case 'progress': case 'touched': case 'submit':
        return '[error] progress, touched and submit are for a task\'s own run, inside its worktree. This is the project folder.';
      default:
        return `[error] Unknown action "${action}". Planning: create, list, get, update.`;
    }
  } catch (e) {
    if (e instanceof D.DeliveryError) return `[error] ${e.message}`;
    throw e;
  }
}

export const deliveryDefinition = {
  name: 'Delivery',
  description:
    'The project\'s delivery board: independent tasks that agents deliver in parallel, each in its own git worktree, landed one at a time after a person approves.\n'
    + 'Planning (from the project folder): create {title, body, acceptance[], priority 1-4, dependsOn[] (task ids or exact titles), labels[] (folders/files it touches, e.g. "src/auth")} -> backlog; '
    + 'list {filter?}; get {id}; update {id, ...fields}. Break a brief into tasks that do not need the same files at once; make one depend on another instead. A person promotes tasks to ready and starts the dispatcher; you cannot.\n'
    + 'Delivering (inside a task\'s worktree): progress {note}; touched {files[]}; submit {summary} when the work is committed and the checks pass; '
    + 'localise (the worktree\'s node_modules / venv / vendor are links to the project\'s own: call this before an install that must not change it); '
    + 'handoff {to, note} (a note for a task that depends on yours). You can act only on your own task.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'get', 'update', 'progress', 'touched', 'submit', 'localise', 'handoff'] },
      id: { type: 'string', description: 'The task id (get, update).' },
      title: { type: 'string' },
      body: { type: 'string', description: 'What to do and why.' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'Checkable criteria.' },
      priority: { type: 'number', description: '1 (most urgent) to 4. Default 3.' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Task ids (or exact titles) that must be merged first.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Topics, or the folders/files the task touches.' },
      status: { type: 'string', enum: ['backlog', 'blocked', 'cancelled'], description: 'update: move a task. Only a person can make it ready.' },
      filter: { type: 'string', description: 'list: only tasks in this status.' },
      summary: { type: 'string', description: 'submit: what you did, in a few sentences.' },
      note: { type: 'string', description: 'progress: what you have done so far. handoff: what the other task needs to know.' },
      to: { type: 'string', description: 'handoff: the id of the task that depends on yours.' },
      files: { type: 'array', items: { type: 'string' }, description: 'touched: project-relative paths you changed.' },
    },
    required: ['action'],
  },
};
