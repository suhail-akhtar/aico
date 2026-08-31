/**
 * Watchers against the real operating system.
 *
 * The harness covers the `work` watcher, because that one is pure ledger
 * bookkeeping. The rest are not: `file` depends on whether `fs.watch` fires on
 * this platform, `process` depends on how a pid disappears, `http` needs a
 * socket, and `log` needs a file that is genuinely being appended to while it
 * is read. Every one of those is a place where the code can be correct and the
 * behaviour still wrong — Windows in particular reports file changes
 * differently from Linux, and `fs.watch` on a path that does not exist yet
 * throws rather than waiting.
 *
 * So this starts real servers, writes real files and kills real processes.
 *
 * Run: node scripts/watcher-live.mjs
 * Needs: npx tsup src/test-exports.ts --format esm --outDir dist-test --target node22
 * NOTE: `npm test` rebuilds dist-test with --clean, so do not run it against a
 * live probe.
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import {
  ledger, setWorkStorePath, watch, setWakeDelivery, resetWatchersForTest, activeWatcherCount,
} from '../dist-test/test-exports.js';

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

/** Wait for a condition, or give up. Returns whether it happened. */
async function until(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-watch-live-'));
setWorkStorePath(path.join(dir, 'work.jsonl'));
ledger.resetForTest();

const woken = [];
setWakeDelivery({
  steer: (sessionId, message) => { woken.push({ as: 'steer', sessionId, message }); return true; },
  followup: (sessionId, message) => { woken.push({ as: 'followup', sessionId, message }); return true; },
});

const servers = [];
const children = [];

try {
  console.log('\n-- file: a build writes a file that did not exist --');
  {
    const target = path.join(dir, 'dist', 'bundle.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const id = watch({
      condition: { kind: 'file', path: target, debounceMs: 50 },
      wake: { sessionId: 'live', as: 'steer', message: 'bundle written' },
    });
    check(activeWatcherCount() === 1, 'armed against a path with no file at it yet');

    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(target, 'console.log(1)\n');

    const fired = await until(() => woken.some(w => /bundle written/.test(w.message)));
    check(fired, 'fired when the file appeared');
    check(ledger.get(id).state === 'done', 'and closed itself, being a "first" watcher');
    check(activeWatcherCount() === 0, 'leaving nothing armed');
  }

  console.log('\n-- file: an existing file being rewritten --');
  {
    woken.length = 0;
    const target = path.join(dir, 'watched.txt');
    fs.writeFileSync(target, 'one\n');
    const id = watch({
      condition: { kind: 'file', path: target, debounceMs: 50 },
      wake: { sessionId: 'live', as: 'followup' },
    });
    await new Promise(r => setTimeout(r, 400));
    check(woken.length === 0, 'a file that already exists does not fire on arming');

    fs.writeFileSync(target, 'two\n');
    check(await until(() => woken.length > 0), 'but does when it actually changes');
    check(woken[0].as === 'followup', 'delivered as the followup it asked for');
    check(ledger.get(id).state === 'done', 'and closed');
  }

  console.log('\n-- process: a real child exiting --');
  {
    woken.length = 0;
    // A child that sleeps, so the watcher is armed while it is genuinely alive.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 1200)'], {
      stdio: 'ignore',
    });
    children.push(child);
    await new Promise(r => setTimeout(r, 100));

    const id = watch({
      condition: { kind: 'process', pid: child.pid },
      wake: { sessionId: 'live', as: 'steer', message: 'the process ended' },
    });
    await new Promise(r => setTimeout(r, 300));
    check(woken.length === 0, 'does not fire while the process is alive');

    check(await until(() => woken.length > 0), 'fires once the process exits');
    check(ledger.get(id).state === 'done', 'and closes');
  }

  console.log('\n-- http: waiting for a server to come up --');
  {
    woken.length = 0;
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    servers.push(server);
    // Pick the port first, then start the watcher, then listen — the real
    // sequence, where the watcher is armed against something not yet serving.
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    server.close();
    await new Promise(r => setTimeout(r, 100));

    const id = watch({
      condition: { kind: 'http', url: `http://127.0.0.1:${port}/`, intervalMs: 250 },
      wake: { sessionId: 'live', as: 'steer', message: 'server is up' },
    });
    await new Promise(r => setTimeout(r, 700));
    check(woken.length === 0,
      'a refused connection is "not ready", not a firing — otherwise every '
      + 'watcher would wake the agent to say the server has not started');

    const second = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    servers.push(second);
    await new Promise(resolve => second.listen(port, '127.0.0.1', resolve));

    check(await until(() => woken.length > 0), 'fires when the server answers');
    check(ledger.get(id).state === 'done', 'and closes');
  }

  console.log('\n-- log: a pattern appearing in a file being appended to --');
  {
    woken.length = 0;
    const logFile = path.join(dir, 'build.log');
    fs.writeFileSync(logFile, 'starting\ncompiling\n');
    const id = watch({
      condition: { kind: 'log', path: logFile, pattern: 'BUILD (SUCCESS|FAILED)' },
      wake: { sessionId: 'live', as: 'steer' },
    });
    await new Promise(r => setTimeout(r, 600));
    check(woken.length === 0,
      'starts at the end of the file — matching what was already written would '
      + 'fire instantly on a log that has been running for an hour');

    fs.appendFileSync(logFile, 'still going\n');
    await new Promise(r => setTimeout(r, 400));
    check(woken.length === 0, 'and non-matching new lines do not fire it');

    fs.appendFileSync(logFile, 'BUILD SUCCESS in 4.2s\n');
    check(await until(() => woken.length > 0), 'fires on the matching line');
    check(/BUILD SUCCESS/.test(woken[0]?.message ?? ''),
      'and carries the line itself, so the agent does not have to go and read it');
    check(ledger.get(id).state === 'done', 'and closes');
  }

  console.log('\n-- until: "always" keeps watching --');
  {
    woken.length = 0;
    const target = path.join(dir, 'repeat.txt');
    fs.writeFileSync(target, '0\n');
    const id = watch({
      condition: { kind: 'file', path: target, debounceMs: 50 },
      wake: { sessionId: 'live', as: 'steer' },
      until: 'always',
    });
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(target, '1\n');
    check(await until(() => woken.length >= 1), 'fires the first time');
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(target, '2\n');
    check(await until(() => woken.length >= 2), 'and again, rather than disarming');
    check(ledger.get(id).state === 'blocked', 'staying blocked, because it is still waiting');
    check(ledger.get(id).progress.steps >= 2, 'counting its firings');
  }

  console.log('\n-- expiry: a watcher that never fires gives up --');
  {
    const id = watch({
      condition: { kind: 'file', path: path.join(dir, 'never-written.txt'), debounceMs: 50 },
      wake: { sessionId: 'live', as: 'steer' },
      expiresInMs: 800,
    });
    check(await until(() => ledger.get(id).state === 'done', 4000),
      'closes itself after its expiry rather than watching forever');
    check(/Expired/.test(ledger.get(id).result ?? ''),
      `and says it expired rather than claiming it fired (${ledger.get(id).result})`);
  }
} finally {
  // Report first, tidy up afterwards. A cleanup failure must never be the
  // reason a passing run has no verdict — a locked file has swallowed a whole
  // summary in this repo before.
  console.log(`\nwatchers (live): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  resetWatchersForTest();
  for (const s of servers) { try { s.close(); } catch { /* already closed */ } }
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked; harmless */ }
  process.exit(failed ? 1 : 0);
}
