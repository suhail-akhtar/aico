/**
 * Delivery (ADR 0038), offline: the board journal, the dispatcher, conflict-aware
 * scheduling, the serial merge queue, landing, hygiene, the human gate on the routes
 * and the guarantee that nothing is ever pushed. Then the second half of the plan:
 * batch review, a run that needs a person (and the chat session it is held in),
 * per-stack worktree preparation and the install guard, git maintenance, and
 * release trains (version proposal, notes, a local tag, a gated deploy, a rollback
 * that goes through the same queue).
 *
 * Why a script of its own: every rule that matters here is about real git state (a
 * worktree on its own branch, a rebase that conflicts, a trunk that only moves when
 * a person approves, a worktree that is gone afterwards), so it runs against real
 * temporary repositories. The agent is a scripted runner (it edits and commits in the
 * task's worktree exactly as a model would, and submits through the same service the
 * Delivery tool calls); one block at the end runs a REAL background agent against the
 * local stub model to prove the tool group, the guard and the submit path work in the
 * actual loop.
 *
 * Part of `npm test`. No network, no cost.
 */

// A store of this process's own: nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startStubModel, stubSettings, textOf } from './lib/stub-model.mjs';

for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) delete process.env[key];

import {
  Delivery as D, DeliveryStore as S, DeliveryGit as G, assessRisk, deliveryNumstat, verifyTree, predictTouches, touchOverlap,
  deliveryRunPrompt, deliveryRunDenial, isDeliveryWorktree, deliveryTool, deliveryDefinition, handleDeliveryRoute, DecisionGate,
  runInContext, groupsForRequest, toolDefinitions, TOOL_GROUPS, setBackgroundAgentOpts, spawnBackgroundAgent, getBackgroundAgents,
  DeliveryRelease, DeliveryEnv, deliveryConfig, deliverySessionRunner, subscribeToNotifications, EventHub, RunManager,
  projectTrustStatus, approveProjectTrust, parkAction, denyAction, loadCustomTools, setToolEnabled,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` - ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(30); }
}
const errOf = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e.message ?? e); } };

const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico delivery ')));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...args) => sh('git', args, cwd);
const gitOk = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };

/** A repository with a passing check, two source files and a test. `main` is the trunk. */
function makeProject(extra = {}) {
  const dir = path.join(tmpRoot, `proj-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Owner'); git(dir, 'config', 'user.email', 'owner@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false'); git(dir, 'config', 'core.autocrlf', 'false');
  const files = {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node check.js' } }),
    'check.js': "const fs=require('fs');if(process.env.CHECK_LOG)fs.appendFileSync(process.env.CHECK_LOG,'run\\n');if(fs.existsSync('FAIL')){console.error('FAIL marker present');process.exit(1)}\n",
    '.gitignore': '.aico/\nnode_modules/\n',
    'src/a.js': 'exports.a = () => 1;\n',
    'src/b.js': 'exports.b = () => 2;\n',
    'test/a.test.js': "const t=require('node:test');const assert=require('node:assert');t('a',()=>assert.equal(require('../src/a.js').a(),1));\n",
    'README.md': 'line one\nline two\nline three\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'chore: initial');
  // The project's own definition of its test check, as a person would set it: no npm start-up on every run.
  fs.mkdirSync(path.join(dir, '.aico'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.aico', 'profile.json'), JSON.stringify({ version: 1, commands: { test: { command: 'node check.js', source: 'user', at: '2026-01-01T00:00:00.000Z' } } }));
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });   // a link target for the worktrees
  return fs.realpathSync.native(dir);
}

const checkLog = path.join(tmpRoot, 'checks.log');
process.env.CHECK_LOG = checkLog;
const checkRuns = () => (fs.existsSync(checkLog) ? fs.readFileSync(checkLog, 'utf8').split('\n').filter(Boolean).length : 0);

/** A scripted agent runner: `script(spec, runId)` does what a model would in the worktree. */
function makeRunner(script, { sessions = true, sessionPrefix = 'chat-' } = {}) {
  const runs = new Map(); let n = 0;
  const r = {
    runs,
    started: [],
    start(spec) {
      const id = `run-${++n}`;
      // `need` is what a run held in a chat session reports while it waits for a person (the server's runner fills it from the session).
      const rec = { state: 'running', ok: undefined, lastActivityAt: Date.now(), costUsd: 0.05, ...(sessions ? { sessionId: `${sessionPrefix}${id}` } : {}) };
      runs.set(id, rec); r.started.push({ id, spec });
      Promise.resolve().then(() => script(spec, id, rec)).then(() => { rec.state = 'ended'; rec.ok = true; }, e => { rec.state = 'ended'; rec.ok = false; rec.error = String(e?.message ?? e); });
      return id;
    },
    poll(id) { const x = runs.get(id); return x ? { state: x.state, ...(x.ok !== undefined ? { ok: x.ok } : {}), ...(x.error ? { error: x.error } : {}), ...(x.sessionId ? { sessionId: x.sessionId } : {}), ...(x.need ? { need: x.need } : {}), lastActivityAt: x.lastActivityAt, costUsd: x.costUsd } : { state: 'gone', lastActivityAt: 0, costUsd: 0 }; },
    stop(id) { const x = runs.get(id); if (x && x.state === 'running') { x.state = 'ended'; x.ok = false; x.error = 'stopped'; } },
  };
  return r;
}

/** Edit files in the task's worktree and commit them, as an agent following the prompt does. */
function work(spec, files, message = 'feat: change') {
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(spec.cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, rel), text); }
  git(spec.cwd, 'add', '-A'); git(spec.cwd, 'commit', '-q', '-m', message);
}

const task = (p, id) => D.boardState(p).tasks.find(t => t.id === id);
async function pump(p, cond, ms = 25_000) {
  const end = Date.now() + ms;
  for (;;) {
    await D.tick(p); await D.settled(p);
    if (cond()) return true;
    if (Date.now() > end) return false;
    await sleep(40);
  }
}
const fresh = () => { D.resetDeliveryForTest(); };

// ═════════════════════════════════════════════════════════════════════════════════════════
// Regressions found in the first real use of the board (project with ten tasks, a cheap model).
// Each block was written to FAIL on the engine as released in 0.52.0 and pass after the fix.
// `DELIVERY_ONLY_NEW=1 node scripts/delivery-test.mjs` runs just these.
// ═════════════════════════════════════════════════════════════════════════════════════════

const codeOf = async (fn) => { try { await fn(); return undefined; } catch (e) { return e; } };
/** A passing test file + source, so the project's own check stays green and the risk stays low. */
const ok1 = (name) => ({ [`src/${name}.js`]: `exports.${name} = () => 1;\n`, [`test/${name}.test.js`]: `require('node:test')('${name}', () => {});\n` });

console.log('\n-- real use 1a: AICO\'s own files never travel with a task, and an Approve never ends in a raw git error --');
{
  fresh();
  // The owner's project did not ignore .aico/: its profile.json is untracked in the checkout.
  const p = makeProject({ '.gitignore': 'node_modules/\n' });
  const profile = fs.readFileSync(path.join(p, '.aico', 'profile.json'), 'utf8');
  ok(git(p, 'status', '--porcelain').includes('.aico/'), 'setup: the checkout has its own untracked .aico/profile.json');
  D.configureDelivery({
    runner: makeRunner(async (spec) => {
      if (/committed/.test(spec.title)) {
        // The agent runs `git add -A` itself, so AICO's profile (written by its observer in the worktree) is swept into the commit.
        work(spec, { ...ok1('real'), '.aico/profile.json': '{"version":1,"observed":true}', '.aico/settings.local.json': '{"x":1}' }, 'feat: real');
        // ...and the observer rewrites it after the commit, so the file on disk now differs from the committed one (found in the live run).
        fs.writeFileSync(path.join(spec.cwd, '.aico', 'profile.json'), '{"version":1,"observed":true,"later":"written by the observer"}');
      } else {
        // Left uncommitted: the engine's own commit at submit must not stage AICO's files.
        for (const [rel, text] of Object.entries({ ...ok1('loose'), '.aico/profile.json': '{"version":1,"observed":true}', '.aico/screenshots/load-1280.png': 'png' })) {
          fs.mkdirSync(path.dirname(path.join(spec.cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, rel), text);
        }
      }
    }),
  });
  await D.setDispatch(p, 'start');
  const a = await D.createTask(p, { title: 'committed profile', status: 'ready' });
  const b = await D.createTask(p, { title: 'loose files', status: 'ready' });
  ok(await pump(p, () => task(p, a.id).status === 'review' && task(p, b.id).status === 'review'), 'both tasks reach review', [task(p, a.id).status, task(p, b.id).status]);
  const diffA = await D.taskDiffInfo(p, a.id);
  ok(diffA.files.map(f => f.path).sort().join() === 'src/real.js,test/real.test.js' && !/\.aico/.test(diffA.diff), 'the diff holds only what the agent changed, not AICO\'s profile or local settings', diffA.files);
  ok(task(p, a.id).changeCount === 2, 'and the count is those two files', task(p, a.id).changeCount);
  const treeB = git(task(p, b.id).worktree, 'ls-tree', '-r', '--name-only', 'HEAD');
  ok(!/\.aico/.test(treeB) && /src\/loose\.js/.test(treeB), 'the engine\'s own commit at submit left AICO\'s files out');
  // b lands first, so the trunk has moved when a is approved: a is rebased (its commits replayed) onto the new tip, with the observer's newer profile.json lying untracked in its worktree.
  await D.approveTask(p, b.id);
  ok(task(p, b.id).status === 'merged', 'the task whose files were left uncommitted lands');
  await D.approveTask(p, a.id);
  ok(task(p, a.id).status === 'merged', 'Approve lands the task that committed AICO files, after a rebase onto a moved trunk (it failed with "untracked working tree files would be overwritten" before)', task(p, a.id).status);
  ok(fs.readFileSync(path.join(p, '.aico', 'profile.json'), 'utf8') === profile, 'the checkout\'s own profile.json is untouched');
  ok(!/\.aico/.test(git(p, 'ls-tree', '-r', '--name-only', 'main')), 'and the trunk never gained any .aico file');

  // A branch that already carries the file (reviewed before this fix) is cleaned when it is approved, not refused.
  const c = await D.createTask(p, { title: 'legacy branch', status: 'ready' });
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, ok1('legacy'), 'feat: legacy'); }) });
  ok(await pump(p, () => task(p, c.id).status === 'review'), 'a third task in review');
  const wtC = task(p, c.id).worktree;
  fs.mkdirSync(path.join(wtC, '.aico'), { recursive: true });
  fs.writeFileSync(path.join(wtC, '.aico', 'profile.json'), '{"version":1,"legacy":true}');
  git(wtC, 'add', '-f', '-A'); git(wtC, 'commit', '-q', '-m', 'chore: committed by an older engine');
  ok(/\.aico\/profile\.json/.test(git(wtC, 'ls-tree', '-r', '--name-only', 'HEAD')), 'setup: the reviewed branch carries .aico/profile.json');
  ok((await D.approveTask(p, c.id)).status === 'merged', 'approving it cleans the branch and lands it');
  ok(!/\.aico/.test(git(p, 'ls-tree', '-r', '--name-only', 'main')) && fs.readFileSync(path.join(p, '.aico', 'profile.json'), 'utf8') === profile, 'with nothing of AICO\'s on the trunk and the checkout\'s file intact');
  D.resetDeliveryForTest();
}

console.log('\n-- real use 1b: files in the way of a landing are a decision with two choices, never a raw git error --');
{
  fresh();
  const p = makeProject();
  D.configureDelivery({
    runner: makeRunner(async (spec) => {
      if (/same/.test(spec.title)) work(spec, { ...ok1('s1'), 'same.txt': 'identical\n' }, 'feat: same');
      else if (/mine/.test(spec.title)) work(spec, { ...ok1('m1'), 'notes.txt': 'the task\'s notes\n' }, 'feat: mine');
      else if (/theirs/.test(spec.title)) work(spec, { ...ok1('t1'), 'draft.txt': 'the task\'s draft\n' }, 'feat: theirs');
      else if (/edit/.test(spec.title)) work(spec, { ...ok1('e1'), 'README.md': 'line one\nline two\nline three changed by the task\n' }, 'docs: readme');
      else work(spec, ok1('plain'), 'feat: plain');
    }),
  });
  await D.setDispatch(p, 'start');
  const same = await D.createTask(p, { title: 'same file', status: 'ready' });
  const mine = await D.createTask(p, { title: 'keep mine', status: 'ready' });
  const theirs = await D.createTask(p, { title: 'take theirs', status: 'ready' });
  const edit = await D.createTask(p, { title: 'edit readme', status: 'ready' });
  const plain = await D.createTask(p, { title: 'plain', status: 'ready' });
  ok(await pump(p, () => [same, mine, theirs, edit, plain].every(x => task(p, x.id).status === 'review'), 90_000), 'five tasks in review', [same, mine, theirs, edit, plain].map(x => task(p, x.id).status));

  // The person's own work in the checkout.
  fs.writeFileSync(path.join(p, 'same.txt'), 'identical\n');
  fs.writeFileSync(path.join(p, 'notes.txt'), 'MY notes, not committed\n');
  fs.writeFileSync(path.join(p, 'draft.txt'), 'MY draft, not committed\n');
  fs.writeFileSync(path.join(p, 'unrelated.txt'), 'something else I am writing\n');
  const mainBefore = git(p, 'rev-parse', 'main');

  const landedSame = await D.approveTask(p, same.id);
  ok(landedSame.status === 'merged' && fs.readFileSync(path.join(p, 'same.txt'), 'utf8') === 'identical\n', 'an untracked file identical to the task\'s is not in the way: it lands and says it set the copy aside', task(p, same.id).review.comments.slice(-3).map(c => c.text));
  ok(task(p, same.id).review.comments.some(c => /set aside/.test(c.text)), 'and the thread says so');

  const e1 = await codeOf(() => D.approveTask(p, mine.id));
  ok(e1 && e1.code === 'landing-collision' && /notes\.txt/.test(e1.message) && !/untracked working tree files would be overwritten/.test(e1.message) && e1.data?.choices?.join() === 'keep-mine,take-task', 'a file of the person\'s that differs from the task\'s stops the landing with a named, structured refusal', e1 && { code: e1.code, message: e1.message });
  ok(task(p, mine.id).status === 'review' && task(p, mine.id).landingBlock?.files[0]?.path === 'notes.txt' && git(p, 'rev-parse', 'main') !== mainBefore, 'the task stays in review with the block on it (the trunk only moved for the identical-file task)', task(p, mine.id).landingBlock);
  ok(fs.readFileSync(path.join(p, 'notes.txt'), 'utf8') === 'MY notes, not committed\n', 'nothing of the person\'s was touched');

  const keepMine = await D.resolveLanding(p, mine.id, 'keep-mine');
  ok(keepMine.status === 'merged' && fs.readFileSync(path.join(p, 'notes.txt'), 'utf8') === 'MY notes, not committed\n' && !git(p, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('notes.txt'), 'keep-mine: the task lands without its change to that file and the person\'s file is exactly as it was');
  ok(git(p, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('src/m1.js'), 'while the rest of the task did land');

  const e2 = await codeOf(() => D.approveTask(p, theirs.id));
  ok(e2 && e2.code === 'landing-collision', 'the same refusal for the next one');
  const takeTheirs = await D.resolveLanding(p, theirs.id, 'take-task');
  ok(takeTheirs.status === 'merged' && fs.readFileSync(path.join(p, 'draft.txt'), 'utf8') === 'the task\'s draft\n', 'take-task: the task\'s version is in the checkout');
  const saved = path.join(S.boardDir(p), 'displaced', theirs.id);
  const copies = fs.existsSync(saved) ? fs.readdirSync(saved, { recursive: true }).filter(f => /draft\.txt$/.test(String(f))) : [];
  ok(copies.length === 1 && fs.readFileSync(path.join(saved, String(copies[0])), 'utf8') === 'MY draft, not committed\n', 'and the person\'s version was saved aside first, byte for byte', copies);

  // A tracked file with the person's uncommitted edit that the task also changes: the same decision.
  fs.writeFileSync(path.join(p, 'README.md'), 'line one\nline two\nline three (my edit)\n');
  const e3 = await codeOf(() => D.approveTask(p, edit.id));
  ok(e3 && e3.code === 'landing-collision' && /README\.md/.test(e3.message) && /could not land/.test(e3.message), 'an uncommitted edit to a file the task changes is the same decision (README.md)', e3 && e3.message);
  git(p, 'checkout', '--', 'README.md');
  // A dirty checkout that the task does not overlap lands fine and keeps the person's work.
  ok((await D.approveTask(p, plain.id)).status === 'merged' && fs.readFileSync(path.join(p, 'unrelated.txt'), 'utf8') === 'something else I am writing\n', 'a dirty checkout the task does not overlap lands, and the unrelated file is intact');
  ok((await D.approveTask(p, edit.id)).status === 'merged', 'once the checkout is clean again the edit task lands');
  D.resetDeliveryForTest();
}

console.log('\n-- real use 1c: a trunk named like a tag - the diff holds only the task\'s own change --');
{
  fresh();
  const p = makeProject();
  // The release branch carries the name of a tag that points at an OLDER commit (a project that tags its release branches).
  git(p, 'checkout', '-q', '-b', 'rel-1.0.1');
  git(p, 'tag', 'rel-1.0.1');                       // the tag, at the initial commit
  fs.mkdirSync(path.join(p, 'src/agents'), { recursive: true });
  fs.writeFileSync(path.join(p, 'src/agents/personas.mjs'), Array.from({ length: 53 }, (_, i) => `export const persona${i} = ${i};`).join('\n') + '\n');
  git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'feat: personas');   // the branch moved on after the tag
  S.ensureInit(p, 'rel-1.0.1');   // the board's trunk is named explicitly (a board journaled before `currentBranch` was fully qualified, or one a person set)
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, ok1('sanitise'), 'feat: sanitise tool results'); }) });
  await D.setDispatch(p, 'start');
  ok(D.boardState(p).settings.trunk === 'rel-1.0.1', 'setup: the trunk is the branch whose name a tag shares', D.boardState(p).settings.trunk);
  const t = await D.createTask(p, { title: 'Sanitise tool results', status: 'ready' });
  ok(await pump(p, () => task(p, t.id).status === 'review'), 'the task reaches review', task(p, t.id).status);
  const d = await D.taskDiffInfo(p, t.id);
  ok(!/personas/.test(d.diff) && d.files.map(f => f.path).sort().join() === 'src/sanitise.js,test/sanitise.test.js', 'its diff holds only its own two files - none of the 53 lines the branch gained are shown as deleted', d.files);
  ok(!/^-export const persona/m.test(d.diff), 'no deleted lines at all');
  ok(task(p, t.id).evidence && task(p, t.id).risk && task(p, t.id).risk.level === 'low', 'and its risk is scored on that diff', task(p, t.id).risk);
  await D.approveTask(p, t.id);
  ok(git(p, 'show', 'refs/heads/rel-1.0.1:src/agents/personas.mjs').split('\n').length >= 53 && git(p, 'show', 'refs/heads/rel-1.0.1:src/sanitise.js').includes('sanitise'), 'landing it keeps everything the branch had and adds the task');
  D.resetDeliveryForTest();
}


/** The delivery routes over a fake request, for the tests below (the same harness the routes section uses). */
function routeHarness(p) {
  const gate = new DecisionGate();
  const mkReq = (method, headers = {}) => ({ method, headers, on() {} });
  const deps = {
    send: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body ?? {},
    isKnownProject: async (d) => path.resolve(d) === p,
    human: (req, body) => gate.checkHuman({ grant: req.headers['x-aico-grant'], client: body.client, uiKey: req.headers['x-aico-ui-key'], fetchSite: undefined }),
    startPlan: async () => ({ sessionId: 'plan-x' }),
    subscribe: () => () => {},
  };
  return async (route, method, body = {}, { person = false, query = '' } = {}) => {
    const req = mkReq(method, person ? { 'x-aico-ui-key': gate.uiKey } : {}); req.body = body;
    const res = { headers: {}, written: [], write(x) { this.written.push(x); } };
    const handled = await handleDeliveryRoute(route, req, res, new URL(`http://127.0.0.1/api/${route}${query}`), deps);
    return { handled, status: res.status, body: res.body };
  };
}

console.log('\n-- real use 2: ready tasks that never start - the board says why, and one click unblocks them --');
{
  fresh();
  const p = makeProject();
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, ok1(spec.title.toLowerCase().replace(/[^a-z]+/g, '')), 'feat: ' + spec.title); }) });
  const call = routeHarness(p);
  // Moved to Ready BEFORE the dispatcher was ever started, two of them behind prerequisites that are still in the backlog.
  const A = await D.createTask(p, { title: 'Add auth' });
  const B = await D.createTask(p, { title: 'Add sessions', status: 'ready', dependsOn: [A.id] });
  const C = await D.createTask(p, { title: 'Add db' });
  const Dd = await D.createTask(p, { title: 'Add audit', status: 'ready', dependsOn: [C.id] });
  const E = await D.createTask(p, { title: 'Add docs', status: 'ready' });
  const F = await D.createTask(p, { title: 'Add logging', status: 'ready' });
  const G2 = await D.createTask(p, { title: 'Add metrics', status: 'ready' });
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => [E, F, G2].every(x => task(p, x.id).status === 'review'), 90_000), 'the three independent ready tasks that were moved before the start all run, two at a time (not only the newest)', [E, F, G2].map(x => task(p, x.id).status));
  const b = task(p, B.id); const d = task(p, Dd.id);
  ok(b.status === 'ready' && d.status === 'ready', 'the two behind unmerged prerequisites wait');
  ok(b.blockedBy?.length === 1 && b.blockedBy[0].id === A.id && b.blockedBy[0].status === 'backlog', 'and each says what it waits for: task.blockedBy names the prerequisite and where it is', b.blockedBy);
  ok(/Add auth/.test(b.waitingReason) && /Backlog/.test(b.waitingReason), 'with the reason in words', b.waitingReason);
  const board = D.boardState(p);
  ok(/^2 ready tasks wait for "Add auth" and "Add db", which are in Backlog\.$/.test(board.idleReason), 'the board says why nothing is being picked up (it was silent before)', board.idleReason);
  // Promoting needs a person, and moves the whole chain in one call.
  ok((await call('delivery/tasks/' + B.id + '/promote-prerequisites', 'POST', { project: p })).status === 403, 'promote-prerequisites with only the token is refused');
  const moved = await call('delivery/tasks/' + B.id + '/promote-prerequisites', 'POST', { project: p }, { person: true });
  ok(moved.status === 200 && moved.body.moved.join() === A.id && task(p, A.id).status === 'ready' && task(p, Dd.id).status === 'ready' && task(p, C.id).status === 'backlog', 'a person promotes B\'s prerequisites: A moves to Ready, nothing else does', moved.body);
  ok(await pump(p, () => task(p, A.id).status === 'review'), 'A runs');
  ok(task(p, B.id).blockedBy?.[0]?.status === 'review', 'and B now says A is in review');
  await D.approveTask(p, A.id);
  ok(await pump(p, () => task(p, B.id).status === 'review'), 'once A is merged, B starts by itself', task(p, B.id).status);
  const idle2 = D.boardState(p).idleReason;
  ok(/Add db/.test(idle2) && /Backlog/.test(idle2), 'D still waits for C, and the board still names it', idle2);
  // A cancelled prerequisite can never merge: it is reported, not silently waited for.
  await D.updateTask(p, C.id, { status: 'cancelled' }, 'person');
  const stuck = await D.promotePrerequisites(p, Dd.id, 'person');
  ok(stuck.moved.length === 0 && stuck.stuck[0]?.id === C.id && stuck.stuck[0].status === 'cancelled', 'promoting behind a cancelled prerequisite moves nothing and says which one is stuck', stuck);
  ok(/Cancelled/.test(task(p, Dd.id).waitingReason) || /Cancelled/.test(D.boardState(p).idleReason ?? ''), 'and the card shows it');
  // A task moved to Ready while the dispatcher was paused starts when it is started again.
  await D.setDispatch(p, 'pause');
  const late = await D.createTask(p, { title: 'Add late', status: 'ready' });
  await pump(p, () => false, 600);
  ok(task(p, late.id).status === 'ready' && /paused/.test(task(p, late.id).waitingReason), 'while paused it waits, and says the dispatcher is paused', task(p, late.id).waitingReason);
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => task(p, late.id).status === 'review'), 'starting the dispatcher picks it up');
  D.resetDeliveryForTest();
}

console.log('\n-- real use 3: the Changes count is the real diff, and a running task\'s diff is live --');
{
  fresh();
  const p = makeProject();
  let release; const gate = new Promise(r => { release = r; });
  D.configureDelivery({
    runner: makeRunner(async (spec) => {
      // Edits a tracked file and adds a new one, commits nothing, and keeps working until the test lets it finish.
      fs.writeFileSync(path.join(spec.cwd, 'README.md'), 'line one\nline two\nline three\nline four (live)\n');
      fs.mkdirSync(path.join(spec.cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(spec.cwd, 'src', 'live.js'), 'exports.live = () => 42;\n');
      fs.writeFileSync(path.join(spec.cwd, 'test', 'live.test.js'), "require('node:test')('live', () => {});\n");
      fs.mkdirSync(path.join(spec.cwd, 'src', 'brand', 'new'), { recursive: true });   // a NEW folder: git lists it as one line unless asked for its files
      fs.writeFileSync(path.join(spec.cwd, 'src', 'brand', 'new', 'deep.js'), 'exports.deep = 1;\n');
      await gate;
    }),
  });
  const t = await D.createTask(p, { title: 'Watch me', status: 'ready', labels: ['src/a.js'] });
  ok(task(p, t.id).touches === undefined && task(p, t.id).changeCount === 0, 'before it starts the count is 0');
  // Predicted touches exist (one file named by a label) but are not a change: the old tab counted them.
  await D.setDispatch(p, 'start');
  await pump(p, () => task(p, t.id).status === 'running' && task(p, t.id).changeCount === 4, 30_000);
  const live = task(p, t.id);
  ok(live.status === 'running' && live.changeCount === 4, 'a running task with uncommitted work counts its real files (an edit, two new files and one in a brand-new folder)', { status: live.status, count: live.changeCount, touches: live.touches });
  const dd = await D.taskDiffInfo(p, t.id);
  ok(dd.live === true && dd.files.length === live.changeCount && dd.files.every(f => f.uncommitted), 'the live diff lists exactly that many files, all uncommitted', dd.files);
  ok(/\+line four \(live\)/.test(dd.diff) && /\+exports\.live = \(\) => 42;/.test(dd.diff) && /new file mode/.test(dd.diff), 'and its text shows the edit and the new file\'s contents', dd.diff.slice(0, 300));
  ok(git(live.worktree, 'diff', '--cached', '--name-only') === '', "looking at it staged nothing in the task's worktree");
  release();
  ok(await pump(p, () => task(p, t.id).status === 'review'), 'it finishes and reaches review');
  const done = task(p, t.id); const after = await D.taskDiffInfo(p, t.id);
  ok(after.live === false && after.files.length === done.changeCount && done.changeCount === 4, 'in review the count and the committed diff agree (4 files)', { files: after.files.map(f => f.path), count: done.changeCount });
  await D.approveTask(p, t.id);
  const merged = await D.taskDiffInfo(p, t.id);
  ok(task(p, t.id).changeCount === 4 && merged.files.length === 4 && /live\.js/.test(merged.diff), 'after the merge the drawer still has its diff, from the range that landed', merged.files);
  // A task nobody has started: nothing to show, said plainly, and a count of 0.
  const idle = await D.createTask(p, { title: 'Not yet', labels: ['src/b.js'] });
  S.patchTask(p, idle.id, { touches: { files: ['src/b.js'], symbols: [], predicted: true } });   // what the dispatcher leaves on a task that is waiting its turn
  const none = await D.taskDiffInfo(p, idle.id);
  ok(none.files.length === 0 && none.diff === '' && /No agent has started/.test(none.note) && task(p, idle.id).changeCount === 0 && task(p, idle.id).touches.files.length === 1, 'an unstarted task has a predicted file but a changeCount of 0 and an honest empty diff', { note: none.note, touches: task(p, idle.id).touches });
  D.resetDeliveryForTest();
}

console.log('\n-- real use 4: a task and its chat find each other, in every status --');
{
  fresh();
  const p = makeProject();
  let round = 0;
  D.configureDelivery({ runner: makeRunner(async (spec) => { round++; work(spec, { [`src/r${round}.js`]: `exports.r = ${round};\n`, [`test/r${round}.test.js`]: `require('node:test')('r${round}', () => {});\n` }, `feat: round ${round}`); }, { sessionPrefix: 'p4-chat-' }) });
  await D.setDispatch(p, 'start');
  const t = await D.createTask(p, { title: 'Linked', status: 'ready' });
  ok(await pump(p, () => task(p, t.id).status === 'review'), 'a task in review');
  const r1 = task(p, t.id);
  ok(r1.session?.id === 'p4-chat-run-1' && r1.sessionId === 'p4-chat-run-1' && r1.sessions?.[0]?.id === 'p4-chat-run-1' && r1.sessions[0].stage === 'ready', 'the task records its chat, and the stage it was in when the run began', r1.sessions);
  const link = D.deliveryLinkOfSession('p4-chat-run-1');
  ok(link && link.taskId === t.id && link.title === 'Linked' && link.status === 'review' && link.board === p && link.project === p && link.stage === 'ready', 'and the chat resolves back to the task with its status and board (review)', link);
  await D.requestChanges(p, t.id, 'please add more');
  ok(await pump(p, () => task(p, t.id).status === 'review' && task(p, t.id).sessions?.length === 2), 'a second run (changes requested) is a second chat');
  const r2 = task(p, t.id);
  ok(r2.session.id === 'p4-chat-run-2' && r2.sessions.map(s => s.id).join() === 'p4-chat-run-1,p4-chat-run-2' && r2.sessions[1].stage === 'changes', 'the task points at the latest chat and keeps the earlier one', r2.sessions);
  ok(D.deliveryLinkOfSession('p4-chat-run-1')?.taskId === t.id && D.deliveryLinkOfSession('p4-chat-run-2')?.taskId === t.id, 'both chats link back to the task');
  await D.approveTask(p, t.id);
  ok(D.deliveryLinkOfSession('p4-chat-run-2')?.status === 'merged' && D.deliveryLinkOfSession('p4-chat-run-1')?.status === 'merged', 'after the merge both still link back (status merged)');
  ok(D.deliveryLinkOfSession('chat-nobody') === undefined && D.deliveryLinkOfSession('') === undefined, 'a chat that is not a task\'s has no link');
  D.resetDeliveryForTest();
}

if (process.env.DELIVERY_ONLY_NEW === '1') { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }

console.log('\n-- the journal: fold, restart, torn lines, validation --');
{
  fresh();
  const p = makeProject();
  const a = await D.createTask(p, { title: 'First', body: 'do it', acceptance: ['it works'], priority: 2, labels: ['src/a.js'] });
  const b = await D.createTask(p, { title: 'Second', dependsOn: ['First'] });
  ok(a.status === 'backlog' && a.priority === 2 && /^[a-f0-9]{8}$/.test(a.id) && a.project === p, 'a new task lands in the backlog with an 8-hex id', a);
  ok(b.dependsOn.length === 1 && b.dependsOn[0] === a.id, 'dependsOn resolves an exact title to the id');
  const file = path.join(process.env.AICO_HOME, 'delivery');
  ok(fs.existsSync(file) && S.journalFile(p).startsWith(file) && fs.existsSync(S.journalFile(p)), 'the journal lives under aicoHome()/delivery/<project key>/');
  const board = D.boardState(p);
  ok(Object.keys(board).sort().join() === 'agents,autonomy,dispatcher,feed,metrics,project,queue,releases,running,settings,tasks' && Array.isArray(board.releases)
    && board.autonomy === 'manual' && board.settings.autonomy === 'manual' && board.settings.budgetUsdPerDay === 10 && board.settings.pauseAfterFailures === 3 && board.metrics.throughput7d === 0
    && board.dispatcher === 'idle' && board.settings.maxParallel === 2 && board.settings.autoLandLowRisk === false && board.settings.trunk === 'main'
    && Array.isArray(board.queue) && Array.isArray(board.running), 'BoardState has exactly the contract keys and defaults (maxParallel 2, autoLand off, manual autonomy, $10 a day, pause after 3 failures)', board.settings);
  await D.updateTask(p, a.id, { status: 'ready', title: 'First, renamed' }, 'person');
  S.addComment(p, a.id, 'person', 'a note');
  S.resetStoreCache();   // a restart folds the journal again
  const again = D.boardState(p);
  ok(JSON.stringify(again.tasks) === JSON.stringify(D.boardState(p).tasks) && again.tasks.find(t => t.id === a.id).title === 'First, renamed'
    && again.tasks.find(t => t.id === a.id).status === 'ready' && again.tasks.find(t => t.id === a.id).review.comments[0].text === 'a note', 'a restart folds the same board back', again.tasks[0]);
  // A torn last line (a crash mid-append) is skipped and the next event is not glued to it.
  fs.appendFileSync(S.journalFile(p), '{"t":"patch","at":"2026-01-01T00:00:00.000Z","id":"' + a.id + '","set":{"title":"TORN');
  S.resetStoreCache();
  ok(D.boardState(p).tasks.length === 2, 'a torn last line is ignored');
  await D.createTask(p, { title: 'After the tear' });
  S.resetStoreCache();
  ok(D.boardState(p).tasks.length === 3 && D.boardState(p).tasks.some(t => t.title === 'After the tear'), 'the next append starts on a fresh line and survives');

  ok(/title required/.test(await errOf(() => D.createTask(p, { title: '  ' }))), 'a task needs a title');
  ok(/priority/.test(await errOf(() => D.createTask(p, { title: 'x', priority: 9 }))), 'priority is 1-4');
  ok(/no task/.test(await errOf(() => D.createTask(p, { title: 'x', dependsOn: ['nope'] }))), 'dependsOn must name a task on the board');
  ok(/cycle/.test(await errOf(() => D.updateTask(p, a.id, { dependsOn: [b.id] }))), 'a dependency cycle is refused');
  ok(/only a person/.test(await errOf(() => D.updateTask(p, b.id, { status: 'ready' }, 'agent'))), 'an agent cannot promote a task to ready');
  ok(/status can be set/.test(await errOf(() => D.updateTask(p, b.id, { status: 'merged' }))), 'the engine owns running/review/changes/merged');
  S.setSettings(p, { maxParallel: 99 });
  ok(D.boardState(p).settings.maxParallel === 4, 'maxParallel is capped at 4');
}

console.log('\n-- dispatcher: dependencies, parallel cap, overlap, worktrees --');
{
  fresh();
  const p = makeProject();
  const gates = new Map();
  const runner = makeRunner(async (spec) => {
    // Hold the run open until the test releases it, so the running set can be observed.
    await new Promise(r => gates.set(spec.taskId, r));
    work(spec, { [`src/${spec.title.toLowerCase().replace(/\W+/g, '-')}.js`]: `// ${spec.title}\n` }, `feat: ${spec.title}`);
  });
  D.configureDelivery({ runner });
  const t1 = await D.createTask(p, { title: 'One', status: 'ready', priority: 1, labels: ['src/a.js'] });
  const t2 = await D.createTask(p, { title: 'Two', status: 'ready', priority: 2, labels: ['src/a.js'] });          // overlaps One
  const t3 = await D.createTask(p, { title: 'Three', status: 'ready', priority: 3, labels: ['src/b.js'] });        // independent
  const t4 = await D.createTask(p, { title: 'Four', status: 'ready', priority: 1, dependsOn: [t3.id], labels: ['src/c.js'] });   // waits for Three
  let before = D.boardState(p);
  await D.tick(p);
  ok(runner.started.length === 0 && D.boardState(p).dispatcher === 'idle', 'nothing starts until a person starts the dispatcher');
  const started = await D.setDispatch(p, 'start', 3);
  const running = () => D.boardState(p).tasks.filter(t => t.status === 'running').map(t => t.title).sort();
  ok(started.dispatcher === 'running' && started.settings.maxParallel === 3, 'start sets the dispatcher running and maxParallel');
  ok(running().join() === 'One,Three', 'One and Three run; Two overlaps One, Four depends on Three', running());
  ok(task(p, t2.id).status === 'ready' && task(p, t4.id).status === 'ready', 'held tasks stay ready');
  const one = task(p, t1.id);
  ok(one.branch === `aico/task-${t1.id}` && one.worktree && fs.existsSync(one.worktree) && one.claim && one.claim.runId && Date.parse(one.claim.leaseUntil) > Date.now(), 'a started task has its branch, worktree and a lease', one);
  ok(path.relative(process.env.AICO_HOME, one.worktree).startsWith('worktrees') && !one.worktree.startsWith(p), 'the worktree is under aicoHome()/worktrees, outside the repository');
  ok(git(p, 'branch', '--list', one.branch).includes(one.branch) && git(one.worktree, 'rev-parse', '--abbrev-ref', 'HEAD') === one.branch, 'the branch exists and the worktree is on it');
  ok(git(p, 'rev-parse', 'main') === git(one.worktree, 'rev-parse', 'HEAD'), 'the worktree starts from the trunk');
  ok(fs.existsSync(path.join(one.worktree, 'node_modules')) && git(one.worktree, 'status', '--porcelain') === '', 'node_modules is linked in and does not show as a change');
  ok(runner.started[0].spec.prompt.includes('delivery task') && runner.started[0].spec.prompt.includes(one.branch) && runner.started[0].spec.cwd === one.worktree, 'the run prompt names the task, its branch and runs in the worktree');
  ok(D.boardState(p).running.length === 2 && D.boardState(p).running[0].runId, 'BoardState.running lists the live runs');
  ok(one.touches && one.touches.predicted === true && one.touches.files.includes('src/a.js'), 'touches are predicted from the task text and marked predicted', one.touches);

  // Actual touches replace the prediction as the run edits.
  fs.writeFileSync(path.join(one.worktree, 'src/zzz.js'), 'x\n');
  await D.tick(p);
  const touched = task(p, t1.id).touches;
  ok(touched.predicted === false && touched.files.includes('src/zzz.js'), 'actual touches replace the prediction as the run edits', touched);
  fs.rmSync(path.join(one.worktree, 'src/zzz.js'));

  // A run's progress renews its lease.
  const lease0 = Date.parse(task(p, t1.id).claim.leaseUntil);
  D.configureDelivery({ now: () => Date.now() + 120_000 });
  runner.runs.get(runner.started[0].id).lastActivityAt = Date.now() + 1;
  await D.tick(p);
  ok(Date.parse(task(p, t1.id).claim.leaseUntil) > lease0 + 100_000, 'observed progress renews the lease', { lease0, now: task(p, t1.id).claim.leaseUntil });
  D.configureDelivery({ now: Date.now });
  ok((task(p, t1.id).costUsd ?? 0) > 0, 'the run cost is recorded on the task', task(p, t1.id).costUsd);

  // Release One: it finishes without calling submit, so finishing with commits submits it.
  gates.get(t1.id)();
  ok(await pump(p, () => ['review', 'running'].includes(task(p, t1.id).status) && task(p, t1.id).status === 'review'), 'a run that ends with commits is submitted for it and reaches review', task(p, t1.id).status);
  ok(running().join() === 'Three' || running().join() === 'Three,Two', 'One leaving frees its files: Two may start', running());
  gates.get(t3.id)();
  await pump(p, () => task(p, t3.id).status === 'review');
  ok(task(p, t4.id).status === 'ready' && task(p, t3.id).status === 'review', 'Four still waits for Three to be MERGED, not merely reviewed', task(p, t4.id).status);
  const landed = await D.approveTask(p, t3.id);
  ok(landed.status === 'merged', 'approving Three merges it');
  await pump(p, () => task(p, t4.id).status === 'running');
  ok(task(p, t4.id).status === 'running', 'Four starts once Three is merged');
  for (const [, open] of gates) open();
  await pump(p, () => ['review'].includes(task(p, t4.id).status) && task(p, t2.id).status === 'review');
  await D.setDispatch(p, 'pause');
  ok(D.boardState(p).dispatcher === 'paused', 'pause is recorded');
}

console.log('\n-- merge queue: review package, trunk only moves on approval, checks cached by tree --');
{
  fresh();
  fs.rmSync(checkLog, { force: true });
  const p = makeProject();
  const runner = makeRunner(async (spec) => {
    work(spec, { 'src/a.js': 'exports.a = () => 11;\n', 'test/a2.test.js': "require('node:test')('a2',()=>{});\n" }, 'feat: change a');
    await D.submitTask(spec.projectPath ?? p, spec.taskId, { summary: 'changed a and added a test' });
  });
  D.configureDelivery({ runner });
  const t = await D.createTask(p, { title: 'Change a', status: 'ready', acceptance: ['a returns 11'], labels: ['src/a.js'] });
  const mainBefore = git(p, 'rev-parse', 'main');
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => task(p, t.id).status === 'review'), 'submit -> rebase -> checks -> review', task(p, t.id));
  const r = task(p, t.id);
  ok(git(p, 'rev-parse', 'main') === mainBefore, 'the trunk has not moved before approval');
  ok(!r.claim && D.boardState(p).queue.includes(t.id), 'the claim is released and the task waits in the queue');
  ok(r.evidence && /Change evidence/.test(r.evidence.md) && /Change a/.test(r.evidence.md) && /a returns 11/.test(r.evidence.md) && /node check/.test(r.evidence.md) && r.evidence.summary.length > 0, 'the evidence report names the task, criteria and the check that ran', r.evidence?.md.slice(0, 400));
  ok(!/co-authored|generated with|claude/i.test(r.evidence.md), 'the evidence carries no attribution');
  ok(r.risk && r.risk.score >= 0 && r.risk.score <= 100 && ['low', 'medium', 'high'].includes(r.risk.level) && r.risk.reasons.length > 0, 'a risk score with reasons', r.risk);
  ok(r.touches && r.touches.predicted === false && r.touches.files.includes('src/a.js') && r.touches.files.includes('test/a2.test.js'), 'touches are the actual changed files', r.touches);
  ok(r.review.comments.some(c => c.by === 'agent' && /changed a and added a test/.test(c.text)), "the agent's summary is on the task");
  ok(checkRuns() === 1, 'the project checks ran once on the rebased tree', checkRuns());
  const diff = await D.taskDiff(p, t.id);
  ok(/exports\.a = \(\) => 11/.test(diff) && /a2\.test\.js/.test(diff), 'the diff is the task branch against the trunk');

  // Tree-hash cache: the same tree is not checked twice.
  const tree = await G.treeOf(r.worktree);
  const again = await verifyTree(p, r.worktree, tree);
  ok(again.cached === true && again.ok && checkRuns() === 1, 'a tree already green is not run again (checks cached by tree hash)', { again, runs: checkRuns() });
  const other = await verifyTree(p, r.worktree, 'f'.repeat(40));
  ok(other.cached === false && checkRuns() === 2, 'a different tree hash always runs');

  const landed = await D.approveTask(p, t.id);
  ok(landed.status === 'merged', 'approve lands the task', landed.status);
  ok(git(p, 'show', 'main:src/a.js').includes('11') && fs.readFileSync(path.join(p, 'src/a.js'), 'utf8').includes('11'), 'the trunk and the checkout have the change (fast-forward)');
  ok(git(p, 'log', '--format=%s', '-1') === 'feat: change a' && git(p, 'rev-list', '--merges', '--count', 'main') === '0', 'a fast-forward: no merge commit, the agent\'s Conventional Commit is the tip');
  ok(!fs.existsSync(r.worktree) && !gitOk(p, 'rev-parse', '--verify', r.branch) && !git(p, 'worktree', 'list').includes('task-'), 'hygiene: worktree and branch are gone after merge');
  ok(!D.boardState(p).queue.includes(t.id), 'and it left the queue');
  ok(fs.existsSync(path.join(p, 'node_modules', '.bin')), 'removing the worktree did not follow its node_modules link into the project own folder');
  ok(/Not|merged/.test(await errOf(() => D.approveTask(p, t.id))) && /review/.test(await errOf(() => D.approveTask(p, t.id))), 'a task cannot be approved twice');
}

console.log('\n-- send-backs: red checks, rebase conflict, request changes --');
{
  fresh();
  fs.rmSync(checkLog, { force: true });
  const p = makeProject();
  const prompts = [];
  let mode = 'failing-check';
  // The first run of 'Conflicting' is held until the trunk has moved, so the conflict does not depend on how fast this machine is.
  let trunkMoved; const trunkMovedP = new Promise(r => { trunkMoved = r; });
  const runner = makeRunner(async (spec) => {
    prompts.push(spec.prompt);
    if (spec.taskTitle === 'Conflicting' || spec.title === 'Conflicting') {
      if (!/Rebase conflict/.test(spec.prompt)) {
        await trunkMovedP;
        work(spec, { 'README.md': 'line one\nTASK LINE two\nline three\n' }, 'docs: task wording');
      } else {
        // Resolve as a model would: rebase, keep both intents, continue.
        try { git(spec.cwd, 'rebase', 'main'); } catch { /* conflicts, expected */ }
        fs.writeFileSync(path.join(spec.cwd, 'README.md'), 'line one\nTRUNK LINE two\nTASK LINE two\nline three\n');
        git(spec.cwd, 'add', 'README.md');
        execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: spec.cwd, env: { ...process.env, GIT_EDITOR: 'true' } });
      }
      return;
    }
    if (spec.title === 'Red') {
      if (!/Checks failed/.test(spec.prompt)) work(spec, { FAIL: 'x\n', 'src/b.js': 'exports.b = () => 3;\n' }, 'fix: b');
      else { fs.rmSync(path.join(spec.cwd, 'FAIL')); git(spec.cwd, 'add', '-A'); git(spec.cwd, 'commit', '-q', '-m', 'fix: remove the failing marker'); }
      return;
    }
    if (spec.title === 'Reviewed') {
      if (!/please rename/.test(spec.prompt)) work(spec, { 'src/b.js': 'exports.b = () => 20;\n' }, 'feat: b');
      else work(spec, { 'src/b2.js': 'exports.renamed = true;\n' }, 'refactor: rename as asked');
    }
  });
  D.configureDelivery({ runner });
  await D.setDispatch(p, 'start');

  // Red check: sent back with the failure, resumed with it in the prompt, then green.
  const red = await D.createTask(p, { title: 'Red', status: 'ready' });
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => runner.started.some(s => /Checks failed/.test(s.spec.prompt)), 30_000), 'a failing check sends the task back and the run is resumed with the failure in its prompt', task(p, red.id)?.status);
  const redPrompt = runner.started.find(s => /Checks failed/.test(s.spec.prompt)).spec.prompt;
  ok(/FAIL marker present/.test(redPrompt) || task(p, red.id).review.comments.some(c => /FAIL marker present/.test(c.text)), 'the failing check output reaches the agent', redPrompt.slice(-400));
  ok(await pump(p, () => task(p, red.id).status === 'review', 30_000), 'after the fix it reaches review', task(p, red.id).status);
  ok(task(p, red.id).worktree === runner.started.find(s => s.spec.title === 'Red').spec.cwd && runner.started.filter(s => s.spec.title === 'Red').every(s => s.spec.cwd === task(p, red.id).worktree), 'the resumed run works in the same worktree');
  await D.approveTask(p, red.id);

  // Rebase conflict: another change lands on the same line first.
  const conflicting = await D.createTask(p, { title: 'Conflicting', status: 'ready' });
  await pump(p, () => task(p, conflicting.id).status === 'running', 15_000);
  // While it runs, the trunk moves on the same line (a person edits and commits on main).
  fs.writeFileSync(path.join(p, 'README.md'), 'line one\nTRUNK LINE two\nline three\n');
  git(p, 'add', 'README.md'); git(p, 'commit', '-q', '-m', 'docs: trunk wording');
  trunkMoved();
  ok(await pump(p, () => runner.started.some(s => s.spec.title === 'Conflicting' && /Rebase conflict/.test(s.spec.prompt)), 30_000), 'a rebase conflict sends the task to changes and resumes the run', task(p, conflicting.id)?.status);
  const cprompt = runner.started.find(s => s.spec.title === 'Conflicting' && /Rebase conflict/.test(s.spec.prompt)).spec.prompt;
  ok(/README\.md/.test(cprompt), 'the conflict files are named in the agent comment it is resumed with', cprompt.slice(-300));
  ok(await pump(p, () => task(p, conflicting.id).status === 'review', 30_000), 'once resolved it reaches review', task(p, conflicting.id));
  const readme = (await D.taskDiff(p, conflicting.id));
  ok(/TASK LINE two/.test(readme), 'the resolution keeps the task\'s change on top of the trunk\'s');
  await D.approveTask(p, conflicting.id);
  ok(fs.readFileSync(path.join(p, 'README.md'), 'utf8').includes('TRUNK LINE two') && fs.readFileSync(path.join(p, 'README.md'), 'utf8').includes('TASK LINE two'), 'both landed on the trunk');

  // Request changes: the comment is on the task and in the new run's prompt.
  const rev = await D.createTask(p, { title: 'Reviewed', status: 'ready' });
  ok(await pump(p, () => task(p, rev.id).status === 'review', 30_000), 'Reviewed reaches review');
  const startedBefore = runner.started.length;
  const bounced = await D.requestChanges(p, rev.id, 'please rename the helper');
  ok(bounced.status === 'changes' && bounced.review.comments.at(-1).by === 'person' && bounced.review.comments.at(-1).text === 'please rename the helper' && !bounced.evidence && !bounced.risk, 'request-changes: status changes, the comment is appended, the old evidence is dropped', bounced);
  ok(!D.boardState(p).queue.includes(rev.id), 'and it leaves the landing queue');
  ok(/comment/.test(await errOf(() => D.requestChanges(p, rev.id, '  '))), 'a comment is required');
  ok(await pump(p, () => runner.started.length > startedBefore && /please rename the helper/.test(runner.started.at(-1).spec.prompt), 30_000), 'the run is resumed with the comment in its prompt');
  ok(await pump(p, () => task(p, rev.id).status === 'review', 30_000), 'and comes back for review');
  const final = await D.approveTask(p, rev.id);
  ok(final.status === 'merged' && fs.existsSync(path.join(p, 'src/b2.js')), 'the loop ends in a landing');

  // Trunk moved after review with a clean rebase: re-rebased, re-checked, then fast-forwarded.
  const late = await D.createTask(p, { title: 'Late', status: 'ready' });
  const lateRunner = makeRunner(async (spec) => { work(spec, { 'src/late.js': 'exports.late = 1;\n' }, 'feat: late'); });
  D.configureDelivery({ runner: lateRunner });
  ok(await pump(p, () => task(p, late.id).status === 'review', 30_000), 'Late reaches review');
  fs.writeFileSync(path.join(p, 'src/elsewhere.js'), 'exports.e = 1;\n'); git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'feat: elsewhere');
  const runsBefore = checkRuns();
  const landedLate = await D.approveTask(p, late.id);
  ok(landedLate.status === 'merged' && fs.existsSync(path.join(p, 'src/late.js')) && fs.existsSync(path.join(p, 'src/elsewhere.js')), 'a clean rebase after the trunk moved still lands');
  ok(checkRuns() === runsBefore + 1, 'and its checks ran again on the new tree before it landed', { runsBefore, after: checkRuns() });
  ok(git(p, 'rev-list', '--merges', '--count', 'main') === '0', 'still no merge commit');
}

console.log('\n-- landing edge cases: a checkout that cannot take the merge, a trunk checked out nowhere --');
{
  fresh();
  const p = makeProject();
  const runner = makeRunner(async (spec) => { work(spec, { 'README.md': 'line one\nline two changed\nline three\n', 'test/r.test.js': "require('node:test')('r',()=>{});\n" }, 'docs: reword'); });
  D.configureDelivery({ runner });
  await D.setDispatch(p, 'start');
  const t = await D.createTask(p, { title: 'Reword', status: 'ready' });
  ok(await pump(p, () => task(p, t.id).status === 'review'), 'a task in review');
  const mainBefore = git(p, 'rev-parse', 'main');
  fs.writeFileSync(path.join(p, 'README.md'), 'my own uncommitted edit\n');   // the person's work in progress, in the file the task changes
  const refused = await errOf(() => D.approveTask(p, t.id));
  ok(/could not land/.test(refused) && task(p, t.id).status === 'review' && git(p, 'rev-parse', 'main') === mainBefore, 'git refusing to overwrite the person\'s edit leaves the task in review and the trunk untouched', refused);
  ok(fs.readFileSync(path.join(p, 'README.md'), 'utf8') === 'my own uncommitted edit\n', 'and the person\'s edit is intact');
  git(p, 'checkout', '--', 'README.md');
  ok((await D.approveTask(p, t.id)).status === 'merged', 'once the checkout can take it, approve lands it');

  // The trunk checked out nowhere: the ref moves forward and the person's branch is left alone.
  const t2 = await D.createTask(p, { title: 'Elsewhere', status: 'ready' });
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, { 'src/else.js': 'exports.e = 1;\n', 'test/else.test.js': "require('node:test')('else',()=>{});\n" }, 'feat: else'); }) });
  ok(await pump(p, () => task(p, t2.id).status === 'review'), 'another task in review');
  git(p, 'checkout', '-q', '-b', 'side');
  const sideBefore = git(p, 'rev-parse', 'side');
  ok((await D.approveTask(p, t2.id)).status === 'merged' && git(p, 'show', 'main:src/else.js').includes('exports'), 'the trunk moves forward even when it is not the checked-out branch');
  ok(git(p, 'rev-parse', 'side') === sideBefore && !fs.existsSync(path.join(p, 'src/else.js')), 'and the checked-out branch and its files are not touched');
  // The trunk checked out in ANOTHER worktree: refused, not desynchronised.
  const t3 = await D.createTask(p, { title: 'Held trunk', status: 'ready' });
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, { 'src/held.js': 'exports.h = 1;\n', 'test/held.test.js': "require('node:test')('held',()=>{});\n" }, 'feat: held'); }) });
  ok(await pump(p, () => task(p, t3.id).status === 'review'), 'a third task in review');
  const other = path.join(tmpRoot, 'main-elsewhere');
  git(p, 'worktree', 'add', '-q', other, 'main');
  const mainNow = git(p, 'rev-parse', 'main');
  const held = await errOf(() => D.approveTask(p, t3.id));
  ok(/checked out in/.test(held) && git(p, 'rev-parse', 'main') === mainNow && task(p, t3.id).status === 'review', 'a trunk checked out in another worktree is not moved from under it', held);
  D.resetDeliveryForTest();
}

console.log('\n-- the board setting: auto-land low risk (off by default) --');
{
  fresh();
  const p = makeProject();
  const runner = makeRunner(async (spec) => { work(spec, { 'src/tiny.js': 'exports.t = 1;\n', 'test/tiny.test.js': "require('node:test')('tiny',()=>{});\n" }, 'feat: tiny'); });
  D.configureDelivery({ runner });
  await D.setDispatch(p, 'start');
  const t1 = await D.createTask(p, { title: 'Tiny', status: 'ready' });
  ok(await pump(p, () => task(p, t1.id).status === 'review'), 'with autoLandLowRisk off a low-risk task still waits for a person', task(p, t1.id));
  ok(task(p, t1.id).risk.level === 'low' && !fs.existsSync(path.join(p, 'src/tiny.js')), 'it is low risk and the trunk did not move');
  await D.approveTask(p, t1.id);
  D.setBoardSettings(p, { autoLandLowRisk: true });
  const t2 = await D.createTask(p, { title: 'Tiny two', status: 'ready' });
  const runner2 = makeRunner(async (spec) => { work(spec, { 'src/tiny2.js': 'exports.t = 2;\n', 'test/tiny2.test.js': "require('node:test')('tiny2',()=>{});\n" }, 'feat: tiny two'); });
  D.configureDelivery({ runner: runner2 });
  ok(await pump(p, () => task(p, t2.id).status === 'merged'), 'with the setting on, low risk + green checks lands by itself', task(p, t2.id));
  ok(task(p, t2.id).review.comments.some(c => /autoLandLowRisk/.test(c.text)), 'and says so');
  // A risky one never auto-lands.
  const t3 = await D.createTask(p, { title: 'Weakens a test', status: 'ready' });
  const runner3 = makeRunner(async (spec) => { fs.rmSync(path.join(spec.cwd, 'test/a.test.js')); work(spec, { 'src/a.js': 'exports.a = () => 2;\n' }, 'feat: a'); });
  D.configureDelivery({ runner: runner3 });
  ok(await pump(p, () => task(p, t3.id).status === 'review'), 'a change that deletes a test goes to review even with auto-land on', task(p, t3.id).status);
  ok(task(p, t3.id).risk.level !== 'low' && task(p, t3.id).risk.reasons.some(r => /weakened tests/.test(r)), 'it is not low risk, and the reason names the test', task(p, t3.id).risk);
}

console.log('\n-- risk score --');
{
  fresh();
  const p = makeProject();
  const wt = path.join(tmpRoot, 'risk-wt');
  git(p, 'worktree', 'add', '-q', '-b', 'risk-branch', wt, 'main');
  const base = git(p, 'rev-parse', 'main');
  fs.writeFileSync(path.join(wt, 'src/a.js'), 'exports.a = () => 1;\nexports.token = "' + 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' + '";\n'); // standards-allow: secret
  fs.rmSync(path.join(wt, 'test/a.test.js'));
  git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'feat: risky');
  const risk = await assessRisk({ project: p, worktree: wt, base, stats: await deliveryNumstat(wt, base) });
  ok(risk.level !== 'low' && risk.score >= 40, 'a deleted test plus a secret-looking token is not low risk', risk);
  ok(risk.reasons.some(r => /weakened tests/.test(r)) && risk.reasons.some(r => /secret/.test(r)), 'the reasons name both', risk.reasons);
  ok(!JSON.stringify(risk).includes('ghp_a1B2'), 'the secret value is never in the result');
  const wt2 = path.join(tmpRoot, 'risk-wt2');
  git(p, 'worktree', 'add', '-q', '-b', 'risk-branch2', wt2, 'main');
  fs.writeFileSync(path.join(wt2, 'src/b.js'), 'exports.b = () => 5;\n'); fs.writeFileSync(path.join(wt2, 'test/b.test.js'), "require('node:test')('b',()=>{});\n");
  git(wt2, 'add', '-A'); git(wt2, 'commit', '-q', '-m', 'feat: small');
  const small = await assessRisk({ project: p, worktree: wt2, base, stats: await deliveryNumstat(wt2, base) });
  ok(small.level === 'low' && small.score < 25, 'a small change with its test is low risk', small);
}

console.log('\n-- conflict-aware scheduling units --');
{
  ok(touchOverlap({ files: ['a.js', 'b.js'], symbols: [], predicted: true }, { files: ['B.js'], symbols: [], predicted: false }) === 'B.js', 'overlap is case-insensitive on file names');
  ok(touchOverlap({ files: [], symbols: [], predicted: true }, { files: ['b.js'], symbols: [], predicted: true }) === undefined, 'an empty prediction blocks nothing');
  const p = makeProject({ 'src/auth/login.js': 'exports.login = () => 1;\n', 'src/auth/token.js': 'exports.mintToken = () => 1;\n' });
  const dir = await predictTouches(p, { title: 'Harden login', body: 'see src/auth', acceptance: [], labels: ['src/auth'] }, { graph: false });
  ok(dir.predicted === true && dir.files.length === 0, 'without a graph a folder label predicts nothing it cannot see (graph:false)', dir);
  const file = await predictTouches(p, { title: 'Fix src/b.js and README.md', body: '', acceptance: ['src/a.js stays'], labels: [] }, { graph: false });
  ok(file.files.join() === 'README.md,src/a.js,src/b.js', 'paths named in the text that exist are predicted', file.files);
  const viaGraph = await predictTouches(p, { title: 'Rotate the mintToken secret', body: '', acceptance: [], labels: ['src/auth'] });
  ok(viaGraph.files.includes('src/auth/login.js') && viaGraph.files.includes('src/auth/token.js'), 'the code graph expands a folder label and finds a named exported symbol', viaGraph);
}

console.log('\n-- lease expiry and restart --');
{
  fresh();
  const p = makeProject();
  const hold = makeRunner(async () => { await new Promise(() => {}); });
  D.configureDelivery({ runner: hold });
  const t = await D.createTask(p, { title: 'Held', status: 'ready' });
  await D.setDispatch(p, 'start');
  ok(task(p, t.id).status === 'running' && task(p, t.id).claim, 'running with a claim');
  await D.setDispatch(p, 'pause');   // else the dispatcher would start it again the moment it is ready
  // The process dies: in-memory state is gone, the journal is not.
  D.resetDeliveryForTest();
  D.configureDelivery({ runner: makeRunner(async () => { await new Promise(() => {}); }) });
  await D.tick(p);
  ok(task(p, t.id).status === 'running', 'a claim whose lease has not run out is left alone after a restart');
  D.configureDelivery({ now: () => Date.now() + 10 * 60_000 });
  await D.tick(p);
  ok(task(p, t.id).status === 'ready' && !task(p, t.id).claim, 'once the lease has run out the task goes back to ready', task(p, t.id));
  ok(fs.existsSync(task(p, t.id).worktree) && task(p, t.id).review.comments.some(c => /lease/.test(c.text)), 'its worktree and commits are kept, and the board says why');
  // Boot: a dispatcher that was running comes back paused.
  D.resetDeliveryForTest();
  S.setDispatcher(p, 'running');
  await D.bootDelivery();
  ok(D.boardState(p).dispatcher === 'paused', 'a restart pauses a dispatcher that was running (a restart is not a person\'s yes to spend)');
  D.resetDeliveryForTest();
}

console.log('\n-- run ends without finishing: blocked, never silently lost --');
{
  fresh();
  const p = makeProject();
  D.configureDelivery({ runner: makeRunner(async () => { throw new Error('spend ceiling reached'); }) });
  const t = await D.createTask(p, { title: 'Dies', status: 'ready' });
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => task(p, t.id).status === 'blocked'), 'a failed run blocks the task', task(p, t.id).status);
  ok(task(p, t.id).review.comments.some(c => /spend ceiling reached/.test(c.text)) && fs.existsSync(task(p, t.id).worktree), 'with the reason, and the worktree kept');
  const none = await D.createTask(p, { title: 'Does nothing', status: 'ready' });
  D.configureDelivery({ runner: makeRunner(async () => { /* finishes, changes nothing */ }) });
  ok(await pump(p, () => task(p, none.id).status === 'blocked'), 'a run that finishes without a change is blocked, not reviewed', task(p, none.id).status);
  ok(task(p, none.id).review.comments.some(c => /nothing to review|no commits/.test(c.text)), 'and says so');
}

console.log('\n-- hygiene: cancel and the orphan sweep --');
{
  fresh();
  const p = makeProject();
  const runner = makeRunner(async () => { await new Promise(() => {}); });
  D.configureDelivery({ runner });
  const t = await D.createTask(p, { title: 'Cancelled soon', status: 'ready' });
  await D.setDispatch(p, 'start');
  const wt = task(p, t.id).worktree; const br = task(p, t.id).branch;
  fs.writeFileSync(path.join(wt, 'src/wip.js'), 'work in progress\n');
  const cancelled = await D.updateTask(p, t.id, { status: 'cancelled' }, 'person');
  ok(cancelled.status === 'cancelled' && !fs.existsSync(wt), 'cancel stops the run and removes the worktree');
  ok(runner.started[0] && (await sleep(5), runner.poll(runner.started[0].id).state === 'ended'), 'and stops the agent');
  ok(gitOk(p, 'rev-parse', '--verify', br) && git(p, 'show', `${br}:src/wip.js`).includes('work in progress'), 'unmerged work in progress is committed to the branch and the branch is kept, never discarded');
  ok(cancelled.review.comments.some(c => /kept/.test(c.text)), 'the board names the kept branch');
  ok(fs.existsSync(path.join(p, 'node_modules', '.bin')), 'and cancelling did not touch the project node_modules either');
  const empty = await D.createTask(p, { title: 'Cancelled clean', status: 'ready' });
  const runner2 = makeRunner(async () => { await new Promise(() => {}); });
  D.configureDelivery({ runner: runner2 });
  await D.tick(p);
  const e = task(p, empty.id);
  await D.updateTask(p, empty.id, { status: 'cancelled' }, 'person');
  ok(!fs.existsSync(e.worktree) && !gitOk(p, 'rev-parse', '--verify', e.branch), 'a cancelled task with nothing on its branch loses worktree and branch');
  ok(/cannot change/.test(await errOf(() => D.updateTask(p, empty.id, { title: 'x' }))), 'a cancelled task is final');

  // The sweep: an aico/task-* worktree no live task owns is removed; a live task's is not.
  const orphan = path.join(D.worktreesRoot(), (await import('node:path')).default.basename(path.dirname(task(p, t.id).worktree ?? D.worktreePath(p, 'deadbeef'))), 'deadbeef');
  git(p, 'worktree', 'add', '-q', '-b', 'aico/task-deadbeef', orphan, 'main');
  const liveTask = await D.createTask(p, { title: 'Live', status: 'ready' });
  D.configureDelivery({ runner: makeRunner(async () => { await new Promise(() => {}); }) });
  await D.tick(p);
  const liveWt = task(p, liveTask.id).worktree;
  const removed = await D.sweep(p);
  ok(removed.some(r => r.endsWith('deadbeef')) && !fs.existsSync(orphan) && !gitOk(p, 'rev-parse', '--verify', 'aico/task-deadbeef'), 'the sweep removes an orphaned task worktree and its (empty) branch', removed);
  ok(fs.existsSync(liveWt), 'and leaves a live task\'s worktree alone');
  await D.updateTask(p, liveTask.id, { status: 'cancelled' }, 'person');
  D.resetDeliveryForTest();
}

console.log('\n-- never pushes --');
{
  fresh();
  const p = makeProject();
  const remote = path.join(tmpRoot, 'remote.git');
  git(tmpRoot, 'init', '-q', '--bare', remote);
  git(p, 'remote', 'add', 'origin', remote);
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, { 'src/n.js': 'exports.n = 1;\n', 'test/n.test.js': "require('node:test')('n',()=>{});\n" }, 'feat: n'); }) });
  const t = await D.createTask(p, { title: 'No push', status: 'ready' });
  await D.setDispatch(p, 'start');
  await pump(p, () => task(p, t.id).status === 'review');
  await D.approveTask(p, t.id);
  ok(task(p, t.id).status === 'merged', 'a full flow ran');
  ok(git(remote, 'for-each-ref') === '' && git(p, 'branch', '-r') === '', 'the remote received nothing: no branch, no tag, no push');
  const src = ['index', 'git', 'store', 'runner', 'verify', 'risk', 'touches', 'prompts', 'paths', 'release', 'env', 'exec', 'config'].map(f => fs.readFileSync(path.resolve(`src/delivery/${f}.ts`), 'utf8')).join('\n');
  ok(!/\[\s*'(push|fetch|pull|remote|clone)'/.test(src) && !/git\(\s*\[\s*'(push|fetch|pull)'/.test(src), 'no module of src/delivery runs git push, fetch, pull, remote or clone');
  // The in-loop guard on a task's run.
  ok(deliveryRunDenial('Git', { action: 'push' }, undefined) && deliveryRunDenial('Git', { action: 'pr' }, undefined), 'the Git tool\'s push and pr are refused for a task\'s run');
  ok(deliveryRunDenial('Bash', {}, 'git push origin main') && deliveryRunDenial('Bash', {}, 'cd x && git -C y merge feature') && deliveryRunDenial('Bash', {}, 'git switch main') && deliveryRunDenial('Bash', {}, 'git worktree remove .'), 'push / merge / switch / worktree in a shell are refused');
  ok(!deliveryRunDenial('Bash', {}, 'git commit -m "feat: x"') && !deliveryRunDenial('Bash', {}, 'git status --short') && !deliveryRunDenial('Bash', {}, 'git checkout -- src/a.js') && !deliveryRunDenial('Bash', {}, 'npm test') && !deliveryRunDenial('Git', { action: 'commit' }, undefined), 'commit, status, restore and tests are not');
  ok(isDeliveryWorktree(path.join(D.worktreesRoot(), 'k', 'abcd1234', 'src')) && !isDeliveryWorktree(p) && !isDeliveryWorktree(D.worktreesRoot()), 'the guard recognises task worktrees by path');
  D.resetDeliveryForTest();
}

console.log('\n-- routes: the human gate, projects, ids --');
{
  fresh();
  const p = makeProject();
  const gate = new DecisionGate();
  const calls = [];
  const mkReq = (method, headers = {}) => ({ method, headers, on() {} });
  const mkRes = () => ({ headers: {}, written: [], write(x) { this.written.push(x); } });
  const deps = (over = {}) => ({
    send: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body ?? {},
    isKnownProject: async (d) => path.resolve(d) === p,
    human: (req, body) => gate.checkHuman({ grant: req.headers['x-aico-grant'], client: body.client, uiKey: req.headers['x-aico-ui-key'], fetchSite: undefined }),
    startPlan: async (project, brief) => { calls.push({ project, brief }); return { sessionId: 'plan-1' }; },
    subscribe: () => () => {},
    ...over,
  });
  const call = async (route, method, body = {}, { person = false, query = '' } = {}) => {
    const req = mkReq(method, person ? { 'x-aico-ui-key': gate.uiKey } : {}); req.body = body;
    const res = mkRes();
    const handled = await handleDeliveryRoute(route, req, res, new URL(`http://127.0.0.1/api/${route}${query}`), deps());
    return { handled, status: res.status, body: res.body, res };
  };
  const t = await D.createTask(p, { title: 'Gate me', status: 'ready' });
  ok((await call('delivery/board', 'GET', {}, { query: `?project=${encodeURIComponent(p)}` })).body.tasks.length === 1, 'GET board with the token');
  ok((await call('delivery/board', 'GET', {}, { query: '?project=' + encodeURIComponent(os.tmpdir()) })).status === 403, 'a folder that is not a registered project is refused');
  ok((await call('delivery/board', 'GET')).status === 400, 'project is required');
  ok((await call('delivery/nope', 'GET')).status === 404 && (await call('other/route', 'GET')).handled === false, 'unknown delivery routes 404; other routes are not claimed');
  const created = await call('delivery/tasks', 'POST', { project: p, title: 'Via route', acceptance: ['x'] });
  ok(created.status === 200 && created.body.status === 'backlog' && created.body.title === 'Via route', 'POST tasks creates in the backlog with the token alone');
  const patched = await call(`delivery/tasks/${created.body.id}`, 'PATCH', { project: p, status: 'ready', priority: 1 });
  ok(patched.status === 200 && patched.body.status === 'ready' && patched.body.priority === 1, 'PATCH edits fields and status');
  ok((await call(`delivery/tasks/${created.body.id}`, 'PATCH', { project: p, status: 'merged' })).status === 400, 'PATCH cannot set an engine-owned status');
  ok((await call('delivery/tasks/not-an-id', 'PATCH', { project: p })).status === 400 && (await call('delivery/tasks/../../x', 'PATCH', { project: p })).status === 400, 'a task id is validated before it reaches a path');
  ok((await call(`delivery/tasks/${'0'.repeat(8)}`, 'PATCH', { project: p, title: 'x' })).status === 404, 'an unknown task 404s');
  ok((await call('delivery/plan', 'POST', { project: p, brief: 'Build the thing' })).body.sessionId === 'plan-1' && calls[0].brief === 'Build the thing', 'plan starts a planning turn and returns its session id');
  ok((await call('delivery/plan', 'POST', { project: p, brief: ' ' })).status === 400, 'plan needs a brief');

  // The three acts that need a person: the token alone is refused, and nothing changes.
  const mainBefore = git(p, 'rev-parse', 'main');
  const start = await call('delivery/dispatch', 'POST', { project: p, action: 'start' });
  ok(start.status === 403 && start.body.code === 'human-required' && D.boardState(p).dispatcher === 'idle', 'dispatch start with only the token is refused and starts nothing', start.body);
  const raise = await call('delivery/dispatch', 'POST', { project: p, action: 'pause', maxParallel: 4 });
  ok(raise.status === 403, 'raising maxParallel is spending: refused with only the token');
  const approve = await call(`delivery/tasks/${t.id}/approve`, 'POST', { project: p });
  ok(approve.status === 403 && approve.body.code === 'human-required', 'approve with only the token is refused (before it looks at the task)', approve.body);
  const changes = await call(`delivery/tasks/${t.id}/request-changes`, 'POST', { project: p, comment: 'no' });
  ok(changes.status === 403 && changes.body.code === 'human-required', 'request-changes with only the token is refused');
  ok(git(p, 'rev-parse', 'main') === mainBefore && D.boardState(p).dispatcher === 'idle', 'the trunk and the dispatcher are untouched by the refusals');
  const forged = await call('delivery/dispatch', 'POST', { project: p, action: 'start', client: 'made-up' });
  ok(forged.status === 403, 'a made-up client nonce is not a person');
  // A person (the UI key) can.
  D.configureDelivery({ runner: makeRunner(async () => { await new Promise(() => {}); }) });
  const person = await call('delivery/dispatch', 'POST', { project: p, action: 'start', maxParallel: 3 }, { person: true });
  ok(person.status === 200 && person.body.dispatcher === 'running' && person.body.settings.maxParallel === 3, 'a person can start the dispatcher', person.body);
  const pause = await call('delivery/dispatch', 'POST', { project: p, action: 'pause' });
  ok(pause.status === 200 && pause.body.dispatcher === 'paused', 'pausing needs only the token (refusing to spend is always safe)');
  ok((await call('delivery/dispatch', 'POST', { project: p, action: 'sideways' }, { person: true })).status === 400, 'an unknown dispatch action is refused');
  const notReview = await call(`delivery/tasks/${t.id}/approve`, 'POST', { project: p }, { person: true });
  ok(notReview.status === 409 && /review/.test(notReview.body.error), 'a person approving a task that is not in review gets a clear 409', notReview.body);
  // The desktop mints a grant for exactly these routes.
  const proto = fs.readFileSync(path.resolve('desktop/electron/protocol.ts'), 'utf8');
  ok(/'\/api\/delivery\/dispatch'/.test(proto) && /HUMAN_ROUTE_PATTERNS/.test(proto) && /approve\|request-changes/.test(proto), 'the desktop\'s HUMAN_ROUTES covers dispatch, approve and request-changes');
  const re = new RegExp(proto.match(/HUMAN_ROUTE_PATTERNS = \[(.*)\];/)[1].slice(1, -1).replace(/\\\//g, '/'));
  ok(re.test('/api/delivery/tasks/0123abcd/approve') && re.test('/api/delivery/tasks/0123abcd/request-changes') && !re.test('/api/delivery/tasks/0123abcd/diff') && !re.test('/api/delivery/tasks/x/approve'), 'the pattern matches those two verbs on a real id and nothing else');
  D.resetDeliveryForTest();
}

console.log('\n-- the Delivery tool --');
{
  fresh();
  const p = makeProject();
  const names = toolDefinitions.map(t => t.name);
  const group = TOOL_GROUPS.find(g => g.id === 'delivery');
  ok(names.includes('Delivery') && group && group.tools.join() === 'Delivery', 'Delivery is a registered tool in the deferred group "delivery"');
  ok(groupsForRequest('break this into tasks for the backlog').includes('delivery') && groupsForRequest('add it to the sprint').includes('delivery') && groupsForRequest('delivery task abc').includes('delivery') && !groupsForRequest('fix the login bug').includes('delivery'), 'words like backlog, sprint and "delivery task" load the group; a plain request does not');
  ok(groupsForRequest(deliveryRunPrompt({ id: 'abcd1234', title: 't', body: '', acceptance: [], review: undefined }, 'main')).includes('delivery'), 'a task run\'s prompt loads the group from its first message');
  ok(/delivery board/i.test(deliveryDefinition.description) && /submit/.test(deliveryDefinition.description) && deliveryDefinition.inputSchema.properties.action.enum.includes('submit'), 'the definition describes both uses');
  const asPlanner = (fn) => runInContext({ cwd: p }, fn);
  const made = await asPlanner(() => deliveryTool({ action: 'create', title: 'Planned', body: 'b', acceptance: ['c1'], priority: 2, labels: ['src/a.js'] }));
  ok(/Created task [a-f0-9]{8} in the backlog/.test(made), 'create lands in the backlog', made);
  const id = /task ([a-f0-9]{8})/.exec(made)[1];
  ok(task(p, id).status === 'backlog', 'the board has it');
  const second = await asPlanner(() => deliveryTool({ action: 'create', title: 'Planned two', dependsOn: ['Planned'] }));
  ok(task(p, /task ([a-f0-9]{8})/.exec(second)[1]).dependsOn[0] === id, 'a planner can refer to an earlier task by title');
  ok(/only a person/i.test(await asPlanner(() => deliveryTool({ action: 'update', id, status: 'ready' }))), 'an agent cannot make a task ready');
  ok(/Updated/.test(await asPlanner(() => deliveryTool({ action: 'update', id, priority: 1, status: 'blocked' }))) && task(p, id).status === 'blocked', 'it can edit and block');
  ok(/backlog or blocked/.test(await asPlanner(async () => { await D.updateTask(p, id, { status: 'backlog' }); await D.updateTask(p, id, { status: 'ready' }); return deliveryTool({ action: 'update', id, status: 'cancelled' }); })), 'an agent cannot cancel a task that is ready for the dispatcher');
  ok(/for a task's own run/.test(await asPlanner(() => deliveryTool({ action: 'submit' }))), 'submit from the project folder is refused');
  ok((await asPlanner(() => deliveryTool({ action: 'list' }))).includes('Planned') && /Planned/.test(await asPlanner(() => deliveryTool({ action: 'get', id }))), 'list and get');
  // From inside a worktree: only that task.
  D.configureDelivery({ runner: makeRunner(async () => { await new Promise(() => {}); }) });
  await D.updateTask(p, id, { status: 'ready' });
  const other = await D.createTask(p, { title: 'Other', status: 'ready' });
  S.setSettings(p, { maxParallel: 2 });
  await D.setDispatch(p, 'start');
  const mine = task(p, id); const theirs = task(p, other.id);
  const inRun = (cwd, fn) => runInContext({ cwd }, fn);
  ok(mine.status === 'running' && theirs.status === 'running', 'two tasks are running');
  ok(/cannot submit/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'submit', id: other.id }))), 'one run cannot submit another task');
  ok(/cannot create or edit/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'create', title: 'sneaky' }))) && /cannot create or edit/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'update', id, status: 'ready' }))), 'a run cannot create or edit tasks');
  ok(/no commits/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'submit', summary: 'nothing' }))), 'submitting with nothing committed is refused with the fix named');
  ok(/Recorded 1/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'touched', files: ['src/a.js'] }))) && task(p, id).touches.predicted === false, 'touched records actual files');
  ok(/Noted/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'progress', note: 'half done' }))) && task(p, id).review.comments.some(c => /half done/.test(c.text)), 'progress is noted on the task');
  fs.writeFileSync(path.join(mine.worktree, 'src/a.js'), 'exports.a = () => 100;\n');
  git(mine.worktree, 'add', '-A'); git(mine.worktree, 'commit', '-q', '-m', 'feat: a');
  const submitted = await inRun(path.join(mine.worktree, 'src'), () => deliveryTool({ action: 'submit', summary: 'done' }));
  ok(/Submitted task/.test(submitted), 'submit works from the task\'s own worktree (even a subfolder of it)', submitted);
  ok(await pump(p, () => task(p, id).status === 'review'), 'and the queue prepares it for review');
  ok(/running with a claim|is review|only a running/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'submit' }))), 'a second submit is refused');
  ok(/Do your task|cannot create/.test(await inRun(mine.worktree, () => deliveryTool({ action: 'create', title: 'x' }))), 'still no creating from a worktree');
  await D.updateTask(p, other.id, { status: 'cancelled' }, 'person');
  D.resetDeliveryForTest();
}

console.log('\n-- a real background agent delivers a task through the loop (stub model) --');
{
  fresh();
  const p = makeProject();
  const stub = await startStubModel(async (body) => {
    const messages = body.messages ?? [];
    const first = textOf(messages.find(m => m.role === 'user'));
    if (!/delivery task/.test(first)) return { text: 'ok' };
    const wt = /Work only in this directory[^\n]*/.exec(first) ? first : first;
    void wt;
    const tools = (body.tools ?? []).map(t => t.function?.name ?? t.name);
    const toolResults = messages.filter(m => m.role === 'tool').length;
    const cwdMatch = /branch (aico\/task-[a-f0-9]{8})/.exec(first);
    const steps = messages.filter(m => m.role === 'assistant').length;
    if (steps === 0) {
      // Does the model even see the Delivery tool from its first message? (the prompt names "delivery task")
      return { tools: [{ name: 'Write', args: { file_path: 'src/real.js', content: 'exports.real = true;\n' } }] };
    }
    if (steps === 1) return { tools: [{ name: 'Bash', args: { command: 'git add -A && git commit -q -m "feat: real change"' } }] };
    if (steps === 2) return { tools: [{ name: 'Bash', args: { command: 'git push origin main' } }] };   // must be refused by the guard
    if (steps === 3) return { tools: [{ name: 'Bash', args: { command: 'npm install left-pad' } }] };   // through the linked node_modules: must be refused by the guard
    if (steps === 4) return { tools: [{ name: 'Delivery', args: { action: 'submit', summary: tools.includes('Delivery') ? 'delivered through the loop' : 'no tool' } }] };
    void toolResults; void cwdMatch;
    return { text: 'Submitted.' };
  });
  const settings = stubSettings(stub.url);
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify(settings, null, 2));
  const ownRepo = process.cwd();
  process.chdir(p);
  setBackgroundAgentOpts({ model: 'stub/model', token: 'x', autoApprove: true, verbose: false, settings });
  D.configureDelivery({ runner: undefined });
  const t = await D.createTask(p, { title: 'Real loop', body: 'write src/real.js', status: 'ready', labels: ['src/real.js'] });
  await D.setDispatch(p, 'start');
  const reached = await pump(p, () => task(p, t.id).status === 'review', 90_000);
  ok(reached, 'a real agent run, with the Delivery tool loaded from its first message, submitted the task and it reached review', { status: task(p, t.id).status, comments: task(p, t.id).review?.comments });
  const rt = task(p, t.id);
  ok(rt.review?.comments.some(c => /delivered through the loop/.test(c.text)), 'the Delivery tool was offered to the run and its submit summary is on the task');
  ok(fs.existsSync(path.join(rt.worktree, 'src/real.js')) && !fs.existsSync(path.join(p, 'src/real.js')), 'the agent wrote in its worktree, not the person\'s checkout');
  const sawPushDenied = stub.requests.some(r => (r.messages ?? []).some(m => m.role === 'tool' && /does not push|never pushes/.test(textOf(m))));
  ok(sawPushDenied, 'a `git push` by the run was refused by the guard in the loop');
  const sawInstallDenied = stub.requests.some(r => (r.messages ?? []).some(m => m.role === 'tool' && /is a link to the project's own folder/.test(textOf(m)) && /localise/.test(textOf(m))));
  ok(sawInstallDenied && !fs.existsSync(path.join(p, 'node_modules', 'left-pad')), 'an `npm install` through the linked node_modules was refused in the loop, naming the fix, and wrote nothing into the project');
  ok(git(p, 'rev-parse', 'main') === git(p, 'rev-list', '--max-parents=0', 'main').split('\n')[0] || !fs.existsSync(path.join(p, 'src/real.js')), 'and the trunk has not moved');
  ok(rt.risk && rt.evidence, 'with a risk score and evidence');
  const landed = await D.approveTask(p, t.id);
  ok(landed.status === 'merged' && fs.readFileSync(path.join(p, 'src/real.js'), 'utf8').includes('real'), 'a person approves it and it lands');
  await sleep(100);
  for (const a of getBackgroundAgents()) void a;
  process.chdir(ownRepo);
  await stub.close();
  D.resetDeliveryForTest();
}

// ════════════════════════════════════════════════════════════════════════
// The second half of the plan: batch review, needs-you, stacks, hygiene, releases.
// ════════════════════════════════════════════════════════════════════════

const readSettingsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(process.env.AICO_HOME, 'settings.json'), 'utf8')); } catch { return {}; } };
/** Set (or with `undefined`, remove) the person's own `delivery` settings for the code below. */
function setUserDelivery(delivery) {
  const s = readSettingsFile();
  if (delivery === undefined) delete s.delivery; else s.delivery = delivery;
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify(s, null, 2));
}

/** Create a task, let a scripted run commit `files`, and land it as a person. Returns the merged task. */
async function landOne(p, title, files, message, over = {}) {
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, files, message); }) });
  const t = await D.createTask(p, { title, status: 'ready', ...over });
  await D.setDispatch(p, 'start');
  if (!(await pump(p, () => task(p, t.id)?.status === 'review', 40_000))) throw new Error(`"${title}" did not reach review (${task(p, t.id)?.status})`);
  return D.approveTask(p, t.id);
}

/** Several tasks at once, all left in review. `defs`: { title, files, message, remove?, over? }. */
async function reviewMany(p, defs) {
  const byTitle = new Map(defs.map(d => [d.title, d]));
  D.configureDelivery({
    runner: makeRunner(async (spec) => {
      const d = byTitle.get(spec.title);
      for (const rm of d.remove ?? []) fs.rmSync(path.join(spec.cwd, rm));
      work(spec, d.files, d.message);
    }),
  });
  const ts = [];
  for (const d of defs) ts.push(await D.createTask(p, { title: d.title, status: 'ready', ...(d.over ?? {}) }));
  await D.setDispatch(p, 'start');
  await pump(p, () => ts.every(t => task(p, t.id)?.status === 'review'), 90_000);
  return ts.map(t => task(p, t.id));
}

const lowDef = (name, extra = {}) => ({
  title: `Low ${name}`, files: { [`src/${name}.js`]: `exports.${name} = 1;\n`, [`test/${name}.test.js`]: `require('node:test')('${name}', () => {});\n` },
  message: `feat: ${name}`, ...extra,
});
const mainFiles = (p) => git(p, 'ls-tree', '-r', '--name-only', 'main').split('\n');

console.log('\n-- batch review: low risk and green only, one yes, one at a time --');
{
  fresh();
  fs.rmSync(checkLog, { force: true });
  const p = makeProject();
  const [l1, l2, risky] = await reviewMany(p, [
    lowDef('alpha'), lowDef('beta'),
    { title: 'Weakens a test', remove: ['test/a.test.js'], files: { 'src/a.js': 'exports.a = () => 2;\n' }, message: 'feat: change a' },
  ]);
  ok(l1.status === 'review' && l2.status === 'review' && risky.status === 'review' && l1.risk.level === 'low' && l2.risk.level === 'low' && risky.risk.level !== 'low', 'two low-risk tasks and one that weakens a test are in review', [l1.risk, risky.risk]);
  const before = git(p, 'rev-parse', 'main');
  ok(D.batchBlocker(p, l1) === undefined && /risk/.test(D.batchBlocker(p, risky)) && /only low-risk/.test(D.batchBlocker(p, risky)), 'batchBlocker: low and green may be batched; anything else is refused by name', D.batchBlocker(p, risky));
  const refused = await errOf(() => D.approveBatch(p, [l1.id, risky.id]));
  ok(/nothing was landed/.test(refused) && refused.includes(risky.id) && task(p, l1.id).status === 'review' && git(p, 'rev-parse', 'main') === before, 'a set with one medium/high task is refused whole: nothing lands', refused);
  ok(/at least one/.test(await errOf(() => D.approveBatch(p, []))) && /nothing was landed/.test(await errOf(() => D.approveBatch(p, ['deadbeef']))), 'an empty set and an unknown task are refused');
  ok(/at most/.test(await errOf(() => D.approveBatch(p, Array.from({ length: 26 }, (_, i) => `${String(i).padStart(8, '0')}`)))), 'a batch is capped');
  const res = await D.approveBatch(p, [l1.id, l2.id, l1.id]);
  ok(res.landed.join() === [l1.id, l2.id].join() && res.skipped.length === 0, 'the two low-risk tasks landed, in the order given, duplicates ignored', res);
  ok(task(p, l1.id).status === 'merged' && task(p, l2.id).status === 'merged' && mainFiles(p).includes('src/alpha.js') && mainFiles(p).includes('src/beta.js'), 'both are on the trunk');
  ok(git(p, 'rev-list', '--merges', '--count', 'main') === '0' && git(p, 'log', '--format=%s', '-2') === 'feat: beta\nfeat: alpha', 'a fast-forward each, no merge commit, in order');
  ok(task(p, risky.id).status === 'review', 'the risky one still waits for a person');
  ok(task(p, l1.id).landed && task(p, l1.id).landed.kind === 'feat' && task(p, l1.id).landed.by === 'person' && /^[0-9a-f]{40}$/.test(task(p, l1.id).landed.to), 'what landed and where is recorded for release notes and rollback', task(p, l1.id).landed);
  ok(/not in review/.test(await errOf(() => D.approveBatch(p, [l1.id]))), 'a task that already landed cannot be batched again');

  // The trunk moves while they wait: each is re-checked, a conflict is sent back and the rest still land.
  const [c1, c2, c3] = await reviewMany(p, [
    { title: 'Edits b', files: { 'src/b.js': 'exports.b = () => 20;\n', 'test/b20.test.js': "require('node:test')('b20', () => {});\n" }, message: 'fix: b to 20' },
    lowDef('gamma'), lowDef('delta'),
  ]);
  ok([c1, c2, c3].every(t => t.status === 'review' && t.risk.level === 'low'), 'three more low-risk tasks in review', [c1, c2, c3].map(t => t.risk));
  fs.writeFileSync(path.join(p, 'src/b.js'), 'exports.b = () => 99;\n'); git(p, 'add', '-A'); git(p, 'commit', '-q', '-m', 'fix: b to 99 on the trunk');
  await D.setDispatch(p, 'pause');   // so a task sent back is not started again behind the assertions
  const runsBefore = checkRuns();
  const res2 = await D.approveBatch(p, [c1.id, c2.id, c3.id]);
  ok(res2.landed.join() === [c2.id, c3.id].join() && res2.skipped.length === 1 && res2.skipped[0].id === c1.id && /trunk moved/.test(res2.skipped[0].reason), 'the task that no longer rebases is skipped with the reason; the others land', res2);
  ok(task(p, c1.id).status === 'changes' && task(p, c2.id).status === 'merged' && task(p, c3.id).status === 'merged', 'the conflicting one went back for changes');
  ok(checkRuns() >= runsBefore + 2, 'the trunk had moved, so the landed ones were checked again on their rebased trees', { runsBefore, after: checkRuns() });

  // A checkout that cannot take a landing at all: the first fails, the rest are not attempted, nothing lands.
  const [d1, d2] = await reviewMany(p, [
    { title: 'Reword readme', files: { 'README.md': 'line one\nline two edited\nline three\n', 'test/readme.test.js': "require('node:test')('readme', () => {});\n" }, message: 'docs: reword' },
    lowDef('epsilon'),
  ]);
  fs.writeFileSync(path.join(p, 'README.md'), 'my own uncommitted edit\n');
  const mainNow = git(p, 'rev-parse', 'main');
  const res3 = await D.approveBatch(p, [d1.id, d2.id]);
  ok(res3.landed.length === 0 && res3.skipped.length === 2 && /could not land/.test(res3.skipped[0].reason) && /not attempted/.test(res3.skipped[1].reason) && git(p, 'rev-parse', 'main') === mainNow, 'a checkout that cannot take it stops the batch: nothing landed, the rest were not attempted', res3);
  ok(fs.readFileSync(path.join(p, 'README.md'), 'utf8') === 'my own uncommitted edit\n', 'and the person\'s edit is intact');
  git(p, 'checkout', '--', 'README.md');
  D.resetDeliveryForTest();
}

console.log('\n-- a run that needs a person: the task says so, the chat is its own, the answer is not Delivery\'s --');
{
  fresh();
  const p = makeProject();
  let seen = [];
  const unsubscribe = subscribeToNotifications(list => { seen = list; });
  const gates = new Map();
  const runner = makeRunner(async (spec, id, rec) => {
    rec.need = { kind: 'question', prompt: 'Should a code stack with the sale price?', since: new Date().toISOString() };
    rec.lastActivityAt = Date.now() + 1;
    await new Promise(r => gates.set(spec.taskId, r));
    work(spec, { 'src/need.js': 'exports.need = 1;\n', 'test/need.test.js': "require('node:test')('need', () => {});\n" }, 'feat: need');
  });
  D.configureDelivery({ runner });
  const t = await D.createTask(p, { title: 'Ask me', status: 'ready' });
  await D.setDispatch(p, 'start');
  ok(await pump(p, () => Boolean(task(p, t.id)?.needs)), 'a run waiting for a question puts it on its task', task(p, t.id));
  const n1 = task(p, t.id);
  ok(n1.needs.kind === 'question' && /stack with the sale price/.test(n1.needs.prompt) && Date.parse(n1.needs.since) > 0, 'with the kind, the question and when it began');
  ok(n1.sessionId === 'chat-run-1' && n1.claim.sessionId === 'chat-run-1' && n1.claim.runId === 'run-1', 'the task records the run\'s chat (claim.runId is the run, sessionId is the chat)', n1.claim);
  await pump(p, () => false, 300);
  ok(n1.review.comments.filter(c => /Waiting for you/.test(c.text)).length === 1 && task(p, t.id).review.comments.filter(c => /Waiting for you/.test(c.text)).length === 1, 'the wait is on the thread once, not on every poll');
  ok(seen.some(n => /Task needs you: Ask me/.test(n.title) && n.sourceId === `delivery:${t.id}`), 'a notification went out through the existing plumbing', seen.slice(0, 3).map(n => n.title));
  const att = D.attention();
  ok(att.boards.some(b => b.project === p && b.tasks.some(x => x.id === t.id && x.needs === true && x.kind === 'question')), 'attention() carries the needs flag for a client that raises notifications');
  ok(D.attention(() => false).boards.length === 0, 'and only for projects the caller says are registered');
  // A new, different wait replaces the old one and is told again.
  const rec = runner.runs.get('run-1');
  rec.need = { kind: 'permission', prompt: 'Bash', detail: 'rm -rf build', tool: 'Bash', ref: 'perm-1', since: new Date().toISOString() };
  await pump(p, () => task(p, t.id)?.needs?.kind === 'permission');
  ok(task(p, t.id).needs.ref === 'perm-1' && task(p, t.id).needs.tool === 'Bash', 'a permission card is carried with its id', task(p, t.id).needs);
  // A person answered (in the chat): the wait is lifted and the thread says so.
  delete rec.need;
  rec.lastActivityAt = Date.now() + 5;
  await pump(p, () => !task(p, t.id)?.needs);
  ok(!task(p, t.id).needs && task(p, t.id).review.comments.some(c => /A person responded/.test(c.text)), 'when the wait is over the task says so');
  gates.get(t.id)();
  ok(await pump(p, () => task(p, t.id)?.status === 'review'), 'the run finishes and the task reaches review');
  const r = task(p, t.id);
  ok(r.sessionId === 'chat-run-1' && !r.claim && !r.needs, 'the chat stays on the finished task (so "Session" still opens it); the claim and the wait are gone');
  ok(seen.some(n => /Ready for review: Ask me/.test(n.title)), 'ready-for-review is announced');
  await D.approveTask(p, t.id);
  ok(seen.some(n => /Landed: Ask me/.test(n.title)), 'landing is announced');
  // A wait that is still there when the run ends is cleared with the claim.
  D.configureDelivery({ runner: makeRunner(async (spec, id, rec2) => { rec2.need = { kind: 'approval', prompt: 'deploy: needs a person', ref: 'act-1', since: new Date().toISOString() }; rec2.lastActivityAt = Date.now() + 1; await sleep(200); throw new Error('spend ceiling reached'); }) });
  const f = await D.createTask(p, { title: 'Dies waiting', status: 'ready' });
  ok(await pump(p, () => task(p, f.id)?.status === 'blocked'), 'a run that dies while waiting blocks its task');
  ok(!task(p, f.id).needs && !task(p, f.id).claim && seen.some(n => /Task failed: Dies waiting/.test(n.title)), 'the wait does not outlive the run, and the failure is announced');
  // A runner with no chat (the background-agent fallback) offers no session to open.
  D.configureDelivery({ runner: makeRunner(async (spec) => { work(spec, { 'src/nochat.js': 'exports.n = 1;\n', 'test/nochat.test.js': "require('node:test')('nochat', () => {});\n" }, 'feat: nochat'); }, { sessions: false }) });
  const nc = await D.createTask(p, { title: 'No chat', status: 'ready' });
  ok(await pump(p, () => task(p, nc.id)?.status === 'review') && task(p, nc.id).sessionId === undefined, 'a run with no chat leaves sessionId unset: the UI must not link to the run id');
  unsubscribe();
  D.resetDeliveryForTest();
}

console.log('\n-- the server\'s runner: a task\'s run is a chat session; its limits are enforced by the loop --');
{
  // A fake RunManager says what the real one would, so the mapping and the ceilings are exact and instant.
  const fakeRuns = () => {
    const runs = new Map(); const log = [];
    return {
      log, runs,
      async ensure(id, cwd) { const run = { sessionId: id, cwd, session: { length: 0 }, cost: 0, tokenTracker: { estimateCost() { return run.cost; } } }; runs.set(id, run); return run; },
      rename(id, title) { log.push(['rename', id, title]); return true; },
      get(id) { return runs.get(id); },
      cancel(id) { log.push(['cancel', id]); runs.get(id)?.reject?.(new Error('cancelled')); return true; },
      submit(id, cwd, prompt, model, opts) { log.push(['submit', id, opts]); return new Promise((resolve, reject) => { const run = runs.get(id); run.resolve = resolve; run.reject = reject; }); },
    };
  };
  let clock = 1_000_000;
  const mk = (runs) => deliverySessionRunner({ runs, mintSessionId: () => `sess-${++clock}`, model: async () => 'stub/model', settings: async () => ({}), now: () => clock, onSession: (id, cwd) => runs.log.push(['onSession', id, cwd]) });
  const runs = fakeRuns();
  const runner = mk(runs);
  const spec = { taskId: 'abcd1234', title: 'Build the thing', prompt: 'do it', cwd: '/tmp/wt', budgetUsd: 1, deadlineMs: 60_000 };
  const id = runner.start(spec);
  await sleep(20);
  ok(runner.poll(id).sessionId === id && runs.log.some(l => l[0] === 'onSession' && l[1] === id) && runs.log.some(l => l[0] === 'rename' && /Task: Build the thing/.test(l[2])), 'the run id IS the chat session id; the server is told where it lives; the chat is titled for the task');
  ok(runs.log.some(l => l[0] === 'submit' && l[2].autonomy === 'L4'), 'it runs unattended at L4: what needs a person is parked, not run');
  ok(runner.poll(id).state === 'running' && !runner.poll(id).need, 'running, waiting for no one');
  const run = runs.get(id);
  run.pendingQuestion = { question: 'Which colour?', resolve() {}, at: Date.now() };
  ok(runner.poll(id).need.kind === 'question' && runner.poll(id).need.prompt === 'Which colour?', 'a pending AskUser question is the run\'s need');
  delete run.pendingQuestion;
  run.pendingPermission = { id: 'perm-9', tool: 'Bash', detail: 'npm publish', resolve() {}, at: Date.now() };
  const perm = runner.poll(id).need;
  ok(perm.kind === 'permission' && perm.ref === 'perm-9' && perm.tool === 'Bash' && perm.detail === 'npm publish', 'a permission card is the run\'s need, with the id to answer');
  delete run.pendingPermission;
  // A call parked in the approve-later inbox for THIS session.
  const toolDir = path.join(process.env.AICO_HOME, 'tools', 'ops');
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, 'ship_it.tool.json'), JSON.stringify({
    name: 'ship_it', description: 'Ship.', input_schema: { type: 'object', properties: { release: { type: 'string', pattern: '^[a-z]+$' } }, required: ['release'], additionalProperties: false },
    run: { argv: [process.execPath, '-e', 'console.log(1)'] }, effect: 'destructive',
  }));
  const shipIt = (await loadCustomTools(process.cwd())).find(t => t.name === 'ship_it');
  setToolEnabled(shipIt, true);
  const parkedOther = parkAction({ tool: shipIt, args: { release: 'web' }, why: 'destructive', cwd: '/tmp/wt', agentId: 'x', origin: 'chat', sessionId: 'someone-else' });
  ok(!runner.poll(id).need, 'a call parked by another session is not this run\'s need');
  const parked = parkAction({ tool: shipIt, args: { release: 'web' }, why: 'destructive — a person approves every call', cwd: '/tmp/wt', agentId: 'x', origin: 'chat', sessionId: id });
  const ap = runner.poll(id).need;
  ok(ap.kind === 'approval' && ap.ref === parked.id && /ship_it/.test(ap.prompt), 'a call parked for this session is the run\'s need (answered through the inbox)', ap);
  denyAction(parked.id, 'test'); denyAction(parkedOther.id, 'test');
  ok(!runner.poll(id).need, 'and it is gone once decided');
  // Ceilings.
  run.cost = 1.5;
  runner.poll(id);
  ok(runs.log.some(l => l[0] === 'cancel' && l[1] === id), 'past its spend ceiling the run is cancelled by the loop that watches it');
  await sleep(20);
  const ended = runner.poll(id);
  ok(ended.state === 'ended' && ended.ok === false && /spend ceiling reached \(\$1\.50 of \$1\.00\)/.test(ended.error), 'and reported as failed with the reason', ended);
  const id2 = runner.start({ ...spec, budgetUsd: 0 });
  await sleep(20);
  clock += 61_000;
  runner.poll(id2);
  await sleep(20);
  ok(runner.poll(id2).ok === false && /deadline reached \(1 minutes\)/.test(runner.poll(id2).error), 'a deadline stops it too');
  const id3 = runner.start(spec);
  await sleep(20);
  runs.get(id3).resolve('all done');
  await sleep(20);
  const done = runner.poll(id3);
  ok(done.state === 'ended' && done.ok === true && done.result === 'all done', 'a run that finishes reports its answer');
  const id4 = runner.start(spec);
  await sleep(20);
  runner.stop(id4);
  await sleep(20);
  ok(runner.poll(id4).ok === false && /stopped/.test(runner.poll(id4).error), 'stop() ends it as stopped');
  ok(runner.poll('nope').state === 'gone', 'an unknown run is gone');
  D.resetDeliveryForTest();
}

console.log('\n-- a task\'s run in a REAL chat session (stub model): its own question, answered in its own chat --');
{
  fresh();
  const p = makeProject();
  const asked = [];
  const stub = await startStubModel(async (body) => {
    const messages = body.messages ?? [];
    const first = textOf(messages.find(m => m.role === 'user'));
    if (!/delivery task/.test(first)) return { text: 'ok' };
    const who = /Task: (Ask [AB])/.exec(first)?.[1] ?? '?';
    const steps = messages.filter(m => m.role === 'assistant').length;
    if (steps === 0) { asked.push(who); return { tools: [{ name: 'AskUserQuestion', args: { question: `${who}: which colour?` } }] }; }
    if (steps === 1) {
      const answer = textOf([...messages].reverse().find(m => m.role === 'tool'));
      return { tools: [{ name: 'Write', args: { file_path: `src/${who.replace(' ', '-').toLowerCase()}.js`, content: `// ${answer}\nexports.c = ${JSON.stringify(answer)};\n` } }] };
    }
    if (steps === 2) return { tools: [{ name: 'Bash', args: { command: 'git add -A && git commit -q -m "feat: colour"' } }] };
    if (steps === 3) return { tools: [{ name: 'Delivery', args: { action: 'submit', summary: 'asked and answered' } }] };
    return { text: 'Submitted.' };
  });
  const settings = stubSettings(stub.url);
  fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify(settings, null, 2));
  const ownRepo = process.cwd();
  process.chdir(p);   // a project of ours is the server's launch directory, as for the real server (its config is judged for trust)
  const hub = new EventHub();
  const runs = new RunManager(hub, settings);
  runs.defaultModel = async () => 'stub/model';
  D.configureDelivery({
    runner: deliverySessionRunner({ runs, mintSessionId: () => crypto.randomUUID(), model: async () => 'stub/model', settings: async () => settings }),
    budgetUsd: () => 5,
  });
  const a = await D.createTask(p, { title: 'Ask A', body: 'ask a question', status: 'ready', labels: ['src/ask-a.js'] });
  const b = await D.createTask(p, { title: 'Ask B', body: 'ask a question', status: 'ready', labels: ['src/ask-b.js'] });
  await D.setDispatch(p, 'start', 2);
  ok(await pump(p, () => task(p, a.id)?.needs && task(p, b.id)?.needs, 90_000), 'both runs are held in chat sessions and each reports its own question', [task(p, a.id), task(p, b.id)].map(t => ({ status: t?.status, needs: t?.needs?.prompt, comments: t?.review?.comments?.map(c => c.text.slice(0, 200)) })));
  const ta = task(p, a.id); const tb = task(p, b.id);
  ok(ta.sessionId && tb.sessionId && ta.sessionId !== tb.sessionId && ta.claim.sessionId === ta.sessionId && ta.claim.runId === ta.sessionId, 'each task\'s run id is its own chat session id');
  ok(/Ask A: which colour/.test(ta.needs.prompt) && /Ask B: which colour/.test(tb.needs.prompt), 'two concurrent runs did not swap questions (AskUser is per run)', [ta.needs.prompt, tb.needs.prompt]);
  ok(runs.get(ta.sessionId).session.events.some(e => e.type === 'user/message' || e.type === 'turn/start' || JSON.stringify(e).includes('delivery task')), 'the run is in a real session log: the task prompt is in it');
  ok(D.sessionDirOf(ta.sessionId) === ta.worktree && !fs.existsSync(path.join(ta.worktree, 'src/ask-a.js')), 'the server can find the chat\'s folder (the task\'s worktree) by its id');
  // Answer B only: A keeps waiting.
  ok(runs.answer(tb.sessionId, 'teal'), 'the answer goes through the chat\'s own route');
  ok(await pump(p, () => task(p, b.id)?.status === 'review', 90_000), 'B finishes after its answer', task(p, b.id)?.status);
  ok(task(p, a.id).status === 'running' && task(p, a.id).needs && /Ask A/.test(task(p, a.id).needs.prompt), 'and A is still waiting for its own');
  ok(fs.readFileSync(path.join(task(p, b.id).worktree, 'src/ask-b.js'), 'utf8').includes('teal') && !fs.existsSync(path.join(task(p, a.id).worktree, 'src/ask-a.js')), 'B used B\'s answer; A has not written anything');
  ok(runs.answer(ta.sessionId, 'amber') && await pump(p, () => task(p, a.id)?.status === 'review', 90_000), 'A finishes after its answer');
  ok(task(p, a.id).review.comments.some(c => /Waiting for you: Ask A: which colour/.test(c.text)) && task(p, a.id).review.comments.some(c => /A person responded/.test(c.text)), 'the thread has the question and that it was answered');
  ok(task(p, a.id).sessionId === ta.sessionId && !task(p, a.id).claim, 'the finished task still points at its chat');
  await D.approveTask(p, a.id); await D.approveTask(p, b.id);
  ok(!fs.existsSync(ta.worktree) && await until(() => D.sessionDirOf(ta.sessionId) === ta.worktree, 10_000), 'once the worktree is gone the chat is still found by its id: its log is in the store, filed under the worktree\'s key');
  ok(D.sessionDirOf('00000000-0000-4000-8000-000000000000') === undefined, 'and an id that belongs to no task finds nothing');
  process.chdir(ownRepo);
  await stub.close();
  D.resetDeliveryForTest();
}

console.log('\n-- a person\'s word and an agent\'s handoff reach the next run --');
{
  fresh();
  const p = makeProject();
  const hold = makeRunner(async () => { await new Promise(() => {}); });
  D.configureDelivery({ runner: hold });
  const a = await D.createTask(p, { title: 'Build the API', status: 'ready', labels: ['src/a.js'] });
  const b = await D.createTask(p, { title: 'Build the client', status: 'ready', dependsOn: [a.id], labels: ['src/b.js'] });
  const c = await D.createTask(p, { title: 'Unrelated', status: 'ready', labels: ['README.md'] });
  S.setSettings(p, { maxParallel: 3 });
  await D.setDispatch(p, 'start');
  const ta = task(p, a.id);
  const inRun = (cwd, fn) => runInContext({ cwd }, fn);
  ok(/Left a note on "Build the client"/.test(await inRun(ta.worktree, () => deliveryTool({ action: 'handoff', to: b.id, note: 'The endpoint is POST /api/items and returns {id}.' }))), 'a run can leave a note for a task that depends on it');
  ok(task(p, b.id).review.comments.some(x => x.by === 'agent' && /Handoff from "Build the API": The endpoint is POST/.test(x.text)), 'on that task\'s thread, as an agent\'s');
  ok(/not connected/.test(await inRun(ta.worktree, () => deliveryTool({ action: 'handoff', to: c.id, note: 'hi' }))), 'not to a task it has no dependency edge with');
  ok(/note required/.test(await inRun(ta.worktree, () => deliveryTool({ action: 'handoff', to: b.id, note: ' ' }))) && /to required/.test(await inRun(ta.worktree, () => deliveryTool({ action: 'handoff', note: 'x' }))), 'a handoff needs a target and a note');
  // A person's comment on a task is a person's: only through the gated route; the next run reads it.
  D.commentTask(p, b.id, 'Use the existing fetch wrapper.', 'person');
  const rerun = deliveryRunPrompt(task(p, b.id), 'main');
  ok(/\[agent\] Handoff from "Build the API"/.test(rerun) && /\[person\] Use the existing fetch wrapper\./.test(rerun), 'a run starting on that task is told both, with who said each');
  ok(/needs some text/.test(await errOf(() => D.commentTask(p, b.id, '  ', 'person'))) && /no task/.test(await errOf(() => D.commentTask(p, 'deadbeef', 'x', 'person'))), 'empty and unknown are refused');
  // Resumed after a lost lease: the prompt of the new run carries the thread.
  await D.setDispatch(p, 'pause');
  D.resetDeliveryForTest();   // the process restarts: no live runs, the journal remains
  D.configureDelivery({ runner: makeRunner(async () => { await new Promise(() => {}); }), now: () => Date.now() + 10 * 60_000 });
  await D.tick(p);
  D.configureDelivery({ now: Date.now });
  ok(task(p, a.id).status === 'ready', 'a run whose lease ran out goes back to ready');
  D.commentTask(p, a.id, 'Remember the rate limit.', 'person');
  const second = makeRunner(async () => { await new Promise(() => {}); });
  D.configureDelivery({ runner: second });
  await D.setDispatch(p, 'start');
  ok(second.started.some(s => s.spec.title === 'Build the API' && /\[person\] Remember the rate limit\./.test(s.spec.prompt)), 'the resumed run\'s prompt carries the person\'s note', second.started.map(s => s.spec.title));
  for (const t of D.boardState(p).tasks) if (['running', 'ready'].includes(t.status)) await D.updateTask(p, t.id, { status: 'cancelled' }, 'person');
  D.resetDeliveryForTest();
}

console.log('\n-- worktrees per stack: what is linked, what is left to global caches, a custom setup, the install guard --');
{
  fresh();
  const hold = () => D.configureDelivery({ runner: makeRunner(async () => { await new Promise(() => {}); }) });
  const startOne = async (p, title = 'Probe') => {
    hold();
    const t = await D.createTask(p, { title, status: 'ready' });
    await D.setDispatch(p, 'start');
    return task(p, t.id);
  };
  const isLink = (x) => { try { return fs.lstatSync(x).isSymbolicLink(); } catch { return false; } };
  const envNote = (t) => (t.review?.comments ?? []).find(c => /^Environment:/.test(c.text))?.text ?? '';

  // Stack detection.
  const detect = (files) => { const d = fs.mkdtempSync(path.join(tmpRoot, 'stack-')); for (const f of files) fs.writeFileSync(path.join(d, f), ''); return DeliveryEnv.detectStacks(d).join(); };
  ok(detect(['package.json']) === 'node' && detect(['pyproject.toml']) === 'python' && detect(['requirements-dev.txt']) === 'python' && detect(['composer.json']) === 'php' && detect(['App.csproj']) === 'dotnet' && detect(['go.mod']) === 'go' && detect(['pom.xml']) === 'java' && detect(['build.gradle.kts']) === 'java' && detect(['Cargo.toml']) === 'rust' && detect(['Gemfile']) === 'ruby' && detect(['package.json', 'go.mod']) === 'node,go' && detect(['README.md']) === '', 'each stack is recognised by its manifest');

  // Node: the existing link.
  const node = makeProject();
  const tn = await startOne(node);
  ok(isLink(path.join(tn.worktree, 'node_modules')) && /node_modules is linked/.test(envNote(tn)) && git(tn.worktree, 'status', '--porcelain') === '', 'Node: node_modules is linked, invisible to git, and the thread says so', envNote(tn));
  ok(/refused until the run calls Delivery "localise"/.test(envNote(tn)), 'and tells the run how an install is done');
  await D.updateTask(node, tn.id, { status: 'cancelled' }, 'person');

  // Python: an existing venv is linked; none is said plainly.
  const py = makeProject({ 'requirements.txt': 'requests\n' });
  fs.mkdirSync(path.join(py, '.venv'), { recursive: true }); fs.writeFileSync(path.join(py, '.venv', 'pyvenv.cfg'), 'home = x\n');
  const tp = await startOne(py);
  ok(isLink(path.join(tp.worktree, '.venv')) && git(tp.worktree, 'status', '--porcelain') === '', 'Python: the project\'s .venv is linked and invisible to git', envNote(tp));
  const py2 = makeProject({ 'requirements.txt': 'requests\n' });
  const tp2 = await startOne(py2);
  ok(!fs.existsSync(path.join(tp2.worktree, '.venv')) && /no virtualenv to link/.test(envNote(tp2)), 'Python without a venv: nothing is invented, the run is told to create one', envNote(tp2));
  // An AICO app declares its own install: the worktree runs it once.
  const app = makeProject({
    'requirements.txt': 'requests\n',
    'app.json': JSON.stringify({ slug: 'py-app', run: { install: 'node install.js', installedMarker: '.venv' } }),
    'install.js': "require('fs').mkdirSync('.venv', { recursive: true }); require('fs').writeFileSync('.venv/ready', 'yes');\n",
  });
  const ta = await startOne(app);
  ok(fs.existsSync(path.join(ta.worktree, '.venv', 'ready')) && !isLink(path.join(ta.worktree, '.venv')) && !fs.existsSync(path.join(app, '.venv')) && /Ran the app's install/.test(envNote(ta)), 'an AICO app\'s own install (app.json run.install) ran in the worktree, not in the project', envNote(ta));
  const bad = makeProject({ 'app.json': JSON.stringify({ slug: 'bad-app', run: { install: 'node -e "process.exit(4)"', installedMarker: 'deps' } }) });
  hold();
  const tbad = await D.createTask(bad, { title: 'Bad install', status: 'ready' });
  await D.setDispatch(bad, 'start');
  ok(task(bad, tbad.id).status === 'blocked' && task(bad, tbad.id).review.comments.some(c => /The run was not started: the app's install failed/.test(c.text)), 'an install that fails blocks the task before any agent is paid for, with the reason', task(bad, tbad.id).review?.comments);

  // PHP.
  const php = makeProject({ 'composer.json': '{}\n' });
  fs.mkdirSync(path.join(php, 'vendor'), { recursive: true }); fs.writeFileSync(path.join(php, 'vendor', 'autoload.php'), '<?php\n');
  const tphp = await startOne(php);
  ok(isLink(path.join(tphp.worktree, 'vendor')), 'PHP: vendor is linked', envNote(tphp));
  // Stacks that use a global cache: nothing linked, and it says why.
  for (const [files, re] of [[{ 'go.mod': 'module x\n' }, /module cache/], [{ 'App.csproj': '<Project/>\n' }, /NuGet/], [{ 'pom.xml': '<project/>\n' }, /\.m2/], [{ 'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\n' }, /cargo/], [{ 'Gemfile': "source 'https://rubygems.org'\n" }, /gems/]]) {
    const q = makeProject(files);
    const tq = await startOne(q);
    ok(re.test(envNote(tq)), `${Object.keys(files)[0]}: left to its global cache, and the thread says so`, envNote(tq));
  }

  // A custom setup command: from the person's own settings it runs at once; from the project's file only once approved.
  const cs = makeProject({ 'setup.js': "require('fs').writeFileSync('setup-ran.txt', process.cwd());\n" });
  setUserDelivery({ worktreeSetup: 'node setup.js' });
  const tcs = await startOne(cs);
  ok(fs.readFileSync(path.join(tcs.worktree, 'setup-ran.txt'), 'utf8').startsWith(tcs.worktree) && !fs.existsSync(path.join(cs, 'setup-ran.txt')) && /worktree setup \(node setup\.js\)/.test(envNote(tcs)), 'delivery.worktreeSetup (the person\'s own settings) ran in the new worktree', envNote(tcs));
  setUserDelivery({ worktreeSetup: 'node -e "process.exit(2)"' });
  const failing = makeProject();
  hold();
  const tf = await D.createTask(failing, { title: 'Setup fails', status: 'ready' });
  await D.setDispatch(failing, 'start');
  ok(task(failing, tf.id).status === 'blocked' && /worktree setup failed/.test(JSON.stringify(task(failing, tf.id).review.comments)), 'a failing setup blocks the task with the reason');
  setUserDelivery({ worktreeSetup: 'aico vault show secret' });
  const refusedP = makeProject();
  hold();
  const tr = await D.createTask(refusedP, { title: 'Setup refused', status: 'ready' });
  await D.setDispatch(refusedP, 'start');
  ok(task(refusedP, tr.id).status === 'blocked' && /refused|BLOCKED/.test(JSON.stringify(task(refusedP, tr.id).review.comments)), 'a setup command that would reveal the vault is refused by the shell guard, whoever configured it');
  setUserDelivery(undefined);
  const untrusted = makeProject({ 'setup.js': "require('fs').writeFileSync('setup-ran.txt', 'x');\n" });
  fs.writeFileSync(path.join(untrusted, '.aico', 'settings.json'), JSON.stringify({ delivery: { worktreeSetup: 'node setup.js' } }));
  ok(deliveryConfig(untrusted).worktreeSetup === undefined && /not trusted|trust|approve/i.test(deliveryConfig(untrusted).untrusted), 'a project\'s own settings file defining a command is ignored until a person approves it', deliveryConfig(untrusted));
  const tu = await startOne(untrusted);
  ok(!fs.existsSync(path.join(tu.worktree, 'setup-ran.txt')) && /no person has approved/.test(envNote(tu)), 'so the worktree setup did not run, and the thread says why', envNote(tu));
  await D.updateTask(untrusted, tu.id, { status: 'cancelled' }, 'person');
  const status = await projectTrustStatus(untrusted);
  await approveProjectTrust(untrusted, status.hash);
  ok(deliveryConfig(untrusted).worktreeSetup === 'node setup.js' && deliveryConfig(untrusted).from.worktreeSetup === 'project', 'once a person approves that exact file the project\'s command applies');
  const tu2 = await startOne(untrusted, 'Probe two');
  ok(fs.existsSync(path.join(tu2.worktree, 'setup-ran.txt')), 'and runs in the next worktree');

  // The guard: an install through a link is refused with the fix named; everything else is untouched.
  const gp = makeProject({ 'requirements.txt': 'x\n', 'composer.json': '{}\n' });
  fs.mkdirSync(path.join(gp, '.venv')); fs.mkdirSync(path.join(gp, 'vendor'));
  const tg = await startOne(gp, 'Guarded');
  const wt = tg.worktree;
  const deny = (cmd, cwd = wt) => deliveryRunDenial('Bash', {}, cmd, cwd);
  ok(['npm install lodash', 'npm i', 'npm ci', 'npm --silent install x', 'pnpm add left-pad', 'yarn add x', 'yarn', 'bun add x', 'npm uninstall x', 'cd sub && npm update'].every(c => /localise/.test(deny(c) ?? '')), 'npm / pnpm / yarn / bun installs are refused through a linked node_modules, naming "localise"');
  ok(['pip install -r requirements.txt', 'pip3 install x', 'python -m pip install x', 'uv pip install x', 'poetry add x', 'pipenv install'].every(c => /localise/.test(deny(c) ?? '') && /\.venv/.test(deny(c))), 'pip and friends are refused through a linked .venv');
  ok(/vendor/.test(deny('composer require x/y') ?? '') && /localise/.test(deny('composer install') ?? ''), 'composer is refused through a linked vendor');
  ok(['npm test', 'npm run build', 'npx tsc', 'node check.js', 'git status', 'git commit -m "x"', 'pip list', 'composer show', 'yarn test'].every(c => deny(c) === undefined), 'running things, listing and committing are not refused');
  ok(/localise/.test(deny('npm install x', path.join(wt, 'src')) ?? ''), 'a call from a subfolder is judged by the worktree root too');
  ok(deny('npm install x', node) === undefined, 'a directory that is not a delivery worktree is never judged');
  // localise: Node is copied (the project\'s own stays), the others have the link removed.
  fs.mkdirSync(path.join(gp, 'node_modules', 'left-pad'), { recursive: true }); fs.writeFileSync(path.join(gp, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  const wtNode = (await startOne(node, 'Localise me')).worktree;
  ok(isLink(path.join(wtNode, 'node_modules')), 'before: linked');
  const said = await runInContext({ cwd: wtNode }, () => deliveryTool({ action: 'localise' }));
  ok(/Localised: node_modules \(copied/.test(said) && !isLink(path.join(wtNode, 'node_modules')) && fs.existsSync(path.join(wtNode, 'node_modules', '.bin')), 'localise replaced the link with a private copy', said);
  fs.writeFileSync(path.join(wtNode, 'node_modules', 'added-by-install'), 'x');
  ok(!fs.existsSync(path.join(node, 'node_modules', 'added-by-install')) && fs.existsSync(path.join(node, 'node_modules', '.bin')), 'a write into the copy does not reach the project\'s own node_modules');
  ok(deny('npm install lodash', wtNode) === undefined, 'after localising, the install is no longer refused');
  ok(/Nothing to localise/.test(await runInContext({ cwd: wtNode }, () => deliveryTool({ action: 'localise' }))), 'localising twice is harmless');
  const gt = await runInContext({ cwd: wt }, () => deliveryTool({ action: 'localise' }));
  ok(!isLink(path.join(wt, '.venv')) && !isLink(path.join(wt, 'vendor')) && /python -m venv \.venv/.test(gt) && /composer install/.test(gt) && fs.existsSync(path.join(gp, '.venv')) && fs.existsSync(path.join(gp, 'vendor')), 'a venv and vendor cannot be copied: their links are removed, the run is told what to run, the project keeps its own', gt);
  ok(/Only that task|cannot localise/.test(await runInContext({ cwd: wt }, () => deliveryTool({ action: 'localise', id: 'deadbeef' }))), 'one run cannot localise another task');
  ok(/\[error\] Unknown action "localise"/.test(await runInContext({ cwd: gp }, () => deliveryTool({ action: 'localise' }))), 'from the project folder `localise` is not an action');
  // Removing a worktree never follows a link into the project.
  const keep = makeProject();
  const tk = await startOne(keep, 'Keep node_modules');
  fs.writeFileSync(path.join(keep, 'node_modules', 'precious'), 'x');
  await D.updateTask(keep, tk.id, { status: 'cancelled' }, 'person');
  ok(fs.existsSync(path.join(keep, 'node_modules', 'precious')) && !fs.existsSync(tk.worktree), 'removing a worktree takes its link out first: the project\'s dependencies are untouched');
  D.resetDeliveryForTest();
}

console.log('\n-- hygiene: dangling worktree records are pruned, git maintenance runs off the critical path --');
{
  fresh();
  const p = makeProject();
  const dangling = path.join(D.worktreesRoot(), 'k', 'cafebabe');
  fs.mkdirSync(path.dirname(dangling), { recursive: true });
  git(p, 'worktree', 'add', '-q', '-b', 'scratch-branch', dangling, 'main');
  fs.rmSync(dangling, { recursive: true, force: true });   // the folder vanished (a crash, a cleaner)
  ok(git(p, 'worktree', 'list').includes('cafebabe'), 'git still lists the worktree whose folder is gone');
  await D.sweep(p);
  ok(!git(p, 'worktree', 'list').includes('cafebabe'), 'the sweep prunes the stale record');

  // `git gc --auto` runs when due and nothing of the project is running.
  git(p, 'config', 'gc.auto', '1'); git(p, 'config', 'gc.autoDetach', 'false');
  const loose = () => Number(/^count: (\d+)/m.exec(git(p, 'count-objects', '-v'))[1]);
  const packs = () => Number(/^packs: (\d+)/m.exec(git(p, 'count-objects', '-v'))[1]);
  let seeded = 0;
  const seedLoose = () => {
    // git decides "due" by sampling the objects/17 fan-out directory (it needs more than one object there), so write loose objects that land in it.
    let written = 0;
    for (let i = seeded; i < 400_000 && written < 3; i++) {
      const body = `loose ${i}\n`;
      const hash = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0${body}`).digest('hex');
      if (hash.startsWith('17')) { execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: p, input: body }); written++; seeded = i + 1; }
    }
  };
  seedLoose();
  const looseBefore = loose(); const packsBefore = packs();
  ok(looseBefore > 0, 'a loose object exists to be packed', looseBefore);
  const hold = makeRunner(async () => { await new Promise(() => {}); });
  D.configureDelivery({ runner: hold });
  const t = await D.createTask(p, { title: 'Busy', status: 'ready' });
  await D.setDispatch(p, 'start');
  await D.sweep(p);
  ok(loose() === looseBefore && packs() === packsBefore, 'while a run is active in the project the sweep does not run git\'s maintenance');
  await D.updateTask(p, t.id, { status: 'cancelled' }, 'person');
  await D.setDispatch(p, 'pause');
  seedLoose();
  await D.sweep(p);
  ok(packs() > packsBefore, 'with nothing running, git\'s own gc --auto ran (it packed the repository; unreachable loose objects stay until they expire)', { loose: loose(), packs: packs() });
  D.resetDeliveryForTest();
}

console.log('\n-- release trains: proposal, notes, the local tag, a gated deploy, a rollback through the queue --');
{
  fresh();
  const R = DeliveryRelease;
  // Conventional Commits and semver arithmetic.
  ok(R.parseConventional('feat: x').kind === 'feat' && R.parseConventional('fix(api): x').kind === 'fix' && R.parseConventional('feat(api)!: x').breaking === true && R.parseConventional('chore: x', 'BREAKING CHANGE: gone').breaking === true && R.parseConventional('Revert "x"').kind === 'other' && R.parseConventional('docs: x').kind === 'docs', 'Conventional Commit parsing: types, scopes, ! and BREAKING CHANGE');
  ok(R.bumpFor([{ kind: 'fix', breaking: false }]).bump === 'patch' && R.bumpFor([{ kind: 'fix', breaking: false }, { kind: 'feat', breaking: false }]).bump === 'minor' && R.bumpFor([{ kind: 'feat', breaking: true }, { kind: 'fix', breaking: false }]).bump === 'major' && R.bumpFor([{ kind: 'chore', breaking: false }]).bump === 'patch', 'feat is a minor, fix a patch, a breaking change a major; the highest wins');
  const sv = R.parseSemver;
  ok(R.formatSemver(R.bumpSemver(sv('1.4.9'), 'minor')) === '1.5.0' && R.formatSemver(R.bumpSemver(sv('1.4.9'), 'major')) === '2.0.0' && R.formatSemver(R.bumpSemver(sv('1.4.9'), 'patch')) === '1.4.10' && sv('1.2') === undefined && sv('v2.0.1').major === 2 && R.compareSemver(sv('1.10.0'), sv('1.9.9')) > 0, 'semver: bump, parse, and compare numerically (1.10 > 1.9)');
  // Version files keep their formatting and line endings.
  const vf = fs.mkdtempSync(path.join(tmpRoot, 'vf-'));
  fs.writeFileSync(path.join(vf, 'package.json'), '{\r\n    "name": "x",\r\n    "version": "1.2.3"\r\n}\r\n');
  fs.writeFileSync(path.join(vf, 'package-lock.json'), '{\n  "name": "x",\n  "version": "1.2.3",\n  "packages": { "": { "name": "x", "version": "1.2.3" }, "node_modules/y": { "version": "9.9.9" } }\n}\n');
  fs.writeFileSync(path.join(vf, 'pyproject.toml'), '[build-system]\nrequires = ["x"]\n\n[project]\nname = "x"\nversion = "1.2.3"\n\n[tool.other]\nversion = "7.7.7"\n');
  fs.writeFileSync(path.join(vf, 'Cargo.toml'), '[package]\nname = "x"\nversion = "1.2.3"\n\n[dependencies]\nserde = "1.0.0"\n');
  fs.writeFileSync(path.join(vf, 'App.csproj'), '<Project><PropertyGroup><Version>1.2.3</Version></PropertyGroup></Project>\n');
  ok(R.readVersionFiles(vf).map(f => `${f.file}@${f.version}`).sort().join() === 'App.csproj@1.2.3,Cargo.toml@1.2.3,package.json@1.2.3,pyproject.toml@1.2.3', 'version files are read: package.json, pyproject.toml, Cargo.toml, .csproj');
  for (const f of ['package.json', 'pyproject.toml', 'Cargo.toml', 'App.csproj']) R.writeVersionFile(vf, f, '2.0.0');
  const pj = fs.readFileSync(path.join(vf, 'package.json'), 'utf8');
  ok(pj === '{\r\n    "name": "x",\r\n    "version": "2.0.0"\r\n}\r\n', 'package.json: only the version changed; indent and CRLF kept', JSON.stringify(pj));
  const lock = JSON.parse(fs.readFileSync(path.join(vf, 'package-lock.json'), 'utf8'));
  ok(lock.version === '2.0.0' && lock.packages[''].version === '2.0.0' && lock.packages['node_modules/y'].version === '9.9.9', 'package-lock.json: the project\'s own two version fields, not a dependency\'s');
  ok(/version = "2.0.0"/.test(fs.readFileSync(path.join(vf, 'pyproject.toml'), 'utf8')) && /\[tool\.other\]\nversion = "7.7.7"/.test(fs.readFileSync(path.join(vf, 'pyproject.toml'), 'utf8')) && /name = "x"\nversion = "2.0.0"\n\n\[dependencies\]\nserde = "1\.0\.0"/.test(fs.readFileSync(path.join(vf, 'Cargo.toml'), 'utf8')) && fs.readFileSync(path.join(vf, 'App.csproj'), 'utf8').includes('<Version>2.0.0</Version>'), 'pyproject.toml, Cargo.toml and .csproj: the right table, not a dependency\'s or another tool\'s');
  // CHANGELOG insertion.
  const sec = '## 1.1.0 - 2026-10-09\n\n### Added\n\n- A thing\n';
  ok(R.insertChangelog('', sec).startsWith('# Changelog\n\n## 1.1.0'), 'a missing changelog is created with a title');
  ok(R.insertChangelog('# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- First\n', sec).indexOf('## 1.1.0') < R.insertChangelog('# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- First\n', sec).indexOf('## 1.0.0'), 'the new section goes above the older ones');
  const withUnrel = R.insertChangelog('# Changelog\n\n## Unreleased\n\n- Pending\n\n## 1.0.0\n\n- First\n', sec);
  ok(withUnrel.indexOf('## Unreleased') < withUnrel.indexOf('## 1.1.0') && withUnrel.indexOf('## 1.1.0') < withUnrel.indexOf('## 1.0.0') && withUnrel.includes('- Pending'), 'an Unreleased section stays on top, untouched');
  ok(R.insertChangelog('# Changelog\r\n\r\n## 1.0.0\r\n', sec).includes('\r\n## 1.1.0 - 2026-10-09\r\n'), 'CRLF changelogs stay CRLF');
  ok(R.buildNotes([{ id: '1', title: 'Big', kind: 'feat', breaking: true }, { id: '2', title: 'New', kind: 'feat', breaking: false, summary: 'Checks passed' }, { id: '3', title: 'Bug', kind: 'fix', breaking: false }, { id: '4', title: 'Docs', kind: 'docs', breaking: false }], [{ subject: 'chore: bump' }]).split('\n').filter(l => l.startsWith('#')).join('|') === '### Breaking changes|### Added|### Fixed|### Other|### Also on the trunk', 'notes: breaking first, then Added, Fixed, Other, and the trunk\'s own commits last');

  // A real project and the whole train.
  const rp = makeProject({
    '.gitignore': '.aico/\nnode_modules/\ndeploy.log\n',
    'deploy.js': "require('fs').appendFileSync('deploy.log', 'deployed ' + process.cwd() + '\\n'); console.log('shipping the release');\n",
  });
  const remote = path.join(tmpRoot, 'release-remote.git');
  git(tmpRoot, 'init', '-q', '--bare', remote); git(rp, 'remote', 'add', 'origin', remote);
  const plan0 = await D.planRelease(rp);
  ok(!plan0.lastTag && plan0.next.version === '1.0.0' && plan0.next.bump === 'none' && /first release/.test(plan0.next.reason) && plan0.versionFiles.join() === 'package.json' && plan0.blockers.length === 0 && plan0.commitCount === 1 && plan0.deploy.available === false && /No deploy command/.test(plan0.deploy.why), 'first release: no tag, so the project\'s own declared version is the release; no deploy command is said plainly', plan0);
  const rel0 = await D.createRelease(rp);
  ok(rel0.tag === 'v1.0.0' && git(rp, 'cat-file', '-t', 'v1.0.0') === 'tag' && git(rp, 'log', '-1', '--format=%s') === 'chore(release): v1.0.0' && git(rp, 'tag', '--points-at', 'HEAD') === 'v1.0.0' && rel0.files.join() === 'CHANGELOG.md', 'create: one release commit and an ANNOTATED tag on it; package.json already said 1.0.0 so only the CHANGELOG changed', rel0);
  ok(fs.readFileSync(path.join(rp, 'CHANGELOG.md'), 'utf8').startsWith('# Changelog\n\n## 1.0.0 - '), 'a CHANGELOG was created');

  const t1 = await landOne(rp, 'Add a wishlist page', { 'src/wish.js': 'exports.wish = 1;\n', 'test/wish.test.js': "require('node:test')('wish', () => {});\n" }, 'feat: add a wishlist page');
  const t2 = await landOne(rp, 'Fix the rounding bug', { 'src/b.js': 'exports.b = () => 3;\n', 'test/b3.test.js': "require('node:test')('b3', () => {});\n" }, 'fix: round correctly');
  const plan1 = await D.planRelease(rp);
  ok(plan1.lastTag === 'v1.0.0' && plan1.next.version === '1.1.0' && plan1.next.bump === 'minor' && plan1.next.reason === '1 new feature' && plan1.tasks.map(x => x.title).join() === 'Add a wishlist page,Fix the rounding bug' && plan1.other.length === 0 && plan1.commitCount === 2, 'a feat and a fix since v1.0.0 propose 1.1.0 (minor), from the merged tasks', plan1);
  ok(/### Added\n\n- Add a wishlist page/.test(plan1.notes) && /### Fixed\n\n- Fix the rounding bug/.test(plan1.notes) && plan1.tasks.every(x => x.summary), 'the notes are the tasks\' titles with their evidence summaries, grouped', plan1.notes);

  // Names the person did not choose: a version that is not higher, not a version, a lower one.
  ok((await D.planRelease(rp, '1.0.0')).blockers.some(b => /not higher than 1\.0\.0/.test(b)) && /not higher/.test(await errOf(() => D.createRelease(rp, { version: '1.0.0' }))) && /not a version/.test(await errOf(() => D.createRelease(rp, { version: 'banana' }))), 'a version that is not higher than the last, or not a version, is refused');
  ok(git(rp, 'tag', '-l').trim() === 'v1.0.0', 'and no tag was created by the refusals');
  // The person's uncommitted edit to a file the release would change blocks it, untouched.
  fs.writeFileSync(path.join(rp, 'package.json'), fs.readFileSync(path.join(rp, 'package.json'), 'utf8').replace('"p"', '"p-edited"'));
  const dirtyPlan = await D.planRelease(rp);
  ok(dirtyPlan.blockers.some(b => /package\.json has uncommitted changes/.test(b)) && /uncommitted changes/.test(await errOf(() => D.createRelease(rp))) && git(rp, 'tag', '-l').trim() === 'v1.0.0' && fs.readFileSync(path.join(rp, 'package.json'), 'utf8').includes('p-edited'), 'uncommitted edits to a file the release would overwrite block it; the edit and the tags are untouched');
  git(rp, 'checkout', '--', 'package.json');

  const mainBefore = git(rp, 'rev-parse', 'main');
  const rel1 = await D.createRelease(rp);
  ok(rel1.version === '1.1.0' && rel1.bump === 'minor' && rel1.tasks.length === 2 && JSON.parse(fs.readFileSync(path.join(rp, 'package.json'), 'utf8')).version === '1.1.0' && rel1.files.join() === 'package.json,CHANGELOG.md', 'create 1.1.0: package.json bumped, CHANGELOG touched, both recorded', rel1);
  const log = fs.readFileSync(path.join(rp, 'CHANGELOG.md'), 'utf8');
  ok(log.indexOf('## 1.1.0 - ') < log.indexOf('## 1.0.0 - ') && /### Added\n\n- Add a wishlist page/.test(log), 'the CHANGELOG has a 1.1.0 section above 1.0.0 with the notes');
  ok(git(rp, 'rev-list', '--count', `${mainBefore}..main`) === '1' && git(rp, 'rev-list', '--merges', '--count', 'main') === '0' && git(rp, 'cat-file', '-t', 'v1.1.0') === 'tag', 'one commit on top of the trunk, a fast-forward, an annotated tag');
  ok(git(rp, 'tag', '-l', '--format=%(contents)', 'v1.1.0').includes('Add a wishlist page'), 'the tag message carries the notes');
  const everything = [git(rp, 'log', '-5', '--format=%an %ae %cn %ce %B'), git(rp, 'tag', '-l', '--format=%(taggername) %(taggeremail) %(contents)', 'v1.1.0'), log, rel1.notes].join('\n');
  ok(!/co-authored-by|generated with|claude|anthropic|\bAI\b/i.test(everything) && /Test Owner/.test(git(rp, 'log', '-1', '--format=%an')), 'no AI credit anywhere in the commit, the tag, the changelog or the notes; the repository\'s own identity made them');
  ok(git(remote, 'for-each-ref') === '' && git(rp, 'branch', '-r') === '', 'nothing was pushed: the remote holds no branch and no tag');
  ok(D.boardState(rp).releases[0].version === '1.1.0' && D.boardState(rp).releases[0].notes === rel1.notes && D.boardState(rp).releases.length === 2, 'the release is on the board, newest first');
  ok((await D.planRelease(rp)).blockers.some(b => /Nothing has landed on main since v1\.1\.0/.test(b)), 'and with nothing new the plan says there is nothing to release');
  ok(!git(rp, 'worktree', 'list').includes('release') && git(rp, 'branch', '--list', 'aico/release-*') === '', 'the release left no worktree and no branch behind');

  // ── deploy: a person, the exact command, only from a checkout that has the release ──
  const gate = new DecisionGate();
  const mkRes = () => ({ headers: {}, written: [], write(x) { this.written.push(x); } });
  const deps = {
    send: (res, status, body) => { res.status = status; res.body = body; },
    readJson: async (req) => req.body ?? {},
    isKnownProject: async (d) => [rp].includes(path.resolve(d)),
    human: (req, body) => gate.checkHuman({ grant: req.headers['x-aico-grant'], client: body.client, uiKey: req.headers['x-aico-ui-key'], fetchSite: undefined }),
    startPlan: async () => ({ sessionId: 'x' }), subscribe: () => () => {},
  };
  const call = async (route, method, body = {}, { person = false, query = '' } = {}) => {
    const req = { method, headers: person ? { 'x-aico-ui-key': gate.uiKey } : {}, on() {}, body };
    const res = mkRes();
    const handled = await handleDeliveryRoute(route, req, res, new URL(`http://127.0.0.1/api/${route}${query}`), deps);
    return { handled, status: res.status, body: res.body };
  };
  const q = `?project=${encodeURIComponent(rp)}`;
  const listed = await call('delivery/releases', 'GET', {}, { query: q });
  ok(listed.status === 200 && listed.body.releases.length === 2 && listed.body.plan.trunk === 'main', 'GET releases: the token alone may read the history and the plan');
  ok((await call('delivery/releases', 'GET', {}, { query: `${q}&version=banana` })).status === 400, 'a malformed version preview is a 400');
  ok((await call('delivery/releases', 'POST', { project: rp })).status === 403 && (await call('delivery/releases/1.1.0/deploy', 'POST', { project: rp })).status === 403 && (await call('delivery/releases/1.1.0/rollback', 'POST', { project: rp })).status === 403 && (await call('delivery/approve-batch', 'POST', { project: rp, ids: ['00000000'] })).status === 403 && (await call('delivery/tasks/00000000/comment', 'POST', { project: rp, text: 'x' })).status === 403, 'create, deploy, rollback, batch approve and a person\'s comment all refuse the token alone');
  ok((await call('delivery/releases/1.1.0/deploy', 'POST', { project: rp }, { person: true })).status === 409, 'a deploy with no command configured is a 409 that says what to set');
  setUserDelivery({ deployCommand: 'node deploy.js' });
  ok((await D.planRelease(rp)).deploy.available && (await D.planRelease(rp)).deploy.source === 'setting' && (await D.planRelease(rp)).deploy.command === 'node deploy.js', 'the plan shows the exact command and where it came from');
  const started = await call('delivery/releases/1.1.0/deploy', 'POST', { project: rp }, { person: true });
  ok(started.status === 200 && started.body.deploy.state === 'running' && started.body.deploy.command === 'node deploy.js', 'a person can deploy: the answer is immediate and says it is running', started.body);
  await D.settled(rp);
  const dep = D.boardState(rp).releases.find(r => r.version === '1.1.0').deploy;
  ok(dep.state === 'ok' && dep.source === 'setting' && dep.command === 'node deploy.js' && /shipping the release/.test(dep.tail), 'the deploy ran and its outcome and output tail were recorded', dep);
  ok(fs.readFileSync(path.join(rp, 'deploy.log'), 'utf8').includes(`deployed ${rp}`), 'in the project\'s own folder');
  setUserDelivery({ deployCommand: 'node -e "process.exit(3)"' });
  await D.deployRelease(rp, '1.1.0'); await D.settled(rp);
  ok(D.boardState(rp).releases.find(r => r.version === '1.1.0').deploy.state === 'failed', 'a failing deploy is recorded as failed');
  setUserDelivery({ deployCommand: 'aico vault show secret' });
  await D.deployRelease(rp, '1.1.0'); await D.settled(rp);
  const refusedDeploy = D.boardState(rp).releases.find(r => r.version === '1.1.0').deploy;
  ok(refusedDeploy.state === 'failed' && /BLOCKED/.test(refusedDeploy.tail), 'a deploy command that would reveal the vault is refused by the shell guard');
  fs.writeFileSync(path.join(rp, 'slow.js'), 'setTimeout(() => {}, 1500);\n');
  setUserDelivery({ deployCommand: 'node slow.js' });
  const first = D.deployRelease(rp, '1.1.0');
  ok(/already running/.test(await errOf(() => D.deployRelease(rp, '1.1.0'))), 'two deploys of one release at once are refused');
  await first; await D.settled(rp);
  ok(/no release 9\.9\.9/.test(await errOf(() => D.deployRelease(rp, '9.9.9'))), 'deploying a release the board did not make is a 404');
  git(rp, 'checkout', '-q', '-b', 'old', 'v1.0.0');
  ok(/does not contain v1\.1\.0/.test(await errOf(() => D.deployRelease(rp, '1.1.0'))), 'a checkout that does not contain the release cannot deploy it');
  git(rp, 'checkout', '-q', 'main'); git(rp, 'branch', '-q', '-D', 'old');
  setUserDelivery(undefined);
  // A project file's command is the project's, so it needs the person's approval first.
  fs.mkdirSync(path.join(rp, '.aico'), { recursive: true });
  fs.writeFileSync(path.join(rp, '.aico', 'settings.json'), JSON.stringify({ delivery: { deployCommand: 'node deploy.js' } }));
  const untrustedPlan = await D.planRelease(rp);
  ok(!untrustedPlan.deploy.available && /approved/.test(untrustedPlan.deploy.why), 'a deploy command in the project\'s own settings is not offered until a person approves that file', untrustedPlan.deploy);
  const st = await projectTrustStatus(rp);
  ok(/Delivery deploy command/.test(st.summary) && st.names.includes('Delivery deploy command'), 'the approval card shows the exact deploy command', st.summary);
  await approveProjectTrust(rp, st.hash);
  ok((await D.planRelease(rp)).deploy.available && (await D.planRelease(rp)).deploy.source === 'setting', 'and then it is');
  fs.rmSync(path.join(rp, '.aico', 'settings.json'));

  // ── rollback: a task that reverts, through the same queue ──
  const rb = await call('delivery/releases/1.1.0/rollback', 'POST', { project: rp }, { person: true });
  ok(rb.status === 200 && rb.body.title === 'Revert release v1.1.0' && rb.body.labels.includes('rollback') && rb.body.priority === 1, 'a person asks for a rollback and a task is created', rb.body);
  const rbId = rb.body.id;
  ok(await pump(rp, () => task(rp, rbId)?.status === 'review', 60_000), 'it goes through the merge queue like any task: rebased, checked, scored, then review', task(rp, rbId)?.status);
  ok(task(rp, rbId).evidence && task(rp, rbId).risk && task(rp, rbId).branch === `aico/task-${rbId}`, 'with evidence and a risk score');
  const rdiff = await D.taskDiff(rp, rbId);
  ok(/-exports\.wish = 1/.test(rdiff) && /-exports\.b = \(\) => 3/.test(rdiff) && /\+exports\.b = \(\) => 2/.test(rdiff), 'its diff undoes the released tasks\' changes', rdiff.slice(0, 400));
  ok(D.boardState(rp).releases.find(r => r.version === '1.1.0').rollback.taskId === rbId && /already has a rollback task/.test(await errOf(() => D.rollbackRelease(rp, '1.1.0'))), 'the release records its rollback task; a second one is refused');
  ok(git(rp, 'ls-tree', '-r', '--name-only', 'main').includes('src/wish.js'), 'nothing is reverted on the trunk until a person approves');
  await D.approveTask(rp, rbId);
  ok(!mainFiles(rp).includes('src/wish.js') && git(rp, 'show', 'main:src/b.js').includes('=> 2') && task(rp, rbId).status === 'merged', 'approved: the trunk no longer has the released changes');
  ok(/no release/.test(await errOf(() => D.rollbackRelease(rp, '7.7.7'))), 'rolling back a release the board did not make is a 404');
  const next = await D.planRelease(rp);
  ok(next.next.bump === 'patch' && next.commitCount >= 1, 'the revert is itself releasable (a patch)', next.next);

  // A later change touches the same lines: the revert cannot be made automatically, and nothing is left behind.
  await landOne(rp, 'Add greeting', { 'src/greet.js': 'exports.greet = () => "hi";\n', 'test/greet.test.js': "require('node:test')('greet', () => {});\n" }, 'feat: add greeting');
  const rel2 = await D.createRelease(rp);
  await landOne(rp, 'Change greeting', { 'src/greet.js': 'exports.greet = () => "hello";\n', 'test/greet2.test.js': "require('node:test')('greet2', () => {});\n" }, 'fix: friendlier greeting');
  const wtsBefore = git(rp, 'worktree', 'list'); const branchesBefore = git(rp, 'branch', '--list', 'aico/task-*');
  const conflict = await errOf(() => D.rollbackRelease(rp, rel2.version));
  ok(/cannot be reverted automatically/.test(conflict) && /src\/greet\.js/.test(conflict) && git(rp, 'worktree', 'list') === wtsBefore && git(rp, 'branch', '--list', 'aico/task-*') === branchesBefore && !D.boardState(rp).releases.find(r => r.version === rel2.version).rollback, 'a revert that conflicts names the files and creates nothing: no task, no branch, no worktree', conflict);

  // A breaking change is a major, and a chosen version is honoured.
  await landOne(rp, 'Drop the old API', { 'src/old.js': 'exports.gone = 1;\n', 'test/old.test.js': "require('node:test')('old', () => {});\n" }, 'feat!: drop the old API');
  const majorPlan = await D.planRelease(rp);
  ok(majorPlan.next.bump === 'major' && /breaking/.test(majorPlan.next.reason) && majorPlan.tasks.some(x => x.breaking) && /### Breaking changes/.test(majorPlan.notes), 'a feat! commit proposes a major and heads the notes with the breaking change', majorPlan.next);
  const chosen = await D.planRelease(rp, '3.0.0');
  ok(chosen.next.version === '3.0.0' && chosen.next.reason === 'chosen by you', 'a version the person chose is previewed as chosen');
  // The trunk checked out nowhere: the ref moves, the person's branch and files are left alone.
  git(rp, 'checkout', '-q', '-b', 'side');
  const sideHead = git(rp, 'rev-parse', 'side'); const sideFiles = fs.readFileSync(path.join(rp, 'package.json'), 'utf8');
  const rel3 = await D.createRelease(rp, { version: '3.0.0', changelog: false });
  ok(rel3.version === '3.0.0' && git(rp, 'show', 'main:package.json').includes('"3.0.0"') && git(rp, 'rev-parse', 'side') === sideHead && fs.readFileSync(path.join(rp, 'package.json'), 'utf8') === sideFiles && rel3.files.join() === 'package.json', 'the trunk is released even when another branch is checked out; that branch and its files are not touched (changelog off)');
  git(rp, 'checkout', '-q', 'main');

  // Tag only: a project with no version file.
  const bare = makeProject();
  fs.rmSync(path.join(bare, 'package.json')); git(bare, 'add', '-A'); git(bare, 'commit', '-q', '-m', 'chore: drop package.json');
  const bp = await D.planRelease(bare);
  ok(bp.versionFiles.length === 0 && bp.next.version === '0.1.0' && /first release/.test(bp.next.reason), 'a project with no version file and no tag starts at 0.1.0 and updates no file', bp);
  const tagOnly = await D.createRelease(bare, { changelog: false });
  ok(tagOnly.files.length === 0 && git(bare, 'rev-parse', 'v0.1.0^{commit}') === git(bare, 'rev-parse', 'main') && git(bare, 'cat-file', '-t', 'v0.1.0') === 'tag', 'tag only: no version file and no changelog means no commit, just an annotated tag on the trunk\'s tip');
  ok((await D.planRelease(bare)).blockers.length > 0, 'and then nothing is left to release');

  // An AICO app releases by its own deploy script.
  const ap = makeProject({
    '.gitignore': '.aico/\nnode_modules/\ndeployed-app.txt\n',
    'app.json': JSON.stringify({ slug: 'release-demo', title: 'Demo', deploy: [{ id: 'local', label: 'Local', script: 'node deploy-app.js' }] }),
    'deploy-app.js': "require('fs').writeFileSync('deployed-app.txt', 'ok'); console.log('app deployed');\n",
  });
  setUserDelivery({ deployCommand: 'node should-not-run.js' });
  await D.createRelease(ap);
  const appPlan = await D.planRelease(ap);
  ok(appPlan.deploy.available && appPlan.deploy.source === 'app' && appPlan.deploy.command === 'node deploy-app.js', 'for an AICO app the deploy is the app\'s own script, ahead of any setting', appPlan.deploy);
  await D.deployRelease(ap, '1.0.0'); await D.settled(ap);
  const appDep = D.boardState(ap).releases[0].deploy;
  ok(appDep.state === 'ok' && appDep.source === 'app' && fs.readFileSync(path.join(ap, 'deployed-app.txt'), 'utf8') === 'ok' && /app deployed/.test(appDep.tail), 'and it ran, through the apps deploy runner', appDep);
  setUserDelivery(undefined);
  // The desktop mints a grant for exactly the person-gated acts, and for nothing a token alone may do.
  const proto = fs.readFileSync(path.resolve('desktop/electron/protocol.ts'), 'utf8');
  const humanRe = new RegExp(proto.match(/HUMAN_ROUTE_PATTERNS = \[(.*)\];/)[1].slice(1, -1).replace(/\\\//g, '/'));
  ok(/'\/api\/delivery\/approve-batch'/.test(proto) && /'\/api\/delivery\/releases'/.test(proto), 'the desktop\'s HUMAN_ROUTES covers batch approve and making a release');
  ok(humanRe.test('/api/delivery/releases/1.2.0/deploy') && humanRe.test('/api/delivery/releases/10.0.11/rollback') && humanRe.test('/api/delivery/tasks/0123abcd/comment') && humanRe.test('/api/delivery/tasks/0123abcd/approve') && !humanRe.test('/api/delivery/releases/1.2.0') && !humanRe.test('/api/delivery/releases/1.2.0/notes') && !humanRe.test('/api/delivery/attention') && !humanRe.test('/api/delivery/tasks/0123abcd/diff'), 'and its id patterns match deploy, rollback, comment and approve on a real id/version and nothing else');
  D.resetDeliveryForTest();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
