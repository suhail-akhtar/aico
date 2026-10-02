/**
 * Long jobs (src/longjob, tools/long-job.ts, the ProposePlan sizing step).
 *
 * Why a suite of its own: the gate is a promise to the owner — "a job over
 * a few hours does not start without my explicit yes, and once started it
 * stops at the budget" — and each half of it lives in a different place
 * (the agent loop, a guard, a server route, the run manager's turn end). One
 * place proves them together.
 *
 * What each block proves:
 *   - the threshold: at or below it nothing changes (a short plan, then a
 *     write, run as today); above it the plan becomes a proposal, the turn
 *     ends on it, and nothing that writes runs until a person answers;
 *   - an incomplete proposal blocks just the same and cannot be approved;
 *   - approval needs a person: the API token alone is refused, the agent's
 *     shell cannot reach the route, a chat message does nothing;
 *   - the acceptance gate: a milestone closes only with evidence for every
 *     criterion and the project's checks green;
 *   - the loop between turns: continue while criteria are unmet, stop at the
 *     budget, pause on cancel and when nothing moves;
 *   - the journal survives a simulated crash (fresh read, torn last line) and
 *     a restart resumes running jobs from it; pause/resume/stop; the report.
 *
 * Offline and free; nothing touches ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico longjob '));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

/** A provider that plays fixed steps and records what it was offered. */
function mock(steps, seen = { calls: 0, tools: [] }) {
  return {
    id: 'mock', displayName: 'Mock',
    async *chat(opts) {
      seen.tools.push((opts.tools ?? []).map(t => t.name));
      const step = steps[Math.min(seen.calls++, steps.length - 1)];
      for (const ev of step) yield ev;
    },
  };
}
const calls = (...list) => [
  ...list.map(([name, input], i) => [{ type: 'tool_call', id: `c${i}-${name}`, name, input }, { type: 'finish', reason: 'tool_calls' }]),
  [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
];
const SETTINGS = { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, deferTools: false };
async function turn(sessionId, steps, seen) {
  const session = new T.Session({ id: sessionId, cwd: tmp, startedAt: Date.now() });
  await T.runAgent({
    task: 'go', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId, session, provider: mock(steps, seen), settings: SETTINGS, cwd: tmp,
  });
  return session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
}
const file = (name) => path.join(tmp, name);
const PROPOSAL = {
  title: 'Build the billing service',
  steps: [
    { title: 'Ledger model', acceptance: ['amounts are integer cents', 'tests cover rounding'] },
    { title: 'E2E verification and docs', acceptance: ['an invoice renders end to end'] },
  ],
  estimate_hours: 8,
  long_job: { research: 'Users need invoices; Stripe-like flows.', design: 'One service, a ledger table.', cost_usd: 6, budget_usd: 10, budget_hours: 10 },
};
const human = { no: async () => ({ ok: false, reason: 'no person' }), yes: async () => ({ ok: true, via: 'ui-key' }) };
const started = [];
T.setLongJobHost({ start: (sid, msg) => started.push({ sid, msg }), cancel: () => {} });

// ═══════════════════════════════════════════════════════════════════════
await block('Threshold: short work runs as today', async () => {
  assert(!T.isLongEstimate(2) && !T.isLongEstimate(3) && T.isLongEstimate(3.5), 'default threshold 3h: 2h and 3h are normal, 3.5h is long');
  assert(!T.isLongEstimate(8, { longJobs: { thresholdHours: 10 } }) && T.thresholdHours({ longJobs: { thresholdHours: 10 } }) === 10, 'the threshold is configurable');
  assert(!T.isLongEstimate('soon') && !T.isLongEstimate(undefined), 'no estimate is not a long job');
  const seen = { calls: 0, tools: [] };
  const r = await turn('short-1', calls(['ProposePlan', { title: 'Fix a typo', steps: [{ title: 'edit' }], estimate_hours: 0.2 }], ['Write', { file_path: file('short.txt'), content: 'ok' }]), seen);
  assert(fs.existsSync(file('short.txt')), 'a short estimate does not stop the work (the write ran)');
  assert(r.some(x => /Plan recorded/.test(x)) && T.listLongJobs({ sessionId: 'short-1' }).length === 0, 'an ordinary plan, and no long job recorded');
  assert(!seen.tools[0].includes('LongJob'), 'LongJob is not offered to an ordinary session (schema budget flat)');
});

let jobId;
await block('Long estimate: a proposal, and nothing runs', async () => {
  const seen = { calls: 0, tools: [] };
  const r = await turn('long-1', calls(['ProposePlan', PROPOSAL], ['Write', { file_path: file('early.txt'), content: 'x' }]), seen);
  const job = T.pendingJob('long-1');
  jobId = job?.id;
  assert(job && job.status === 'pending' && job.missing.length === 0, 'a complete, pending long-job proposal is recorded');
  assert(job.research && job.design && job.milestones.length === 2 && job.milestones[0].acceptance.length === 2 && job.budget.usd === 10 && job.budget.hours === 10,
    'with research, design, milestones and their acceptance criteria, and the budget');
  assert(r.some(x => /long-job proposal/.test(x) && /a chat message does not approve it/.test(x)), 'the model is told it is a proposal a person must approve');
  assert(seen.calls === 1 && !fs.existsSync(file('early.txt')), 'the turn ended on the proposal: the next step (a write) never ran');
});

await block('While pending: the guard refuses writes; reads still work', async () => {
  fs.writeFileSync(file('readme.txt'), 'hello');
  const r = await turn('long-1', calls(['Read', { file_path: file('readme.txt') }], ['Write', { file_path: file('sneaky.txt'), content: 'x' }], ['Bash', { command: 'node -e "require(\'fs\').writeFileSync(\'sneaky2.txt\',\'x\')"' }]));
  assert(r.some(x => /hello/.test(x)), 'a read runs');
  assert(!fs.existsSync(file('sneaky.txt')) && !fs.existsSync(path.join(tmp, 'sneaky2.txt')), 'a write and a writing command are refused');
  assert(r.filter(x => /waiting for the person to approve or decline/.test(x)).length === 2, 'each refusal names the waiting proposal');
  const lower = await turn('long-1', calls(['ProposePlan', { title: 'Smaller', steps: [{ title: 'a' }], estimate_hours: 1 }], ['Write', { file_path: file('sneaky3.txt'), content: 'x' }]));
  assert(!fs.existsSync(file('sneaky3.txt')) && lower.some(x => /still waiting for the person/.test(x)) && T.pendingJob('long-1')?.id === jobId,
    'a smaller re-estimate does not clear the gate');
});

await block('Approval needs a person, never the token', async () => {
  const r1 = await T.handleSystemRoute('longjob/decide', 'POST', { id: jobId, decision: 'approve' }, new URLSearchParams(), human.no);
  assert(r1.status === 403 && r1.body.code === 'human-required' && T.getLongJob(jobId).status === 'pending', 'the API token alone is refused; still pending');
  assert(/BLOCKED/.test(T.shellDenial('curl -X POST -H "x-aico-token: abc" http://127.0.0.1:7340/api/longjob/decide -d "{}"') ?? ''), 'the agent\'s shell cannot drive the route');
  await turn('long-1', calls(['Write', { file_path: file('after-chat.txt'), content: 'x' }]));
  assert(!fs.existsSync(file('after-chat.txt')) && T.getLongJob(jobId).status === 'pending', 'a "go ahead" turn changes nothing');
  const list = await T.handleSystemRoute('longjob/list', 'GET', {}, new URLSearchParams('sessionId=long-1'), human.no);
  assert(list.status === 200 && list.body.jobs[0].id === jobId, 'listing is a read');
  const bad = await T.handleSystemRoute('longjob/decide', 'POST', { id: jobId, decision: 'yes' }, new URLSearchParams(), human.yes);
  assert(bad.status === 400, 'an unknown decision is a 400');
});

await block('An incomplete proposal blocks and cannot be approved', async () => {
  await turn('long-2', calls(['ProposePlan', { title: 'Rewrite it all', steps: [{ title: 'everything' }], estimate_hours: 40 }]));
  const job = T.pendingJob('long-2');
  assert(job && job.missing.some(m => /research/.test(m)) && job.missing.some(m => /acceptance/.test(m)) && job.missing.some(m => /budget_usd/.test(m)), 'what is missing is recorded');
  const r = await T.handleSystemRoute('longjob/decide', 'POST', { id: job.id, decision: 'approve' }, new URLSearchParams(), human.yes);
  assert(r.status === 409 && /incomplete/.test(r.body.message) && T.getLongJob(job.id).status === 'pending', 'even a person cannot approve it');
  const d = await T.handleSystemRoute('longjob/decide', 'POST', { id: job.id, decision: 'decline' }, new URLSearchParams(), human.no);
  assert(d.status === 200 && T.getLongJob(job.id).status === 'declined', 'declining needs no proof');
  await turn('long-2', calls(['Write', { file_path: file('after-decline.txt'), content: 'x' }]));
  assert(fs.existsSync(file('after-decline.txt')), 'after a decline the session works normally again');
});

await block('A person approves: the job starts with milestone 1', async () => {
  started.length = 0;
  const r = await T.handleSystemRoute('longjob/decide', 'POST', { id: jobId, decision: 'approve' }, new URLSearchParams(), human.yes);
  const job = T.getLongJob(jobId);
  assert(r.status === 200 && job.status === 'running' && job.decidedVia === 'ui-key', 'approved, with the channel recorded');
  assert(started.length === 1 && started[0].sid === 'long-1' && /Milestone 1\/2: Ledger model/.test(started[0].msg) && /amounts are integer cents/.test(started[0].msg),
    'a turn is started with the first milestone and its criteria');
  assert(T.ledger.get(jobId)?.state === 'running' && /M1\/2/.test(T.ledger.get(jobId)?.progress?.note ?? ''), 'the Activity row shows the job and its milestone');
  const again = await T.handleSystemRoute('longjob/decide', 'POST', { id: jobId, decision: 'approve' }, new URLSearchParams(), human.yes);
  assert(again.status === 409, 'a second approval is refused');
});

await block('Acceptance gate: evidence for each criterion, checks green', async () => {
  fs.writeFileSync(file('package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(1)"' } }));
  const seen = { calls: 0, tools: [] };
  const r = await turn('long-1', calls(
    ['LongJob', { action: 'complete_milestone', evidence: ['cents everywhere'] }],
    ['LongJob', { action: 'complete_milestone', evidence: ['cents everywhere', 'rounding tests pass'] }],
    ['LongJob', { action: 'decision', text: 'Integer cents, not floats: no rounding drift.' }],
  ), seen);
  assert(seen.tools[0].includes('LongJob'), 'LongJob is offered once the session has an approved job');
  assert(r.some(x => /no evidence for criterion 2/.test(x)), 'a missing piece of evidence is refused');
  assert(r.some(x => /checks do not pass/.test(x)) && !T.getLongJob(jobId).milestones[0].doneAt, 'red checks keep the milestone open');
  fs.writeFileSync(file('package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }));
  const ok = await turn('long-1', calls(['LongJob', { action: 'complete_milestone', evidence: ['cents everywhere', 'rounding tests pass'] }]));
  const job = T.getLongJob(jobId);
  assert(ok.some(x => /Milestone 1 closed/.test(x) && /Next — milestone 2\/2/.test(x)) && job.milestones[0].doneAt && /PASSED|passed/i.test(job.milestones[0].checks ?? ''),
    'green checks and full evidence close it, and the checks result is journalled');
  assert(job.decisions.some(d => /Integer cents/.test(d.text)), 'decisions are journalled');
});

await block('Between turns: continue, then pause when nothing moves', async () => {
  const next = T.afterLongJobTurn('long-1', { usd: 0.5, ms: 60_000 });
  assert(/Milestone 2\/2: E2E verification and docs/.test(next ?? '') && /\$0\.50 of \$10/.test(next ?? ''), 'unmet criteria: the next turn is queued with the current milestone and spend');
  let last;
  for (let i = 1; i < T.NO_PROGRESS_TURNS; i++) last = T.afterLongJobTurn('long-1', { usd: 0.1, ms: 1000 });
  assert(last === undefined && T.getLongJob(jobId).status === 'paused' && /closed no milestone/.test(T.getLongJob(jobId).note), `${T.NO_PROGRESS_TURNS} turns without a milestone: paused for a person`);
  assert(T.ledger.get(jobId)?.state === 'blocked', 'the Activity row shows it waiting');
  const noPerson = await T.handleSystemRoute('longjob/control', 'POST', { id: jobId, action: 'resume' }, new URLSearchParams(), human.no);
  assert(noPerson.status === 403, 'resuming (spending again) needs a person');
  started.length = 0;
  const res = await T.handleSystemRoute('longjob/control', 'POST', { id: jobId, action: 'resume' }, new URLSearchParams(), human.yes);
  assert(res.status === 200 && T.getLongJob(jobId).status === 'running' && started.length === 1 && /Resumed by the person/.test(started[0].msg), 'a person resumes it');
  const cancelled = T.afterLongJobTurn('long-1', { usd: 0.1, ms: 1000, cancelled: true });
  assert(cancelled === undefined && T.getLongJob(jobId).status === 'paused', 'a cancelled turn pauses the job');
  await T.handleSystemRoute('longjob/control', 'POST', { id: jobId, action: 'resume' }, new URLSearchParams(), human.yes);
});

await block('Crash: the journal is the record, and a restart resumes', async () => {
  const dir = path.dirname(T.longJobReportFile(T.getLongJob(jobId)));
  const journal = path.join(dir, `${jobId}.jsonl`);
  fs.appendFileSync(journal, '{"t":"turn","at":1,"usd":');   // a torn write mid-crash
  const job = T.getLongJob(jobId);
  assert(job.status === 'running' && job.milestones[0].doneAt && !job.milestones[1].doneAt && job.spentUsd >= 0.89, 'a fresh read folds the journal: running, milestone 1 done, spend kept — the torn line ignored');
  T.ledger.close(jobId, 'lost', 'Interrupted — aico restarted');   // what the ledger does on boot
  started.length = 0;
  const n = T.resumeAfterRestart();
  assert(n === 1 && started.length === 1 && started[0].sid === 'long-1' && /AICO restarted; resuming from the journal/.test(started[0].msg) && /Milestone 2\/2/.test(started[0].msg),
    'the running job resumes at its open milestone');
  assert(T.ledger.get(jobId)?.state === 'running', 'and its Activity row is back');
  assert(T.getLongJob(jobId).decisions.some(d => /Resumed from the journal/.test(d.text)), 'an event written after the torn line is not lost with it');
});

await block('Budget: the loop stops at the approved cap', async () => {
  const before = T.getLongJob(jobId).spentUsd;
  const r = T.afterLongJobTurn('long-1', { usd: 10 - before, ms: 1000 });
  const job = T.getLongJob(jobId);
  assert(r === undefined && job.status === 'budget' && /approved budget/.test(job.note), 'spend reaching the budget stops the job; no next turn');
  assert(T.ledger.get(jobId)?.state === 'cancelled', 'the Activity row is closed');
  assert(fs.existsSync(T.longJobReportFile(job)) && /Stopped at the approved budget|budget/.test(fs.readFileSync(T.longJobReportFile(job), 'utf8')), 'a report is written');
  const res = await T.handleSystemRoute('longjob/control', 'POST', { id: jobId, action: 'resume' }, new URLSearchParams(), human.yes);
  assert(res.status === 409, 'a job at its budget cannot resume without a new proposal');
});

await block('A tiny job runs to done, with its report', async () => {
  await turn('long-3', calls(['ProposePlan', { ...PROPOSAL, title: 'Tiny', steps: [{ title: 'One', acceptance: ['it works'] }] }]));
  const id = T.pendingJob('long-3').id;
  T.decideLongJob(id, 'approve', 'ui-key');
  await turn('long-3', calls(['LongJob', { action: 'complete_milestone', evidence: ['ran it: works'] }]));
  const job = T.getLongJob(id);
  assert(job.status === 'done', 'the last milestone closes the job');
  const report = fs.readFileSync(T.longJobReportFile(job), 'utf8');
  assert(/Status: \*\*done\*\*/.test(report) && /Evidence: ran it: works/.test(report) && /Research and requirements/.test(report), 'the report carries the proposal, the milestones and the evidence');
  assert(T.afterLongJobTurn('long-3', { usd: 0.25, ms: 1 }, id) === undefined, 'a done job queues nothing');
  assert(T.getLongJob(id).spentUsd === 0.25 && /Spent: \$0\.25/.test(fs.readFileSync(T.longJobReportFile(job), 'utf8')),
    'the turn that closed the last milestone is still counted, and the report rewritten (found live)');
  assert(T.ledger.get(id)?.state === 'done', 'the Activity row ends done');
});

await block('Pause and stop are always allowed; sub-agent ceiling', async () => {
  await turn('long-4', calls(['ProposePlan', { ...PROPOSAL, title: 'Stoppable' }]));
  const id = T.pendingJob('long-4').id;
  T.decideLongJob(id, 'approve', 'ui-key');
  const p = await T.handleSystemRoute('longjob/control', 'POST', { id, action: 'pause' }, new URLSearchParams(), human.no);
  assert(p.status === 200 && T.getLongJob(id).status === 'paused', 'pause needs no proof');
  const s = await T.handleSystemRoute('longjob/control', 'POST', { id, action: 'stop' }, new URLSearchParams(), human.no);
  assert(s.status === 200 && T.getLongJob(id).status === 'stopped' && fs.existsSync(T.longJobReportFile(T.getLongJob(id))), 'stop needs no proof and writes the report');
  assert(T.subAgentMaxMs() === 60 * 60_000 && T.subAgentMaxMs({ longJobs: { subAgentMaxMinutes: 120 } }) === 120 * 60_000, 'sub-agent ceiling inside a long job: 60 min default, configurable');
});

console.log(`\n  LONG JOBS: ${passed} passed, ${failed} failed\n`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); }
process.exit(failed > 0 ? 1 : 0);
