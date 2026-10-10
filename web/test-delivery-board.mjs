/**
 * Unit tests for the true-board logic (web/src/delivery-board.ts): the honest status line and its
 * one-click unblock, blockers, ordering inside a column, WIP states, swimlanes, epics, filters and
 * saved views, list sorting, due dates, how a refused landing becomes choices (including the raw git
 * sentence the owner saw), the autonomy copy and settings parsing, agents, feed, quick add, keys.
 *
 * Bundles its own subjects with esbuild, so it runs on its own:
 *   node web/test-delivery-board.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-delivery-board-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, 'src', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const B = await load('delivery-board');
const Q = await (async () => {
  const outfile = path.join(tmp, 'quickadd.mjs');
  await build({ entryPoints: [path.join(here, '..', 'shared', 'delivery', 'quickadd.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
})();
const M = await load('delivery-model');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}

const task = (id, over = {}) => ({
  id, project: '/p', title: `Task ${id}`, body: '', acceptance: [], status: 'backlog', priority: 3,
  dependsOn: [], labels: [], createdAt: Number(id.replace(/\D/g, '')) || 1, updatedAt: 1000, ...over,
});
const board = (tasks, over = {}) => ({
  project: '/p', tasks, queue: [], running: [], settings: { maxParallel: 2, autoLandLowRisk: false, trunk: 'main' },
  dispatcher: 'running', releases: [], ...over,
});
const ref = id => `#${id.replace(/\D/g, '')}`;

// ── the honest status line ───────────────────────────────────────────
test('ready tasks waiting on backlog prerequisites say so and offer the one-click fix', () => {
  const ts = [task('1'), task('2'), task('3', { status: 'ready', dependsOn: ['1', '2'] }), task('4', { status: 'ready', dependsOn: ['1'] })];
  const s = B.statusLine(board(ts), ts, ref);
  assert.equal(s.state, 'idle');
  assert.equal(s.text, 'Idle: 2 ready tasks wait for #1 and #2 (in Backlog)');
  assert.deepEqual(s.promote.sort(), ['1', '2']);
  assert.deepEqual(s.blockedReady.sort(), ['3', '4']);
  assert.equal(s.fix, 'Move #1 and #2 to Ready');
});

test('a single waiting task reads in the singular; prerequisites in other states are named', () => {
  const ts = [task('1', { status: 'review' }), task('2', { status: 'ready', dependsOn: ['1'] })];
  const s = B.statusLine(board(ts), ts, ref);
  assert.equal(s.text, 'Idle: 1 ready task waits for #1 (in review)');
  assert.equal(s.fix, undefined);
  assert.deepEqual(s.promote, []);
});

test('a prerequisite that is in the queue is not a problem; one that never moves is', () => {
  const queue = [task('1', { status: 'ready' }), task('2', { status: 'ready', dependsOn: ['1'] })];
  const q = B.statusLine(board(queue, { dispatcher: 'paused' }), queue, ref);
  assert.equal(q.stuck, false);
  assert.equal(q.waits, '1 ready task waits for #1 (ready)');
  const cancelled = [task('1', { status: 'cancelled' }), task('2', { status: 'ready', dependsOn: ['1'] })];
  const c = B.statusLine(board(cancelled), cancelled, ref);
  assert.equal(c.stuck, true);
  assert.equal(c.fix, undefined);
  assert.match(c.why, /blocked, cancelled or missing/);
  const backlog = [task('1'), task('2', { status: 'ready', dependsOn: ['1'] })];
  assert.equal(B.statusLine(board(backlog, { dispatcher: 'paused' }), backlog, ref).stuck, true);
  assert.match(B.statusLine(board(backlog, { dispatcher: 'paused' }), backlog, ref).detail, /^1 ready task waits for #1 \(in Backlog\)\. Agents only start/);
});

test('the engine blockedBy wins over dependsOn, and merged blockers vanish', () => {
  const ts = [task('1', { status: 'merged' }), task('2', { status: 'ready', dependsOn: ['1'], blockedBy: [{ id: '1', status: 'merged' }] })];
  assert.deepEqual(B.blockersOf(ts[1], new Map(ts.map(t => [t.id, t]))), []);
  const t3 = task('3', { dependsOn: ['9'] });
  assert.deepEqual(B.blockersOf(t3, new Map([[t3.id, t3]])), [{ id: '9', status: 'missing' }]);
});

test('running, paused, stopped, no ready tasks, and the engine idleReason', () => {
  const ts = [task('1', { status: 'running' })];
  assert.equal(B.statusLine(board(ts, { running: [{ taskId: '1', runId: 'r', startedAt: 1, costUsd: 0 }] }), ts, ref).text, 'Agents working 1/2');
  assert.equal(B.statusLine(board(ts, { dispatcher: 'paused', pausedBecause: 'daily budget reached ($5.00)' }), ts, ref).text, 'Paused: daily budget reached ($5.00)');
  assert.equal(B.statusLine(board(ts, { dispatcher: 'paused' }), ts, ref).text, 'Paused');
  assert.equal(B.statusLine(board(ts, { dispatcher: 'idle' }), ts, ref).state, 'off');
  assert.equal(B.statusLine(board([task('1')]), [task('1')], ref).text, 'Idle: no tasks are Ready');
  assert.equal(B.statusLine(board([task('1')], { idleReason: 'waiting for the budget to reset' }), [task('1')], ref).text, 'Idle: waiting for the budget to reset');
  const free = [task('5', { status: 'ready' })];
  assert.match(B.statusLine(board(free), free, ref).text, /^Idle: 1 ready task, about to start/);
});

test('blocked chips read "Blocked by #2 - Backlog" only before work starts', () => {
  const ts = [task('2'), task('3', { status: 'ready', dependsOn: ['2'] }), task('4', { status: 'review', dependsOn: ['2'] })];
  const by = new Map(ts.map(t => [t.id, t]));
  assert.deepEqual(B.blockedChips(ts[1], by, ref).map(c => c.text), ['Blocked by #2 · Backlog']);
  assert.deepEqual(B.blockedChips(ts[2], by, ref), []);
  assert.equal(B.listRefs(['1', '2', '3'], ref), '#1, #2 and #3');
});

// ── ordering ─────────────────────────────────────────────────────────
test('reorderIds puts a card before another, or last', () => {
  assert.deepEqual(B.reorderIds(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(B.reorderIds(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
  assert.deepEqual(B.reorderIds(['a', 'b', 'c'], 'b', 'c'), ['a', 'b', 'c']);
  assert.deepEqual(B.reorderIds(['a', 'b'], 'x', 'a'), ['x', 'a', 'b']);
});

test('nudgeId moves one step and stops at the ends', () => {
  assert.deepEqual(B.nudgeId(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(B.nudgeId(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(B.nudgeId(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
});

test('a person order (rank) beats priority within a column, and no rank sorts as before', () => {
  const g = M.groupTasks([task('a', { priority: 1, rank: 3 }), task('b', { priority: 4, rank: 1 }), task('c', { priority: 2, rank: 2 })]);
  assert.deepEqual(g.backlog.map(t => t.id), ['b', 'c', 'a']);
  const h = M.groupTasks([task('a', { priority: 3 }), task('b', { priority: 1 })]);
  assert.deepEqual(h.backlog.map(t => t.id), ['b', 'a']);
});

// ── WIP ──────────────────────────────────────────────────────────────
test('wip states and limits', () => {
  assert.equal(B.wipState(undefined, 5), 'none');
  assert.equal(B.wipState(0, 5), 'none');
  assert.equal(B.wipState(3, 2), 'ok');
  assert.equal(B.wipState(3, 3), 'at');
  assert.equal(B.wipState(3, 4), 'over');
  const b = board([], { settings: { maxParallel: 2, autoLandLowRisk: false, trunk: 'main', wip: { review: 4 } } });
  assert.equal(B.wipLimit(b, 'running'), 2);
  assert.equal(B.wipLimit(b, 'review'), 4);
  assert.equal(B.wipLimit(b, 'backlog'), undefined);
  assert.equal(B.wipLimit(board([], { settings: { maxParallel: 2, wip: { running: 1 } } }), 'running'), 1);
});

// ── epics and swimlanes ──────────────────────────────────────────────
test('epic progress counts merged children and ignores cancelled', () => {
  const ts = [task('1'), task('2', { parentId: '1', status: 'merged' }), task('3', { parentId: '1' }), task('4', { parentId: '1', status: 'cancelled' })];
  assert.deepEqual(B.epicProgress('1', ts), { done: 1, total: 2, pct: 50 });
  assert.equal(B.isEpic(ts[0], ts), true);
  assert.equal(B.isEpic(ts[1], ts), false);
  assert.deepEqual(B.epicProgress('9', ts), { done: 0, total: 0, pct: 0 });
});

test('swimlanes by assignee: agents, then people, then unassigned last', () => {
  const ts = [task('1'), task('2', { assignee: { kind: 'person', name: 'Sam' } }), task('3', { assignee: { kind: 'agent', name: 'Agent B' } }), task('4', { assignee: { kind: 'agent', name: 'Agent A' } })];
  const lanes = B.buildLanes(ts, 'assignee');
  assert.deepEqual(lanes.map(l => l.label), ['Agent A', 'Agent B', 'Sam', 'Unassigned']);
});

test('swimlanes by type and by epic', () => {
  const ts = [task('1', { type: 'bug' }), task('2', { type: 'feature' }), task('3'), task('4', { type: 'bug' })];
  assert.deepEqual(B.buildLanes(ts, 'type').map(l => `${l.label}:${l.tasks.length}`), ['Feature:1', 'Bug:2', 'No type:1']);
  const es = [task('1', { title: 'Auth epic' }), task('2', { parentId: '1' }), task('3', { parentId: '1' }), task('4')];
  const lanes = B.buildLanes(es, 'epic');
  assert.deepEqual(lanes.map(l => `${l.label}:${l.tasks.length}`), ['Auth epic:3', 'No epic:1']);
  assert.equal(lanes[0].epic.id, '1');
  assert.equal(B.buildLanes(es, 'none').length, 1);
});

// ── filters and saved views ──────────────────────────────────────────
test('parseFilter reads keys, quotes and leaves unknown words in the text', () => {
  const f = B.parseFilter('assignee:"Agent A" type:bug label:auth priority:1 status:ready is:needs fix login foo:bar');
  assert.deepEqual(f.assignee, ['Agent A']);
  assert.deepEqual(f.type, ['bug']);
  assert.deepEqual(f.label, ['auth']);
  assert.deepEqual(f.priority, [1]);
  assert.deepEqual(f.status, ['ready']);
  assert.equal(f.needs, true);
  assert.equal(f.text, 'fix login foo:bar');
  assert.equal(B.parseFilter('type:nonsense').text, 'type:nonsense');
});

test('formatFilter round-trips parseFilter', () => {
  const s = 'assignee:"Agent A" type:bug label:auth priority:1 status:ready is:needs is:blocked fix login';
  assert.equal(B.formatFilter(B.parseFilter(s)), s);
  assert.equal(B.isEmptyFilter(B.parseFilter('   ')), true);
});

test('applyFilter: keys AND together, values OR, text matches title, ref and labels', () => {
  const ts = [
    task('1', { title: 'Fix login', type: 'bug', assignee: { kind: 'agent', name: 'Agent A' }, labels: ['auth'] }),
    task('2', { title: 'Add search', type: 'feature', assignee: { kind: 'person', name: 'Sam' }, priority: 1 }),
    task('3', { title: 'Docs pass', type: 'docs' }),
  ];
  const ids = f => B.applyFilter(ts, B.parseFilter(f), ref).map(t => t.id);
  assert.deepEqual(ids('type:bug'), ['1']);
  assert.deepEqual(ids('type:bug type:feature'), ['1', '2']);
  assert.deepEqual(ids('assignee:"agent a" type:bug'), ['1']);
  assert.deepEqual(ids('assignee:unassigned'), ['3']);
  assert.deepEqual(ids('priority:1'), ['2']);
  assert.deepEqual(ids('login'), ['1']);
  assert.deepEqual(ids('#2'), ['2']);
  assert.deepEqual(ids('auth'), ['1']);
  assert.deepEqual(ids(''), ['1', '2', '3']);
  assert.deepEqual(ids('is:blocked'), []);
});

test('is:blocked finds tasks with an unmerged prerequisite', () => {
  const ts = [task('1'), task('2', { dependsOn: ['1'] }), task('3', { dependsOn: ['9'] })];
  assert.deepEqual(B.applyFilter(ts, B.parseFilter('is:blocked'), ref).map(t => t.id), ['2', '3']);
});

test('saved views upsert, remove, and match a filter regardless of word order', () => {
  let v = B.upsertView([], 'My bugs', 'type:bug assignee:Sam');
  v = B.upsertView(v, 'my bugs', 'type:bug');
  assert.deepEqual(v, [{ name: 'my bugs', filter: 'type:bug' }]);
  v = B.upsertView(v, '  ', 'x');
  assert.equal(v.length, 1);
  v = B.upsertView(v, 'Mine', 'assignee:Sam type:bug');
  assert.equal(B.activeView(v, 'type:bug assignee:Sam').name, 'Mine');
  assert.equal(B.activeView(v, ''), undefined);
  assert.deepEqual(B.removeView(v, 'Mine').map(x => x.name), ['my bugs']);
  assert.deepEqual(B.assigneesOf([task('1', { assignee: { kind: 'person', name: 'Sam' } }), task('2', { assignee: { kind: 'agent', name: 'Agent A' } }), task('3')]), ['Agent A', 'Sam']);
});

// ── list sorting, due dates, initials ────────────────────────────────
test('sortTasks by priority, due, assignee, and ref numerically', () => {
  const ts = [task('10', { priority: 2, dueDate: '2026-10-20' }), task('2', { priority: 1, assignee: { kind: 'person', name: 'Zed' } }), task('3', { priority: 3, dueDate: '2026-10-01', assignee: { kind: 'person', name: 'Amy' } })];
  const ids = (k, d) => B.sortTasks(ts, k, d, ref).map(t => t.id);
  assert.deepEqual(ids('priority', 'asc'), ['2', '10', '3']);
  assert.deepEqual(ids('ref', 'asc'), ['2', '3', '10']);
  assert.deepEqual(ids('ref', 'desc'), ['10', '3', '2']);
  assert.deepEqual(ids('due', 'asc'), ['3', '10', '2']);
  assert.deepEqual(ids('assignee', 'asc'), ['3', '2', '10']);
});

test('due state compares calendar days', () => {
  const now = new Date('2026-10-10T15:00:00').getTime();
  assert.equal(B.dueState('2026-10-09', now), 'overdue');
  assert.equal(B.dueState('2026-10-10', now), 'today');
  assert.equal(B.dueState('2026-10-12', now), 'soon');
  assert.equal(B.dueState('2026-10-20', now), 'later');
  assert.equal(B.dueState(undefined, now), null);
  assert.equal(B.formatDue('2026-10-07', now), 'Overdue 3d');
  assert.equal(B.formatDue('2026-10-10', now), 'Today');
  assert.equal(B.formatDue('2026-10-11', now), 'Tomorrow');
  assert.equal(B.formatDue('2026-10-20', now), 'Oct 20');
});

test('initials', () => {
  assert.equal(B.initials('Agent A'), 'AA');
  assert.equal(B.initials('Sam Rivera'), 'SR');
  assert.equal(B.initials('sam'), 'S');
  assert.equal(B.initials(''), '?');
});

// ── landing errors ───────────────────────────────────────────────────
test('a structured untracked-collision becomes a panel with the files and the offered choices', () => {
  const err = Object.assign(new Error('x'), { body: { code: 'untracked-collision', message: 'collision', files: ['src/a.js', 'src/b.js'], choices: ['keep-mine', 'take-task'] } });
  const p = B.landingProblem(err);
  assert.equal(p.known, true);
  assert.equal(p.code, 'untracked-collision');
  assert.deepEqual(p.files, ['src/a.js', 'src/b.js']);
  assert.deepEqual(p.choices.map(c => c.id), ['keep-mine', 'take-task']);
  assert.equal(p.choices[0].tone, 'primary');
  assert.equal(p.choices[0].label, 'Keep my files');
  assert.match(p.body, /2 files/);
  assert.doesNotMatch(p.body + p.title, /git|fatal|error:/i);
});

test('the raw git sentence the owner saw is recognised and its files listed', () => {
  const raw = 'error: The following untracked working tree files would be overwritten by merge:\n\tsrc/server/auth-middleware.mjs\n\ttest/auth.test.mjs\nPlease move or remove them before you merge.\nAborting';
  const p = B.landingProblem(new Error(raw));
  assert.equal(p.code, 'untracked-collision');
  assert.deepEqual(p.files, ['src/server/auth-middleware.mjs', 'test/auth.test.mjs']);
  assert.deepEqual(p.choices, []);
  assert.deepEqual(B.filesFromGitMessage('nothing'), []);
});

test('a persisted landingBlock becomes the same panel, with why each file is in the way', () => {
  const p = B.landingFromBlock({ at: 'x', files: [{ path: 'src/a.js', why: 'untracked' }, { path: 'src/b.js', why: 'modified' }], choices: ['keep-mine', 'take-task'] });
  assert.deepEqual(p.files, ['src/a.js', 'src/b.js']);
  assert.equal(p.why['src/b.js'], 'modified');
  assert.deepEqual(p.choices.map(c => c.label), ['Keep my files', 'Use the task\u2019s version']);
  const e = B.landingFromBlock({ at: 'x', files: [{ path: 'x.js', why: 'modified' }], choices: ['keep-mine'] });
  assert.match(e.body, /edits that are not committed/);
});

test('shared quick add parses the whole line the same way the engine does', () => {
  const q = Q.parseQuickAdd('Fix login !1 #auth @sam type:bug due:2026-10-20', new Date('2026-10-10T12:00:00'));
  assert.deepEqual(q, { title: 'Fix login', priority: 1, labels: ['auth'], assignee: 'sam', type: 'bug', dueDate: '2026-10-20' });
  assert.equal(Q.parseQuickAdd('Add C# support').title, 'Add C# support');
});

test('dirty trunk, unknown choice ids, and an unknown error show the message as is', () => {
  const d = B.landingProblem({ body: { code: 'dirty-trunk', choices: ['stash', 'rebuild-index'] } });
  assert.equal(d.title, 'The trunk has uncommitted changes');
  assert.deepEqual(d.choices.map(c => c.label), ['Stash my changes, then land', 'Rebuild index']);
  const u = B.landingProblem(new Error('network down'));
  assert.equal(u.known, false);
  assert.equal(u.body, 'network down');
  assert.equal(B.landingProblem(new Error('Your local changes would be overwritten')).code, 'dirty-trunk');
});

// ── autonomy ─────────────────────────────────────────────────────────
test('autonomy levels have a line each; only raising above manual asks', () => {
  assert.deepEqual(B.AUTONOMY_LEVELS.map(l => l.label), ['Manual', 'Assisted', 'Autonomous', 'Full autonomous']);
  assert.ok(B.AUTONOMY_LEVELS.every(l => l.line.length > 10));
  assert.equal(B.autonomyNeedsConfirm('manual', 'assisted'), true);
  assert.equal(B.autonomyNeedsConfirm(undefined, 'full'), true);
  assert.equal(B.autonomyNeedsConfirm('assisted', 'autonomous'), true);
  assert.equal(B.autonomyNeedsConfirm('full', 'assisted'), false);
  assert.equal(B.autonomyNeedsConfirm('full', 'manual'), false);
  assert.equal(B.autonomyNeedsConfirm('assisted', 'assisted'), false);
  for (const l of ['assisted', 'autonomous']) {
    const a = B.alwaysNeedsYou(l);
    assert.ok(a.some(s => /High-risk/.test(s)) && a.some(s => /secret/.test(s)) && a.some(s => /test that was weakened/.test(s)) && a.some(s => /Questions/.test(s)), l);
  }
  assert.ok(B.alwaysNeedsYou('full').some(s => /gate that is not green/.test(s)));
  assert.equal(B.automaticAt('manual').length, 0);
  assert.equal(B.automaticAt('assisted').length, 1);
  assert.equal(B.automaticAt('full').length, 3);
  assert.match(B.automaticAt('autonomous')[0], /^Starts the prerequisites/);
  assert.equal(B.autonomyAllowed('full', 'autonomous'), false);
  assert.equal(B.autonomyAllowed('assisted', 'autonomous'), true);
  assert.equal(B.autonomyAllowed('full', undefined), true);
  assert.equal(B.autonomyLevel(undefined).id, 'manual');
});

test('settings draft parsing names the bad field and treats empty WIP as no limit', () => {
  const ok = B.parseSettingsDraft({ budget: '12.5', failures: '3', wipRunning: '', wipReview: '4' }, 2);
  assert.deepEqual(ok, { ok: true, patch: { budgetUsdPerDay: 12.5, pauseAfterFailures: 3, wip: { review: 4 } } });
  assert.match(B.parseSettingsDraft({ budget: 'abc', failures: '', wipRunning: '', wipReview: '' }, 2).error, /Daily budget/);
  assert.match(B.parseSettingsDraft({ budget: '', failures: '1.5', wipRunning: '', wipReview: '' }, 2).error, /Pause after failures/);
  assert.match(B.parseSettingsDraft({ budget: '', failures: '', wipRunning: '2.5', wipReview: '' }, 2).error, /Running limit/);
  assert.equal(B.budgetShare(2.5, 10), 0.25);
  assert.equal(B.budgetShare(20, 10), 1);
  assert.equal(B.budgetShare(1, 0), null);
});

test('autoLandReason reads the risk and the evidence summary', () => {
  assert.equal(B.autoLandReason(task('1', { risk: { score: 5, level: 'low', reasons: [] }, evidence: { md: '', summary: 'Checks passed: test (14).\nmore' } })), 'low risk, Checks passed: test (14).');
  assert.equal(B.autoLandReason(task('1')), 'it met the autonomy rules');
  assert.equal(B.autoLandReason(task('1', { landed: { by: 'auto', decision: { autonomy: 'autonomous', risk: 'low', score: 4, evidence: 'ok', reason: 'low risk, 14 tests passed' } } })), 'low risk, 14 tests passed');
});

// ── agents, feed, metrics, live ──────────────────────────────────────
test('agents strip: engine list wins; otherwise running tasks fill slots and the rest are idle', () => {
  const ts = [task('1', { status: 'running', live: { summary: 'Running RunChecks', at: 'x' } }), task('2', { status: 'running', needs: { kind: 'question', prompt: '?', since: 'x' } })];
  const b = board(ts, { settings: { maxParallel: 3, autoLandLowRisk: false, trunk: 'main' }, running: [{ taskId: '1', runId: 'a', startedAt: 1, costUsd: 0 }, { taskId: '2', runId: 'b', startedAt: 2, costUsd: 0 }] });
  const a = B.agentsOf(b, ts);
  assert.deepEqual(a.map(x => `${x.name}:${x.state}`), ['Agent A:working', 'Agent B:waiting', 'Agent C:idle']);
  assert.equal(a[0].summary, 'Running RunChecks');
  const eng = [{ name: 'Agent Q', state: 'idle' }];
  assert.equal(B.agentsOf({ ...b, agents: eng }, ts), eng);
});

test('feed filters by task and sorts newest first', () => {
  const feed = [{ at: '2026-10-10T10:00:00Z', taskId: '1', kind: 'run', text: 'a' }, { at: '2026-10-10T11:00:00Z', taskId: '2', kind: 'run', text: 'b' }, { at: '2026-10-10T12:00:00Z', kind: 'sys', text: 'c' }];
  assert.deepEqual(B.filterFeed(feed, null).map(e => e.text), ['c', 'b', 'a']);
  assert.deepEqual(B.filterFeed(feed, '1').map(e => e.text), ['a']);
  assert.equal(B.filterFeed(feed, null, 1).length, 1);
});

test('formatSpan and liveLine', () => {
  assert.equal(B.formatSpan(null), '–');
  assert.equal(B.formatSpan(30_000), '<1m');
  assert.equal(B.formatSpan(45 * 60_000), '45m');
  assert.equal(B.formatSpan(130 * 60_000), '2h 10m');
  assert.equal(B.formatSpan(52 * 3600_000), '2d 4h');
  const t = task('1', { live: { summary: 'Editing src/server/auth-middleware.mjs', at: 'x' } });
  assert.equal(B.liveLine(t, 1000, 0.03, 131_000), 'Editing src/server/auth-middleware.mjs · 2m 10s · $0.03');
  assert.equal(B.liveLine(task('2'), undefined, undefined, 0), 'Working · $0.00');
});

test('chat bar chip and session lookup', () => {
  assert.deepEqual(B.deliveryChip('running'), { label: 'Running', tone: 'accent' });
  assert.equal(B.deliveryChip('merged').tone, 'success');
  assert.equal(B.deliveryChip('backlog').label, 'Backlog');
  const ts = [task('1', { sessionId: 's1' }), task('2', { claim: { runId: 'r', sessionId: 's2', leaseUntil: 'x' } }), task('3', { session: { id: 's3' } })];
  assert.equal(B.taskForSession(ts, 's2').id, '2');
  assert.equal(B.taskForSession(ts, 's3').id, '3');
  assert.equal(B.taskForSession(ts, 'nope'), undefined);
});

test('J/K selection clamps and starts at the ends', () => {
  const o = ['a', 'b', 'c'];
  assert.equal(B.stepSelection(o, null, 1), 'a');
  assert.equal(B.stepSelection(o, null, -1), 'c');
  assert.equal(B.stepSelection(o, 'a', 1), 'b');
  assert.equal(B.stepSelection(o, 'c', 1), 'c');
  assert.equal(B.stepSelection(o, 'a', -1), 'a');
  assert.equal(B.stepSelection([], 'a', 1), null);
  assert.ok(B.SHORTCUTS.length >= 8);
});

test('normaliseBoard keeps the new fields it does not validate', () => {
  const b = M.normaliseBoard({ project: '/p', tasks: [], autonomy: 'assisted', agents: [{ name: 'Agent A', state: 'idle' }], feed: [], metrics: { medianCycleMs: null, medianLeadMs: null, throughput7d: 0, spentTodayUsd: 0 }, idleReason: 'x' });
  assert.equal(b.autonomy, 'assisted');
  assert.equal(b.idleReason, 'x');
  assert.equal(b.agents.length, 1);
  assert.equal(b.dispatcher, 'idle');
});

console.log(`delivery-board: ${passed} passed`);
