/**
 * Delivery's autonomy levels, hard limits and board fields (ADR 0038, "Autonomy levels" and
 * "A board you can run a team from"), offline.
 *
 * Why a script of its own: the question "may the board land this without a person?" is the most
 * consequential decision the engine makes, so it is tested twice - as a pure matrix (every level
 * x every risk x checks green/red x every kind of finding, against an independently written
 * table, not against the code under test) and end to end, with real git repositories and a
 * scripted agent, where a change really lands or really waits. The hard limits (daily budget,
 * per-task budget, failure streak, parallelism, WIP) and the organisation's ceiling are tested
 * the same way: the dispatcher really pauses itself, and says why. Then the board's own fields -
 * rank, assignee, metrics, bulk edits, the activity feed - and the live "what is it doing" line
 * read from a session log.
 *
 * Part of `npm test`. No network, no cost: the "agent" edits and commits in the task's worktree
 * the way a model would, and no provider is ever called.
 */

// A store of this process's own: nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) delete process.env[key];

import {
  Delivery as D, DeliveryStore as S, DeliveryAutonomy as A, DeliveryActivity as ACT, DeliveryAutonomyLevels as LEVELS,
  handleDeliveryRoute, DecisionGate, readOwnAuditEvents, parseQuickAdd, validatePolicy, deliveryAutonomyCap,
  readManagedPolicyFrom, resetManagedPolicyCache, describeRules,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` - ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errOf = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e.message ?? e); } };
const throwOf = async (fn) => { try { await fn(); return undefined; } catch (e) { return e; } };

const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico autonomy ')));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => sh('git', args, cwd);

/** A repository with a passing check, one source file and its test. `main` is the trunk. */
function makeProject() {
  const dir = path.join(tmpRoot, `proj-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Owner'); git(dir, 'config', 'user.email', 'owner@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false');
  const files = {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node check.js' } }),
    'check.js': "const fs=require('fs');if(fs.existsSync('FAIL')){console.error('FAIL marker present');process.exit(1)}\n",
    '.gitignore': '.aico/\nnode_modules/\n',
    'src/a.js': 'exports.a = () => 1;\n',
    'test/a.test.js': "const t=require('node:test');const assert=require('node:assert');t('a',()=>assert.equal(require('../src/a.js').a(),1));\n",
  };
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: initial');
  fs.mkdirSync(path.join(dir, '.aico'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.aico', 'profile.json'), JSON.stringify({ version: 1, commands: { test: { command: 'node check.js', source: 'user', at: '2026-01-01T00:00:00.000Z' } } }));
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  return fs.realpathSync.native(dir);
}

/** A scripted agent runner. `script(spec, id, rec)` does what a model would; `rec` is the run's poll state (cost, activity, need ...). */
function makeRunner(script, { cost = 0.05, prefix = 'chat-', scope } = {}) {
  const runs = new Map(); let n = 0;
  const r = {
    runs, started: [], active: 0, maxActive: 0,
    start(spec) {
      const id = `${prefix}run-${++n}`;
      const rec = { state: 'running', ok: undefined, lastActivityAt: Date.now(), costUsd: cost, sessionId: id };
      runs.set(id, rec); r.started.push({ id, spec });
      // `scope` limits what is counted to one test's own tasks: a run a previous block left in flight can reach the runner configured now.
      const counted = !scope || scope(spec);
      if (counted) { r.active++; r.maxActive = Math.max(r.maxActive, r.active); }
      Promise.resolve().then(() => script(spec, id, rec)).then(() => { rec.state = 'ended'; rec.ok = true; }, e => { rec.state = 'ended'; rec.ok = false; rec.error = String(e?.message ?? e); }).finally(() => { if (counted) r.active--; });
      return id;
    },
    poll(id) {
      const x = runs.get(id);
      if (!x) return { state: 'gone', lastActivityAt: 0, costUsd: 0 };
      const milestones = x.activity?.milestones; if (x.activity) x.activity = { ...x.activity, milestones: [] };
      return {
        state: x.state, ...(x.ok !== undefined ? { ok: x.ok } : {}), ...(x.error ? { error: x.error } : {}), sessionId: x.sessionId,
        ...(x.need ? { need: x.need } : {}), lastActivityAt: x.lastActivityAt, costUsd: x.costUsd,
        ...(x.activity ? { activity: { ...x.activity, milestones: milestones ?? [] } } : {}),
      };
    },
    stop(id) { const x = runs.get(id); if (x && x.state === 'running') { x.state = 'ended'; x.ok = false; x.error = 'stopped'; x.stop?.(); } },
  };
  return r;
}

function work(spec, files, message = 'feat: change') {
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(spec.cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, rel), text); }
  git(spec.cwd, 'add', '-A'); git(spec.cwd, 'commit', '-q', '-m', message);
}

const lines = (n, tag) => Array.from({ length: n }, (_, i) => `exports.${tag}${i} = () => ${i};`).join('\n') + '\n';
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';   // standards-allow: secret (an obviously fake canary)

/** The change a task of each kind makes, so the engine's own scoring - not a hand-set number - puts it in its risk band. */
const CHANGE = {
  low: (spec, tag) => work(spec, { [`src/${tag}.js`]: `exports.${tag} = () => 1;\n`, [`test/${tag}.test.js`]: `require('node:test')('${tag}', () => {});\n` }, `feat: ${tag}`),
  medium: (spec, tag) => work(spec, { [`src/${tag}.js`]: lines(320, tag), [`test/${tag}.test.js`]: `require('node:test')('${tag}', () => {});\n` }, `feat: ${tag}`),
  high: (spec, tag) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(spec.cwd, 'package.json'), 'utf8')); pkg.version = `1.0.${tag.length}${tag.charCodeAt(0)}`;
    work(spec, { [`src/auth/session-${tag}.js`]: lines(320, tag), 'package.json': JSON.stringify(pkg), '.github/workflows/ci.yml': `name: ci-${tag}\n`, Dockerfile: `FROM node:22 # ${tag}\n` }, `feat: ${tag}`);
  },
  secret: (spec, tag) => work(spec, { [`src/${tag}.js`]: `exports.token = "${SECRET}";\n`, [`test/${tag}.test.js`]: `require('node:test')('${tag}', () => {});\n` }, `feat: ${tag}`),
  tamper: (spec, tag) => { fs.rmSync(path.join(spec.cwd, 'test/a.test.js')); work(spec, { [`src/${tag}.js`]: `exports.${tag} = () => 1;\n` }, `feat: ${tag}`); },
};
/** A runner whose task title says what kind of change to make: "low: foo", "medium: bar" ... */
const kindRunner = (over = {}) => {
  const runs = new Map();   // a rework run of the same task must change something new, or its commit would be empty
  return makeRunner(async (spec) => {
    const [kind, tag] = spec.title.split(':').map(x => x.trim());
    const n = (runs.get(spec.taskId) ?? 0) + 1; runs.set(spec.taskId, n);
    CHANGE[kind](spec, tag.replace(/\W+/g, '') + (n > 1 ? `r${n}` : ''));
  }, over);
};

const task = (p, id) => D.boardState(p).tasks.find(t => t.id === id);
async function pump(p, cond, ms = 40_000) {
  const end = Date.now() + ms;
  for (;;) {
    await D.tick(p); await D.settled(p);
    if (cond()) return true;
    if (Date.now() > end) return false;
    await sleep(30);
  }
}
const idle = async (p, rounds = 6) => { for (let i = 0; i < rounds; i++) { await D.tick(p); await D.settled(p); await sleep(20); } };
const fresh = () => { D.resetDeliveryForTest(); };
const person = (p, patch) => D.updateSettings(p, patch, 'person');

// ═══ 1. the matrix: may it land without a person? ══════════════════════════════════════════
console.log('\n-- the rule, as a matrix: level x risk x checks x finding x mode, against an independently written table --');
{
  const levels = ['manual', 'assisted', 'autonomous', 'full'];
  const risks = ['low', 'medium', 'high'];
  const findings = [[], ['secret'], ['test-tamper'], ['code-high'], ['secret', 'test-tamper']];
  let cells = 0; let wrong = [];
  // Written from the policy in the ADR, not from the code: the level that first allows each risk, and what blocks at every level.
  const firstLevel = { low: 'assisted', medium: 'autonomous', high: 'full' };
  for (const level of levels) for (const risk of risks) for (const green of [true, false]) for (const flags of findings) for (const pr of [false, true]) {
    const expected = !pr && green && flags.length === 0 && levels.indexOf(level) >= levels.indexOf(firstLevel[risk]);
    const got = A.autoLandDecision({ level, risk: { score: risk === 'low' ? 10 : risk === 'medium' ? 40 : 80, level: risk, reasons: [], flags }, checksGreen: green, prMode: pr });
    cells++;
    if (got.ok !== expected) wrong.push({ level, risk, green, flags, pr, got: got.ok });
    if (!got.reason) wrong.push({ level, risk, noReason: true });
  }
  ok(cells === 4 * 3 * 2 * 5 * 2 && wrong.length === 0, `all ${cells} combinations give the expected answer, each with a reason`, wrong.slice(0, 3));
  // Monotonic: what a lower level may land, every higher level may land too (the rule never grants what a lower level denied).
  let mono = true;
  for (const risk of risks) for (const green of [true, false]) for (const flags of findings) {
    let prev = false;
    for (const level of levels) {
      const g = A.autoLandDecision({ level, risk: { score: 1, level: risk, reasons: [], flags }, checksGreen: green, prMode: false }).ok;
      if (prev && !g) mono = false;
      prev = g;
    }
  }
  ok(mono, 'raising the level never takes an automatic landing away');
  // A risk record from before flags were recorded: the reasons still name the findings.
  const legacy = A.autoLandDecision({ level: 'full', risk: { score: 70, level: 'high', reasons: ['1 possible secret in the added lines (src/a.js:2 github token) (+40)'] }, checksGreen: true, prMode: false });
  ok(!legacy.ok && /secret/.test(legacy.reason), 'a risk record without flags is read from its reasons (a secret still blocks at full)', legacy);
  const noscan = A.autoLandDecision({ level: 'full', risk: { score: 5, level: 'low', reasons: ['change-safety scan did not run'], flags: [] }, checksGreen: true, prMode: false });
  ok(!noscan.ok && /did not run/.test(noscan.reason), 'a safety scan that could not run is not a clean scan');
  // Powers per level, and the organisation's ceiling.
  ok(A.powersOf('manual').autoLandUpTo === undefined && !A.powersOf('manual').pullBacklog && !A.powersOf('assisted').pullBacklog && A.powersOf('assisted').promotePrerequisites
    && A.powersOf('autonomous').pullBacklog && A.powersOf('autonomous').autoLandUpTo === 'medium' && A.powersOf('full').autoLandUpTo === 'high', 'each level\'s powers are the ones the ADR lists');
  ok(A.effectiveAutonomy('full', 'assisted') === 'assisted' && A.effectiveAutonomy('manual', 'full') === 'manual' && A.effectiveAutonomy('autonomous', undefined) === 'autonomous', 'the ceiling lowers a level and never raises one');
  ok(LEVELS.AUTONOMY_LEVELS.join() === 'manual,assisted,autonomous,full' && LEVELS.minAutonomy('full', 'assisted') === 'assisted' && LEVELS.isAutonomy('full') && !LEVELS.isAutonomy('yolo'), 'the shared level helpers agree');
}

console.log('\n-- the organisation\'s ceiling: delivery.maxAutonomy (restrict-only) --');
{
  const write = (name, obj) => { const f = path.join(tmpRoot, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
  const cap = (...files) => deliveryAutonomyCap(readManagedPolicyFrom(files.map(f => [f, 'override'])));
  ok(deliveryAutonomyCap(readManagedPolicyFrom([])) === undefined, 'with no policy there is no ceiling (a single user decides)');
  ok(cap(write('p1.json', { version: 1, message: 'x' })) === 'autonomous', 'with a policy in force that says nothing about it, the default ceiling is autonomous: full must be granted by name');
  ok(cap(write('p2.json', { version: 1, delivery: { maxAutonomy: 'full' } })) === 'full', 'an organisation can grant full');
  ok(cap(write('p3.json', { version: 1, delivery: { maxAutonomy: 'assisted' } }), write('p4.json', { version: 1, delivery: { maxAutonomy: 'full' } })) === 'assisted', 'layers only restrict: the lowest wins, a second layer cannot loosen the first');
  const bad = validatePolicy({ delivery: { maxAutonomy: 'yolo' } });
  ok(bad.policy.delivery?.maxAutonomy === 'manual' && bad.problems.some(x => x.level === 'error' && /delivery\.maxAutonomy/.test(x.key ?? '')), 'an invalid value fails closed to manual and says so', bad);
  ok(cap(write('p5.json', '{ not json')) === 'manual', 'an unreadable policy file is a lockdown: manual');
  ok(describeRules(readManagedPolicyFrom([[write('p6.json', { version: 1, delivery: { maxAutonomy: 'assisted' } }), 'override']])).some(l => /assisted/.test(l)), 'the status screen lists the rule');
  ok(validatePolicy({ delivery: { maxAutonomy: 'full', nope: 1 } }).problems.some(x => /nope/.test(x.message)), 'an unknown key under delivery is reported, not ignored silently');
}

// ═══ 2. settings: who may change what ═══════════════════════════════════════════════════════
console.log('\n-- settings: widening needs a person, narrowing does not, the ceiling holds --');
{
  fresh();
  const p = makeProject();
  const gate = new DecisionGate();
  const deps = {
    send: (res, status, body) => { res.status = status; res.body = body; }, readJson: async (req) => req.body ?? {},
    isKnownProject: async (d) => path.resolve(d) === p,
    human: (req, body) => gate.checkHuman({ grant: req.headers['x-aico-grant'], client: body.client, uiKey: req.headers['x-aico-ui-key'], fetchSite: undefined }),
    startPlan: async () => ({ sessionId: 'x' }), subscribe: () => () => {},
  };
  const call = async (route, method, body = {}, { human = false, query = '' } = {}) => {
    const req = { method, headers: human ? { 'x-aico-ui-key': gate.uiKey } : {}, on() {} }; req.body = body;
    const res = { headers: {}, written: [], write(x) { this.written.push(x); } };
    await handleDeliveryRoute(route, req, res, new URL(`http://127.0.0.1/api/${route}${query}`), deps);
    return { status: res.status, body: res.body };
  };
  const b0 = (await call('delivery/board', 'GET', {}, { query: `?project=${encodeURIComponent(p)}` })).body;
  ok(b0.autonomy === 'manual' && b0.settings.autonomy === 'manual' && b0.settings.budgetUsdPerDay === 10 && b0.settings.pauseAfterFailures === 3 && b0.settings.wip && Array.isArray(b0.settings.views), 'a new board is manual, $10 a day, pauses after 3 failures', b0.settings);
  const raise = await call('delivery/settings', 'PATCH', { project: p, autonomy: 'autonomous' });
  ok(raise.status === 403 && raise.body.code === 'human-required' && D.boardState(p).autonomy === 'manual', 'raising the level with only the token is refused and changes nothing', raise.body);
  const raised = await call('delivery/settings', 'PATCH', { project: p, autonomy: 'autonomous' }, { human: true });
  ok(raised.status === 200 && raised.body.autonomy === 'autonomous' && raised.body.settings.autonomy === 'autonomous', 'a person raises it', raised.body.autonomy);
  const lower = await call('delivery/settings', 'PATCH', { project: p, autonomy: 'assisted' });
  ok(lower.status === 200 && lower.body.autonomy === 'assisted', 'lowering it needs only the token (refusing to act is always safe)');
  ok((await call('delivery/settings', 'PATCH', { project: p, autonomy: 'manual' })).body.autonomy === 'manual', 'and so does going back to manual');
  ok((await call('delivery/settings', 'PATCH', { project: p, autonomy: 'yolo' }, { human: true })).status === 400, 'an unknown level is refused');
  ok((await call('delivery/settings', 'PATCH', { project: p, budgetUsdPerDay: 50 })).status === 403, 'a bigger daily budget needs a person');
  ok((await call('delivery/settings', 'PATCH', { project: p, budgetUsdPerDay: 5 })).body.settings.budgetUsdPerDay === 5, 'a smaller one does not');
  ok((await call('delivery/settings', 'PATCH', { project: p, pauseAfterFailures: 9 })).status === 403 && (await call('delivery/settings', 'PATCH', { project: p, pauseAfterFailures: 2 })).body.settings.pauseAfterFailures === 2, 'allowing more failures needs a person; fewer does not');
  ok((await call('delivery/settings', 'PATCH', { project: p, maxParallel: 3 })).status === 403 && (await call('delivery/settings', 'PATCH', { project: p, maxParallel: 9 }, { human: true })).body.settings.maxParallel === 4, 'more agents at once needs a person, and the cap is 4 whatever is asked');
  ok((await call('delivery/settings', 'PATCH', { project: p, budgetUsdPerDay: -3 }, { human: true })).status === 400 && (await call('delivery/settings', 'PATCH', { project: p, wip: { running: 0 } })).status === 400, 'out-of-range values are refused');
  const wip = await call('delivery/settings', 'PATCH', { project: p, wip: { running: 1, review: 3 }, views: [{ name: 'Mine', filter: 'assignee:me' }, { name: 'Mine', filter: 'dup' }, { name: '', filter: 'x' }, { name: 'Bugs', filter: 'type:bug' }] });
  ok(wip.status === 200 && wip.body.settings.wip.running === 1 && wip.body.settings.wip.review === 3 && wip.body.settings.views.map(v => v.name).join() === 'Mine,Bugs', 'WIP limits and saved views are stored per board (a duplicate or empty view name is dropped)', wip.body.settings);
  S.resetStoreCache();
  ok(D.boardState(p).settings.views.length === 2 && D.boardState(p).settings.wip.review === 3, 'and they survive a restart (folded from the journal)');
  const audits = readOwnAuditEvents().filter(e => e.kind === 'delivery' && e.action === 'autonomy.set');
  ok(audits.length >= 3 && audits.some(e => e.autonomy === 'autonomous' && e.decidedBy === 'person') && audits.every(e => e.project === p), 'every autonomy change is in the audit log with who decided', audits.map(e => [e.autonomy, e.decidedBy]));
  ok(D.boardState(p).feed.some(f => f.kind === 'autonomy' && /autonomous/.test(f.text)), 'and in the board\'s feed');

  // The organisation's ceiling, in force.
  const pol = path.join(tmpRoot, 'ceiling.json');
  fs.writeFileSync(pol, JSON.stringify({ version: 1, delivery: { maxAutonomy: 'assisted' } }));
  await person(p, { autonomy: 'autonomous' });
  process.env.AICO_POLICY_FILE = pol; resetManagedPolicyCache();
  const capped = D.boardState(p);
  ok(capped.settings.autonomy === 'autonomous' && capped.autonomy === 'assisted' && capped.autonomyCap === 'assisted', 'a board set above the ceiling runs at the ceiling, and says what the ceiling is', { s: capped.settings.autonomy, e: capped.autonomy, cap: capped.autonomyCap });
  const e = await throwOf(() => person(p, { autonomy: 'full' }));
  ok(e && e.status === 403 && e.code === 'policy' && /organisation/.test(e.message), 'the engine refuses to set a level above the ceiling, even for a person', e && e.message);
  ok((await person(p, { autonomy: 'assisted' })).autonomy === 'assisted', 'a level at the ceiling is fine');
  delete process.env.AICO_POLICY_FILE; resetManagedPolicyCache();
  D.resetDeliveryForTest();
}

// ═══ 3. manual and assisted ═════════════════════════════════════════════════════════════════
console.log('\n-- manual does nothing on its own; assisted starts prerequisites and lands low-risk green work --');
{
  fresh();
  const p = makeProject();
  D.configureDelivery({ runner: kindRunner() });
  await D.setDispatch(p, 'start');
  // manual: a Ready task whose prerequisite is in the Backlog just waits (and says so); a green low-risk change waits for a person.
  const pre = await D.createTask(p, { title: 'low: prereq' });
  const main = await D.createTask(p, { title: 'low: main', status: 'ready', dependsOn: [pre.id] });
  const solo = await D.createTask(p, { title: 'low: solo', status: 'ready' });
  ok(await pump(p, () => task(p, solo.id).status === 'review'), 'manual: an independent ready task runs to review');
  await idle(p);
  ok(task(p, pre.id).status === 'backlog' && task(p, main.id).status === 'ready' && task(p, solo.id).status === 'review', 'manual: nothing was promoted, nothing landed');
  // assisted
  await person(p, { autonomy: 'assisted' });
  ok(await pump(p, () => task(p, solo.id).status === 'merged'), 'assisted: the green low-risk change lands without a click', task(p, solo.id).status);
  ok(await pump(p, () => task(p, pre.id).status === 'merged' && task(p, main.id).status === 'merged', 60_000), 'assisted: the prerequisite is started on the board\'s own initiative, lands, and then the task that waited runs and lands', [task(p, pre.id).status, task(p, main.id).status]);
  const landed = task(p, solo.id).landed;
  ok(landed.by === 'auto' && landed.decision?.autonomy === 'assisted' && landed.decision.risk === 'low' && /checks green/.test(landed.decision.reason) && landed.decision.evidence, 'the landing records who decided, at what level, the risk, and why', landed.decision);
  const act = D.taskActivity(p, solo.id);
  ok(act.some(a => a.kind === 'landed' && a.by === 'system' && /assisted/.test(a.text) && /Evidence/.test(a.text)), 'and the task\'s history says the same in words', act.map(a => a.text));
  ok(task(p, pre.id).activity.some(a => a.kind === 'promoted' && a.by === 'system'), 'the promotion of the prerequisite is in its history as the board\'s own act');
  const audit = readOwnAuditEvents().filter(e => e.kind === 'delivery' && e.task === solo.id);
  ok(audit.some(e => e.action === 'auto-land' && e.decidedBy === 'engine:assisted' && e.project === p), 'and in the audit log (auto-land, engine:assisted)', audit);
  // Medium risk waits at assisted.
  D.configureDelivery({ runner: kindRunner() });
  const med = await D.createTask(p, { title: 'medium: m1', status: 'ready' });
  ok(await pump(p, () => task(p, med.id).status === 'review'), 'assisted: a medium-risk change reaches review');
  await idle(p);
  ok(task(p, med.id).status === 'review' && task(p, med.id).risk.level === 'medium', 'and waits for a person', task(p, med.id).risk);
  // The kill switch: nothing acts while the dispatcher is paused, even for a level that could.
  await person(p, { autonomy: 'full' });
  await D.setDispatch(p, 'pause');
  await idle(p);
  ok(task(p, med.id).status === 'review', 'paused: nothing lands on its own, whatever the level');
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => task(p, med.id).status === 'merged'), 'started again, a task already in review that the level allows is landed (one at a time through the queue)');
  D.resetDeliveryForTest();
}

// ═══ 4. autonomous and full, end to end ═════════════════════════════════════════════════════
console.log('\n-- autonomous pulls the backlog and lands medium; high and every finding wait; full lands high --');
{
  fresh();
  const p = makeProject();
  const runner = kindRunner();
  D.configureDelivery({ runner });
  await person(p, { autonomy: 'autonomous', maxParallel: 2 });
  const order = [];
  // The backlog, never moved to Ready by a person: ranks follow priority, and a prerequisite chain is respected.
  const t1 = await D.createTask(p, { title: 'low: urgent', priority: 1 });
  const t2 = await D.createTask(p, { title: 'medium: normal', priority: 3 });
  const t3 = await D.createTask(p, { title: 'low: after', priority: 2, dependsOn: [t2.id] });
  const hi = await D.createTask(p, { title: 'high: sensitive', priority: 3 });
  const sec = await D.createTask(p, { title: 'secret: leaky', priority: 3 });
  const tam = await D.createTask(p, { title: 'tamper: weak', priority: 3 });
  ok(D.boardState(p).tasks.every(t => t.status === 'backlog'), 'six tasks, all in the backlog');
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => ['hi', 'sec', 'tam'].every((_, i) => ['review'].includes(task(p, [hi, sec, tam][i].id).status)) && task(p, t1.id).status === 'merged' && task(p, t2.id).status === 'merged' && task(p, t3.id).status === 'merged', 120_000),
    'with no one moving anything, the board pulls tasks in, runs them and lands the low and medium ones', D.boardState(p).tasks.map(t => `${t.title}:${t.status}`));
  const started = runner.started.map(s => s.spec.title);
  ok(started[0] === 'low: urgent', 'the highest-priority task was pulled first', started);
  ok(started.indexOf('low: after') > started.indexOf('medium: normal'), 'a task is not pulled before its prerequisite has merged', started);
  ok(task(p, t2.id).landed.decision.autonomy === 'autonomous' && task(p, t2.id).landed.decision.risk === 'medium', 'the medium-risk change landed by the board\'s rule and records it', task(p, t2.id).landed.decision);
  ok(task(p, hi.id).risk.level === 'high' && !task(p, hi.id).risk.flags.length, 'the sensitive change scores HIGH with no finding...', task(p, hi.id).risk);
  ok(task(p, hi.id).status === 'review', '...and waits for a person at the autonomous level');
  ok(task(p, sec.id).risk.flags.includes('secret') && task(p, sec.id).status === 'review', 'a possible secret waits for a person', task(p, sec.id).risk);
  ok(task(p, tam.id).risk.flags.includes('test-tamper') && task(p, tam.id).status === 'review' && task(p, tam.id).risk.level !== 'high', 'a weakened test waits for a person even at medium risk', task(p, tam.id).risk);
  ok(D.boardState(p).tasks.filter(t => t.status === 'running' || t.status === 'ready' || t.status === 'backlog').length === 0, 'and nothing is left half-started');
  // Full: the high-risk change lands once the level is raised - but the secret and the weakened test never do.
  await person(p, { autonomy: 'full' });
  ok(await pump(p, () => task(p, hi.id).status === 'merged'), 'full: the high-risk change with every gate green lands', task(p, hi.id).status);
  ok(task(p, hi.id).landed.decision.autonomy === 'full' && task(p, hi.id).landed.decision.risk === 'high', 'recorded as a full-level decision on a high-risk change');
  await idle(p, 8);
  ok(task(p, sec.id).status === 'review' && task(p, tam.id).status === 'review', 'full never lands a change with a secret or a weakened test', [task(p, sec.id).status, task(p, tam.id).status]);
  ok(D.taskActivity(p, sec.id).some(a => a.kind === 'review' && /high risk/.test(a.text)) && !D.taskActivity(p, sec.id).some(a => a.kind === 'landed'), "the secret task's history shows it reached review and never landed");
  // The organisation's default ceiling (a policy in force that does not name delivery) is autonomous: a board at full runs at autonomous.
  const hi2 = await D.createTask(p, { title: 'high: sensitive two', priority: 3 });
  const pol = path.join(tmpRoot, 'org-default.json');
  fs.writeFileSync(pol, JSON.stringify({ version: 1, message: 'managed' }));
  process.env.AICO_POLICY_FILE = pol; resetManagedPolicyCache();
  ok(D.boardState(p).autonomy === 'autonomous' && D.boardState(p).autonomyCap === 'autonomous', 'under a managed policy that says nothing about it, a board set to full runs as autonomous');
  ok(await pump(p, () => task(p, hi2.id).status === 'review'), 'a new high-risk change is pulled, runs and reaches review', { status: task(p, hi2.id).status, board: D.boardState(p).dispatcher, why: D.boardState(p).pausedBecause, act: D.taskActivity(p, hi2.id).map(x => x.text) });
  await idle(p, 8);
  ok(task(p, hi2.id).status === 'review', 'and waits for a person: the organisation never granted full');
  process.env.AICO_POLICY_FILE = path.join(tmpRoot, 'org-full.json'); fs.writeFileSync(process.env.AICO_POLICY_FILE, JSON.stringify({ version: 1, delivery: { maxAutonomy: 'full' } })); resetManagedPolicyCache();
  ok(await pump(p, () => task(p, hi2.id).status === 'merged'), 'once the organisation grants full by name, it lands');
  delete process.env.AICO_POLICY_FILE; resetManagedPolicyCache();
  const bareRemotes = git(p, 'remote').trim();
  ok(bareRemotes === '' && !fs.existsSync(path.join(p, '.git', 'FETCH_HEAD')), 'no remote exists and nothing was fetched or pushed anywhere');
  D.resetDeliveryForTest();
}

// ═══ 5. hard limits ═════════════════════════════════════════════════════════════════════════
console.log('\n-- hard limits: the daily budget, the per-task budget, a failure streak, parallelism, WIP, restart --');
{
  // The daily budget: two runs at $0.05 each against a $0.06 day.
  fresh();
  const p = makeProject();
  let release; const gate = new Promise(r => { release = r; });
  const runner = makeRunner(async (spec, id, rec) => { await new Promise(res => { rec.stop = res; gate.then(res); }); if (rec.error === 'stopped') throw new Error('stopped'); CHANGE.low(spec, 'b' + id.replace(/\W/g, '')); });
  D.configureDelivery({ runner });
  await person(p, { autonomy: 'autonomous', budgetUsdPerDay: 0.06 });
  for (const n of ['one', 'two', 'three', 'four']) await D.createTask(p, { title: `low: ${n}` });
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => D.boardState(p).dispatcher === 'paused', 20_000), 'the dispatcher pauses itself when the day\'s spend is reached', D.boardState(p).dispatcher);
  await idle(p, 4);
  const bs = D.boardState(p);
  ok(/daily budget/.test(bs.pausedBecause) && /\$0\.06/.test(bs.pausedBecause) && bs.metrics.spentTodayUsd >= 0.06, 'and says why, with the figures', { why: bs.pausedBecause, spent: bs.metrics.spentTodayUsd });
  ok(bs.tasks.filter(t => t.status === 'blocked').length === 2 && bs.tasks.some(t => t.review.comments.some(c => /daily budget/.test(c.text))), 'the two runs that were going were stopped too, with the reason on their threads');
  ok(runner.started.length === 2 && bs.tasks.filter(t => t.status === 'backlog').length === 2, 'the two other tasks were never started', runner.started.length);
  ok(bs.feed.some(f => f.kind === 'paused' && /daily budget/.test(f.text)), 'the feed shows the pause');
  ok(readOwnAuditEvents().some(e => e.kind === 'delivery' && e.action === 'auto-pause' && e.project === p), 'the audit log has the automatic pause');
  const refused = await throwOf(() => D.updateSettings(p, { budgetUsdPerDay: 100 }, 'token'));
  ok(refused && refused.status === 403, 'raising the budget needs a person');
  await person(p, { budgetUsdPerDay: 100 });
  release();
  await D.setDispatch(p, 'start');
  ok(D.boardState(p).dispatcher === 'running' && !D.boardState(p).pausedBecause, 'a person starts it again and the reason is cleared');
  D.resetDeliveryForTest();

  // The per-task budget: spend is the sum of a task's runs; a task that has used its allowance is not started again.
  fresh();
  const p2 = makeProject();
  D.configureDelivery({ runner: kindRunner({ cost: 0.05 }), budgetUsd: () => 0.08 });
  await D.setDispatch(p2, 'start');
  const t = await D.createTask(p2, { title: 'low: spender', status: 'ready' });
  ok(await pump(p2, () => task(p2, t.id).status === 'review'), 'a task spends $0.05 on its first run');
  ok(Math.abs(task(p2, t.id).costUsd - 0.05) < 1e-9, 'its cost is recorded', task(p2, t.id).costUsd);
  await D.requestChanges(p2, t.id, 'more');
  ok(await pump(p2, () => task(p2, t.id).status === 'review'), 'the second run is given only the allowance that is left');
  ok(Math.abs(task(p2, t.id).costUsd - 0.1) < 1e-9, 'the task\'s cost is the SUM of its runs ($0.10), not the larger of them', task(p2, t.id).costUsd);
  ok(Math.abs(D.boardState(p2).metrics.spentTodayUsd - 0.1) < 1e-9, 'and the day\'s spend counts both');
  await D.requestChanges(p2, t.id, 'again');
  await pump(p2, () => task(p2, t.id).status === 'blocked', 15_000);
  ok(task(p2, t.id).status === 'blocked' && task(p2, t.id).review.comments.some(c => /already spent/.test(c.text)), 'a third run is refused: the task has used its budget, and says so', task(p2, t.id).status);
  D.resetDeliveryForTest();

  // A failure streak: three tasks in a row whose checks fail.
  fresh();
  const p3 = makeProject();
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, { FAIL: 'x\n', 'src/f.js': 'exports.f = 1;\n' }, 'feat: red'); }) });
  await person(p3, { autonomy: 'autonomous' });
  for (const n of ['a', 'b', 'c', 'd', 'e']) await D.createTask(p3, { title: `low: red ${n}` });
  await D.setDispatch(p3, 'start');
  ok(await pump(p3, () => D.boardState(p3).dispatcher === 'paused', 60_000), 'after three tasks in a row are sent back, the dispatcher pauses itself', D.boardState(p3).dispatcher);
  const f3 = D.boardState(p3);
  ok(/\d+ tasks in a row/.test(f3.pausedBecause) && /limit is 3/.test(f3.pausedBecause), 'with the count and the limit in its reason', f3.pausedBecause);
  ok(f3.tasks.filter(t => t.status === 'backlog').length >= 1, 'the rest of the backlog was left alone', f3.tasks.map(t => t.status));
  await person(p3, { pauseAfterFailures: 5 });
  await D.setDispatch(p3, 'start');
  ok(D.boardState(p3).dispatcher === 'running', 'a person can start it again (the streak is cleared by the start)');
  D.resetDeliveryForTest();

  // Parallelism: never more than four, and the WIP limits.
  fresh();
  const p4 = makeProject();
  let open; const hold = new Promise(r => { open = r; });
  const r4 = makeRunner(async (spec, id) => { await hold; CHANGE.low(spec, 'w' + id.replace(/\W/g, '')); }, { scope: spec => /^low: par /.test(spec.title) });
  D.configureDelivery({ runner: r4 });
  await person(p4, { maxParallel: 9 });
  for (let i = 0; i < 6; i++) await D.createTask(p4, { title: `low: par ${i}`, status: 'ready' });
  await D.setDispatch(p4, 'start');
  await pump(p4, () => r4.active >= 4, 15_000); await idle(p4, 4);
  ok(r4.maxActive === 4 && D.boardState(p4).settings.maxParallel === 4 && D.boardState(p4).agents.filter(a => a.state === 'working').length === 4, 'with maxParallel asked for 9, exactly 4 agents run at once', { maxActive: r4.maxActive });
  const ag = D.boardState(p4).agents;
  ok(ag.map(a => a.name).join() === 'Agent A,Agent B,Agent C,Agent D' && ag.every(a => a.taskId), 'the four slots are named Agent A to D and each holds a task', ag);
  ok(D.boardState(p4).tasks.filter(t => t.status === 'running').every(t => t.assignee?.kind === 'agent' && /^Agent [A-D]$/.test(t.assignee.name)), 'each running task is assigned to its slot automatically');
  open();
  ok(await pump(p4, () => D.boardState(p4).tasks.every(t => t.status === 'review'), 60_000), 'the other two run when slots free up');
  ok(D.boardState(p4).tasks.every(t => t.assignee?.kind === 'agent'), 'the assignee is kept after the run, so a finished card still says who did it');
  D.resetDeliveryForTest();

  fresh();
  const p5 = makeProject();
  let open5; const hold5 = new Promise(r => { open5 = r; });
  const r5 = makeRunner(async (spec, id) => { await hold5; CHANGE.low(spec, 'x' + id.replace(/\W/g, '')); }, { scope: spec => /^low: wip /.test(spec.title) });
  D.configureDelivery({ runner: r5 });
  await person(p5, { maxParallel: 3 });
  await person(p5, { wip: { running: 1 } });
  for (let i = 0; i < 3; i++) await D.createTask(p5, { title: `low: wip ${i}`, status: 'ready' });
  await D.setDispatch(p5, 'start');
  await pump(p5, () => r5.active >= 1, 10_000); await idle(p5, 5);
  ok(r5.maxActive === 1, 'a running WIP limit of 1 holds the board to one agent although three are allowed', r5.maxActive);
  ok(D.boardState(p5).tasks.filter(t => t.status === 'ready').every(t => /busy|agent slot/.test(t.waitingReason ?? '')), 'and the waiting cards say the slots are busy', D.boardState(p5).tasks.map(t => t.waitingReason));
  open5();
  ok(await pump(p5, () => D.boardState(p5).tasks.every(t => t.status === 'review'), 60_000), 'all three still run, one after another');
  D.resetDeliveryForTest();

  // A review WIP limit: while one change waits for a person, the board does not start more.
  fresh();
  const p5b = makeProject();
  D.configureDelivery({ runner: kindRunner() });
  await person(p5b, { wip: { review: 1 } });
  for (let i = 0; i < 3; i++) await D.createTask(p5b, { title: `low: rev ${i}`, status: 'ready' });
  await D.setDispatch(p5b, 'start', 1);
  await pump(p5b, () => D.boardState(p5b).tasks.some(t => t.status === 'review'), 30_000); await idle(p5b, 6);
  const states = D.boardState(p5b).tasks.map(t => t.status);
  ok(states.filter(s => s === 'review').length === 1 && states.filter(s => s === 'ready').length === 2, 'a review WIP limit of 1 stops new runs while one change waits for a person', states);
  ok(/Review is full/.test(D.boardState(p5b).tasks.find(t => t.status === 'ready').waitingReason), 'and the waiting cards say so', D.boardState(p5b).tasks.find(t => t.status === 'ready').waitingReason);
  await D.approveTask(p5b, D.boardState(p5b).tasks.find(t => t.status === 'review').id);
  ok(await pump(p5b, () => D.boardState(p5b).tasks.filter(t => t.status === 'review' || t.status === 'merged').length >= 2), 'approving it makes room for the next');
  D.resetDeliveryForTest();

  // A restart is not a person's yes to spend.
  fresh();
  const p6 = makeProject();
  D.configureDelivery({ runner: kindRunner() });
  await person(p6, { autonomy: 'autonomous' });
  await D.setDispatch(p6, 'start');
  S.resetStoreCache();
  await D.bootDelivery();
  const booted = D.boardState(p6);
  ok(booted.dispatcher === 'paused' && /restart/i.test(booted.pausedBecause) && booted.autonomy === 'autonomous', 'after a restart the dispatcher is paused with the reason, and the autonomy setting is kept', { d: booted.dispatcher, why: booted.pausedBecause });
  D.resetDeliveryForTest();
}

// ═══ 6. the board's fields ══════════════════════════════════════════════════════════════════
console.log('\n-- rank, assignee, due date, type, epics, bulk edits, duplicate, quick-add --');
{
  fresh();
  const p = makeProject();
  const startOrder = [];
  D.configureDelivery({ runner: makeRunner(async (spec) => { startOrder.push(spec.title); CHANGE.low(spec, spec.title.replace(/\W+/g, '')); }) });
  const a = await D.createTask(p, { title: 'task a', priority: 3, status: 'ready' });
  const b = await D.createTask(p, { title: 'task b', priority: 3, status: 'ready' });
  const c = await D.createTask(p, { title: 'task c', priority: 3, status: 'ready' });
  const urgent = await D.createTask(p, { title: 'task urgent', priority: 1, status: 'ready' });
  const rk = id => task(p, id).rank;
  ok(rk(urgent.id) < rk(a.id) && rk(a.id) < rk(b.id) && rk(b.id) < rk(c.id), 'an untouched board keeps priority order: ranks are banded by priority and rise in creation order', [rk(urgent.id), rk(a.id), rk(b.id), rk(c.id)]);
  // Drag: c to the top of the Ready column, above even the urgent one.
  const reordered = D.reorderTasks(p, 'ready', [c.id, urgent.id, a.id, b.id]);
  ok(reordered.ok && rk(c.id) < rk(urgent.id) && rk(urgent.id) < rk(a.id) && rk(a.id) < rk(b.id), 'reordering a column swaps ranks among the dragged cards', reordered.ranks);
  ok(/not in running/.test(await errOf(() => D.reorderTasks(p, 'running', [a.id]))) && /no such task/.test(await errOf(() => D.reorderTasks(p, 'ready', ['00000000']))), 'cards that are not in the named column, or do not exist, are refused');
  ok(D.boardState(p).tasks.find(t => t.id === a.id).priority === 3 && rk(a.id) < rk(b.id), 'cards not moved keep their relative place');
  await D.setDispatch(p, 'start', 1);
  ok(await pump(p, () => D.boardState(p).tasks.every(t => t.status === 'review'), 60_000), 'the four run, one at a time');
  ok(startOrder.join() === 'task c,task urgent,task a,task b', 'the dispatcher honours the person\'s order (rank) before priority', startOrder);
  // A changed priority is a new place at the end of its band.
  await D.updateTask(p, b.id, { priority: 1 }, 'person');
  ok(Math.floor(rk(b.id) / S.RANK_BAND) === 1 && rk(b.id) !== rk(urgent.id), 'changing priority re-banks the rank (a new place at the end of the new priority)', rk(b.id));
  // assignee, due date, type, epic
  const t = await D.createTask(p, { title: 'Fix login redirect', type: 'bug', dueDate: '2026-10-20', assignee: { kind: 'person', name: 'Sam' } });
  ok(t.type === 'bug' && t.dueDate === '2026-10-20' && t.assignee.name === 'Sam' && t.assignee.kind === 'person', 'a task has a type, a due date and a person as assignee');
  ok(/dueDate/.test(await errOf(() => D.updateTask(p, t.id, { dueDate: '20-10-2026' }))) && /type must/.test(await errOf(() => D.updateTask(p, t.id, { type: 'epic' }))) && /agent assignee/.test(await errOf(() => D.updateTask(p, t.id, { assignee: { kind: 'agent', name: 'Skynet' } }))), 'a bad date, type or agent slot is refused');
  const cleared = await D.updateTask(p, t.id, { dueDate: null, assignee: null, type: null });
  ok(!cleared.dueDate && !cleared.assignee && !cleared.type, 'null clears each');
  const epic = await D.createTask(p, { title: 'Auth epic', type: 'feature' });
  const k1 = await D.createTask(p, { title: 'login form', parentId: epic.id });
  const k2 = await D.createTask(p, { title: 'logout', parentId: epic.id });
  ok(task(p, epic.id).children.total === 2 && task(p, epic.id).children.merged === 0, 'an epic shows how its children stand');
  ok(/epic/.test(await errOf(() => D.updateTask(p, epic.id, { parentId: k1.id }))) && /own epic/.test(await errOf(() => D.updateTask(p, k1.id, { parentId: k1.id }))) && /no task/.test(await errOf(() => D.createTask(p, { title: 'x', parentId: '00000000' }))), 'an epic cannot nest, a task cannot be its own epic, a missing parent is refused');
  await D.updateTask(p, k1.id, { status: 'ready' }, 'person'); await D.updateTask(p, k2.id, { status: 'ready' }, 'person'); await D.updateTask(p, epic.id, { status: 'ready' }, 'person');
  ok(await pump(p, () => task(p, k1.id).status === 'review' && task(p, k2.id).status === 'review'), 'the children run; the epic itself is never run as a task');
  ok(task(p, epic.id).status === 'ready' && task(p, epic.id).children.review === 2, 'the epic is still ready, showing 2 in review');
  await D.approveTask(p, k1.id); await D.approveTask(p, k2.id);
  await pump(p, () => task(p, epic.id).status === 'merged', 10_000);
  ok(task(p, epic.id).status === 'merged' && task(p, epic.id).children.merged === 2 && D.taskActivity(p, epic.id).some(x => /child task/.test(x.text)), 'when every child has merged the epic is done, and says why');
  // bulk
  const x1 = await D.createTask(p, { title: 'bulk one' }); const x2 = await D.createTask(p, { title: 'bulk two' }); const x3 = await D.createTask(p, { title: 'bulk three' });
  const bulk = await D.bulkUpdate(p, [x1.id, x2.id, x3.id, '00000000', k1.id], { priority: 2, labels: ['wave-2'], assignee: { kind: 'person', name: 'Ria' } }, 'person');
  ok(bulk.tasks.length === 3 && bulk.tasks.every(x => x.priority === 2 && x.labels[0] === 'wave-2' && x.assignee.name === 'Ria'), 'one patch changes many tasks', bulk.tasks.map(x => x.title));
  ok(bulk.failed.length === 2 && bulk.failed.some(f => f.id === '00000000') && bulk.failed.some(f => f.id === k1.id && /merged/.test(f.error)), 'and what could not change is named with the reason, without undoing the rest', bulk.failed);
  ok(/at least one/.test(await errOf(() => D.bulkUpdate(p, [], { priority: 2 }))) && /patch needs/.test(await errOf(() => D.bulkUpdate(p, [x1.id], {}))), 'an empty bulk request is refused');
  const agentReady = await D.bulkUpdate(p, [x1.id], { status: 'ready' }, 'agent');
  ok(agentReady.failed.length === 1 && /only a person/.test(agentReady.failed[0].error), 'an agent\'s bulk edit cannot ready a task either');
  // duplicate
  const dupSrc = await D.createTask(p, { title: 'Original', body: 'details', acceptance: ['it works'], priority: 1, labels: ['x'], type: 'chore', dueDate: '2026-11-01', assignee: { kind: 'person', name: 'Sam' } });
  const dup = await D.duplicateTask(p, dupSrc.id);
  ok(dup.id !== dupSrc.id && dup.title === 'Original (copy)' && dup.status === 'backlog' && dup.body === 'details' && dup.acceptance[0] === 'it works' && dup.type === 'chore' && dup.dueDate === '2026-11-01' && !dup.assignee && !dup.claim, 'a duplicate is a fresh backlog copy: the same words, no assignee, no run', dup);
  // quick-add
  const q = parseQuickAdd('Fix login redirect !1 #auth #web @sam due:2026-10-20 type:bug', new Date(2026, 9, 10));
  ok(q.title === 'Fix login redirect' && q.priority === 1 && q.labels.join() === 'auth,web' && q.assignee === 'sam' && q.dueDate === '2026-10-20' && q.type === 'bug', 'quick-add reads a typed line', q);
  const q2 = parseQuickAdd('Ship it due:tomorrow type:wizard due:+3d', new Date(2026, 9, 10));
  ok(q2.title === 'Ship it type:wizard' && q2.dueDate === '2026-10-13', 'relative dates work; an unknown type stays in the title; the last due wins', q2);
  const made = await D.createTask(p, { title: 'Quick one !2 #ui @ria due:2026-12-01 type:docs', quick: true });
  ok(made.title === 'Quick one' && made.priority === 2 && made.labels.includes('ui') && made.assignee.name === 'ria' && made.dueDate === '2026-12-01' && made.type === 'docs', 'the engine creates the task from the quick-add line', made);
  const literal = await D.createTask(p, { title: 'Use #hashtags literally' });
  ok(literal.title === 'Use #hashtags literally' && literal.labels.length === 0, 'without quick the title is taken as typed');
  D.resetDeliveryForTest();
}

// ═══ 7. history, live activity, metrics ═════════════════════════════════════════════════════
console.log('\n-- activity: bounded history, a board feed, and what a running agent is doing --');
{
  fresh();
  const p = makeProject();
  let clock = Date.parse('2026-10-10T10:00:00Z');
  let finish; const done = new Promise(r => { finish = r; });
  const runner = makeRunner(async (spec, id, rec) => {
    rec.activity = { summary: 'Editing src/server/auth-middleware.mjs', at: clock, tokens: 1200, milestones: [{ kind: 'edit', text: 'Edited src/server/auth-middleware.mjs.' }] };
    await done;
    CHANGE.low(spec, 'live');
  });
  D.configureDelivery({ runner, now: () => clock });
  const t = await D.createTask(p, { title: 'low: live', status: 'ready' });
  await D.setDispatch(p, 'start');
  await pump(p, () => task(p, t.id).live, 10_000);
  const run = task(p, t.id);
  ok(run.live?.summary === 'Editing src/server/auth-middleware.mjs' && run.live.tokens === 1200 && run.live.at, 'a running task shows what it is doing now: the last tool call and its target, with tokens', run.live);
  const ag = D.boardState(p).agents.find(a => a.taskId === t.id);
  ok(ag && ag.state === 'working' && ag.summary === 'Editing src/server/auth-middleware.mjs' && ag.name === 'Agent A', 'and the board\'s agent table says the same', ag);
  ok(D.taskActivity(p, t.id).filter(a => a.kind === 'edit').length === 1, 'the first edit milestone is in the history');
  // Edits are coalesced to one line per 20 seconds; commits and check runs are always kept.
  const rec = [...runner.runs.values()][0];
  rec.activity = { ...rec.activity, summary: 'Running RunChecks', milestones: [{ kind: 'edit', text: 'Edited src/b.js.' }, { kind: 'checks', text: 'Ran the checks. They passed.' }, { kind: 'commit', text: 'Committed: feat: live' }] };
  await D.tick(p); await D.settled(p);
  ok(D.taskActivity(p, t.id).filter(a => a.kind === 'edit').length === 1 && D.taskActivity(p, t.id).some(a => a.kind === 'checks') && D.taskActivity(p, t.id).some(a => a.kind === 'commit'), 'a second edit inside 20 seconds is not a new line, but a check run and a commit are');
  ok(task(p, t.id).live.summary === 'Running RunChecks', 'while the live line moves on');
  clock += 21_000;
  rec.activity = { ...rec.activity, milestones: [{ kind: 'edit', text: 'Edited src/c.js.' }] };
  await D.tick(p); await D.settled(p);
  ok(D.taskActivity(p, t.id).filter(a => a.kind === 'edit').length === 2, 'after 20 seconds the next edit is a line again');
  const journalBefore = fs.statSync(S.journalFile(p)).size;
  for (let i = 0; i < 5; i++) { rec.activity = { ...rec.activity, summary: `Editing f${i}.js`, milestones: [] }; await D.tick(p); await D.settled(p); }
  ok(task(p, t.id).live.summary === 'Editing f4.js' && fs.statSync(S.journalFile(p)).size - journalBefore < 600, 'the live line follows without writing a journal line per step', fs.statSync(S.journalFile(p)).size - journalBefore);
  finish();
  ok(await pump(p, () => ['review', 'merged'].includes(task(p, t.id).status)), 'the run finishes');
  ok(!task(p, t.id).live, 'and the live line is gone with it');
  const kinds = D.taskActivity(p, t.id).map(a => a.kind);
  ok(['created', 'status', 'started', 'edit', 'checks', 'commit', 'submitted', 'review'].every(k => kinds.includes(k)), 'the timeline has created, started, tool milestones, checks, submitted and review', kinds);
  ok(D.boardState(p).feed.some(f => f.taskId === t.id && f.kind === 'started') && D.boardState(p).feed.every(f => f.at && f.kind && f.text !== undefined), 'the board feed carries the same milestones across tasks');
  // Bounds.
  for (let i = 0; i < 260; i++) S.logActivity(p, t.id, 'note', 'agent', `entry ${i}`);
  ok(D.taskActivity(p, t.id).length === 200 && D.taskActivity(p, t.id).at(-1).text === 'entry 259' && D.taskActivity(p, t.id)[0].text === 'entry 60', 'a task keeps its latest 200 lines (the newest last)');
  ok(task(p, t.id).activity.length === 30 && D.boardState(p).feed.length === 100, 'the board carries the latest 30 per task and a 100-line feed');
  S.resetStoreCache();
  ok(D.taskActivity(p, t.id).length === 200 && D.boardState(p).feed.length === 100, 'and the bounds hold after a restart (folded from the journal)');
  D.resetDeliveryForTest();

  // The live line from a REAL session log: the last tool call and its target, past tense once it has its result.
  const ev = (seq, type, data) => ({ seq, type, timestamp: 1000 + seq, data });
  const cwd = path.join(tmpRoot, 'wt');
  const events = [
    ev(1, 'tool/call', { callId: 'c1', name: 'Read', arguments: JSON.stringify({ file_path: path.join(cwd, 'src', 'a.js') }) }),
    ev(2, 'tool/result', { callId: 'c1', name: 'Read', content: 'x' }),
    ev(3, 'tool/call', { callId: 'c2', name: 'Edit', arguments: JSON.stringify({ file_path: path.join(cwd, 'src', 'server', 'auth-middleware.mjs'), old_string: 'a', new_string: 'b' }) }),
  ];
  ok(ACT.liveSummary(events, cwd)?.summary === 'Editing src/server/auth-middleware.mjs', 'from a session log: "Editing src/server/auth-middleware.mjs" while the edit has no result', ACT.liveSummary(events, cwd));
  events.push(ev(4, 'tool/result', { callId: 'c2', name: 'Edit', content: 'ok' }), ev(5, 'tool/call', { callId: 'c3', name: 'RunChecks', arguments: '{}' }));
  ok(ACT.liveSummary(events, cwd)?.summary === 'Running RunChecks', '"Running RunChecks" for the check tool');
  events.push(ev(6, 'tool/result', { callId: 'c3', name: 'RunChecks', content: '12 passed' }), ev(7, 'tool/call', { callId: 'c4', name: 'Bash', arguments: JSON.stringify({ command: 'git commit -m "feat: x"' }) }), ev(8, 'tool/result', { callId: 'c4', name: 'Bash', content: '[b 1] feat: x' }));
  const m = ACT.milestonesSince(events, 0, cwd);
  ok(m.milestones.map(x => x.kind).join() === 'edit,checks,commit' && m.milestones[0].text === 'Edited src/server/auth-middleware.mjs.' && /Committed: feat: x/.test(m.milestones[2].text) && m.lastSeq === 8, 'milestones: the edit, the check run and the commit, once each', m);
  ok(ACT.milestonesSince(events, 8, cwd).milestones.length === 0, 'and none are reported twice');
  ok(ACT.liveSummary([], cwd) === undefined && ACT.liveSummary([ev(1, 'tool/call', { callId: 'z', name: 'Weird', arguments: 'not json' })], cwd).summary === 'Using Weird', 'a log with no tool call has no line; unparseable arguments give a plain one, never an error');
}

console.log('\n-- metrics: lead and cycle time, throughput, ageing --');
{
  fresh();
  const p = makeProject();
  D.configureDelivery({ runner: kindRunner() });
  await D.setDispatch(p, 'start');
  const ids = [];
  for (const n of ['m1', 'm2', 'm3']) ids.push((await D.createTask(p, { title: `low: ${n}`, status: 'ready' })).id);
  await pump(p, () => ids.every(id => task(p, id).status === 'review'), 60_000);
  for (const id of ids) await D.approveTask(p, id);
  const m = D.boardState(p).metrics;
  ok(m.throughput7d === 3 && m.medianLeadMs !== null && m.medianLeadMs >= 0 && m.medianCycleMs !== null && m.medianCycleMs >= 0 && m.medianCycleMs <= m.medianLeadMs + 5, 'throughput counts the week\'s merges and the medians exist, with cycle time starting at the first run (never longer than lead time)', m);
  ok(m.wipNow === 0 && Math.abs(m.spentTodayUsd - 0.15) < 1e-9, 'work in progress is 0 and today\'s spend is the three runs', { wip: m.wipNow, spent: m.spentTodayUsd });
  const q = await D.createTask(p, { title: 'waiting' });
  const ageing = D.boardState(p).metrics.byStatusAgeing;
  ok(ageing.backlog.count === 1 && ageing.backlog.oldestMs >= 0 && !ageing.merged, 'the backlog has an age; merged work is not "ageing"', ageing);
  void q;
  const empty = S.boardState(makeProject()).metrics;
  ok(empty.medianCycleMs === null && empty.medianLeadMs === null && empty.throughput7d === 0, 'a board with no history reports null medians, not zero');
  // Far in the future: nothing counts toward the week.
  ok(S.boardState(p, Date.now() + 30 * 86_400_000).metrics.throughput7d === 0, 'throughput is a window: a month later, none of it is "this week"');
  D.resetDeliveryForTest();
}

console.log('\n-- the new modules never reach the network --');
{
  const read = (f) => fs.readFileSync(path.resolve(f), 'utf8');
  const bad = ['src/delivery/autonomy.ts', 'src/delivery/activity.ts', 'src/delivery/board-view.ts', 'src/delivery/runtime-files.ts', 'src/delivery/landing.ts']
    .filter(f => /git\(\[\s*['"](push|fetch|pull|remote|clone)['"]|\bfetch\(|http\.request|https\.request/.test(read(f)));
  ok(bad.length === 0, 'autonomy, activity, board-view, runtime-files and landing have no push, fetch, pull, remote or HTTP call', bad);
  ok(!/\bgit\(\[\s*['"](push|fetch)['"]/.test(read('src/delivery/index.ts')), 'and neither does the service');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
