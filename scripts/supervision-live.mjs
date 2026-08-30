/**
 * Does supervising a sub-agent actually work against a real model?
 *
 * The offline suite proves the plumbing: a detached spawn returns an id, the
 * promise is recoverable, a rejection stays handled. None of that proves the
 * thing that matters — that a correction reaches a running agent and changes
 * what it does next. Only a real model can show that, because the behaviour
 * under test is the model reading an instruction mid-run and acting on it.
 *
 * So this drives one: a job with several steps, corrected partway through, and
 * checked by what ended up on disk. Files written before the correction should
 * follow the original brief; files after it should follow the new one. That is
 * a claim a mock cannot make.
 *
 *   node scripts/supervision-live.mjs
 *
 * Costs money — a handful of cheap calls on deepseek-v4-flash, routed through
 * OpenRouter. Reads .env like the CLI does.
 */

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  runTask, executeAgentSupervise, detachedRun, getAgentRegistry,
  runInContext, loadSettings, eventLogPath,
} = await import('../dist-test/test-exports.js');

// The DeepSeek platform key in .env is rejected (401), so the same model is
// reached through OpenRouter, whose key works. Same weights, different route.
const MODEL = 'deepseek/deepseek-v4-flash';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); return; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.log('OPENROUTER_API_KEY not set — nothing to test against.');
  process.exit(1);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-supervision-'));
const settings = await loadSettings();
const sessionId = 'live-supervision';

console.log(`\n  workspace: ${cwd}\n`);

const spawned = await runInContext({ cwd, sessionId, settings }, () => runTask(
  {
    description: 'write three planet notes',
    subagent_type: 'general',
    detach: true,
    prompt: [
      'Work in the current directory. Create exactly three files, one at a time,',
      'in this order: one.txt, two.txt, three.txt.',
      'Each file contains a single short sentence about a different PLANET.',
      'Write one file per step — do not batch them into a single call.',
      'When all three exist, reply DONE and stop.',
    ].join(' '),
  },
  { model: MODEL, autoApprove: true, verbose: false, depth: 0, settings },
));

check('a detached spawn returns straight away', /Spawned/.test(spawned), spawned.slice(0, 80));
const agentId = (spawned.match(/sub-agent (\S+),/) || [])[1];
check('and names the agent', Boolean(agentId), spawned.slice(0, 120));

const listed = await runInContext({ cwd, sessionId, settings },
  () => executeAgentSupervise({ action: 'list' }));
check('the supervisor can see it', listed.includes(agentId), listed.slice(0, 160));

/** Wait until the child has done something, so a correction lands mid-run. */
async function waitForProgress(minCalls, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const live = getAgentRegistry().find(a => a.agentId === agentId);
    if (!live || live.status !== 'running') return live;
    if (live.toolCallCount >= minCalls) return live;
    await new Promise(r => setTimeout(r, 400));
  }
  return getAgentRegistry().find(a => a.agentId === agentId);
}

const working = await waitForProgress(1, 90_000);
// Deliberately not an OR against "or it already finished" — that would let a
// child that did nothing at all pass a progress check.
check('it reports real progress while running',
  Boolean(working) && working.toolCallCount > 0,
  working ? `status=${working.status} calls=${working.toolCallCount}` : 'no record');

/*
  What was already on disk when the correction went out.

  Captured rather than assumed. The first attempt asserted that some files
  would predate the correction, and the correction landed at the very first
  step boundary — before anything was written — so the run was correct and the
  check was wrong. A test that depends on where a step boundary happens to fall
  is a test that fails for the wrong reason.
*/
const NAMES = ['one.txt', 'two.txt', 'three.txt'];
const before = new Map(
  NAMES.filter(n => fs.existsSync(path.join(cwd, n)))
    .map(n => [n, fs.readFileSync(path.join(cwd, n), 'utf8')]),
);

// The correction. Deliberately a change of subject rather than a refinement,
// so the effect is unambiguous in the output.
const guided = await runInContext({ cwd, sessionId, settings }, () => executeAgentSupervise({
  action: 'guide',
  agentId,
  message: 'Change of plan from your supervisor: for every file you have NOT yet written, '
    + 'write about an OCEAN instead of a planet. Leave any file you already wrote exactly as it is.',
}));
check('a correction is accepted while it runs',
  /queued|already/i.test(guided), guided.slice(0, 120));

const result = await runInContext({ cwd, sessionId, settings },
  () => executeAgentSupervise({ action: 'wait', agentId, timeoutSeconds: 180 }));
check('waiting returns the result rather than hanging',
  typeof result === 'string' && result.length > 0 && !/Still running/.test(result),
  result.slice(0, 140));
console.log('\n  --- what the sub-agent said ---');
console.log(result.split(/\r?\n/).slice(0, 25).map(l => '  ' + l).join('\n'));
console.log('  --- end ---\n');

// ── What actually landed on disk ────────────────────────────────────

const files = NAMES
  .map(name => ({ name, path: path.join(cwd, name) }))
  .filter(f => fs.existsSync(f.path))
  .map(f => ({ ...f, text: fs.readFileSync(f.path, 'utf8').trim() }));

console.log('');
for (const f of files) console.log(`  ${f.name}: ${f.text.slice(0, 90)}`);
console.log('');

check('the sub-agent did the work', files.length >= 2, `${files.length} file(s) written`);

const OCEAN = /ocean|atlantic|pacific|indian|arctic|southern|antarctic/i;
const ocean = files.filter(f => OCEAN.test(f.text));

// The claim under test. A correction that arrives and is ignored looks exactly
// like one that never arrived, so the evidence has to be in the output.
check('the correction changed what it wrote next',
  ocean.length > 0,
  ocean.length === 0
    ? 'no file mentions an ocean — the guidance did not take effect'
    : `${ocean.length} of ${files.length} switched`);

// The other half of the instruction: leave finished work alone. Measured
// against what actually existed when the correction was sent, which may be
// nothing — a correction that arrives before any work is done should change
// everything, and that is not a violation.
const rewritten = [...before.entries()]
  .filter(([name, text]) => fs.existsSync(path.join(cwd, name))
    && fs.readFileSync(path.join(cwd, name), 'utf8') !== text)
  .map(([name]) => name);
check('and it left alone the files that already existed when it was corrected',
  rewritten.length === 0,
  `${before.size} file(s) predated the correction; rewritten: ${rewritten.join(', ') || 'none'}`);
console.log(`  (${before.size} file(s) existed when the correction was sent)`);

// ── The child's own transcript ──────────────────────────────────────

const subLog = eventLogPath(`sub-${agentId}`, cwd);
check('the sub-agent kept its own log beside the conversation', fs.existsSync(subLog), subLog);
if (fs.existsSync(subLog)) {
  const lines = fs.readFileSync(subLog, 'utf8').split(/\r?\n/).filter(Boolean);
  const types = lines.map(l => { try { return JSON.parse(l).type; } catch { return ''; } });
  check('the log records the child\'s tool calls', types.includes('tool/call'),
    `types: ${[...new Set(types)].join(', ').slice(0, 120)}`);
  // The supervisor's message is on the record as a plugin message, not as
  // something a person typed — the same distinction the transcript relies on.
  const spliced = lines.some(l => l.includes('inbox/spliced') && l.includes('supervisor'));
  check('and that the correction came from the supervisor', spliced,
    'no supervisor splice found in the child log');
}

check('nothing is left steerable once it is done',
  detachedRun(agentId) !== undefined, 'the result is still collectable');

console.log(`\n  supervision (live): ${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`    FAIL ${f}`);
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
