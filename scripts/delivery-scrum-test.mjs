/**
 * Scrum as a mode of the Delivery board (ADR 0039 section 4), offline: the pure folds
 * (burndown with its scope step, velocity and capacity, the planning proposal, the daily
 * summary, review and retro), the journal's compatibility with boards that never used
 * Scrum, the services and the person gates on the routes, refinement as suggestions an
 * agent can make and only a person can accept, and the dispatcher's mode gate.
 *
 * Why a script of its own: the folds are checked against FIXED journals with fixed
 * clocks (every event carries its own `at`), so a number that drifts is a failing test,
 * not a flaky one. The pieces that need real git state (the dispatcher starting only the
 * sprint's tasks, splitting a task and cancelling the original) use a real temporary
 * repository and a scripted agent runner, as scripts/delivery-test.mjs does; no model is
 * called and nothing is spent.
 *
 * Part of `npm test`. No network, no cost.
 */

// A store of this process's own: nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) delete process.env[key];

import {
  Delivery as D, DeliveryStore as S, DeliveryScrum as Sc, DeliveryScrumFold as Fold, ScrumModel as M, handleDeliveryRoute, DecisionGate,
  runInContext, deliveryTool, deliveryDefinition, deliveryRefinePrompt, groupsForRequest,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` - ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errOf = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e.message ?? e); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico scrum ')));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => sh('git', args, cwd);

/** A small repository: the dispatcher and the split need real git state. */
function makeProject() {
  const dir = path.join(tmpRoot, `proj-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Owner'); git(dir, 'config', 'user.email', 'owner@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.js'), 'exports.a = 1;\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.aico/\nnode_modules/\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: initial');
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  return fs.realpathSync.native(dir);
}
/** A folder that is not a repository: enough for journal-only tests. */
function makeFolder() {
  const dir = path.join(tmpRoot, `folder-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

// ── fixed journals ───────────────────────────────────────────────────────

const T0 = '2026-09-01T08:00:00.000Z';
const task = (id, over = {}) => ({
  id, project: '', title: `Task ${id}`, body: '', acceptance: [], status: 'backlog', priority: 3, dependsOn: [], labels: [],
  createdAt: T0, updatedAt: T0, ...over,
});
const jl = {
  init: (project) => ({ t: 'init', at: T0, project, trunk: 'main' }),
  task: (at, t) => ({ t: 'task', at, task: t }),
  patch: (at, id, set, unset) => ({ t: 'patch', at, id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) }),
  comment: (at, id, by, text) => ({ t: 'comment', at, id, by, text }),
  merged: (at, id, extra = {}) => ({ t: 'patch', at, id, set: { status: 'merged', landed: { from: 'a', to: 'b', at, kind: 'feat', breaking: false, by: 'person' }, ...extra } }),
  scrum: (at, ev) => ({ t: 'scrum', at, ev }),
};
function writeJournal(project, events, { torn } = {}) {
  const file = S.journalFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n' + (torn ?? ''), 'utf8');
  S.resetStoreCache();
}

// ── 1. a board that never used Scrum ─────────────────────────────────────

console.log('\n-- compatibility: a journal without Scrum events loads as before --');
{
  const p = makeFolder();
  writeJournal(p, [
    jl.init(p), jl.task(T0, task('a1b2c3d4', { project: p, title: 'Old task', status: 'ready' })),
    jl.patch('2026-09-02T08:00:00.000Z', 'a1b2c3d4', { priority: 2 }),
  ], { torn: '{"t":"scrum","at":"2026-09-02' });
  const b = S.boardState(p);
  ok(Object.keys(b).sort().join() === 'dispatcher,project,queue,releases,running,settings,tasks', 'the board has exactly the keys it had before Scrum', Object.keys(b));
  ok(b.settings.mode === undefined && b.sprints === undefined && b.proposals === undefined, 'no mode, sprints or suggestions appear until the first Scrum fact');
  ok(b.tasks[0].priority === 2 && b.tasks[0].estimate === undefined && b.tasks[0].sprintId === undefined, 'tasks carry no estimate or sprint');
  ok(Fold.mayStartInMode(S.load(p).scrum, b.tasks[0]), 'the dispatcher gate lets a Kanban board start a ready task');
  // An unknown future Scrum event and an event for a sprint that does not exist must not break the replay.
  writeJournal(p, [
    jl.init(p), jl.task(T0, task('a1b2c3d4', { project: p })),
    jl.scrum(T0, { k: 'commit', sprint: 'ffffffff', add: ['a1b2c3d4'], remove: [] }),
    jl.scrum(T0, { k: 'wat', x: 1 }),
    jl.scrum(T0, { k: 'estimate', task: 'a1b2c3d4', points: 5 }),
  ]);
  const b2 = S.boardState(p);
  ok(b2.tasks[0].estimate === 5 && b2.tasks[0].sprintId === undefined, 'a commit to an unknown sprint and an unknown event are ignored; the estimate still applies', b2.tasks[0]);
}

// ── 2. folds over a fixed journal ────────────────────────────────────────

console.log('\n-- the folds: sprints, scope, burndown, velocity, capacity --');
const P = makeFolder();
const NOW = Date.parse('2026-10-09T10:00:00.000Z');   // a Friday, the fifth day of sprint 3
{
  const t = (id, over) => jl.task(T0, task(id, { project: P, ...over }));
  const ev = [jl.init(P),
    // Sprint 1: 5 + 5, both done.
    t('a0000001', { title: 'S1 one' }), t('a0000002', { title: 'S1 two' }),
    jl.scrum('2026-09-05T09:00:00.000Z', { k: 'sprint', id: 's1000001', name: 'Sprint 1', goal: 'Start', start: '2026-09-07', end: '2026-09-18' }),
    jl.scrum('2026-09-05T09:01:00.000Z', { k: 'estimate', task: 'a0000001', points: 5 }),
    jl.scrum('2026-09-05T09:02:00.000Z', { k: 'estimate', task: 'a0000002', points: 5 }),
    jl.scrum('2026-09-05T09:03:00.000Z', { k: 'commit', sprint: 's1000001', add: ['a0000001', 'a0000002'], remove: [] }),
    jl.scrum('2026-09-07T08:00:00.000Z', { k: 'start', sprint: 's1000001' }),
    jl.merged('2026-09-10T12:00:00.000Z', 'a0000001'), jl.merged('2026-09-15T12:00:00.000Z', 'a0000002'),
    jl.scrum('2026-09-18T17:00:00.000Z', { k: 'close', sprint: 's1000001' }),
    // Sprint 2: 8 + 5 committed, 2 added, the 5 is not finished.
    t('b0000001', { title: 'S2 big' }), t('b0000002', { title: 'S2 carried' }), t('b0000003', { title: 'S2 added' }),
    jl.scrum('2026-09-19T09:00:00.000Z', { k: 'sprint', id: 's2000001', name: 'Sprint 2', goal: 'Grow', start: '2026-09-21', end: '2026-10-02' }),
    jl.scrum('2026-09-19T09:01:00.000Z', { k: 'estimate', task: 'b0000001', points: 8 }),
    jl.scrum('2026-09-19T09:02:00.000Z', { k: 'estimate', task: 'b0000002', points: 5 }),
    jl.scrum('2026-09-19T09:03:00.000Z', { k: 'commit', sprint: 's2000001', add: ['b0000001', 'b0000002'], remove: [] }),
    jl.scrum('2026-09-21T08:00:00.000Z', { k: 'start', sprint: 's2000001' }),
    jl.scrum('2026-09-24T09:00:00.000Z', { k: 'estimate', task: 'b0000003', points: 2 }),
    jl.scrum('2026-09-24T09:01:00.000Z', { k: 'commit', sprint: 's2000001', add: ['b0000003'], remove: [] }),
    jl.merged('2026-09-25T12:00:00.000Z', 'b0000001'), jl.merged('2026-09-29T12:00:00.000Z', 'b0000003'),
    jl.scrum('2026-10-02T17:00:00.000Z', { k: 'close', sprint: 's2000001' }),
    // Sprint 3 (active): carried 5 + 5 + 3 + 8 = 21 committed; 2 added on Thursday; one cancelled; one unestimated, blocked.
    t('c0000001', { title: 'S3 one' }), t('c0000002', { title: 'S3 two' }), t('c0000003', { title: 'S3 three', status: 'running', needs: { kind: 'question', prompt: 'Which currency?', since: '2026-10-09T08:00:00.000Z' } }),
    t('c0000004', { title: 'S3 added', status: 'ready' }), t('c0000005', { title: 'S3 cancelled' }), t('c0000006', { title: 'S3 stuck', status: 'blocked' }),
    jl.comment('2026-10-08T11:00:00.000Z', 'c0000006', 'agent', 'The run ended without finishing: spend ceiling reached.'),
    jl.scrum('2026-10-02T18:00:00.000Z', { k: 'sprint', id: 's3000001', name: 'Sprint 3', goal: 'Ship checkout', start: '2026-10-05', end: '2026-10-16', capacityPoints: 20 }),
    jl.scrum('2026-10-02T18:01:00.000Z', { k: 'estimate', task: 'c0000001', points: 5 }), jl.scrum('2026-10-02T18:02:00.000Z', { k: 'estimate', task: 'c0000002', points: 3 }),
    jl.scrum('2026-10-02T18:03:00.000Z', { k: 'estimate', task: 'c0000003', points: 8 }), jl.scrum('2026-10-02T18:04:00.000Z', { k: 'estimate', task: 'c0000005', points: 4 }),
    jl.scrum('2026-10-03T09:00:00.000Z', { k: 'commit', sprint: 's3000001', add: ['b0000002', 'c0000001', 'c0000002', 'c0000003', 'c0000005'], remove: [] }),
    jl.scrum('2026-10-05T08:00:00.000Z', { k: 'start', sprint: 's3000001' }),
    jl.merged('2026-10-06T12:00:00.000Z', 'c0000001'), jl.merged('2026-10-08T15:00:00.000Z', 'c0000002', { evidence: { md: '', summary: 'Checks passed: test (14). 2 files, +20 -3.' } }),
    jl.scrum('2026-10-08T09:00:00.000Z', { k: 'estimate', task: 'c0000004', points: 2 }),
    jl.scrum('2026-10-08T09:01:00.000Z', { k: 'commit', sprint: 's3000001', add: ['c0000004', 'c0000006'], remove: [] }),
    jl.patch('2026-10-08T10:00:00.000Z', 'c0000005', { status: 'cancelled' }),
  ];
  writeJournal(P, ev);
  const b = S.boardState(P);
  const sp = (id) => b.sprints.find(s => s.id === id);
  const by = (id) => b.tasks.find(t => t.id === id);
  ok(b.settings.mode === undefined && b.sprints.length === 3 && b.sprints.map(s => s.status).join() === 'closed,closed,active', 'three sprints fold in order: closed, closed, active');

  // Closing freezes the result.
  const r1 = sp('s1000001').result; const r2 = sp('s2000001').result;
  ok(r1.committed === 10 && r1.completed === 10 && r1.carried.length === 0 && r1.added === 0, 'sprint 1 result: 10 committed, 10 done, nothing carried', r1);
  ok(r2.committed === 13 && r2.completed === 10 && r2.added === 2 && r2.carried.join() === 'b0000002' && r2.doneIds.join() === 'b0000001,b0000003', 'sprint 2 result: 13 committed, 10 done, 2 added, one carried', r2);
  ok(by('b0000002').sprintId === 's3000001' && by('a0000001').sprintId === 's1000001' && by('b0000001').sprintId === 's2000001', 'done tasks keep their sprint; the carried one was recommitted to sprint 3');

  // Velocity and capacity.
  const v = M.velocity(b.sprints);
  ok(v.rows.length === 2 && v.rows[0].completed === 10 && v.rows[1].completed === 10 && v.rows[1].average === 10 && v.average === 10, 'velocity: two closed sprints, rolling average 10', v);
  ok(M.defaultCapacity(b.sprints) === 10, 'default capacity is the mean of the last closed sprints');
  ok(M.defaultCapacity([]) === undefined && M.velocity([]).average === null, 'no history: no default capacity, no average');
  const long = [10, 20, 30, 40].map((n, i) => ({ id: `x${i}`, name: `S${i}`, goal: '', start: '2026-01-01', end: '2026-01-02', status: 'closed', createdAt: T0, closedAt: `2026-0${i + 1}-05T00:00:00.000Z`, scope: [], result: { committed: n, completed: n, added: 0, removed: 0, unestimatedMerged: i === 3 ? 2 : 0, doneIds: [], carried: [] } }));
  ok(M.velocity(long).rows.map(r => r.average).join() === '10,15,20,30' && M.velocity(long).average === 30 && M.velocity(long).unestimatedMerged === 2, 'the rolling average looks back three sprints; unestimated merges are counted and reported');

  // Burndown of the active sprint, on the fifth day.
  const s3 = sp('s3000001');
  const bd = M.burndown(s3, b.tasks, NOW, 0);
  ok(bd.committed === 25 && bd.days === 12 && bd.workdays === 10, 'committed is the scope at the start (5 carried + 5 + 3 + 8 + 4), over 12 days with 10 working days', { committed: bd.committed, days: bd.days, workdays: bd.workdays });
  const p = bd.points;
  ok(p.length === 13 && p[0].remaining === 25 && p[0].ideal === 25 && p[0].date === '2026-10-05', 'point 0 is the start of the sprint', p[0]);
  ok(p[1].date === '2026-10-05' && p[1].remaining === 25 && near(p[1].ideal, 22.5), 'end of day 1: nothing merged yet, ideal 22.5');
  ok(p[2].remaining === 20 && p[3].remaining === 20, 'the first merge (5) is on day 2 and holds on day 3', [p[2], p[3]]);
  ok(p[4].scope === 23 && p[4].done === 8 && p[4].remaining === 15, 'day 4: scope is 23 (2 added, the 4 cancelled), 8 done, 15 remaining', p[4]);
  ok(p[5].remaining === 15 && p[6].remaining === null && p[12].remaining === null, 'today is the last point with a value; later days have none', [p[5], p[6]]);
  ok(near(p[5].ideal, 12.5) && near(p[6].ideal, 12.5) && near(p[7].ideal, 12.5) && near(p[8].ideal, 10) && p[12].ideal === 0, 'the ideal line is flat over the weekend and ends at 0');
  ok(bd.todayIndex === 5 && bd.remaining === 15 && bd.done === 8 && bd.scope === 23, 'today is point 5: 15 remaining of 23, 8 done');
  ok(bd.scopeChanges.map(c => `${c.kind}:${c.points}`).join() === 'add:2,remove:-4' && bd.scopeChanges.every(c => c.date === '2026-10-08'), 'scope that moved after the start is listed, not hidden: a 2 added and the cancelled 4 removed (a zero-point add is not a step)', bd.scopeChanges);
  ok(near(bd.ideal, 15) && near(bd.delta, 0) && bd.status === 'on-track', 'against the ideal at the end of yesterday: level, on track', { ideal: bd.ideal, delta: bd.delta, status: bd.status });
  const slow = M.burndown(s3, b.tasks.map(t => (t.id === 'c0000002' ? { ...t, status: 'review' } : t)), NOW, 0);
  const fast = M.burndown(s3, b.tasks.map(t => (t.id === 'c0000003' ? { ...t, status: 'merged', landed: { from: '', to: '', at: '2026-10-06T09:00:00.000Z', kind: 'feat', breaking: false, by: 'person' } } : t)), NOW, 0);
  ok(slow.status === 'behind' && slow.remaining === 18 && fast.status === 'ahead' && fast.remaining === 7, 'behind when remaining is more than 10% over the ideal, ahead when it is that much under', { slow: [slow.remaining, slow.delta], fast: [fast.remaining, fast.delta] });
  ok(M.daysLeft(s3, NOW, 0) === 8 && !M.overdue(s3, NOW, 0) && M.overdue(s3, Date.parse('2026-10-17T09:00:00Z'), 0), 'eight days left counting today; overdue only after the end date');
  // A time zone moves the day boundary: 02:00 on the 10th in India is still the 9th in UTC, so a merge then lands on the 10th locally.
  ok(M.dayKey(Date.parse('2026-10-09T22:00:00Z'), 330) === '2026-10-10' && M.dayKey(Date.parse('2026-10-09T22:00:00Z'), 0) === '2026-10-09', 'the day of an instant follows the offset given');
  // The cancelled task (4) was part of the commit: it leaves the scope when it is cancelled.
  const before = M.burndown(s3, b.tasks.map(t => (t.id === 'c0000005' ? { ...t, status: 'ready' } : t)), NOW, 0);
  ok(before.scope === 27 && bd.scope === 23, 'a cancelled task leaves the scope instead of staying as remaining work', { with: before.scope, without: bd.scope });
  ok(JSON.stringify(M.burndown(s3, b.tasks, NOW, 0)) === JSON.stringify(bd), 'the same journal and clock give the same burndown');
  const planned = M.burndown({ ...s3, status: 'planned', startedAt: undefined }, b.tasks, NOW, 0);
  ok(planned.status === 'not-started' && planned.points.every(x => x.remaining === null), 'a planned sprint has no remaining line yet');
  const closedBd = M.burndown(sp('s2000001'), b.tasks, NOW, 0);
  ok(closedBd.status === 'closed' && closedBd.points.at(-1).remaining === 5 && closedBd.committed === 13 && closedBd.scopeChanges.length === 1, 'a closed sprint keeps its final remaining (the carried 5) and its scope step', closedBd.points.at(-1));
}

// ── 3. planning proposal ─────────────────────────────────────────────────

console.log('\n-- the planning proposal: capacity, priority, dependencies --');
{
  const mk = (id, over) => task(id, { createdAt: `2026-09-0${(parseInt(id.slice(-1), 16) % 8) + 1}T08:00:00.000Z`, ...over });
  const tasks = [
    mk('p0000001', { title: 'one', priority: 1, estimate: 5, touches: { files: ['src/cart.js'], symbols: [], predicted: true }, acceptance: ['x'] }),
    mk('p0000002', { title: 'two', priority: 1, estimate: 8 }),
    mk('p0000003', { title: 'three', priority: 2, estimate: 3, dependsOn: ['p0000005'], touches: { files: ['src/cart.js', 'src/a.js'], symbols: [], predicted: true } }),
    mk('p0000004', { title: 'four', priority: 2, estimate: 13 }),
    mk('p0000005', { title: 'five', priority: 4, estimate: 2 }),
    mk('p0000006', { title: 'six', priority: 3 }),
    mk('p0000007', { title: 'seven', priority: 3, estimate: 2 }),
    mk('p0000008', { title: 'eight', priority: 2, estimate: 5, dependsOn: ['p0000004'] }),
    mk('p0000009', { title: 'nine merged dep', priority: 1, estimate: 1, status: 'merged' }),
    mk('p000000a', { title: 'ten', priority: 1, estimate: 1, dependsOn: ['p0000009'] }),
    mk('p000000b', { title: 'blocked', priority: 1, estimate: 1, status: 'blocked' }),
    mk('p000000c', { title: 'in another sprint', priority: 1, estimate: 1, sprintId: 'zzzzzzzz' }),
  ];
  const plan = M.proposePlan(tasks, { capacity: 12 });
  ok(plan.capacity === 12 && plan.capacitySource === 'given', 'the capacity given is used');
  ok(plan.items.map(i => i.taskId).join() === 'p0000001,p000000a,p0000005,p0000003', 'priority order, a merged dependency needs nothing, and a dependency comes before the task that needs it', plan.items.map(i => i.taskId));
  ok(plan.total === 11 && plan.total <= plan.capacity, 'the plan fits the capacity: 5 + 1 + 2 + 3 points', plan.total);
  ok(plan.items.find(i => i.taskId === 'p0000005').dependency === true, 'a task pulled in only as a dependency says so');
  const why = Object.fromEntries(plan.skipped.map(s => [s.taskId, s.reason]));
  ok(why.p0000002 === 'does-not-fit' && why.p0000004 === 'too-big' && why.p0000008 === 'waits-for-dependency' && why.p0000006 === 'needs-estimate' && why.p0000007 === 'does-not-fit', 'each left-out task has a reason', why);
  ok(!('p000000b' in why) && !plan.items.some(i => i.taskId === 'p000000b' || i.taskId === 'p000000c'), 'blocked tasks and tasks already in a sprint are not candidates');
  ok(plan.unestimated === 1 && plan.skipped.find(s => s.taskId === 'p0000008').detail === 'four', 'unestimated items are counted; a dependency wait names the task it waits for');
  ok(plan.overlaps.length === 1 && plan.overlaps[0].files.join() === 'src/cart.js', 'two planned tasks that predict the same file are flagged, since agents would take turns on them', plan.overlaps);
  ok(plan.withoutAcceptance === 3, 'items without acceptance criteria are counted', plan.withoutAcceptance);
  ok(JSON.stringify(M.proposePlan(tasks, { capacity: 12 })) === JSON.stringify(plan), 'the same board and capacity give the same plan');
  ok(M.proposePlan(tasks, { velocityCapacity: 7 }).capacitySource === 'velocity' && M.proposePlan(tasks, {}).capacitySource === 'starter' && M.proposePlan(tasks, {}).capacity === M.STARTER_CAPACITY, 'with no capacity given it falls back to velocity, then to a labelled starter value');
  const kept = M.proposePlan([...tasks, mk('p000000d', { title: 'kept', estimate: 4, sprintId: 'sp', priority: 4 })], { capacity: 12, sprintId: 'sp' });
  ok(kept.items[0].taskId === 'p000000d' && kept.items[0].kept === true && kept.total <= 12, 'tasks already committed to the sprint count against its capacity');
  ok(M.refinementGaps({ acceptance: [] }).join() === 'estimate,acceptance' && M.refinementGaps({ estimate: 13, acceptance: ['a'] }).join() === 'split' && M.refinementGaps({ estimate: 3, acceptance: ['a'] }).length === 0, 'refinement gaps: estimate, acceptance, split at 13');
  ok(M.normalisePoints('5') === 5 && M.normalisePoints(2.7) === 2.5 && M.normalisePoints(0) === undefined && M.normalisePoints(101) === undefined && M.normalisePoints('x') === undefined && M.normalisePoints(null) === undefined, 'estimates are positive numbers up to 100 in half steps');
}

// ── 4. daily summary, review, retro ──────────────────────────────────────

console.log('\n-- daily summary, sprint review and retro: from the log, deterministic --');
{
  const b = S.boardState(P);
  const s3 = b.sprints.find(s => s.id === 's3000001');
  const d = M.dailySummary({ tasks: b.tasks, sprints: b.sprints, now: NOW, offsetMin: 0, mode: 'scrum' });
  ok(d.date === '2026-10-09' && d.since === '2026-10-08' && d.sprint.name === 'Sprint 3' && d.sprint.day === 5 && d.sprint.of === 12 && d.sprint.daysLeft === 8, 'the summary names the day, the sprint and the days left', { sprint: d.sprint, since: d.since });
  ok(d.done.map(x => x.title).join() === 'S3 two' && d.donePoints === 3, 'done since yesterday: only what merged on or after the previous working day');
  ok(d.inProgress.map(x => x.title).join() === 'S3 three' && d.needsYou.length === 1 && d.needsYou[0].reason === 'Which currency?', 'in progress and needs-you come from the task state');
  ok(d.blocked.length === 1 && /spend ceiling/.test(d.blocked[0].reason), 'a blocked task carries its last note as the reason');
  ok(d.pace.status === 'on-track' && d.pace.remaining === 15, 'the burndown status is in the summary');
  const monday = M.dailySummary({ tasks: b.tasks, sprints: b.sprints, now: Date.parse('2026-10-12T07:00:00Z'), offsetMin: 0, mode: 'scrum' });
  ok(monday.since === '2026-10-09' && monday.done.length === 0, 'a Monday summary starts from Friday, so a weekend is covered');
  const md = M.dailyMarkdown(d);
  ok(md === M.dailyMarkdown(M.dailySummary({ tasks: b.tasks, sprints: b.sprints, now: NOW, offsetMin: 0, mode: 'scrum' })), 'the same log and clock give the same text');
  ok(/## Done since 8 Oct\n- S3 two \(3\)/.test(md) && /## Blocked\n- S3 stuck: The run ended/.test(md) && /15 points remaining of 23 points, on track\./.test(md), 'the text reads as a stand-up', md);
  const kanban = M.dailySummary({ tasks: b.tasks, sprints: b.sprints, now: NOW, offsetMin: 0, mode: 'kanban' });
  ok(kanban.sprint !== undefined && kanban.done.length >= 1, 'outside Scrum the summary is about the whole board');

  const review = M.reviewMarkdown(s3, b.tasks, 0);
  ok(review === M.reviewMarkdown(s3, b.tasks, 0), 'the review draft is deterministic');
  ok(/# Sprint review: Sprint 3/.test(review) && /\*\*Goal\.\*\* Ship checkout/.test(review) && /### S3 two \(3\)\nChecks passed: test \(14\)\. 2 files/.test(review), 'delivered work shows its evidence summary', review);
  ok(/## Not finished[\s\S]*### S3 three \(8\)\nStatus: running/.test(review) && !/S3 cancelled/.test(review), 'unfinished work is listed, not omitted; a cancelled task is not');
  ok(/Delivered 8 points of 25 points committed\*\*, with 2 points added after the start/.test(review), 'the headline compares delivered with committed and names the scope added', review.split('\n').find(l => l.startsWith('**Delivered')));
  const r2 = M.reviewMarkdown(b.sprints.find(s => s.id === 's2000001'), b.tasks, 0);
  ok(/with 2 points added after the start/.test(r2) && /## Scope changes\n\n- 2026-09-24: added "S2 added" \(\+2\)/.test(r2) && /### S2 carried \(5\)/.test(r2), 'a closed sprint review lists its scope change and the carried item', r2);
}

console.log('\n-- retro facts: cycle time, rounds, flaky runs, waits --');
{
  const R = makeFolder();
  const t = (id, over) => jl.task(T0, task(id, { project: R, ...over }));
  writeJournal(R, [jl.init(R), t('r0000001', { title: 'Fast', costUsd: 0.4 }), t('r0000002', { title: 'Slow', costUsd: 1.1 }), t('r0000003', { title: 'Carried' }),
    jl.scrum('2026-10-01T09:00:00.000Z', { k: 'sprint', id: 'sr000001', name: 'Sprint R', goal: '', start: '2026-10-05', end: '2026-10-09' }),
    jl.scrum('2026-10-01T09:01:00.000Z', { k: 'estimate', task: 'r0000001', points: 3 }), jl.scrum('2026-10-01T09:02:00.000Z', { k: 'estimate', task: 'r0000002', points: 5 }),
    jl.scrum('2026-10-01T09:03:00.000Z', { k: 'commit', sprint: 'sr000001', add: ['r0000001', 'r0000002', 'r0000003'], remove: [] }),
    jl.scrum('2026-10-05T08:00:00.000Z', { k: 'start', sprint: 'sr000001' }),
    { t: 'start', at: '2026-10-05T09:00:00.000Z', id: 'r0000001', runId: 'x' },
    jl.merged('2026-10-05T11:00:00.000Z', 'r0000001'),
    { t: 'start', at: '2026-10-05T09:30:00.000Z', id: 'r0000002', runId: 'y' },
    jl.patch('2026-10-06T10:00:00.000Z', 'r0000002', { status: 'changes' }), jl.comment('2026-10-06T10:00:00.000Z', 'r0000002', 'agent', 'Rebase conflict against main in: a.js.'),
    jl.patch('2026-10-07T10:00:00.000Z', 'r0000002', { status: 'changes' }), jl.comment('2026-10-07T10:00:00.000Z', 'r0000002', 'agent', 'Checks failed: test (node check.js) did not pass.'),
    jl.patch('2026-10-07T12:00:00.000Z', 'r0000002', { status: 'changes' }), jl.comment('2026-10-07T12:00:00.000Z', 'r0000002', 'person', 'Please add a test.'),
    { t: 'checks', at: '2026-10-07T09:00:00.000Z', tree: 'T1', ok: false, results: [] }, { t: 'checks', at: '2026-10-07T09:10:00.000Z', tree: 'T1', ok: true, results: [] },
    { t: 'checks', at: '2026-10-07T09:20:00.000Z', tree: 'T2', ok: true, results: [] },
    jl.patch('2026-10-08T09:00:00.000Z', 'r0000002', { needs: { kind: 'question', prompt: '?', since: '2026-10-08T09:00:00.000Z' } }),
    jl.patch('2026-10-08T10:30:00.000Z', 'r0000002', {}, ['needs']),
    jl.merged('2026-10-09T09:30:00.000Z', 'r0000002'),
    jl.scrum('2026-10-09T18:00:00.000Z', { k: 'close', sprint: 'sr000001' }),
  ]);
  const f = Sc.retroFacts(R, 'sr000001', NOW);
  ok(f.committed === 8 && f.completed === 8 && f.tasksDone === 2 && f.tasksTotal === 3 && f.carried === 1, 'facts: points and task counts from the frozen result', f);
  ok(f.changeRounds === 3 && f.conflicts === 1 && f.failedChecks === 1, 'three trips back for changes: one conflict, one failed check, one from a person', f);
  ok(f.flakyChecks === 1, 'a tree that failed and then passed is counted as flaky; one that only passed is not');
  ok(f.needsWaits === 1 && f.needsWaitMs === 90 * 60_000, 'one wait for a person, 90 minutes', f);
  ok(f.cycleMedianMs === 2 * 3_600_000 && f.cycleLongest.title === 'Slow' && f.cycleLongest.ms === 96 * 3_600_000, 'cycle time is first run to landing: median 2 h, longest 96 h', f);
  ok(f.costUsd === 1.5 && f.costPerPoint === 0.19, 'spend and cost per delivered point', f);
  const draft = Sc.sprintRetro(R, 'sr000001', NOW);
  ok(draft.draft === Sc.sprintRetro(R, 'sr000001', NOW).draft && /Work went back 3 times for changes \(1 rebase conflict, 1 failed check\)/.test(draft.draft) && /## What went well/.test(draft.draft) && /1\.5 h in total/.test(draft.draft), 'the retro draft states the facts, then asks three questions', draft.draft);
  await Sc.saveNotes(R, 'sr000001', 'retro', 'We shipped. Next time: smaller tasks.');
  ok(Sc.sprintRetro(R, 'sr000001', NOW).saved.text.startsWith('We shipped') && Sc.sprintReview(R, 'sr000001').saved === undefined, 'a saved retro comes back beside the draft; the review is separate');
  ok(/must be/.test(await errOf(() => Sc.saveNotes(R, 'sr000001', 'poem', 'x'))), 'only review and retro notes can be saved');
}

// ── 5. services ──────────────────────────────────────────────────────────

console.log('\n-- services: mode, sprints, estimates, commit, start, close --');
{
  D.resetDeliveryForTest();
  const p = makeProject();
  const a = await D.createTask(p, { title: 'Alpha', acceptance: ['works'] });
  const b = await D.createTask(p, { title: 'Beta' });
  const c = await D.createTask(p, { title: 'Gamma' });
  ok(await Sc.setMode(p, 'scrum') === 'scrum' && D.boardState(p).settings.mode === 'scrum', 'the board switches to Scrum');
  ok(/mode must be/.test(await errOf(() => Sc.setMode(p, 'waterfall'))), 'an unknown mode is refused');
  ok(/dates/.test(await errOf(() => Sc.createSprint(p, { start: 'tomorrow', end: '2026-10-20' }))) && /before it starts/.test(await errOf(() => Sc.createSprint(p, { start: '2026-10-20', end: '2026-10-19' }))) && /at most 42/.test(await errOf(() => Sc.createSprint(p, { start: '2026-10-01', end: '2026-12-31' }))), 'sprint dates are validated');
  ok(/capacity/.test(await errOf(() => Sc.createSprint(p, { start: '2026-10-12', end: '2026-10-23', capacityPoints: -3 }))), 'capacity is validated');
  const sp = await Sc.createSprint(p, { start: '2026-10-12', end: '2026-10-23', goal: 'Checkout', capacityPoints: 12 });
  ok(sp.status === 'planned' && sp.name === 'Sprint 1' && sp.goal === 'Checkout' && sp.capacityPoints === 12 && /^[a-f0-9]{8}$/.test(sp.id), 'a planned sprint gets a default name and an id', sp);
  ok(/still being planned/.test(await errOf(() => Sc.createSprint(p, { start: '2026-11-02', end: '2026-11-13' }))), 'only one sprint can be in planning at a time');
  ok(/estimate is a positive number/.test(await errOf(() => Sc.setEstimate(p, a.id, 0))) && /estimate is a positive number/.test(await errOf(() => Sc.setEstimate(p, a.id, 'lots'))), 'a bad estimate names the scale');
  ok((await Sc.setEstimate(p, a.id, 5)).estimate === 5 && (await Sc.setEstimate(p, b.id, '3')).estimate === 3 && (await Sc.setEstimate(p, c.id, 13)).estimate === 13, 'estimates are set');
  ok((await Sc.setEstimate(p, c.id, null)).estimate === undefined, 'and cleared');
  ok(/no task/.test(await errOf(() => Sc.setEstimate(p, 'ffffffff', 3))), 'an estimate for an unknown task is a 404');
  ok(/at least one task/.test(await errOf(() => Sc.startSprint(p, sp.id))), 'an empty sprint cannot start');
  const committed = await Sc.commitSprint(p, sp.id, [a.id, b.id]);
  ok(D.boardState(p).tasks.find(t => t.id === a.id).sprintId === sp.id && committed.scope.length === 2 && M.scopeAt(committed) === 8 && committed.committedAt, 'commit puts tasks in the sprint with their points as scope', committed.scope);
  await Sc.commitSprint(p, sp.id, [], [b.id]);
  ok(D.boardState(p).tasks.find(t => t.id === b.id).sprintId === undefined && M.scopeAt(D.boardState(p).sprints[0]) === 5, 'taking a task out removes its points from the scope');
  await Sc.setEstimate(p, a.id, 8);
  ok(M.scopeAt(D.boardState(p).sprints[0]) === 8, 're-estimating a member moves the scope');
  await Sc.commitSprint(p, sp.id, [b.id]);
  const started = await Sc.startSprint(p, sp.id);
  const after = D.boardState(p);
  ok(started.status === 'active' && started.startedAt && after.tasks.filter(t => t.sprintId === sp.id).every(t => t.status === 'ready') && after.tasks.find(t => t.id === c.id).status === 'backlog', 'starting readies the sprint\'s tasks and nothing else', after.tasks.map(t => [t.title, t.status]));
  ok(/is active/.test(await errOf(() => Sc.startSprint(p, sp.id))), 'a sprint starts once');
  const next = await Sc.createSprint(p, { start: '2026-11-02', end: '2026-11-13' });
  ok(/already in another sprint/.test(await errOf(() => Sc.commitSprint(p, next.id, [a.id]))), 'a task in one sprint cannot be committed to another');
  ok(/still running/.test(await errOf(() => Sc.startSprint(p, next.id))), 'a second sprint cannot start while one runs');
  const d = await D.createTask(p, { title: 'Delta' });
  await Sc.setEstimate(p, d.id, 2);
  await Sc.commitSprint(p, sp.id, [d.id]);
  const mid = D.boardState(p);
  ok(mid.tasks.find(t => t.id === d.id).status === 'ready' && mid.sprints[0].scope.at(-1).kind === 'add', 'joining a running sprint is a recorded scope change and readies the task');
  await D.updateTask(p, b.id, { status: 'cancelled' }, 'person');
  // Merge one of them the way the board does, then close.
  S.patchTask(p, a.id, { status: 'merged', landed: { from: 'a', to: 'b', at: new Date().toISOString(), kind: 'feat', breaking: false, by: 'person' } });
  const closed = await Sc.closeSprint(p, sp.id);
  ok(closed.status === 'closed' && closed.result.doneIds.join() === a.id && closed.result.carried.join() === d.id && closed.result.completed === 8 && closed.result.committed === 11, 'closing freezes the result: a done, d carried, the cancelled b neither', closed.result);
  const final = D.boardState(p);
  ok(final.tasks.find(t => t.id === d.id).sprintId === undefined && final.tasks.find(t => t.id === d.id).status === 'backlog' && final.tasks.find(t => t.id === a.id).sprintId === sp.id, 'unfinished work returns to the product backlog (a ready task goes back to backlog); done work keeps its sprint');
  ok(/closed/.test(await errOf(() => Sc.closeSprint(p, sp.id))) && /closed/.test(await errOf(() => Sc.commitSprint(p, sp.id, [c.id]))), 'a closed sprint accepts nothing more');
  const view = Sc.scrumView(p, Date.now());
  ok(view.mode === 'scrum' && view.sprints.length === 2 && view.velocity.rows.length === 1 && view.suggestedCapacity === 8 && view.active === undefined && typeof view.dailyMarkdown === 'string', 'the scrum view reads back', Object.keys(view));
  // The estimate survives a whole-task event that replaces the task (an import, a replan).
  S.putTask(p, { ...S.getTask(p, c.id), title: 'Gamma renamed' });
  await Sc.setEstimate(p, c.id, 5);
  S.putTask(p, { ...S.getTask(p, c.id), title: 'Gamma again' });
  ok(S.getTask(p, c.id).estimate === 5 && S.getTask(p, c.id).title === 'Gamma again', 'an estimate is not lost when a later event replaces the whole task');
  // Reload from disk: the fold is the same.
  S.resetStoreCache();
  ok(JSON.stringify(D.boardState(p).sprints) === JSON.stringify(final.sprints) && D.boardState(p).settings.mode === 'scrum', 'a restart folds the journal to the same sprints');
  D.resetDeliveryForTest();
}

// ── 6. routes: the gate ──────────────────────────────────────────────────

console.log('\n-- routes: a person for commit, start, close and accept --');
{
  D.resetDeliveryForTest();
  const p = makeProject();
  const gate = new DecisionGate();
  const mkReq = (method, headers = {}) => ({ method, headers, on() {} });
  const deps = () => ({
    send: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body ?? {},
    isKnownProject: async (d) => path.resolve(d) === p,
    human: (req, body) => gate.checkHuman({ grant: req.headers['x-aico-grant'], client: body.client, uiKey: req.headers['x-aico-ui-key'], fetchSite: undefined }),
    startPlan: async (project, brief, kind) => { refines.push({ project, brief, kind }); return { sessionId: 'refine-1' }; }, subscribe: () => () => {},
  });
  const refines = [];
  const call = async (route, method, body = {}, { person = false, query = '' } = {}) => {
    const req = mkReq(method, person ? { 'x-aico-ui-key': gate.uiKey } : {}); req.body = body;
    const res = { headers: {}, written: [], write() {} };
    const handled = await handleDeliveryRoute(route, req, res, new URL(`http://127.0.0.1/api/${route}${query}`), deps());
    return { handled, status: res.status, body: res.body };
  };
  const q = `?project=${encodeURIComponent(p)}`;
  const t1 = (await call('delivery/tasks', 'POST', { project: p, title: 'Routed one' })).body;
  const t2 = (await call('delivery/tasks', 'POST', { project: p, title: 'Routed two' })).body;

  ok((await call('delivery/scrum', 'GET', {}, { query: q })).body.mode === 'kanban', 'GET scrum on a new board reads Kanban');
  ok((await call('delivery/scrum', 'GET')).status === 400 && (await call('delivery/scrum', 'GET', {}, { query: '?project=' + encodeURIComponent(os.tmpdir()) })).status === 403, 'project is required and must be registered');
  ok((await call('delivery/scrum/mode', 'POST', { project: p, mode: 'scrum' })).body.mode === 'scrum', 'switching the mode needs only the token (it starts nothing)');
  const est = await call(`delivery/scrum/tasks/${t1.id}`, 'PATCH', { project: p, estimate: 5 });
  ok(est.status === 200 && est.body.estimate === 5, 'an estimate needs only the token');
  ok((await call(`delivery/scrum/tasks/${t1.id}`, 'PATCH', { project: p })).status === 400 && (await call(`delivery/scrum/tasks/${t1.id}`, 'PATCH', { project: p, estimate: 'x' })).status === 400, 'a missing or bad estimate is a 400');
  ok((await call('delivery/scrum/tasks/not-an-id', 'PATCH', { project: p, estimate: 3 })).status === 404 || (await call('delivery/scrum/tasks/not-an-id', 'PATCH', { project: p, estimate: 3 })).status === 400, 'a task id is validated');
  await call(`delivery/scrum/tasks/${t2.id}`, 'PATCH', { project: p, estimate: 3 });
  const made = await call('delivery/sprints', 'POST', { project: p, start: '2026-10-12', end: '2026-10-23', goal: 'Gate it' });
  ok(made.status === 200 && made.body.status === 'planned', 'creating a planned sprint needs only the token');
  const sid = made.body.id;

  const commit = await call(`delivery/sprints/${sid}/commit`, 'POST', { project: p, add: [t1.id, t2.id] });
  ok(commit.status === 403 && commit.body.code === 'human-required' && D.boardState(p).tasks.every(t => t.sprintId === undefined), 'commit with only the token is refused and commits nothing', commit.body);
  const start = await call(`delivery/sprints/${sid}/start`, 'POST', { project: p });
  ok(start.status === 403 && D.boardState(p).sprints[0].status === 'planned', 'start with only the token is refused');
  ok((await call(`delivery/sprints/${sid}/close`, 'POST', { project: p })).status === 403, 'close with only the token is refused');
  ok((await call(`delivery/sprints/${sid}/commit`, 'POST', { project: p, add: [t1.id], client: 'made-up' })).status === 403, 'a made-up client nonce is not a person');
  ok((await call(`delivery/sprints/${sid}/commit`, 'POST', { project: p, add: ['nope'] }, { person: true })).status === 400, 'ids in a commit are validated');
  const done = await call(`delivery/sprints/${sid}/commit`, 'POST', { project: p, add: [t1.id, t2.id] }, { person: true });
  ok(done.status === 200 && done.body.scope.length === 2, 'a person can commit');
  ok((await call(`delivery/sprints/${sid}/close`, 'POST', { project: p }, { person: true })).status === 409, 'a planned sprint cannot be closed (409)');
  ok((await call(`delivery/sprints/${sid}/summary`, 'GET', {}, { query: q })).status === 409, 'a daily summary exists only for the running sprint');
  const go = await call(`delivery/sprints/${sid}/start`, 'POST', { project: p }, { person: true });
  ok(go.status === 200 && go.body.status === 'active', 'a person can start');
  const sum = await call(`delivery/sprints/${sid}/summary`, 'GET', {}, { query: `${q}&tz=330` });
  ok(sum.status === 200 && sum.body.summary.sprint.name === 'Sprint 1' && /# Daily summary/.test(sum.body.markdown) && sum.body.burndown.committed === 8, 'the running sprint has a daily summary and burndown', sum.body.summary);
  ok((await call(`delivery/sprints/${sid}/review`, 'GET', {}, { query: q })).body.draft.includes('# Sprint review'), 'the review draft is served');
  ok((await call(`delivery/sprints/${sid}/retro`, 'GET', {}, { query: q })).body.facts.sprintId === sid, 'the retro facts and draft are served');
  const notes = await call(`delivery/sprints/${sid}/notes`, 'POST', { project: p, kind: 'review', text: 'Edited by a person.' });
  ok(notes.status === 200 && (await call(`delivery/sprints/${sid}/review`, 'GET', {}, { query: q })).body.saved.text === 'Edited by a person.', 'saved review notes come back beside the draft');
  ok((await call(`delivery/sprints/${'0'.repeat(8)}/start`, 'POST', { project: p }, { person: true })).status === 404 && (await call('delivery/sprints/xyz/start', 'POST', { project: p }, { person: true })).status === 400, 'an unknown sprint is 404 and a malformed id is 400');
  ok((await call('delivery/sprints', 'GET', {}, { query: q })).status === 405 && (await call('delivery/scrum/mode', 'GET', {}, { query: q })).status === 405, 'wrong methods are 405');
  ok((await call('delivery/scrum/nope', 'GET', {}, { query: q })).status === 404, 'unknown scrum routes 404');
  const refine = await call('delivery/scrum/refine', 'POST', { project: p });
  ok(refine.status === 200 && refine.body.sessionId === 'refine-1' && refines.length === 1 && refines[0].kind === 'refine' && (await call('delivery/scrum/refine', 'GET', {}, { query: q })).status === 405, 'refine starts one planning turn of kind "refine" with the token (it can only suggest)');
  const rp = deliveryRefinePrompt();
  ok(/do NOT create tasks/.test(rp) && /propose_estimate/.test(rp) && /propose_split/.test(rp) && /propose_criteria/.test(rp) && groupsForRequest(rp).includes('delivery'), 'the refinement prompt forbids creating tasks, names the three suggestions and loads the Delivery tool', rp.slice(0, 120));

  // The desktop mints a grant for exactly these routes.
  const proto = fs.readFileSync(path.resolve('desktop/electron/protocol.ts'), 'utf8');
  const re = new RegExp(proto.match(/HUMAN_ROUTE_PATTERNS = \[(.*)\];/)[1].slice(1, -1).replace(/\\\//g, '/'));
  ok(['commit', 'start', 'close'].every(v => re.test(`/api/delivery/sprints/0123abcd/${v}`)) && re.test('/api/delivery/scrum/proposals/0123abcd/accept') && !re.test('/api/delivery/scrum/proposals/0123abcd/dismiss') && !re.test('/api/delivery/sprints/0123abcd/notes') && !re.test('/api/delivery/sprints/0123abcd/review'), 'the desktop grants a person for commit, start, close and accept, and for nothing else here');
  const registry = JSON.parse(fs.readFileSync(path.resolve('scripts/security/routes.json'), 'utf8')).routes;
  ok(['delivery/scrum', 'delivery/scrum/*', 'delivery/sprints', 'delivery/sprints/*'].every(k => registry[k]) && registry['delivery/sprints/*'].gate === 'token+human' && registry['delivery/sprints'].gate === 'token', 'every Scrum route is classified in the security registry');
  D.resetDeliveryForTest();
}

// ── 7. refinement: the agent proposes, a person decides ──────────────────

console.log('\n-- refinement: suggestions an agent makes and only a person accepts --');
{
  D.resetDeliveryForTest();
  const p = makeProject();
  const gate = new DecisionGate();
  const deps = () => ({
    send: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body ?? {},
    isKnownProject: async (d) => path.resolve(d) === p,
    human: (req, body) => gate.checkHuman({ grant: req.headers['x-aico-grant'], client: body.client, uiKey: req.headers['x-aico-ui-key'], fetchSite: undefined }),
    startPlan: async () => ({ sessionId: 'x' }), subscribe: () => () => {},
  });
  const call = async (route, method, body = {}, { person = false } = {}) => {
    const req = { method, headers: person ? { 'x-aico-ui-key': gate.uiKey } : {}, on() {}, body };
    const res = {};
    await handleDeliveryRoute(route, req, res, new URL(`http://127.0.0.1/api/${route}`), deps());
    return { status: res.status, body: res.body };
  };
  const big = await D.createTask(p, { title: 'Big feature', body: 'Everything', labels: ['src/x'], priority: 2, acceptance: ['all of it'] });
  const after = await D.createTask(p, { title: 'After the big one', dependsOn: [big.id] });
  const asPlanner = (fn) => runInContext({ cwd: p }, fn);
  ok(deliveryDefinition.inputSchema.properties.action.enum.includes('propose_split') && !deliveryDefinition.inputSchema.properties.action.enum.some(a => /commit|start_sprint|close|accept/.test(a)), 'the tool can propose; it has no action that commits, starts, closes or accepts');
  ok(/Suggested 5 points/.test(await asPlanner(() => deliveryTool({ action: 'propose_estimate', id: big.id, points: 5, note: 'API plus UI' }))) && S.getTask(p, big.id).estimate === undefined, 'a suggested estimate is not applied');
  ok(/points must be/.test(await asPlanner(() => deliveryTool({ action: 'propose_estimate', id: big.id, points: 0 }))) && /at least two parts/.test(await asPlanner(() => deliveryTool({ action: 'propose_split', id: big.id, parts: [{ title: 'only' }] }))), 'bad suggestions are refused with the fix named');
  const split = await asPlanner(() => deliveryTool({ action: 'propose_split', id: big.id, note: 'too big', parts: [{ title: 'Back end', acceptance: ['endpoint exists'], points: 5 }, { title: 'Front end', points: 3 }] }));
  ok(/Suggested splitting .* into 2 tasks/.test(split), 'a split is suggested', split);
  ok(/Suggested acceptance criteria/.test(await asPlanner(() => deliveryTool({ action: 'propose_criteria', id: after.id, acceptance: ['it runs after the big one'] }))), 'criteria are suggested');
  await asPlanner(() => deliveryTool({ action: 'propose_estimate', id: big.id, points: 8 }));
  let open = D.boardState(p).proposals;
  ok(open.length === 3 && open.filter(x => x.kind === 'estimate').length === 1 && open.find(x => x.kind === 'estimate').points === 8, 'a newer suggestion of the same kind replaces the older one', open.map(x => [x.kind, x.points]));
  ok(S.getTask(p, big.id).status === 'backlog' && S.getTask(p, after.id).acceptance.length === 0 && D.boardState(p).tasks.length === 2, 'nothing on the board changed');
  ok(/Unknown action/.test(await asPlanner(() => deliveryTool({ action: 'accept' }))) && /Unknown action/.test(await asPlanner(() => deliveryTool({ action: 'commit_sprint' }))), 'an agent has no way to accept or commit');
  ok(/Proposed sprint plan/.test(await asPlanner(() => deliveryTool({ action: 'plan', capacity: 10 }))) && /no sprint|Kanban/.test(await asPlanner(() => deliveryTool({ action: 'sprint' }))), 'the agent can read a proposed plan and the sprint state');

  const ids = Object.fromEntries(open.map(x => [x.kind, x.id]));
  const refused = await call(`delivery/scrum/proposals/${ids.split}/accept`, 'POST', { project: p });
  ok(refused.status === 403 && refused.body.code === 'human-required' && D.boardState(p).tasks.length === 2, 'accepting with only the token is refused');
  const acc = await call(`delivery/scrum/proposals/${ids.estimate}/accept`, 'POST', { project: p }, { person: true });
  ok(acc.status === 200 && S.getTask(p, big.id).estimate === 8 && D.boardState(p).proposals.length === 2, 'a person accepts an estimate: it is set and the suggestion is resolved');
  ok((await call(`delivery/scrum/proposals/${ids.estimate}/accept`, 'POST', { project: p }, { person: true })).status === 409, 'a suggestion is accepted once');
  const dis = await call(`delivery/scrum/proposals/${ids.criteria}/dismiss`, 'POST', { project: p });
  ok(dis.status === 200 && dis.body.status === 'dismissed' && S.getTask(p, after.id).acceptance.length === 0, 'dismissing needs only the token and changes nothing');

  // Put the big item in a sprint so the split must carry membership over.
  await Sc.createSprint(p, { start: '2026-10-12', end: '2026-10-23' });
  const sprint = D.boardState(p).sprints[0];
  await Sc.commitSprint(p, sprint.id, [big.id]);
  const splitDone = await call(`delivery/scrum/proposals/${ids.split}/accept`, 'POST', { project: p }, { person: true });
  ok(splitDone.status === 200 && splitDone.body.created.length === 2, 'a person accepts the split', splitDone.body);
  const board = D.boardState(p);
  const parts = board.tasks.filter(t => ['Back end', 'Front end'].includes(t.title));
  ok(parts.length === 2 && parts.every(t => t.status === 'backlog' && t.priority === 2 && t.labels.join() === 'src/x') && parts.map(t => t.estimate).sort().join() === '3,5' && parts.find(t => t.title === 'Back end').acceptance[0] === 'endpoint exists', 'the parts are backlog tasks with the original\'s priority and labels, and their own points and criteria', parts);
  ok(board.tasks.find(t => t.id === big.id).status === 'cancelled' && board.tasks.find(t => t.id === big.id).review.comments.some(c => /Split into 2 tasks/.test(c.text)), 'the original is cancelled with a note saying where it went');
  ok(board.tasks.find(t => t.id === after.id).dependsOn.sort().join() === parts.map(t => t.id).sort().join(), 'what waited for the big item now waits for all its parts');
  ok(parts.every(t => t.sprintId === sprint.id) && board.tasks.find(t => t.id === big.id).sprintId === undefined && M.scopeAt(board.sprints[0]) === 8, 'the parts take over the original\'s place in the sprint, with the same total points');
  D.resetDeliveryForTest();
}

// ── 8. the dispatcher's mode gate ────────────────────────────────────────

console.log('\n-- the dispatcher in Scrum mode starts only the active sprint\'s ready tasks --');
{
  D.resetDeliveryForTest();
  const p = makeProject();
  const runs = [];
  const runner = {
    start(spec) { const id = `run-${runs.length + 1}`; runs.push({ id, spec }); return id; },
    poll(id) { return { state: 'running', lastActivityAt: Date.now(), costUsd: 0, sessionId: `chat-${id}` }; },
    stop() {},
  };
  D.configureDelivery({ runner });
  const inSprint = await D.createTask(p, { title: 'In the sprint', labels: ['src/a.js'] });
  const outside = await D.createTask(p, { title: 'Ready but outside', status: 'ready', labels: ['src/b.js'] });
  await Sc.setMode(p, 'scrum');
  await Sc.createSprint(p, { start: '2026-10-12', end: '2026-10-23' });
  const sprint = D.boardState(p).sprints[0];
  await Sc.setEstimate(p, inSprint.id, 3);
  await Sc.commitSprint(p, sprint.id, [inSprint.id]);
  await D.setDispatch(p, 'start', 4);
  await D.tick(p); await D.settled(p);
  ok(runs.length === 0 && D.boardState(p).tasks.every(t => t.status !== 'running'), 'with a planned sprint nothing starts, even a ready task');
  await Sc.startSprint(p, sprint.id);
  for (let i = 0; i < 20 && runs.length < 1; i++) { await D.tick(p); await D.settled(p); await sleep(30); }
  ok(runs.length === 1 && S.getTask(p, inSprint.id).status === 'running' && S.getTask(p, outside.id).status === 'ready', 'once the sprint is active only its task starts; the other ready task is left alone', runs.length);
  await D.tick(p); await D.settled(p);
  ok(runs.length === 1, 'and it stays that way on later ticks');
  await Sc.setMode(p, 'kanban');
  for (let i = 0; i < 20 && runs.length < 2; i++) { await D.tick(p); await D.settled(p); await sleep(30); }
  ok(runs.length === 2 && S.getTask(p, outside.id).status === 'running', 'switching back to Kanban lets the board take it: the mode loses no data');
  await D.setDispatch(p, 'pause');
  D.resetDeliveryForTest();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
