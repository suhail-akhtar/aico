/**
 * A scheduled job, from firing to visible outcome, against a real model.
 *
 * The bug this exists to prevent from returning: with `autoApprove` off, a cron
 * job that needed `Write` fell through to an interactive permission prompt,
 * wrote it to a terminal nobody was watching, and blocked on stdin forever. The
 * job never finished and nothing anywhere said why — a scheduled job simply
 * stopped producing anything.
 *
 * Nothing here is mocked. A real scheduler tick, a real background agent, a
 * real provider call, a real ledger file.
 *
 * Run: npm run build && node scripts/cron-live.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-cron-'));
// A ledger of our own, so this never touches the user's running work.
process.env.AICO_WORK_LOG = path.join(workdir, 'work.jsonl');
// A cron store of our own too. Without this the probe would write jobs running
// "every minute" into the user's real store and leave them firing forever.
// Both are set before the import below, because each module reads its path at
// load time.
process.env.AICO_CRON_STORE = path.join(workdir, 'cron.json');

const {
  ledger, cronScheduler, executeCronCreate, executeCronList,
  setWorkStorePath, loadSettings, isTerminalWorkState, executeSupervise,
  startLedgerMirroring,
} = await import('../dist-test/test-exports.js');

setWorkStorePath(path.join(workdir, 'work.jsonl'));
// Production starts this in `initializeFeatures`. Without it the ledger never
// learns about background agents, so cost and the schedule→agent link would be
// missing here for a reason that has nothing to do with cron.
startLedgerMirroring();

async function until(fn, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 500));
  }
  return undefined;
}

try {
  const settings = await loadSettings();

  console.log('\n-- a scheduled job that has to write a file --');
  await cronScheduler.start({
    token: process.env.GITHUB_TOKEN ?? '',
    model: settings.model ?? 'gpt-5.6-luna',
    // The setting under which this used to hang forever.
    autoApprove: false,
    settings: { ...settings, autoApprove: false },
  });

  const job = await executeCronCreate({
    name: 'live cron probe',
    // Every minute — but the probe fires it directly rather than waiting.
    schedule: '* * * * *',
    prompt: 'Create a file called cron-ran.txt in the current directory containing '
      + 'exactly the word SCHEDULED. Use the Write tool, then stop.',
    cwd: workdir,
  });
  check(Boolean(job.id), `created (${job.id})`);
  check(job.permissions === 'full',
    `and defaults to full tool access (${job.permissions}) — nobody can approve `
    + 'anything at 3am, so the alternatives are act or silently do nothing');

  await cronScheduler.runJobNow(job.id);

  console.log('\n-- the firing is a supervised record, not a fire-and-forget --');
  const firing = await until(() =>
    ledger.query({ kind: 'schedule' }).find(r => r.title === 'live cron probe'));
  check(Boolean(firing), `the firing appears in the ledger (${firing?.id})`);
  check(firing?.origin === 'cron', 'tagged as scheduled, so it is traceable to a schedule');

  // It used to close the instant it dispatched, so the ledger showed a
  // scheduled job as done while its work was still going.
  const child = await until(() =>
    ledger.all().find(r => r.parent === firing.id));
  check(Boolean(child), `the agent it started is its child (${child?.id})`);

  console.log('\n-- it runs to a real outcome rather than hanging --');
  const settled = await until(() => {
    const r = ledger.get(firing.id);
    return r && isTerminalWorkState(r.state) ? r : undefined;
  }, 240_000);
  check(Boolean(settled), 'the firing reached a terminal state');
  check(settled?.state === 'done',
    `and finished rather than hanging or being denied (${settled?.state}: `
    + `${(settled?.error ?? settled?.result ?? '').slice(0, 80)})`);
  check(fs.existsSync(path.join(workdir, 'cron-ran.txt')),
    'the file was actually written — a scheduled job that cannot act is useless, '
    + 'and one that hangs is worse');
  // Rolled up from the agent onto the schedule: the cost belongs to the run,
  // and a schedule that reports a run with no price cannot answer "what did
  // last night's job cost?"
  check((settled?.cost?.usd ?? 0) > 0,
    `the schedule carries the run's spend ($${(settled?.cost?.usd ?? 0).toFixed(4)})`);
  if (!fs.existsSync(path.join(workdir, 'cron-ran.txt'))) {
    // Diagnostics rather than a guess: what did the agent actually report?
    const kid = ledger.all().find(r => r.parent === firing.id);
    console.log(`     [diag] agent state=${kid?.state} steps=${kid?.progress?.steps} `
      + `tokens=${kid?.cost?.tokens} err=${JSON.stringify(kid?.error)?.slice(0, 300)}`);
    console.log(`     [diag] result=${JSON.stringify(kid?.result)?.slice(0, 400)}`);
    console.log(`     [diag] files in workdir: ${fs.readdirSync(workdir).join(', ')}`);
  }

  console.log('\n-- the user can see what the last run did --');
  const listed = executeCronList().find(j => j.id === job.id);
  check(Boolean(listed?.lastOutcome),
    `the listing reports the outcome, not just the next fire time (${listed?.lastOutcome?.slice(0, 70)})`);
  check(/^done/.test(listed?.lastOutcome ?? ''), 'and it says done');
  check(listed?.lastRunId === firing.id, 'linked to the firing it describes');

  console.log('\n-- and the orchestrator is offered it until acknowledged --');
  const before = await executeSupervise({ action: 'list' });
  check(before.includes(firing.id),
    'Supervise list carries the scheduled run — cron work has no session, so it '
    + 'must reach whichever conversation asks');
  await executeSupervise({ action: 'ack', id: firing.id });
  const after = await executeSupervise({ action: 'list' });
  check(!after.includes(firing.id), 'and stops once acknowledged');

  console.log('\n-- a run still going does not start a second copy --');
  {
    const long = await executeCronCreate({
      name: 'overlap probe',
      schedule: '* * * * *',
      prompt: 'Count from 1 to 300 in words, one per line. Do not stop early.',
      cwd: workdir,
    });
    await cronScheduler.runJobNow(long.id);
    const first = await until(() =>
      ledger.query({ kind: 'schedule', live: true }).find(r => r.title === 'overlap probe'));
    check(Boolean(first), 'the first run is going');

    await cronScheduler.runJobNow(long.id);
    await new Promise(r => setTimeout(r, 1500));
    const all = ledger.query({ kind: 'schedule' }).filter(r => r.title === 'overlap probe');
    // A job every minute that takes an hour would otherwise stack sixty copies,
    // each making the next slower.
    check(all.length === 1,
      `a second firing is skipped while the first is live (${all.length} firing(s))`);

    await executeSupervise({ action: 'stop', id: first.id, reason: 'probe cleanup' });
    const stopped = await until(() => {
      const r = ledger.get(first.id);
      return r && isTerminalWorkState(r.state) ? r : undefined;
    }, 60_000);
    check(stopped?.state === 'cancelled',
      `stopping the schedule stops the run under it (${stopped?.state})`);
    check(/probe cleanup/.test(stopped?.error ?? ''),
      `recording who stopped it and why (${stopped?.error?.slice(0, 60)}) — a run the `
      + 'user stopped and one that crashed are different, and a listing that cannot '
      + 'tell them apart invites the wrong fix');
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
  console.log(err.stack?.split('\n').slice(1, 4).join('\n'));
} finally {
  // Report first, tidy afterwards.
  console.log(`\ncron (live, real model): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  try { cronScheduler.stop(); } catch { /* not started */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
