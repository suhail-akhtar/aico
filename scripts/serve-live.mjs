/**
 * The daemon path: cron and boot reconciliation under `aico serve`.
 *
 * Everything else is tested in-process. That is not the same thing, and the
 * difference is exactly where wiring bugs live: `initializeFeatures` is what
 * loads the ledger, starts the mirror, starts the supervisor and starts the
 * scheduler, and none of those is exercised by importing a module directly.
 * A cron probe that drives the scheduler by hand proves the scheduler; it does
 * not prove that anything ever *starts* it.
 *
 * Two things, both against a real server process:
 *
 *   1. A scheduled job fires on the daemon's own tick — nobody calls
 *      `runJobNow` — runs, and reports its outcome through the HTTP API.
 *   2. Boot reconciliation settles what a previous process left behind, in
 *      both directions: a pid that is still alive is *recovered* and left
 *      running; a pid that is gone is marked *lost*. The recovered branch is
 *      the one that only shows up here — it is unreachable through a graceful
 *      shutdown, because that deliberately kills the children first.
 *
 * Run: npm run build && node scripts/serve-live.mjs
 */

import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const entry = path.join(root, 'dist', 'index.js');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

if (!fs.existsSync(entry)) {
  console.error(`\nNo build at ${entry}. Run: npm run build\n`);
  process.exit(1);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-serve-live-'));
const workLog = path.join(workdir, 'work.jsonl');
const cronStore = path.join(workdir, 'cron.json');
const servers = [];
const strays = [];

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * Start a server and resolve once it prints its URL.
 *
 * `port` may be omitted, which is not the same as passing one: an explicit
 * `--port` makes a clash fail loudly, while the default falls back to a free
 * one. Both paths need exercising, so the flag is only added when asked for.
 *
 * The port is read back out of the printed URL rather than assumed, because on
 * the fallback path it is not the number that was requested.
 */
function startServe(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const label = port ?? `auto-${servers.length}`;
    const logFile = path.join(workdir, `serve-${label}.log`);
    const out = fs.openSync(logFile, 'a');
    const args = [entry, 'serve', '--no-open'];
    if (port) args.push('--port', String(port));

    const proc = spawn(process.execPath, args, {
      cwd: workdir,
      stdio: ['ignore', out, out],
      env: { ...process.env, AICO_WORK_LOG: workLog, AICO_CRON_STORE: cronStore, ...extraEnv },
    });
    servers.push(proc);

    const deadline = Date.now() + 90_000;
    const poll = setInterval(() => {
      const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(text);
      if (match) {
        clearInterval(poll);
        resolve({
          proc, token: match[2], port: Number(match[1]),
          log: () => fs.readFileSync(logFile, 'utf8'),
        });
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`server (${label}) never became ready:\n${text.slice(-500)}`));
      }
    }, 500);
  });
}

async function apiSystem(s) {
  const res = await fetch(`http://127.0.0.1:${s.port}/api/system`, {
    headers: { 'x-aico-token': s.token },
  });
  return res.json();
}

async function until(fn, timeoutMs = 200_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 2000));
  }
  return undefined;
}

try {
  console.log('\n-- a scheduled job fires on the daemon\'s own tick --');
  {
    // Written before the server starts, so the scheduler loads it at boot the
    // way it would load a job the user created yesterday. Nothing in this probe
    // calls runJobNow: the point is that the daemon fires it by itself.
    fs.writeFileSync(cronStore, JSON.stringify({
      version: 1,
      jobs: [{
        id: 'serve-probe-job',
        name: 'daemon tick probe',
        schedule: '* * * * *',
        prompt: 'Reply with exactly the single word TICKED. No tools, no explanation.',
        cwd: workdir,
        permissions: 'readonly',
        status: 'enabled',
        createdAt: Date.now(),
        runCount: 0,
      }],
    }, null, 2));

    const s = await startServe(7451);
    check(/AICO is serving/.test(s.log()), 'the server came up');

    // The scheduler ticks every 30s and the job is due every minute, so this is
    // at most ~90s of waiting plus the run itself.
    const firing = await until(async () => {
      const sys = await apiSystem(s);
      return (sys.work ?? []).find(w => w.kind === 'schedule');
    }, 200_000);
    check(Boolean(firing), `the daemon fired it unprompted (${firing?.id})`);
    check(firing?.origin === 'cron', 'recorded as scheduled work');

    const settled = await until(async () => {
      const sys = await apiSystem(s);
      const row = (sys.work ?? []).find(w => w.kind === 'schedule');
      return row && ['done', 'failed', 'cancelled', 'lost'].includes(row.state) ? row : undefined;
    }, 240_000);
    check(settled?.state === 'done',
      `and it ran to a real outcome rather than hanging (${settled?.state}: `
      + `${(settled?.outcome ?? '').slice(0, 60)})`);
    // The whole point of the permission work: under the daemon, with nobody to
    // ask, a job still finishes instead of blocking on a prompt nobody sees.
    check((settled?.costUsd ?? 0) > 0,
      `with the run's spend rolled onto the schedule ($${(settled?.costUsd ?? 0).toFixed(4)})`);

    const sys = await apiSystem(s);
    const job = (sys.cron ?? []).find(j => j.id === 'serve-probe-job');
    check(Boolean(job?.lastOutcome),
      `and the job listing reports what the run did (${job?.lastOutcome?.slice(0, 60)})`);
    check(/^done/.test(job?.lastOutcome ?? ''), 'not merely when the next one is due');

    s.proc.kill();
    await new Promise(r => { s.proc.on('exit', r); setTimeout(r, 8000); });
  }

  console.log('\n-- boot reconciliation, both directions --');
  {
    // A process that is genuinely alive and genuinely not ours, so the pid check
    // is answering a real question. Started outside aico on purpose: a child of
    // the server would be killed by its shutdown hook, which is correct
    // behaviour and would make the "recovered" branch untestable.
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore',
    });
    survivor.unref();
    strays.push(survivor.pid);
    await new Promise(r => setTimeout(r, 500));

    const now = Date.now();
    const rows = [
      { id: 'proc:alive', kind: 'process', title: 'a server that outlived us', state: 'running',
        origin: 'model', startedAt: now - 60_000, heartbeatAt: now - 60_000,
        pid: survivor.pid, reported: false },
      { id: 'proc:dead', kind: 'process', title: 'a server that did not', state: 'running',
        origin: 'model', startedAt: now - 60_000, heartbeatAt: now - 60_000,
        pid: 999_999, reported: false },
      { id: 'agent:inflight', kind: 'agent', title: 'an agent mid-run', state: 'running',
        origin: 'model', startedAt: now - 60_000, heartbeatAt: now - 60_000, reported: false },
    ];
    fs.writeFileSync(workLog,
      rows.map(record => JSON.stringify({ t: 'add', at: now, record })).join('\n') + '\n');

    const s = await startServe(7452);
    check(/still running from a previous session/.test(s.log()),
      'the boot log says what it recovered');
    check(/interrupted by a restart/.test(s.log()),
      'and what it could not — a crash used to leave no trace at all');

    const sys = await apiSystem(s);
    const byId = Object.fromEntries((sys.work ?? []).map(w => [w.id, w]));

    check(byId['proc:alive']?.state === 'running',
      `a process whose pid is still alive is left running (${byId['proc:alive']?.state})`);
    check(byId['proc:dead']?.state === 'lost',
      `a process whose pid is gone is lost (${byId['proc:dead']?.state})`);
    check(/gone when aico restarted/i.test(byId['proc:dead']?.outcome ?? ''),
      'saying so, rather than just ending');
    check(byId['agent:inflight']?.state === 'lost',
      'an agent is lost without a pid check — it lived in the process that died');
    check(/Interrupted/i.test(byId['agent:inflight']?.outcome ?? ''),
      `and says why (${byId['agent:inflight']?.outcome?.slice(0, 50)})`);

    // Recovered work must be supervisable, not merely visible: it is the case
    // where the only handle on the process is the pid in the log.
    const stopRes = await fetch(`http://127.0.0.1:${s.port}/api/work/stop`, {
      method: 'POST',
      headers: { 'x-aico-token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'proc:alive', reason: 'probe cleanup' }),
    }).then(r => r.json());
    check(stopRes.state === 'cancelled', 'a recovered process can be stopped from the panel');

    s.proc.kill();
    await new Promise(r => { s.proc.on('exit', r); setTimeout(r, 8000); });
  }
  console.log('\n-- a busy port is handled, not fatal --');
  {
    /*
      `listen` had no error handler at all, so a second `aico serve` — or a
      first one after a crash left the port held — died with an unhandled
      EADDRINUSE and exit code 1, saying nothing a user could act on.

      The VS Code extension found it, because it starts a server for you: "the
      port is already busy" is its normal case rather than an edge one.
    */
    const first = await startServe();
    check(Boolean(first.token), `one server is up on ${first.port}`);

    // Also without --port, so this must fall back rather than die.
    const second = await startServe();
    check(Boolean(second.token), 'a second start succeeds instead of exiting 1');
    check(second.port !== first.port,
      `taking a different port (${first.port} then ${second.port})`);
    check(/in use; taking a free one/.test(second.log()),
      'and saying so, rather than moving silently');

    const sys = await apiSystem(second);
    check(Array.isArray(sys.work), 'and the fallback server is fully functional');

    // An explicitly requested port is the opposite case: somebody chose that
    // number, probably because something points at it, so moving quietly would
    // break them. It has to fail loudly instead.
    const clash = await startServe(second.port).then(() => 'started', () => 'refused');
    check(clash === 'refused',
      'while an explicit --port that is taken refuses rather than moving');

    first.proc.kill();
    second.proc.kill();
    await new Promise(r => setTimeout(r, 3000));
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
} finally {
  // Report first, tidy afterwards — a cleanup failure must never be the reason
  // a passing run has no verdict.
  console.log(`\nserve (live, real daemon): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  for (const s of servers) { try { killPid(s.pid); } catch { /* gone */ } }
  for (const pid of strays) killPid(pid);
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
