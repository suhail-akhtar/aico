/**
 * The Tasks panel's engine half (src/work/tasks.ts, the `tasks` route and the
 * `tasks/events` topic).
 *
 * Why a suite of its own: the panel promises a person one list of everything
 * running beside their chats — and a list that silently drops a kind, nests a
 * child under the wrong parent, or shows a secret a command echoed is worse
 * than no list. Each of those has a different source (the ledger, the agent
 * registries, the shell's buffer, the long-job journal, the inbox, the
 * server's open runs), so one place proves them together:
 *
 *   - a delegated sub-agent appears with its model, its brief, its owning chat
 *     and — when another sub-agent started it — its parent, so the tree nests;
 *   - Investigate fan-outs are named by their angle, not "investigate 1/3";
 *   - a backgrounded command shows its command line and output tail, hangs
 *     under the sub-agent that started it, and both are redacted;
 *   - asks (a permission prompt, a question), a long-job proposal and a parked
 *     inbox call come out as "waiting for you" with only the actions their
 *     routes allow — a permission is never approvable from the panel;
 *   - finished rows are bounded, and the model-facing ledger row of a process
 *     is unchanged (no session id added behind its back);
 *   - over HTTP: `GET /api/tasks`, and the topic stream's full frame followed
 *     by a live frame when the ledger changes.
 *
 * Offline and free: settings are emptied and provider keys removed from the
 * environment, so a sub-agent fails at once instead of calling a model.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

// No model may be reached from here: no keys, empty settings.
for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) delete process.env[key];
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');

const T = await import('../dist-test/test-exports.js');

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
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico tasks '));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

T.startLedgerMirroring();
T.startTaskTracking();
const find = (snap, pred) => snap.items.find(pred);

// An obviously fake value shaped like a token, to prove the output is scrubbed.
const FAKE_SECRET = 'ghp_' + 'Q'.repeat(36); // standards-allow: secret

await block('A delegated sub-agent: model, brief, owner and parent', async () => {
  // Spawned from inside another sub-agent's run (`sub-parent1`), which belongs to chat-A.
  T.registerOwnerForTest('sub-parent1', 'chat-A');
  const out = await T.runInContext({ cwd: tmp, sessionId: 'sub-parent1' }, () => T.runTask(
    { description: 'review the parser', prompt: 'Read src/parser.ts and report any bug you can prove.', subagent_type: 'explore' },
    { model: 'glm-5.3-flash', autoApprove: true, verbose: false, depth: 1 },
  ));
  assert(/failed|error/i.test(out), `with no provider it fails fast, offline (got: ${out.slice(0, 80)})`);
  const snap = await until(async () => {
    const s = await T.tasksSnapshot();
    return find(s, i => i.kind === 'subagent' && i.title === 'review the parser' && i.status === 'failed') ? s : null;
  });
  const item = snap && find(snap, i => i.kind === 'subagent' && i.title === 'review the parser');
  assert(Boolean(item), 'the sub-agent is listed as a subagent task, failed');
  assert(item?.model === 'glm-5.3-flash', `with its model (${item?.model})`);
  assert(item?.sessionId === 'chat-A', `owned by the chat that started the chain (${item?.sessionId})`);
  assert(item?.parentId === 'agent:parent1', `and nested under the sub-agent that spawned it (${item?.parentId})`);
  assert(/^sub-/.test(item?.transcriptId ?? ''), 'with a transcript id the trajectory view can open');
  assert(/parser\.ts/.test(item?.detail ?? ''), 'its brief is shown so siblings can be told apart');
  assert(Boolean(item?.error), 'and why it failed');
  assert(item?.endedAt >= item?.startedAt, 'with start and end times');
  assert(item?.agentName === 'explore', `the role stands in for an agent name (${item?.agentName})`);
  assert(!item?.can?.retry, 'retry is not offered when the chat has no run on this server');
  T.setTaskAsksProvider({ asks: () => [], open: (id) => id === 'chat-A' });
  const again = find(await T.tasksSnapshot(), i => i.id === item?.id);
  assert(again?.can?.retry === true, 'and is offered when it does');
  assert(T.sharedTasks.actionsFor(again).join(',') === 'retry,transcript,open-chat', `actions: ${T.sharedTasks.actionsFor(again).join(',')}`);
});

await block('Investigate fan-outs are named by their angle', async () => {
  await T.runInContext({ cwd: tmp, sessionId: 'chat-B' }, () => T.runTask(
    { description: 'investigate 2/3', prompt: 'Overall question: why is it slow?\n\nYour angle, and only this one: the cache layer\n\nReport only what you found.', subagent_type: 'explore' },
    { model: 'glm-5.3-flash', autoApprove: true, verbose: false, depth: 0 },
  ));
  const item = await until(async () => find(await T.tasksSnapshot(), i => i.kind === 'investigate' && i.sessionId === 'chat-B'));
  assert(item?.title === 'Investigate 2/3 — the cache layer', `title: ${item?.title}`);
  assert(!item?.parentId, 'a chat-level fan-out has no parent row');
});

await block('A backgrounded command: command, tail, parent — redacted', async () => {
  let buffer = `listening on http://127.0.0.1:5173\nGITHUB_TOKEN=${FAKE_SECRET}\n\x1b[32mready\x1b[0m in 312 ms\n`;
  const id = T.registerBackgroundProcess({
    pid: 4_000_001, command: `npm run dev -- --token ${FAKE_SECRET}`, kill: () => {},
    startedBy: 'sub-parent1', tail: () => buffer,
  });
  buffer += 'compiled successfully\n';
  const snap = await T.tasksSnapshot();
  const item = find(snap, i => i.id === id);
  assert(item?.kind === 'shell' && item.status === 'running', 'listed as a running shell command');
  assert(item?.parentId === 'agent:parent1' && item?.sessionId === 'chat-A', 'under the sub-agent that started it, in its chat');
  assert(/compiled successfully/.test(item?.output ?? ''), 'the output tail is live, read at snapshot time');
  assert(!JSON.stringify(item).includes(FAKE_SECRET), 'no secret survives in the command, the output or the title');
  assert(/redacted/.test(item?.output ?? '') && /redacted/.test(item?.command ?? ''), 'it is visibly redacted, not dropped');
  assert(!/\x1b\[/.test(item?.output ?? ''), 'terminal colour codes are stripped');
  assert(T.ledger.get(id).sessionId === undefined, 'the ledger row the model reads is unchanged (no session id added)');
  assert(T.sharedTasks.actionsFor(item).includes('stop') && T.sharedTasks.actionsFor(item).includes('copy-command'), 'offers Stop and Copy command');
  T.closeBackgroundProcess(4_000_001, 'Exited 0');
  buffer = 'garbage after exit';
  const done = find(await T.tasksSnapshot(), i => i.id === id);
  assert(done?.status === 'completed' && /compiled successfully/.test(done?.output ?? ''), 'after exit the tail is frozen at its last output');
});

await block('What waits for a person: asks, a proposal, a parked call', async () => {
  T.setTaskAsksProvider({
    asks: () => [
      { type: 'permission', sessionId: 'chat-A', id: 'perm-1', tool: 'Write', detail: 'Write src/app.ts', at: Date.now() - 5000 },
      { type: 'question', sessionId: 'chat-C', question: 'Which branch should I use?' },
    ],
    open: () => true,
  });
  const job = T.proposeLongJob({
    title: 'Build the billing service',
    steps: [{ title: 'Ledger model', acceptance: ['amounts are integer cents'] }, { title: 'Docs', acceptance: ['an invoice renders'] }],
    estimate_hours: 8,
    long_job: { research: 'Users need invoices.', design: 'One service.', cost_usd: 6, budget_usd: 10, budget_hours: 10 },
  }, { sessionId: 'chat-A', cwd: tmp });
  let parkedId;
  try {
    const tool = { name: 'helm_upgrade', sha256: 'test', scope: 'user', def: { name: 'helm_upgrade', effect: 'exec', run: { argv: ['helm', 'upgrade', '{{release}}'] } } };
    const r = T.parkAction({ tool, args: { release: 'web' }, why: 'destructive — a person approves every call', cwd: tmp, agentId: 'bg-1', origin: 'cron', label: 'nightly deploy', sessionId: 'chat-A' });
    parkedId = r.id;
  } catch (err) { console.log(`    (could not park a test action: ${err.message})`); }

  // The disk-backed sources are cached for two seconds.
  await sleep(2100);
  const snap = await T.tasksSnapshot();
  const perm = find(snap, i => i.kind === 'permission');
  assert(perm?.needsYou && perm.status === 'waiting' && perm.sessionId === 'chat-A', 'a pending permission waits for you, in its chat');
  assert(perm?.can?.deny === true && !perm?.can?.approve, 'it can be refused from the panel but never allowed (the chat window decides)');
  assert(T.sharedTasks.actionsFor(perm).join(',') === 'review,deny', `actions: ${T.sharedTasks.actionsFor(perm).join(',')}`);
  const q = find(snap, i => i.kind === 'question');
  assert(q?.needsYou && /branch/.test(q.detail ?? ''), 'a question waits for you with its text');
  const lj = find(snap, i => i.id === `longjob:${job.id}`);
  assert(lj?.needsYou && lj.kind === 'longjob' && lj.todo?.total === 2, 'a long-job proposal waits for you with its milestones');
  assert(lj?.can?.approve === (job.missing.length === 0) && lj?.can?.deny === true, 'approvable only when complete; always declinable');
  if (parkedId) {
    const p = find(snap, i => i.id === `inbox:${parkedId}`);
    assert(p?.needsYou && p.can?.approve && p.can?.deny && /helm upgrade/.test(p.detail ?? ''), 'a parked call waits for you with the exact call');
  } else {
    assert(false, 'a parked call could be created for the test');
  }
  const totals = T.sharedTasks.summarise(snap.items, Date.now());
  assert(totals.waiting >= 3, `totals count what waits (${totals.waiting})`);
  T.setTaskAsksProvider(undefined);
});

await block('Finished rows are bounded', async () => {
  for (let i = 0; i < 180; i++) {
    const id = T.ledger.open({ kind: 'watcher', title: `old watcher ${i}`, origin: 'model' });
    T.ledger.close(id, 'done', 'fired');
  }
  const snap = await T.tasksSnapshot();
  const finished = snap.items.filter(i => !T.sharedTasks.isLive(i.status) && !i.needsYou);
  assert(finished.length <= 150, `at most 150 finished rows (${finished.length})`);
  assert(finished.some(i => i.title === 'old watcher 179'), 'the most recent are the ones kept');
});

await block('Over HTTP: the route and the live topic', async () => {
  const project = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = await T.serve({ port: 0, cwd: project, open: false });
  const u = new URL(server.url);
  const token = u.searchParams.get('token');
  const base = `${u.origin}/api/`;
  const ctl = new AbortController();
  try {
    const res = await fetch(`${base}tasks`, { headers: { 'x-aico-token': token } });
    const body = await res.json();
    assert(res.status === 200 && Array.isArray(body.items) && Array.isArray(body.schedules), 'GET /api/tasks answers with items and schedules');
    assert(body.items.some(i => i.title === 'old watcher 179'), 'and lists what the engine is tracking');
    assert((await fetch(`${base}tasks`)).status !== 200, 'not without the token');

    const frames = [];
    const stream = await fetch(`${base}tasks/events?token=${encodeURIComponent(token)}`, { signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let at;
          while ((at = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, at); buf = buf.slice(at + 2);
            const line = frame.split('\n').find(l => l.startsWith('data: '));
            if (line) frames.push(JSON.parse(line.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
    const full = await until(() => frames.find(f => f.type === 'full'));
    assert(full && Array.isArray(full.data.items), 'the stream opens with a full frame');
    const live = T.ledger.open({ kind: 'watcher', title: 'wait for the build', origin: 'model' });
    const changed = await until(() => frames.find(f => f.type === 'tasks' && f.data.items.some(i => i.id === live)), 5000);
    assert(Boolean(changed), 'a ledger change arrives as a live frame');
    T.ledger.close(live, 'done', 'fired');
    ctl.abort();
    await pump;
  } finally {
    ctl.abort();
    await server.close?.();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
