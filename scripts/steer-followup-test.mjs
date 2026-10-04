/**
 * Steer and Queue during a running turn, end to end and offline.
 *
 * Why a suite of its own: both were reported as "do nothing" from the desktop
 * composer. The engine half is the inbox (session/inbox.ts) and the agent
 * loop's step-boundary drain; this proves, against the real loop and a
 * scripted model (scripts/lib/stub-model.mjs), that a steer sent while a step
 * is in flight reaches the model at the next step, that a queued follow-up
 * runs as its own next turn, and that a queued follow-up can be withdrawn
 * before its turn starts. No key, no network, no cost.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
    await sleep(25);
  }
}
function gate() {
  let open;
  const promise = new Promise(r => { open = r; });
  return { promise, open };
}

// ── The scripted model ─────────────────────────────────────────────────────
let handler = () => ({ text: 'ok' });
const stub = await startStubModel(body => handler({
  body,
  messages: body.messages ?? [],
  steps: (body.messages ?? []).filter(m => m.role === 'assistant').length,
  // The loop appends a reminder after the person's last message; it is not theirs.
  users: (body.messages ?? []).filter(m => m.role === 'user').map(textOf).filter(t => !t.startsWith('# System reminder')),
}));

const home = process.env.AICO_HOME;
const settings = stubSettings(stub.url);
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2));
const T = await import(pathToFileURL(path.resolve('dist-test/test-exports.js')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico steer '));
const cwd = fs.mkdtempSync(path.join(tmp, 'project-'));
const ownRepo = process.cwd();
process.chdir(cwd);
process.on('exit', () => {
  try { process.chdir(ownRepo); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});
const MODEL = 'stub/model';

const hub = new T.EventHub();
const published = [];
const publish = hub.publish.bind(hub);
hub.publish = (e) => { published.push(e); publish(e); };
const runs = new T.RunManager(hub, settings);
runs.defaultModel = async () => MODEL;

const humanMessages = (run) => [...run.session.events]
  .filter(e => e.type === 'user/message' && (e.data.source?.kind ?? 'human') === 'human')
  .map(e => ({ content: e.data.content, turn: e.data.turn }));

await block('A steer sent mid-step reaches the model at the next step; a queued message runs next', async () => {
  const hold = gate();
  const requests = [];
  handler = async ({ steps, users }) => {
    requests.push(users);
    if ((users[users.length - 1] ?? '').includes('[[FOLLOW]]')) return { text: 'FOLLOW-DONE' };
    if (steps === 0) {
      await hold.promise;
      return { tools: [{ name: 'Glob', args: { pattern: '*.none' } }] };
    }
    return { text: users.some(u => u.includes('STEER-X')) ? 'STEERED-ANSWER' : 'UNSTEERED-ANSWER' };
  };

  const done = runs.submit('chat-steer', cwd, '[[MAIN]] do the slow thing', MODEL);
  const run = await until(() => runs.get('chat-steer')?.busy && runs.get('chat-steer'));
  assert(Boolean(run), 'the turn is running');
  await until(() => requests.length >= 1);
  assert(runs.steer('chat-steer', 'STEER-X use the other approach'), 'steer accepted while busy');
  assert(runs.followup('chat-steer', '[[FOLLOW]] and then this'), 'follow-up accepted while busy');
  assert(run.inbox.nextStep.length === 1 && run.inbox.nextTurn.length === 1, 'both are pending in their own queues');
  const frames = () => published.filter(e => e.type === 'inbox' && e.sessionId === 'chat-steer');
  const pendingFrame = frames().at(-1)?.data;
  assert(pendingFrame?.nextStep?.[0]?.content.includes('STEER-X') && pendingFrame?.nextTurn?.[0]?.content.includes('[[FOLLOW]]'),
    'clients are told, live, what is waiting in each queue');
  assert(runs.inboxOf('chat-steer')?.nextTurn.length === 1, 'and a reconnecting client can read the same view');
  const steerId = pendingFrame?.nextStep?.[0]?.id;
  hold.open();
  await done;
  const deliveredFrame = frames().find(f => f.data.delivered?.some(d => d.id === steerId));
  assert(deliveredFrame?.data.delivered.find(d => d.id === steerId)?.step === 2,
    `the steer is reported delivered, at the step that read it (${JSON.stringify(deliveredFrame?.data.delivered)})`);

  const turn1 = [...run.session.events].filter(e => e.type === 'assistant/message').map(e => e.data.content);
  assert(turn1.some(c => /STEERED-ANSWER/.test(c)), 'the next step saw the steer and answered to it');
  assert(requests[1]?.some(u => u.includes('STEER-X')), 'the steer was in the second request, not the first');
  assert(!requests[0]?.some(u => u.includes('STEER-X')), '…and not in the request already in flight');

  const followed = await until(() => [...run.session.events].some(e => e.type === 'assistant/message' && /FOLLOW-DONE/.test(String(e.data.content))));
  assert(Boolean(followed), 'the queued follow-up ran as its own turn');
  await until(() => !run.busy);
  const humans = humanMessages(run);
  const steer = humans.find(h => h.content.includes('STEER-X'));
  const follow = humans.find(h => h.content.includes('[[FOLLOW]]'));
  const main = humans.find(h => h.content.includes('[[MAIN]]'));
  assert(steer && main && steer.turn === main.turn, 'the steer is recorded in the running turn, as the person');
  assert(follow && main && follow.turn > main.turn, 'the follow-up is recorded as the person, in a later turn');
  assert(run.inbox.nextTurn.length === 0 && run.inbox.nextStep.length === 0, 'nothing left pending');
});

await block('Only what the person typed is shown as theirs', async () => {
  const view = T.inboxView({
    nextStep: [{ id: 'a', content: 'mine', source: { kind: 'human' } }, { id: 'b', content: 'report', source: { kind: 'plugin', plugin: 'background-agent' } }],
    nextTurn: [{ id: 'c', content: 'later', source: { kind: 'plugin', plugin: 'long-job' } }],
  });
  assert(view.nextStep.length === 1 && view.nextStep[0].id === 'a' && view.nextTurn.length === 0, 'plugin messages are not drawn as the person\'s');
  assert(T.deliveryStep([{ type: 'turn/start', data: { turn: 1 } }]) === 1, "claimed at a turn's start: read by step 1");
  assert(T.deliveryStep([{ type: 'turn/start', data: {} }, { type: 'step/start', data: { turn: 1, step: 3 } }, { type: 'tool/result', data: {} }]) === 4, 'claimed after step 3: read by step 4');
});

await block('A queued follow-up can be withdrawn before its turn starts', async () => {
  const hold = gate();
  let saw = 0;
  handler = async ({ users }) => {
    if ((users[0] ?? '').includes('[[GONE]]')) { saw++; return { text: 'SHOULD-NOT-RUN' }; }
    await hold.promise;
    return { text: 'MAIN-DONE' };
  };
  const done = runs.submit('chat-cancel', cwd, '[[MAIN2]] slow', MODEL);
  const run = await until(() => runs.get('chat-cancel')?.busy && runs.get('chat-cancel'));
  runs.followup('chat-cancel', '[[GONE]] never mind');
  const id = run.inbox.nextTurn[0]?.id;
  assert(typeof id === 'string', 'the queued message has an id a client can name');
  assert(runs.unqueue('chat-cancel', id) === true, 'withdrawn by id');
  assert(runs.unqueue('chat-cancel', id) === false, 'a second withdraw finds nothing');
  assert(run.inbox.nextTurn.length === 0, 'the queue is empty');
  hold.open();
  await done;
  await sleep(200);
  assert(saw === 0, 'the withdrawn message never ran');
  assert(!published.some(e => e.type === 'inbox' && e.sessionId === 'chat-cancel' && e.data.delivered?.length),
    'a withdrawn follow-up is never reported as delivered');
  const replay = new T.Inbox(run.session);
  assert(replay.nextTurn.length === 0, 'a replay of the log agrees it is gone');
});

await stub.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
