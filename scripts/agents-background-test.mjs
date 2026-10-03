/**
 * Background agents that report back (ADR 0021), end to end and offline.
 *
 * Why a suite of its own: each of the seven gaps it covers was a promise the
 * product made and the loop did not keep — a detached agent's result reached
 * nobody, a BackgroundTask escaped every bound its parent had, a finished
 * agent could not be asked a follow-up, a "worktree" child edited the real
 * checkout and its cleanup threw work away, a crashed background command was
 * filed as done, a restart lost background work, and nothing bounded how many
 * agents ran at once. Each is proven here against the real agent loop.
 *
 * The model is a local scripted server (scripts/lib/stub-model.mjs): every
 * run — parent, sub-agent, background agent, a turn the server starts by
 * itself, and a second process that is killed mid-tool — resolves its provider
 * from settings and talks to it. No key, no network, no cost.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { startStubModel, stubSettings, textOf } from './lib/stub-model.mjs';

for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) delete process.env[key];

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(40);
  }
}
function gate() {
  let open;
  const promise = new Promise(r => { open = r; });
  return { promise, open };
}
const never = new Promise(() => {});

// ── The scripted model ─────────────────────────────────────────────────────
const scenarios = new Map();
const seen = new Map();   // tag → request bodies
function firstUserText(body) {
  return textOf((body.messages ?? []).find(m => m.role === 'user'));
}
const stub = await startStubModel(async (body) => {
  const tag = /\[\[([A-Z0-9-]+)\]\]/.exec(firstUserText(body))?.[1];
  if (!tag) return { text: 'ok' };
  if (!seen.has(tag)) seen.set(tag, []);
  seen.get(tag).push(body);
  const handler = scenarios.get(tag);
  if (!handler) return { text: `no scenario for ${tag}` };
  const messages = body.messages ?? [];
  if (process.env.BG_DEBUG) console.log('    [stub]', tag, 'steps', messages.filter(m => m.role === 'assistant').length, 'last tool result:', textOf([...messages].reverse().find(m => m.role === 'tool')).slice(0, 300).replace(/\s+/g, ' '));
  return handler({
    body,
    all: JSON.stringify(messages),
    steps: messages.filter(m => m.role === 'assistant').length,
    lastUser: textOf([...messages].reverse().find(m => m.role === 'user')),
    tools: (body.tools ?? []).map(t => t.function?.name ?? t.name),
  });
});

const home = process.env.AICO_HOME;
const settings = stubSettings(stub.url);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2));

const distTest = path.resolve('dist-test/test-exports.js');
const T = await import(pathToFileURL(distTest).href);
T.startLedgerMirroring();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico bg agents '));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const cwd = fs.mkdtempSync(path.join(tmp, 'project-'));
const MODEL = 'stub/model';
// Run from the project, as a server launched there would: the server's trust
// gate reads the process directory, and this repository's own config is not
// trusted in a fresh test store (it would wait on a permission card).
const ownRepo = process.cwd();
process.chdir(cwd);
process.on('exit', () => { try { process.chdir(ownRepo); } catch { /* best effort */ } });
const baseOpts = { model: MODEL, autoApprove: true, verbose: false, depth: 0, settings };
const spawnedId = (text) => (/sub-agent (\S+),/.exec(text) ?? [])[1];
const sessionEvents = (session) => [...session.events];
const pluginMessages = (session, plugin) => sessionEvents(session)
  .filter(e => e.type === 'user/message' && e.data.source?.kind === 'plugin' && e.data.source.plugin === plugin);

// ── Units first: the pieces the flows below lean on ─────────────────────────

await block('Limiter: queueing, release, and no hold-and-wait deadlock', async () => {
  T.resetLimiterForTest();
  assert(T.maxConcurrentFrom(undefined) === T.DEFAULT_MAX_CONCURRENT && T.DEFAULT_MAX_CONCURRENT === 6, 'default cap is 6');
  assert(T.maxConcurrentFrom({ agents: { maxConcurrent: 0 } }) === 6 && T.maxConcurrentFrom({ agents: { maxConcurrent: 2.7 } }) === 2, 'nonsense falls back; fractions floor');
  const a = T.acquireSlot('s', 'a', 1);
  const b = T.acquireSlot('s', 'b', 1);
  assert(!a.queued && b.queued, 'second holder over a cap of 1 is queued, not refused');
  let bReady = false; void b.ready.then(() => { bReady = true; });
  // a blocks on its own child c: it suspends, c gets the slot instead of deadlocking.
  T.suspendSlot('s', 'a');
  await sleep(5);
  assert(bReady, 'a suspended holder frees its slot for the queue');
  const resumed = T.resumeSlot('s', 'a', 1);
  let aBack = false; void resumed.then(() => { aBack = true; });
  await sleep(5);
  assert(!aBack, 'and waits to take one back while the cap is full');
  T.releaseSlot('s', 'b');
  await sleep(5);
  assert(aBack, 'and gets it once one frees');
  const ctl = new AbortController();
  const c = T.acquireSlot('s', 'c', 1, ctl.signal);
  ctl.abort();
  let rejected = false;
  await c.ready.catch(() => { rejected = true; });
  assert(rejected && T.slotState('s').queued === 0, 'a queued holder that is stopped leaves the queue and never starts');
  T.releaseSlot('s', 'a');
  assert(T.slotState('s').active === 0, 'all released');
});

await block('Scope survives JSON; a resume narrows, never widens', async () => {
  const layer = { label: 'reviewer', tools: new Set(['Read', 'Grep']), mcp: 'readonly', deny: ['Bash'] };
  const scope = T.narrowScope(undefined, { layer, canDelegate: true, writeBound: { label: 'paths', root: cwd, globs: ['src/**'] } });
  const back = T.deserializeScope(JSON.parse(JSON.stringify(T.serializeScope(scope))));
  assert(back.layers[0].tools.has('Read') && !back.layers[0].tools.has('Write') && back.layers[0].mcp === 'readonly', 'layers round-trip as sets');
  assert(back.writeBounds?.[0]?.globs[0] === 'src/**' && back.delegate === true, 'write bounds and delegation round-trip');
  const narrower = T.narrowScope(undefined, { layer: { label: 'caller', tools: new Set(['Read']), mcp: [] }, canDelegate: false });
  const both = T.intersectScopes(narrower, back);
  assert(both.layers.length === 2 && both.delegate === false, 'intersection keeps every layer and the stricter delegation');
});

await block('Inbox: a cancelled turn drops steering but keeps background reports', async () => {
  const opened = await T.openSession('inbox-unit', cwd);
  const inbox = new T.Inbox(opened.session);
  inbox.steer('do it differently');
  inbox.inject('[Background agent x finished — "y"]', { kind: 'plugin', plugin: 'background-agent' });
  inbox.steer('and again');
  const dropped = inbox.discardStep(m => m.source.kind === 'plugin' && m.source.plugin === 'background-agent');
  assert(dropped.length === 2 && inbox.nextStep.length === 1 && /Background agent/.test(inbox.nextStep[0].content), 'two steers dropped, the report kept');
  const replay = new T.Inbox(opened.session);
  assert(replay.nextStep.length === 1, 'and a replay of the log agrees');
  await opened.close();
});

await block('Reports are bounded like a Task result', async () => {
  const big = `HEAD ${'z'.repeat(70_000)} TAIL`;
  const bounded = await T.boundReport(big, 'BackgroundAgent', 'unit1');
  assert(bounded.length <= T.REPORT_MAX_CHARS + 600, `bounded to ~${T.REPORT_MAX_CHARS} (${bounded.length})`);
  assert(bounded.includes('HEAD') && bounded.includes('TAIL'), 'head and tail both survive');
});

await block('Ledger: a restart marks resumable agents interrupted, the rest lost', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ledger-'));
  T.setWorkStorePath(path.join(dir, 'work.jsonl'));
  T.ledger.resetForTest();
  const spec = { v: 1, description: 'r', agentType: 'general', model: MODEL, cwd, logCwd: cwd, depth: 1, detach: true };
  const resumable = T.ledger.open({ kind: 'agent', title: 'resumable', origin: 'model', resume: spec });
  const plain = T.ledger.open({ kind: 'agent', title: 'plain', origin: 'model' });
  await sleep(80);
  T.ledger.resetForTest();
  await T.ledger.load();
  assert(T.ledger.get(resumable).state === 'interrupted' && /resumed/.test(T.ledger.get(resumable).error), 'an agent with a spec is interrupted, and says it can be resumed');
  assert(T.ledger.get(plain).state === 'lost', 'one without is lost, as before');
  assert(T.autoResumable(T.ledger.get(resumable), settings), 'a recent detached top-level one is auto-resumable');
  assert(!T.autoResumable(T.ledger.get(resumable), { agents: { resumeAfterRestart: false } }), 'not when the setting is off');
  assert(!T.autoResumable({ ...T.ledger.get(resumable), heartbeatAt: Date.now() - 25 * 3_600_000 }, settings), 'not when its last sign of life is over 24h old');
  assert(!T.autoResumable({ ...T.ledger.get(resumable), resume: { ...spec, detach: false } }, settings), 'not a blocking sub-agent (nobody waits for it)');
  // Back to the default store for everything below.
  T.setWorkStorePath(path.join(home, 'work.jsonl'));
  T.ledger.resetForTest();
  await T.ledger.load();
});

// ── 1 + 2: result delivery and bounds ─────────────────────────────────────

const hub = new T.EventHub();
const published = [];
const publish = hub.publish.bind(hub);
hub.publish = (e) => { published.push(e); publish(e); };
const runs = new T.RunManager(hub, settings);
runs.defaultModel = async () => MODEL;
T.setReportBackDelivery({ deliver: (req) => runs.reportBack(req) });

await block('1a. A BackgroundTask whose parent turn has ended: full report delivered, session woken', async () => {
  const release = gate();
  scenarios.set('P1', ({ steps, all }) => {
    if (all.includes('Background work finished while no turn was running')) return { text: 'WOKEN-ACK: I read the report.' };
    return steps === 0
      ? { tools: [{ name: 'BackgroundTask', args: { description: 'long report', prompt: '[[C1]] produce the long report' } }] }
      : { text: 'P1: started it, carrying on.' };
  });
  scenarios.set('C1', async () => { await release.promise; return { text: `HEAD-C1 ${'x'.repeat(60_000)} TAIL-C1` }; });

  await runs.submit('chat-s1', cwd, '[[P1]] start some background work', MODEL);
  const run = runs.get('chat-s1');
  assert(!run.busy, 'the parent turn ended before the child finished');
  const row = T.ledger.query({ kind: 'agent', sessionId: 'chat-s1' })[0];
  assert(row && !['done', 'failed'].includes(row.state), `the background agent is a ledger row of this session (${row?.state})`);
  assert(row?.resume?.detach === true && row?.resume?.depth === 1, 'with its spec: detached, one level below the chat');
  release.open();
  const woke = await until(() => sessionEvents(run.session).some(e => e.type === 'assistant/message' && /WOKEN-ACK/.test(JSON.stringify(e.data))), 20_000);
  assert(woke, 'a turn was started to read it, and the model answered');
  const reports = pluginMessages(run.session, 'background-agent');
  const report = reports.find(e => /\[Background agent \S+ finished/.test(e.data.content));
  assert(Boolean(report), 'the report is in the log as a background-agent plugin message, never as the person');
  assert(report && report.data.content.includes('HEAD-C1') && report.data.content.includes('TAIL-C1'), 'it carries the full result (head and tail)');
  assert(report && report.data.content.length < T.REPORT_MAX_CHARS + 2000, `bounded to the Task ceiling (${report?.data.content.length})`);
  const wakeMsg = reports.find(e => /Background work finished/.test(e.data.content));
  assert(Boolean(wakeMsg), 'the wake turn\'s own task is recorded as a plugin message too');
  const humans = sessionEvents(run.session).filter(e => e.type === 'user/message' && (e.data.source?.kind ?? 'human') === 'human');
  assert(humans.length === 1, `only what the person typed is attributed to them (${humans.length})`);
  assert(published.some(e => e.type === 'turn-start' && e.sessionId === 'chat-s1' && e.data.source?.plugin === 'background-agent'), 'the wake turn-start says where it came from');
  const c1 = seen.get('C1')?.[0];
  const childTools = c1?.tools?.map(t => t.function?.name) ?? [];
  assert(c1 && !childTools.includes('AskUserQuestion'), 'the background child runs headless (nobody to ask)');
});

await block('1b. Parent turn still running: the report lands at its next step boundary', async () => {
  T.setReportBackDelivery(undefined);   // the CLI's path: the run's own inbox
  const opened = await T.openSession('chat-s2', cwd);
  const inbox = new T.Inbox(opened.session);
  scenarios.set('P2', async ({ steps, all }) => {
    if (steps === 0) return { tools: [{ name: 'Task', args: { description: 'quick', prompt: '[[C2]] answer', detach: true, subagent_type: 'explore' } }] };
    if (steps === 1) {
      await until(() => inbox.nextStep.some(m => m.source.plugin === 'background-agent'), 15_000);
      return { text: 'P2 thinking' };
    }
    return { text: `P2 final saw ${all.includes('RESULT-C2') ? 'yes' : 'no'}` };
  });
  scenarios.set('C2', () => ({ text: 'RESULT-C2 done' }));
  const result = await T.runAgent({
    task: '[[P2]] go', model: MODEL, token: '', autoApprove: true, verbose: false, showPlan: false,
    conversationHistory: [], silent: true, sessionId: 'chat-s2', cwd, session: opened.session, inbox, settings,
    tokenTracker: T.createTokenTracker(),
  });
  assert(/saw yes/.test(result), `the running turn read the report before finishing (${result.slice(0, 40)})`);
  const turns = sessionEvents(opened.session).filter(e => e.type === 'turn/start').length;
  assert(turns === 1, `no second turn was needed (${turns})`);
  assert(pluginMessages(opened.session, 'background-agent').some(e => /RESULT-C2/.test(e.data.content)), 'recorded as a background-agent message in that turn');
  await opened.close();
  T.setReportBackDelivery({ deliver: (req) => runs.reportBack(req) });
});

await block('1c. Failures and stops are delivered too; a stop never wakes', async () => {
  scenarios.set('C3', () => ({ status: 400, error: 'model exploded' }));
  const holdC3b = gate();
  scenarios.set('C3B', async () => { await holdC3b.promise; return { text: 'late' }; });
  const out = await T.runInContext({ cwd, sessionId: 'chat-s3' }, () => T.runTask(
    { description: 'doomed', prompt: '[[C3]] fail', detach: true, subagent_type: 'explore' }, baseOpts));
  const id = spawnedId(out);
  await T.detachedRun(id);
  const failedReport = await until(() => T.recentReports().find(r => r.content.includes(`Background agent ${id} failed`)));
  assert(Boolean(failedReport), 'a failed background agent reports its failure');
  assert(failedReport && /400|exploded/i.test(failedReport.content), 'with the reason');
  assert(failedReport?.wake === true, 'a failure may wake the session (someone has to act on it)');
  const out2 = await T.runInContext({ cwd, sessionId: 'chat-s3' }, () => T.runTask(
    { description: 'to stop', prompt: '[[C3B]] hold', detach: true, subagent_type: 'explore' }, baseOpts));
  const id2 = spawnedId(out2);
  await until(() => seen.get('C3B')?.length);
  T.requestAgentStop(id2, 'no longer needed');
  const stopped = await until(() => T.recentReports().find(r => r.content.includes(`Background agent ${id2} was stopped`)));
  assert(Boolean(stopped) && /no longer needed/.test(stopped.content), 'a stopped one reports the stop and its reason');
  assert(stopped?.wake === false, 'and does not wake the session');
  holdC3b.open();
});

await block('2. Background spawns inherit plan mode, tool scope, depth and the session tracker', async () => {
  // A detached Task from a plan-mode parent: the child is held to plan mode.
  scenarios.set('P4A', ({ steps }) => steps === 0
    ? { tools: [{ name: 'Task', args: { description: 'plan child', prompt: '[[C4A]] inspect', detach: true, subagent_type: 'explore' } }] }
    : { text: 'P4A done' });
  scenarios.set('C4A', () => ({ text: 'C4A ok' }));
  await T.runInContext({ cwd, sessionId: 'chat-s4a' }, () => T.runAgent({
    task: '[[P4A]] plan something', model: MODEL, token: '', autoApprove: true, verbose: false, showPlan: false,
    conversationHistory: [], silent: true, sessionId: 'chat-s4a', cwd, settings, planMode: true,
  }));
  const planRow = await until(() => T.ledger.query({ kind: 'agent', sessionId: 'chat-s4a' })[0]);
  assert(planRow?.resume?.planMode === true, 'plan mode is inherited');
  await until(() => seen.get('C4A')?.length);
  const planTools = seen.get('C4A')?.[0]?.tools.map(t => t.function?.name) ?? [];
  assert(planTools.length > 0 && !planTools.includes('Write') && !planTools.includes('Edit'), 'and the plan-mode child is offered no writer');

  // BackgroundTask from a parent with a narrowed scope.
  scenarios.set('P4', ({ steps }) => steps === 0
    ? { tools: [{ name: 'BackgroundTask', args: { description: 'inherit', prompt: '[[C4]] inspect' } }] }
    : { text: 'P4 done' });
  scenarios.set('C4', () => ({ text: 'C4 ok' }));
  const scope = T.narrowScope(undefined, {
    layer: { label: 'test layer', tools: new Set(['Read', 'Grep', 'Glob', 'LS', 'BackgroundTask', 'Supervise', 'TodoWrite']), mcp: [] },
  });
  const tracker = T.createTokenTracker();
  await T.runInContext({ cwd, sessionId: 'chat-s4' }, () => T.runAgent({
    task: '[[P4]] look around', model: MODEL, token: '', autoApprove: true, verbose: false, showPlan: false,
    conversationHistory: [], silent: true, sessionId: 'chat-s4', cwd, settings, toolScope: scope,
    tokenTracker: tracker,
  }));
  const row = await until(() => T.ledger.query({ kind: 'agent', sessionId: 'chat-s4' })[0]);
  const spec = row?.resume;
  assert(spec?.scope?.layers.some(l => l.label === 'test layer'), 'BackgroundTask inherits the parent\'s tool scope');
  assert(spec?.depth === 1 && spec?.cwd === cwd && spec?.detach === true, 'one level below its parent, in the parent\'s directory, detached');
  await until(() => seen.get('C4')?.length);
  const childTools = seen.get('C4')?.[0]?.tools.map(t => t.function?.name) ?? [];
  assert(childTools.length > 0 && !childTools.includes('Write') && !childTools.includes('Edit') && !childTools.includes('Bash'),
    `the child is never offered more than its parent (${childTools.join(',')})`);
  await until(() => T.ledger.get(row.id)?.state === 'done');
  assert(tracker.getUsage().inputTokens >= 200, `the child's spend lands on the session tracker (${tracker.getUsage().inputTokens})`);

  const deep = await T.runTask({ description: 'too deep', prompt: 'x', detach: true }, { ...baseOpts, depth: 4 });
  assert(/depth limit/.test(deep), 'the four-level cap applies to background spawns');

  // The session ceiling is measured on the conversation's tracker, not the child's own share.
  scenarios.set('C4C', () => ({ tools: [{ name: 'Glob', args: { pattern: '*' } }] }));
  const session = T.createTokenTracker();
  session.add(5000, 0);
  const capped = await T.runInContext({ cwd, sessionId: 'chat-s4c' }, () => T.runTask(
    { description: 'over budget', prompt: '[[C4C]] spend', subagent_type: 'explore' },
    { ...baseOpts, settings: { ...settings, safetyLimits: { maxTokensPerSession: 1000 } }, tokenTracker: session }));
  assert(/token limit reached/.test(capped), `a child stops at the session ceiling the session already reached (${capped.slice(0, 80)})`);
  assert(!seen.get('C4C')?.length, 'before making a single model call');
});

// ── Cross-session isolation and ids ───────────────────────────────────────

await block('Cross-session isolation; both id spellings work', async () => {
  const hold = gate();
  scenarios.set('C5', async () => { await hold.promise; return { text: `C5 result ${'r'.repeat(400)} END-C5` }; });
  const out = await T.runInContext({ cwd, sessionId: 'chat-A' }, () => T.runTask(
    { description: 'isolated', prompt: '[[C5]] work', detach: true, subagent_type: 'explore' }, baseOpts));
  const id = spawnedId(out);
  await until(() => T.ledger.get(`agent:${id}`));
  const fromB = await T.runInContext({ cwd, sessionId: 'chat-B' }, () => T.executeSupervise({ action: 'list' }));
  assert(!fromB.includes(id), 'another chat does not see it');
  const stopB = await T.runInContext({ cwd, sessionId: 'chat-B' }, () => T.executeSupervise({ action: 'stop', id, reason: 'mine now' }));
  assert(/Not found in this session/.test(stopB), 'and cannot stop it');
  const resumeB = await T.runInContext({ cwd, sessionId: 'chat-B' }, () => T.resumeTask({ resume: id, prompt: 'hi' }, baseOpts));
  assert(/another conversation/.test(resumeB), 'nor resume it');
  const fromA = await T.runInContext({ cwd, sessionId: 'chat-A' }, () => T.executeSupervise({ action: 'list' }));
  assert(fromA.includes(id), 'its own chat does');
  // Waited on by its bare id (what Task printed): the full result comes back from the wait …
  const waiting = T.runInContext({ cwd, sessionId: 'chat-A' }, () => T.executeSupervise({ action: 'wait', id, timeoutSeconds: 20 }));
  await sleep(100);
  hold.open();
  const waited = await waiting;
  assert(waited.includes('END-C5'), 'wait by bare id returns the full result, not a 200-char preview');
  await sleep(300);
  assert(!T.recentReports().some(r => r.content.includes(`Background agent ${id} `)), '… and it is not delivered a second time into the conversation');
});

// ── 3: continue a finished sub-agent ──────────────────────────────────────

await block('3. Resume: a finished agent continues with its own history; a running one is guided', async () => {
  scenarios.set('C6', ({ all }) => all.includes('FOLLOWUP-BAR')
    ? { text: `second answer, earlier I said ${all.includes('FIRST-ANSWER-FOO') ? 'FOO' : 'nothing'}` }
    : { text: 'FIRST-ANSWER-FOO' });
  const first = await T.runInContext({ cwd, sessionId: 'chat-6' }, () => T.runTask(
    { description: 'remember', prompt: '[[C6]] say something', subagent_type: 'explore' }, baseOpts));
  assert(/FIRST-ANSWER-FOO/.test(first), 'first run answered');
  const row = T.ledger.query({ kind: 'agent', sessionId: 'chat-6' }).find(r => r.title === 'remember');
  const id = row.id.slice('agent:'.length);
  const second = await T.runInContext({ cwd, sessionId: 'chat-6' }, () => T.resumeTask({ resume: `agent:${id}`, prompt: 'FOLLOWUP-BAR please' }, baseOpts));
  assert(/earlier I said FOO/.test(second), `the follow-up ran with its prior conversation (${second.slice(0, 60)})`);
  const resumedReq = seen.get('C6').at(-1);
  assert(resumedReq.messages.some(m => m.role === 'assistant' && textOf(m).includes('FIRST-ANSWER-FOO')), 'its earlier answer was in the request, rebuilt from its own log');
  assert(T.ledger.get(`agent:${id}`).state === 'done', 'same id, settled again');

  const hold = gate();
  scenarios.set('C6B', async ({ steps }) => { if (steps === 0) await hold.promise; return { text: 'C6B reply' }; });
  const out = await T.runInContext({ cwd, sessionId: 'chat-6' }, () => T.runTask(
    { description: 'running', prompt: '[[C6B]] work', detach: true, subagent_type: 'explore' }, baseOpts));
  const runningId = spawnedId(out);
  await until(() => seen.get('C6B')?.length);
  const guided = await T.runInContext({ cwd, sessionId: 'chat-6' }, () => T.resumeTask({ resume: runningId, prompt: 'GUIDE-ME-NOW' }, baseOpts));
  assert(/Delivered to running sub-agent/.test(guided), 'a running one gets the follow-up at its next step');
  hold.open();
  await T.detachedRun(runningId);
  assert(seen.get('C6B').some(b => JSON.stringify(b.messages).includes('GUIDE-ME-NOW')), 'and read it');
});

// ── 4: worktrees that isolate and never discard ───────────────────────────

function git(args, dir) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim(); }

await block('4. Worktree: the child works in it; its work is committed to a branch; git runs in the repo', async () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'repo '));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const escape = path.join(repo, 'escape.txt');
  scenarios.set('C7', ({ steps }) => steps === 0
    ? { tools: [
      { name: 'Write', args: { file_path: 'wt-file.txt', content: 'from worktree\n' } },
      { name: 'Write', args: { file_path: escape, content: 'escaped\n' } },
    ] }
    : { text: 'C7 done' });
  const result = await T.runInContext({ cwd: repo, sessionId: 'chat-7' }, () => T.runTask(
    { description: 'isolated edit', prompt: '[[C7]] write a file', isolation: 'worktree', agent_spec: { tools: ['Write', 'Read'] } }, baseOpts));
  assert(!fs.existsSync(path.join(repo, 'wt-file.txt')), 'the parent checkout is untouched');
  assert(!fs.existsSync(escape), 'an absolute path into the parent checkout is refused (write bound)');
  const branch = git(['branch', '--list', 'aico/worktree/*', '--format=%(refname:short)'], repo).split('\n').filter(Boolean)[0];
  assert(Boolean(branch), `a branch was kept (${branch})`);
  assert(branch && git(['show', `${branch}:wt-file.txt`], repo) === 'from worktree', 'uncommitted work was committed to it, not discarded');
  assert(result.includes(branch ?? '?') && /wt-file\.txt/.test(result), 'the parent is told the branch and a diff summary');
  const listed = git(['worktree', 'list', '--porcelain'], repo);
  assert(listed.split('\n').filter(l => l.startsWith('worktree ')).length === 1, 'the worktree itself was removed — by git run in the repo');
  const ours = git(['worktree', 'list', '--porcelain'], ownRepo);
  assert(!ours.includes('wt-file') && !ours.includes(path.basename(repo)), 'and nothing touched the process directory\'s repository');
  const registry = JSON.parse(fs.readFileSync(path.join(home, 'worktrees', 'registry.json'), 'utf8'));
  assert(registry.some(r => r.branch === branch && r.repoRoot), 'the registry is persisted in the store');

  // A commit that fails (a refusing hook) keeps the worktree as it is.
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  scenarios.set('C7B', ({ steps }) => steps === 0
    ? { tools: [{ name: 'Write', args: { file_path: 'kept.txt', content: 'keep me\n' } }] }
    : { text: 'C7B done' });
  const kept = await T.runInContext({ cwd: repo, sessionId: 'chat-7' }, () => T.runTask(
    { description: 'unlucky edit', prompt: '[[C7B]] write', isolation: 'worktree', agent_spec: { tools: ['Write'] } }, baseOpts));
  const keptPath = /Worktree kept at (.+?) \(branch/.exec(kept)?.[1];
  assert(Boolean(keptPath), `a failed commit keeps the worktree and says where (${kept.slice(-160)})`);
  assert(keptPath && fs.readFileSync(path.join(keptPath, 'kept.txt'), 'utf8') === 'keep me\n', 'with the work still in it');
  fs.rmSync(hook);
});

await block('4b. EnterWorktree/ExitWorktree are honest and never discard', async () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'repo2-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const entered = await T.runInContext({ cwd: repo }, () => T.executeEnterWorktree({ agent_id: 'manual' }));
  assert(/unchanged/.test(entered.note), 'it says the working directory is unchanged');
  fs.writeFileSync(path.join(entered.path, 'b.txt'), 'b\n');
  const exited = await T.executeExitWorktree({ worktree_id: entered.worktreeId, keep_branch: false });
  assert(exited.outcome === 'committed' && git(['show', `${entered.branch}:b.txt`], repo) === 'b', 'keep_branch:false no longer throws work away');
});

// ── 5: backgrounded shell commands ────────────────────────────────────────

await block('5. Bash background: non-zero exit is failed, filed under its chat, and reported', async () => {
  const delivered = [];
  T.setReportBackDelivery({ deliver: (req) => { delivered.push(req); return 'queued'; } });
  const command = `node -e "console.log('BG-LINE-1'); setTimeout(() => { console.log('BG-LINE-2'); process.exit(3); }, 6500)"`;
  const res = await T.runInContext({ cwd, sessionId: 'chat-bash' }, () => T.bash({ command, background: true }));
  const pid = res.background?.pid;
  assert(Boolean(pid), 'started in the background');
  assert(T.ledger.get(`proc:${pid}`)?.sessionId === 'chat-bash', 'its ledger row carries the session');
  const row = await until(() => (T.ledger.get(`proc:${pid}`)?.state === 'failed' ? T.ledger.get(`proc:${pid}`) : null), 15_000);
  assert(row?.state === 'failed' && /3/.test(row?.error ?? ''), `exit 3 is failed, with the code (${row?.state} ${row?.error})`);
  const notice = await until(() => delivered.find(d => d.plugin === 'background-command'));
  assert(notice?.sessionId === 'chat-bash' && notice?.wake === false, 'a notice goes to its chat, without waking it');
  assert(/exit code 3/.test(notice?.content ?? '') && /BG-LINE-2/.test(notice?.content ?? ''), 'naming the exit code and its last lines');
  const otherChat = await T.runInContext({ cwd, sessionId: 'chat-other' }, () => T.executeSupervise({ action: 'list', all: true }));
  assert(!otherChat.includes(`proc:${pid}`), 'another chat does not see it');
  T.setReportBackDelivery({ deliver: (req) => runs.reportBack(req) });
});

// ── 7: concurrency, Investigate, children-first stop ─────────────────────

await block('7a. A session cap queues agents instead of refusing them', async () => {
  const hold = gate();
  scenarios.set('C10', async () => { await hold.promise; return { text: 'C10 done' }; });
  const capped = { ...settings, agents: { maxConcurrent: 2 } };
  const ids = [];
  for (const n of [1, 2, 3]) {
    const out = await T.runInContext({ cwd, sessionId: 'chat-10' }, () => T.runTask(
      { description: `slot ${n}`, prompt: `[[C10]] job ${n}`, detach: true, subagent_type: 'explore' }, { ...baseOpts, settings: capped }));
    ids.push(spawnedId(out));
    if (n === 3) assert(/queued/.test(out), 'the third spawn says it is queued');
  }
  await until(() => T.slotState('chat-10').active === 2 && T.slotState('chat-10').queued === 1);
  assert(T.slotState('chat-10').active === 2 && T.slotState('chat-10').queued === 1, 'two run, one waits');
  assert(T.ledger.get(`agent:${ids[2]}`)?.state === 'queued', 'and the ledger says queued');
  hold.open();
  await Promise.all(ids.map(id => T.detachedRun(id)));
  assert(ids.every(id => T.ledger.get(`agent:${id}`)?.state === 'done'), 'all three finish');
  assert(T.slotState('chat-10').active === 0, 'and every slot is given back');
});

await block('7b. Investigate goes through the limiter', async () => {
  let inFlight = 0;
  let peak = 0;
  scenarios.set('INV', async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(150); inFlight--; return { text: 'finding' }; });
  const out = await T.runInContext({ cwd, sessionId: 'chat-inv' }, () => T.investigate(
    { question: '[[INV]] why is it slow', angles: ['the cache layer and eviction', 'network round trips to the API', 'disk writes during startup'] },
    { ...baseOpts, settings: { ...settings, agents: { maxConcurrent: 1 } } }));
  assert(peak === 1, `never more than the cap at once (peak ${peak})`);
  assert((out.match(/finding/g) ?? []).length >= 3, 'and every angle still reports');
});

await block('7c. Stopping a parent stops its children first; Stop reaches earlier detached agents', async () => {
  scenarios.set('P11', ({ steps }) => steps === 0
    ? { tools: [{ name: 'Task', args: { description: 'grandchild', prompt: '[[G11]] hold', detach: true, subagent_type: 'explore' } }] }
    : never);
  scenarios.set('G11', () => never);
  const out = await T.runInContext({ cwd, sessionId: 'chat-11' }, () => T.runTask(
    { description: 'parent agent', prompt: '[[P11]] delegate', detach: true }, baseOpts));
  const parentId = spawnedId(out);
  const child = await until(() => T.ledger.all().find(r => r.parent === `agent:${parentId}`));
  assert(Boolean(child), 'the grandchild\'s ledger row links to its parent');
  await until(() => seen.get('G11')?.length);
  const stopped = await T.runInContext({ cwd, sessionId: 'chat-11' }, () => T.executeSupervise({ action: 'stop', id: parentId, reason: 'enough' }));
  assert(/Stopped 1/.test(stopped), 'stop by bare id');
  const childRow = await until(() => (T.ledger.get(child.id)?.state === 'cancelled' ? T.ledger.get(child.id) : null));
  assert(childRow && /parent agent:\S+ stopped/.test(childRow.error ?? ''), `the child was stopped with its parent, and says so (${childRow?.error})`);

  scenarios.set('C11C', () => never);
  const out2 = await T.runInContext({ cwd, sessionId: 'chat-11b' }, () => T.runTask(
    { description: 'earlier detached', prompt: '[[C11C]] hold', detach: true, subagent_type: 'explore' }, baseOpts));
  const earlier = spawnedId(out2);
  await until(() => seen.get('C11C')?.length);
  assert(runs.cancel('chat-11b') === true, 'Stop on the chat reports it stopped something');
  const row = await until(() => (T.ledger.get(`agent:${earlier}`)?.state === 'cancelled' ? T.ledger.get(`agent:${earlier}`) : null));
  assert(Boolean(row), 'the detached agent an earlier turn spawned is stopped');
});

// ── 6: restart → interrupted → resume, nothing replayed ──────────────────

await block('6. A restart mid-tool: interrupted, resumed from its log, the tool not re-run', async () => {
  const marker = path.join(tmp, 'ran-marker.txt');
  // Forward slashes and single quotes: this goes through a shell, then into JS.
  const cmd = `node -e "require('fs').appendFileSync('${marker.replace(/\\/g, '/')}', 'ran\\n'); setTimeout(() => {}, 60000)"`;
  scenarios.set('C9', ({ all }) => {
    if (all.includes('Resumed after a restart')) {
      return { text: `RESUMED-OK unanswered=${/no result was recorded/.test(all)}` };
    }
    return { tools: [{ name: 'Bash', args: { command: cmd, timeout: 120 } }] };
  });
  const script = `
    const T = await import(${JSON.stringify(pathToFileURL(distTest).href)});
    await T.ledger.load();
    T.startLedgerMirroring();
    const settings = await T.loadSettings();
    await T.runInContext({ cwd: ${JSON.stringify(cwd)}, sessionId: 'chat-9' }, () => T.runTask(
      { description: 'crashy', prompt: '[[C9]] run it', detach: true, agent_spec: { tools: ['Bash', 'Read'] } },
      { model: 'stub/model', autoApprove: true, verbose: false, depth: 0, settings }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let childErr = '';
  child.stderr.on('data', d => { childErr += d; });
  const ran = await until(() => fs.existsSync(marker), 30_000);
  assert(ran, `the other process got as far as running the tool${ran ? '' : ` (${childErr.slice(0, 400)})`}`);
  await sleep(500);
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else {
    child.kill('SIGKILL');
  }
  await sleep(300);
  // This process plays the restarted engine.
  T.ledger.resetForTest();
  await T.ledger.load();
  const row = T.ledger.all().find(r => r.kind === 'agent' && r.title === 'crashy');
  assert(row?.state === 'interrupted', `the agent is interrupted, not lost (${row?.state})`);
  const delivered = [];
  T.setReportBackDelivery({ deliver: (req) => { delivered.push(req); return 'queued'; } });
  const resumed = await T.resumeInterruptedAgents({ settings, model: MODEL });
  assert(resumed.includes(row?.id), 'the boot sweep resumes it');
  const report = await until(() => delivered.find(d => d.sessionId === 'chat-9'), 20_000);
  assert(/RESUMED-OK unanswered=true/.test(report?.content ?? ''), `it continued its conversation, seeing the unanswered call as unanswered (${report?.content?.slice(0, 120)})`);
  assert(fs.readFileSync(marker, 'utf8') === 'ran\n', 'and the tool was not run a second time');
  T.setReportBackDelivery({ deliver: (req) => runs.reportBack(req) });
});

// ── Sub-agent logs are transcripts, not chats ─────────────────────────────

await block('Sub-agent logs stay out of the chat list but open by id', async () => {
  const summaries = await T.listSessionSummaries(cwd);
  assert(summaries.length > 0 && !summaries.some(s => T.isSubAgentSessionId(s.id)), `no sub-* rows in the session list (${summaries.length} listed)`);
  const subLog = fs.readdirSync(path.dirname(T.eventLogPath('sub-x', cwd))).find(f => f.startsWith('sub-'));
  assert(Boolean(subLog), 'while the sub-agent logs are on disk');
  const server = await T.serve({ port: 0, cwd, open: false });
  try {
    const u = new URL(server.url);
    const headers = { 'x-aico-token': u.searchParams.get('token') };
    const listed = await (await fetch(`${u.origin}/api/sessions`, { headers })).json();
    assert(!listed.sessions.some(s => s.id.startsWith('sub-')), 'GET /api/sessions lists none');
    const id = subLog.replace('.events.jsonl', '');
    const res = await fetch(`${u.origin}/api/trajectory?id=${encodeURIComponent(id)}`, { headers });
    assert(res.status === 200, `GET /api/trajectory?id=${id} serves the transcript (${res.status})`);
  } finally {
    await server.close?.();
  }
});

await stub.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
