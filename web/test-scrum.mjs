/**
 * Unit tests for the Scrum mode's client logic that has no DOM: the product backlog's
 * order, which ready tasks the agents will skip, the words for pace and days left, the
 * default dates of a new sprint, the plan dialog's capacity arithmetic, and the chart
 * options (which series appear, where "today" is, that future days have no value). The
 * arithmetic underneath (burndown, velocity, planning) is the engine's own shared module,
 * pinned against fixed journals in scripts/delivery-scrum-test.mjs; here it is only
 * checked to be reachable from the client's import.
 *
 * Bundles its own subject with esbuild, so it runs on its own:
 *   node web/test-scrum.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-scrum-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, 'src', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const S = await load('delivery-scrum');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL ${name}\n`, e); process.exitCode = 1; }
}

const task = (id, over = {}) => ({
  id, project: '/p', title: `Task ${id}`, body: '', acceptance: [], status: 'backlog', priority: 3,
  dependsOn: [], labels: [], createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z', ...over,
});
const sprint = (over = {}) => ({
  id: 's1', name: 'Sprint 1', goal: 'Ship it', start: '2026-10-05', end: '2026-10-16', status: 'active', createdAt: '2026-10-01T08:00:00.000Z',
  startedAt: '2026-10-05T08:00:00.000Z', scope: [], ...over,
});
const entry = (taskId, points, at = '2026-10-04T09:00:00.000Z', kind = 'commit') => ({ at, taskId, points, kind });
const NOW = Date.parse('2026-10-09T10:00:00.000Z');

test('mode defaults to kanban and reads scrum from the settings', () => {
  assert.equal(S.modeOf(null), 'kanban');
  assert.equal(S.modeOf({ settings: { maxParallel: 2, autoLandLowRisk: false, trunk: 'main' } }), 'kanban');
  assert.equal(S.modeOf({ settings: { maxParallel: 2, autoLandLowRisk: false, trunk: 'main', mode: 'scrum' } }), 'scrum');
  assert.deepEqual(S.sprintsOf({}), []);
  assert.deepEqual(S.sprintsOf(null), []);
});

test('the current sprint is the running one, then the one being planned, then the latest closed', () => {
  const a = sprint({ id: 'a', status: 'closed' }); const b = sprint({ id: 'b', status: 'closed' }); const c = sprint({ id: 'c', status: 'planned' }); const d = sprint({ id: 'd', status: 'active' });
  assert.equal(S.currentSprintOf([a, b])?.id, 'b');
  assert.equal(S.currentSprintOf([a, b, c])?.id, 'c');
  assert.equal(S.currentSprintOf([a, b, c, d])?.id, 'd');
  assert.equal(S.currentSprintOf([]), undefined);
  assert.equal(S.activeSprintOf([a, c]), undefined);
  assert.equal(S.plannedSprintOf([a, c])?.id, 'c');
});

test('the product backlog is what could join a sprint, by priority then age', () => {
  const tasks = [
    task('a', { priority: 3 }), task('b', { priority: 1, createdAt: '2026-09-03T00:00:00.000Z' }), task('c', { priority: 1, createdAt: '2026-09-02T00:00:00.000Z' }),
    task('d', { status: 'merged' }), task('e', { sprintId: 's1' }), task('f', { status: 'running' }), task('g', { status: 'blocked', priority: 2 }), task('h', { status: 'ready', priority: 4 }),
    task('i', { status: 'cancelled' }),
  ];
  assert.deepEqual(S.productBacklog(tasks).map(t => t.id), ['c', 'b', 'g', 'a', 'h']);
  assert.deepEqual(S.tasksOfSprint([...tasks, task('j', { sprintId: 's1', status: 'cancelled' })], 's1').map(t => t.id), ['e']);
});

test('a ready task outside the running sprint is flagged as skipped by the agents', () => {
  const sp = [sprint({ id: 's1' })];
  assert.equal(S.skippedBySprint({ status: 'ready' }, sp), true);
  assert.equal(S.skippedBySprint({ status: 'ready', sprintId: 's1' }, sp), false);
  assert.equal(S.skippedBySprint({ status: 'backlog' }, sp), false);
  assert.equal(S.skippedBySprint({ status: 'ready', sprintId: 's1' }, [sprint({ status: 'planned' })]), true, 'with no running sprint nothing starts');
});

test('words: pace, detail, days left, range, points', () => {
  assert.equal(S.PACE_LABEL.behind, 'Behind');
  assert.equal(S.paceTone('on-track'), 'success');
  assert.equal(S.paceTone('behind'), 'warning');
  assert.equal(S.paceTone('closed'), 'neutral');
  assert.match(S.paceDetail({ status: 'behind', delta: 3, remaining: 18, ideal: 15 }), /3 points behind the ideal line \(18 remaining, ideal 15\)/);
  assert.match(S.paceDetail({ status: 'ahead', delta: -1, remaining: 4, ideal: 5 }), /1 point ahead of the ideal/);
  assert.match(S.paceDetail({ status: 'on-track', delta: 0, remaining: 15, ideal: 15 }), /^On track: 15 points remaining/);
  assert.equal(S.daysLeftWord(8, 'active'), '8 days left');
  assert.equal(S.daysLeftWord(1, 'active'), 'last day');
  assert.equal(S.daysLeftWord(0, 'active'), 'ended');
  assert.equal(S.daysLeftWord(5, 'planned'), 'not started');
  assert.equal(S.rangeWord({ start: '2026-10-05', end: '2026-10-16' }), '5 Oct – 16 Oct');
  assert.equal(S.pointsWord(1), '1 pt');
  assert.equal(S.pointsWord(2.5), '2.5 pts');
  assert.deepEqual(S.gapWords({ acceptance: [] }), ['No estimate', 'No criteria']);
  assert.deepEqual(S.gapWords({ estimate: 13, acceptance: ['x'] }), ['Large (13+): consider splitting']);
  assert.deepEqual(S.gapWords({ estimate: 3, acceptance: ['x'] }), []);
});

test('a new sprint starts on the next working day after the last one and runs two weeks, ending on a working day', () => {
  const fri = Date.parse('2026-10-09T10:00:00Z');
  assert.deepEqual(S.defaultSprintDates([], fri, 0), { start: '2026-10-09', end: '2026-10-22' }, 'with no sprint it starts today (a Friday) and ends the Thursday two weeks on');
  assert.deepEqual(S.defaultSprintDates([sprint({ end: '2026-10-02', status: 'closed' })], fri, 0), { start: '2026-10-09', end: '2026-10-22' }, 'a sprint that ended last week does not push the start');
  assert.deepEqual(S.defaultSprintDates([sprint({ end: '2026-10-16' })], fri, 0), { start: '2026-10-19', end: '2026-10-30' }, 'after a running sprint it starts the Monday after it ends');
  assert.deepEqual(S.defaultSprintDates([], Date.parse('2026-10-10T10:00:00Z'), 0), { start: '2026-10-12', end: '2026-10-23' }, 'on a Saturday it starts Monday');
  assert.deepEqual(S.defaultSprintDates([], Date.parse('2026-10-09T20:00:00Z'), 330), { start: '2026-10-12', end: '2026-10-23' }, 'the day follows the time zone: late Friday in India is already Saturday');
  assert.equal(S.nextSprintName([sprint(), sprint({ id: 'x' })]), 'Sprint 3');
  assert.equal(S.validateSprintDates('2026-10-12', '2026-10-23'), null);
  assert.match(S.validateSprintDates('', '2026-10-23'), /Pick a start/);
  assert.match(S.validateSprintDates('2026-10-23', '2026-10-12'), /cannot end before/);
  assert.match(S.validateSprintDates('2026-10-01', '2026-12-31'), /at most 42/);
});

test('the plan dialog: capacity arithmetic and ticking', () => {
  const byId = new Map([task('a', { estimate: 5 }), task('b', { estimate: 3 }), task('c', { estimate: 8, dependsOn: ['a'] }), task('d')].map(t => [t.id, t]));
  const st = S.planState(['a', 'b'], byId, 10);
  assert.equal(st.total, 8); assert.equal(st.over, false); assert.equal(st.remaining, 2); assert.equal(Math.round(st.load * 100), 80);
  const over = S.planState(['a', 'b', 'c'], byId, 10);
  assert.equal(over.total, 16); assert.equal(over.over, true); assert.equal(over.remaining, -6);
  assert.equal(S.planState(['d'], byId, 10).total, 0, 'an unestimated task adds nothing');
  assert.equal(S.planState([], byId, 0).load, 0);
  assert.deepEqual(S.toggleChosen(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(S.toggleChosen(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(S.dependentsInPlan(['a', 'c'], 'a', byId), ['c'], 'unticking a task that another chosen task depends on reports the dependent');
  assert.deepEqual(S.dependentsInPlan(['a', 'b'], 'a', byId), []);
});

test('the proposal and refinement logic is reachable from the client', () => {
  const tasks = [task('a', { estimate: 5, priority: 1 }), task('b', { estimate: 8, priority: 2 }), task('c', { estimate: 3, priority: 3 })];
  const plan = S.proposePlan(tasks, { capacity: 8 });
  assert.deepEqual(plan.items.map(i => i.taskId), ['a', 'c']);
  assert.equal(plan.skipped[0].reason, 'does-not-fit');
  assert.equal(S.SKIP_WORD['does-not-fit'], 'Does not fit the capacity');
  assert.deepEqual(S.POINT_SCALE, [1, 2, 3, 5, 8, 13]);
  assert.equal(S.normalisePoints('3'), 3);
});

const committed = [entry('a', 5), entry('b', 3), entry('c', 8)];
const done = (id, at) => ({ status: 'merged', landed: { from: '', to: '', at, kind: 'feat', breaking: false, by: 'person' }, id });
const board = [
  task('a', { estimate: 5, sprintId: 's1', ...done('a', '2026-10-06T12:00:00.000Z') }),
  task('b', { estimate: 3, sprintId: 's1', status: 'review' }),
  task('c', { estimate: 8, sprintId: 's1', status: 'running' }),
];
const PAL = { actual: '#2a78d6', ideal: '#999', scope: '#bbb', ink: '#111', muted: '#666', line: '#ddd', surface: '#fff', committed: '#9ec1ef' };

test('burndown option: ideal dashed, remaining stops at today, a marker for today, scope only when it moved', () => {
  const sp = sprint({ scope: committed });
  const bd = S.burndown(sp, board, NOW, 0);
  const opt = S.burndownOption(bd, PAL);
  const names = opt.series.map(s => s.name);
  assert.deepEqual(names, ['Ideal', 'Remaining'], 'no scope line while the scope never moved');
  assert.equal(opt.series[0].lineStyle.type, 'dashed');
  const remaining = opt.series[1].data;
  assert.equal(remaining.length, bd.points.length);
  assert.equal(remaining[0], 16); assert.equal(remaining[2], 11);
  assert.equal(remaining[bd.todayIndex], 11);
  assert.equal(remaining[bd.todayIndex + 1], null, 'days that have not happened have no value');
  assert.equal(opt.xAxis.data[0], 'Start');
  assert.equal(opt.xAxis.data[bd.todayIndex], '9 Oct');
  assert.deepEqual(opt.series[1].markLine.data, [{ xAxis: '9 Oct' }], 'a vertical marker at today');
  assert.equal(opt.yAxis.min, 0);
  const moved = S.burndown(sprint({ scope: [...committed, entry('d', 2, '2026-10-08T09:00:00.000Z', 'add')] }), board, NOW, 0);
  assert.deepEqual(S.burndownOption(moved, PAL).series.map(s => s.name), ['Ideal', 'Scope', 'Remaining'], 'a scope step appears once scope moved');
  const text = S.burndownRows(bd);
  assert.deepEqual(text[0], ['Start', '16', '16']);
  assert.deepEqual(text[bd.todayIndex + 1], ['10 Oct', 'not yet', String(bd.points[bd.todayIndex + 1].ideal)]);
});

test('velocity option: committed and completed bars with the rolling average, in sprint order', () => {
  const closed = (id, name, c, d, at) => sprint({ id, name, status: 'closed', closedAt: at, result: { committed: c, completed: d, added: 0, removed: 0, unestimatedMerged: 0, doneIds: [], carried: [] } });
  const v = S.velocity([closed('b', 'Sprint 2', 13, 10, '2026-10-02T17:00:00Z'), closed('a', 'Sprint 1', 10, 10, '2026-09-18T17:00:00Z')]);
  const opt = S.velocityOption(v, PAL);
  assert.deepEqual(opt.xAxis.data, ['Sprint 1', 'Sprint 2']);
  assert.deepEqual(opt.series.map(s => s.name), ['Committed', 'Completed', 'Average']);
  assert.deepEqual(opt.series[0].data, [10, 13]);
  assert.deepEqual(opt.series[1].data, [10, 10]);
  assert.deepEqual(opt.series[2].data, [10, 10]);
  assert.deepEqual(S.velocityRows(v)[1], ['Sprint 2', '13', '10', '10']);
});

test('sprint progress: points and tasks done', () => {
  const sp = sprint({ scope: committed });
  const bd = S.burndown(sp, board, NOW, 0);
  const p = S.sprintProgress(sp, board, bd);
  assert.deepEqual(p, { done: 5, scope: 16, pct: 31, tasksDone: 1, tasksTotal: 3 });
  assert.equal(S.sprintProgress(sp, [], { done: 0, scope: 0 }).pct, 0);
});

console.log(`web/test-scrum: ${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
