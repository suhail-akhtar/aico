/**
 * The Tasks panel's pure rules (shared/tasks.ts) and the desktop's own rows
 * (renderer/src/tasks/desktop-items.ts), bundled with esbuild and run in Node.
 *
 * Why these and not the component: what a person reads in the panel is
 * decided here — what a tool call is called, how a delegation tree nests,
 * which section a row lands in and in what order, what "This chat" includes,
 * what a filter matches, which controls a row offers, what is announced, and
 * how a terminal command that just ended becomes a finished row. A bug in
 * any of them is a wrong panel with a correct-looking UI.
 *
 *   node scripts/test-tasks.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-tasks-'));
process.on('exit', () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* best effort */ } });

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error' });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const S = await load(path.join(repo, 'shared/tasks.ts'), 'tasks');
const D = await load(path.join(desktop, 'renderer/src/tasks/desktop-items.ts'), 'desktop-items');

const item = (id, over = {}) => ({ id, kind: 'subagent', title: id, status: 'running', startedAt: 1000, ...over });

// ── words ──
console.log('\n── step text ──');
ok(S.humaniseStep('Edit', { file_path: 'E:\\repo\\src\\app\\main.ts' }) === 'Editing app/main.ts', 'Edit names the file by its last two segments', S.humaniseStep('Edit', { file_path: 'E:\\repo\\src\\app\\main.ts' }));
ok(S.humaniseStep('Bash', { command: 'npm   test' }) === 'Running npm test', 'Bash names the command, whitespace folded');
ok(S.humaniseStep('Grep', { pattern: 'TODO' }) === 'Searching for TODO', 'Grep says what it searches for');
ok(S.humaniseStep('Task', { description: 'review auth' }) === 'Delegating: review auth', 'Task says what it delegated');
ok(S.humaniseStep('Read') === 'Reading', 'a tool with no argument still reads as a verb');
ok(S.humaniseStep('mcp__github__list_issues') === 'Using github · list issues', 'an MCP tool reads as a sentence, not an id');
ok(S.humaniseStep('mcp__aico-desktop__browser_click', { text: 'Sign in' }) === 'Browser: click Sign in', 'a desktop browser tool says what it clicks', S.humaniseStep('mcp__aico-desktop__browser_click', { text: 'Sign in' }));
ok(S.humaniseStep('Bash', { command: 'x'.repeat(200) }).length <= 70, 'a long command is clipped');
ok(S.humaniseStep(undefined) === '', 'no tool, no text');

console.log('\n── numbers ──');
ok(S.formatElapsed(4_200) === '4s' && S.formatElapsed(65_000) === '1m 05s' && S.formatElapsed(30 * 60_000 + 26_000) === '30m 26s', 'elapsed: seconds, then minutes with padded seconds', [S.formatElapsed(4_200), S.formatElapsed(65_000)]);
ok(S.formatElapsed(2 * 3_600_000 + 4 * 60_000) === '2h 04m' && S.formatElapsed(-5) === '0s', 'elapsed: hours, and never negative');
ok(S.formatTokens(950) === '950' && S.formatTokens(362_400) === '362.4k' && S.formatTokens(1_250_000) === '1.25M' && S.formatTokens(12_000) === '12k', 'tokens: 950, 362.4k, 1.25M, 12k', [S.formatTokens(362_400), S.formatTokens(1_250_000), S.formatTokens(12_000)]);
ok(S.formatCost(0) === '$0' && S.formatCost(0.0012) === '$0.0012' && S.formatCost(0.123) === '$0.123' && S.formatCost(4.5) === '$4.50', 'cost: as many places as the amount needs');
ok(S.elapsedOf({ startedAt: 1000, endedAt: 4000 }, 99_999) === 3000 && S.elapsedOf({ startedAt: 1000 }, 6000) === 5000, 'elapsed of a finished row is fixed; of a live one, it grows');

// ── tree ──
console.log('\n── delegation tree ──');
{
  const rows = S.buildTaskTree([item('a'), item('b', { parentId: 'a' }), item('c', { parentId: 'b' }), item('d', { parentId: 'a' }), item('e')]);
  ok(rows.map(r => `${r.item.id}${r.depth}`).join(' ') === 'a0 b1 c2 d1 e0', 'children nest under their parent, in order', rows.map(r => `${r.item.id}${r.depth}`));
  const b = rows.find(r => r.item.id === 'b');
  ok(b.last === false && rows.find(r => r.item.id === 'd').last === true, 'siblings know which is last (for the elbow guide)');
  ok(rows.find(r => r.item.id === 'c').guides.join() === 'false,false', 'a grandchild under a non-last parent keeps the guide line', rows.find(r => r.item.id === 'c').guides);
  ok(rows.find(r => r.item.id === 'a').descendants === 3, 'a parent counts every descendant');
  const orphan = S.buildTaskTree([item('x', { parentId: 'gone' })]);
  ok(orphan.length === 1 && orphan[0].depth === 0, 'a child whose parent is not in the list is a root, never hidden');
  const cyc = S.buildTaskTree([item('p', { parentId: 'q' }), item('q', { parentId: 'p' })]);
  ok(cyc.length === 2, 'a parent cycle neither hangs nor loses a row', cyc.map(r => r.item.id));
  const self = S.buildTaskTree([item('s', { parentId: 's' })]);
  ok(self.length === 1 && self[0].depth === 0, 'a row that names itself as parent is a root');
  const folded = S.buildTaskTree([item('a'), item('b', { parentId: 'a' }), item('c', { parentId: 'b' })], new Set(['a']));
  ok(folded.length === 1 && folded[0].descendants === 2, 'collapsing a parent hides its whole subtree and keeps the count');
}

// ── sections ──
console.log('\n── sections and order ──');
{
  const s = S.groupTasks([
    item('run-old', { startedAt: 100 }), item('run-new', { startedAt: 900 }),
    item('ask-late', { needsYou: true, status: 'waiting', startedAt: 800 }), item('ask-early', { needsYou: true, status: 'waiting', startedAt: 200 }),
    item('done-1', { status: 'completed', endedAt: 500 }), item('done-2', { status: 'failed', endedAt: 700 }),
    item('paused', { status: 'paused', startedAt: 50 }),
    item('answered', { needsYou: true, status: 'completed', endedAt: 600 }),
  ]);
  ok(s.waiting.map(i => i.id).join() === 'ask-early,ask-late', 'waiting: oldest first — the longest wait is answered first');
  ok(s.running.map(i => i.id).join() === 'run-new,run-old,paused', 'running: newest first; paused stays with running work', s.running.map(i => i.id));
  ok(s.finished.map(i => i.id).join() === 'done-2,answered,done-1', 'finished: most recently ended first; an answered ask is finished', s.finished.map(i => i.id));
}

// ── filters ──
console.log('\n── filters ──');
{
  const items = [
    item('a', { sessionId: 'chat-1', title: 'Review the parser', model: 'deepseek-v4-flash' }),
    item('a-child', { parentId: 'a', title: 'Grep for TODO' }),
    item('b', { sessionId: 'chat-2', kind: 'shell', title: 'npm run dev', command: 'npm run dev' }),
    item('cron', { kind: 'scheduled', title: 'Nightly report' }),
    item('ask', { kind: 'inbox', sessionId: 'chat-1', title: 'helm_upgrade', needsYou: true, status: 'waiting' }),
  ];
  const chat = S.filterTasks(items, { scope: 'chat', sessionId: 'chat-1' }).map(i => i.id);
  ok(chat.join() === 'a,a-child,ask', 'This chat: its own rows and the children of its rows (which do not name a chat)', chat);
  ok(S.filterTasks(items, { scope: 'chat' }).length === 0, 'This chat with no chat open shows nothing rather than everything');
  ok(S.filterTasks(items, { scope: 'all' }).length === 5, 'All chats includes work with no chat (a cron firing)');
  ok(S.filterTasks(items, { scope: 'all', groups: new Set(['commands']) }).map(i => i.id).join() === 'b', 'a kind chip keeps only its group');
  ok(S.filterTasks(items, { scope: 'all', groups: new Set(['agents', 'asks']) }).length === 3, 'chips combine as OR');
  ok(S.filterTasks(items, { scope: 'all', query: 'deepseek parser' }).map(i => i.id).join() === 'a', 'search matches every word, across title and model');
  ok(S.filterTasks(items, { scope: 'all', query: 'parked' }).map(i => i.id).join() === 'ask', 'search matches the kind label too ("Parked call")');
  const counts = S.countByGroup(items);
  ok(counts.agents === 2 && counts.commands === 1 && counts.jobs === 1 && counts.asks === 1, 'chip counts by group', counts);
}

// ── clearing and totals ──
console.log('\n── clear finished, totals ──');
{
  const items = [item('live', { status: 'running', startedAt: 10 }), item('old', { status: 'completed', endedAt: 100 }), item('new', { status: 'failed', endedAt: 300 })];
  ok(S.applyCleared(items, 200).map(i => i.id).join() === 'live,new', 'clearing hides what ended before the mark, never live work');
  ok(S.applyCleared(items, undefined).length === 3, 'nothing cleared, nothing hidden');
  const now = new Date(2026, 9, 3, 15, 0, 0).getTime();
  const today = new Date(2026, 9, 3, 9, 0, 0).getTime();
  const yesterday = new Date(2026, 9, 2, 22, 0, 0).getTime();
  const t = S.summarise([
    item('x', { startedAt: today, costUsd: 0.25 }),
    item('y', { startedAt: yesterday, costUsd: 9, status: 'completed', endedAt: today }),
    item('lj', { kind: 'longjob', startedAt: today, costUsd: 5 }),
    item('w', { needsYou: true, status: 'waiting', startedAt: today }),
  ], now);
  ok(Math.abs(t.spentTodayUsd - 0.25) < 1e-9, 'spent today: started since midnight; long jobs left out (their spend includes their sub-agents)', t);
  ok(t.running === 2 && t.waiting === 1 && t.finished === 1, 'running, waiting and finished counts', t);
}

// ── actions ──
console.log('\n── actions offered ──');
{
  const a = (it) => S.actionsFor(it).join(',');
  ok(a(item('p', { kind: 'inbox', needsYou: true, status: 'waiting', can: { approve: true, deny: true } })) === 'approve,deny', 'a parked call: Approve and Deny');
  ok(a(item('p', { kind: 'permission', needsYou: true, status: 'waiting', sessionId: 's', can: { deny: true } })) === 'review,deny', 'a permission: answer in chat, or Deny — never Approve here');
  ok(a(item('q', { kind: 'question', needsYou: true, status: 'waiting', sessionId: 's' })) === 'review', 'a question: answer in chat');
  ok(a(item('r', { status: 'running', sessionId: 's', transcriptId: 'sub-r', can: { stop: true } })) === 'stop,transcript,open-chat', 'a running sub-agent: Stop, View transcript, Open chat');
  ok(a(item('j', { kind: 'longjob', status: 'running', can: { stop: true, pause: true } })) === 'pause,stop', 'a running long job: Pause, Stop');
  ok(a(item('j', { kind: 'longjob', status: 'paused', can: { stop: true, resume: true } })) === 'resume,stop', 'a paused long job: Resume, Stop');
  ok(a(item('f', { status: 'failed', can: { retry: true }, transcriptId: 't' })) === 'retry,transcript', 'a failed delegation: Retry (where its chat can take it), transcript');
  ok(a(item('d', { status: 'completed', can: { retry: true } })) === '', 'a completed one is not retried');
  ok(a(item('s', { kind: 'shell', status: 'running', command: 'npm run dev', can: { stop: true } })) === 'stop,copy-command', 'a shell command: Stop, Copy command');
  ok(a(item('t', { kind: 'terminal', status: 'running', can: { stop: true, show: true } })) === 'stop,show', 'a terminal: Stop (Ctrl+C), Show');
  ok(a(item('x', { status: 'completed', can: { stop: true } })) === '', 'nothing stops what has already stopped');
}

// ── notifications ──
console.log('\n── what is announced ──');
{
  const first = [item('a'), item('ask', { needsYou: true, status: 'waiting' })];
  ok(S.taskChanges(undefined, first).length === 0, 'the first snapshot announces nothing (no overnight burst on open)');
  const memo = S.memoOf(first);
  const next = [item('a', { status: 'completed', endedAt: 5 }), item('ask', { needsYou: true, status: 'waiting' }), item('ask2', { needsYou: true, status: 'waiting' })];
  const ch = S.taskChanges(memo, next);
  ok(ch.length === 2 && ch.some(c => c.type === 'finished' && c.item.id === 'a') && ch.some(c => c.type === 'needs-you' && c.item.id === 'ask2'), 'a finish and a new ask are announced; an ask already seen is not', ch.map(c => `${c.type}:${c.item.id}`));
  ok(S.taskChanges(S.memoOf(next), next).length === 0, 'the same snapshot twice announces nothing');
  ok(S.taskChanges(memo, [item('new-done', { status: 'completed' })]).length === 0, 'a row first seen already finished is not announced as finishing');
}

// ── desktop rows ──
console.log('\n── terminals and procedures ──');
{
  let rows = D.terminalItems([{ id: 't1', title: 'pwsh', running: true, lastCommand: 'npm test', owner: 'agent', cwd: 'E:/repo' }, { id: 't2', title: 'bash', running: false }], new Map(), 1000);
  ok(rows.length === 1 && rows[0].id === 'term:t1' && rows[0].status === 'running', 'a tab running a command is a task; an idle tab is not');
  ok(rows[0].title === 'pwsh (agent)' && rows[0].origin === 'model', "the agent's own tab says so");
  ok(rows[0].can.stop && rows[0].can.show && rows[0].ref.terminalId === 't1', 'it can be interrupted and shown');
  const prev = new Map(rows.map(r => [r.id, r]));
  rows = D.terminalItems([{ id: 't1', title: 'pwsh', running: true, owner: 'agent' }], prev, 3000);
  ok(rows[0].startedAt === 1000, 'still running: it keeps its start time, so elapsed keeps counting');
  const prev2 = new Map(rows.map(r => [r.id, r]));
  rows = D.terminalItems([{ id: 't1', title: 'pwsh', running: false, lastExit: 1, lastCommand: 'npm test' }], prev2, 9000);
  ok(rows.length === 1 && rows[0].status === 'failed' && rows[0].endedAt === 9000 && /code 1/.test(rows[0].error), 'when it stops, it becomes a finished row with its exit code', rows[0]);
  const prev3 = new Map(rows.map(r => [r.id, r]));
  rows = D.terminalItems([{ id: 't1', title: 'pwsh', running: false, lastExit: 1 }], prev3, 12000);
  ok(rows.length === 1 && rows[0].status === 'failed', 'the finished row stays on later polls');
  rows = D.terminalItems([{ id: 't1', title: 'pwsh', running: false, exited: true }], new Map(), 1);
  ok(rows.length === 0, 'an exited tab is gone');

  const procs = D.procedureItems([
    { id: 'run-1', name: 'Download invoices', status: 'running', at: 500, done: 2, total: 5, current: 'step 3: open billing' },
    { id: 'run-2', name: 'Renew domain', status: 'waiting_for_user', at: 400, done: 1, total: 4 },
    { id: 'run-3', name: 'Post update', status: 'needs_judgement', at: 300, done: 3, total: 6 },
  ], new Map(), 1000);
  ok(procs[0].status === 'running' && procs[0].todo.done === 2 && procs[0].todo.total === 5 && procs[0].step === 'step 3: open billing', 'a replay shows its step and progress');
  ok(procs[1].needsYou && procs[1].status === 'waiting', 'a replay waiting for the person is in Waiting for you');
  ok(procs[2].status === 'stopped' && procs[2].endedAt === 1000 && /handed back/.test(procs[2].error), 'a step handed back to the agent ends the replay, and says why');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
