/**
 * Delegation over MCP, end to end, against a real model.
 *
 * `mcp-server-live.mjs` proves the transport. This proves the thing the
 * transport exists for: another process hands aico a task, aico actually runs
 * it, and the result comes back. Nothing here is mocked — a real child process,
 * a real provider call, a real ledger file on disk.
 *
 * It costs a few cents. That is the point: every cheaper version of this test
 * would be testing something other than what ships.
 *
 * Run: npm run build && node scripts/mcp-submit-live.mjs
 * Needs: a configured provider (it uses whatever `aico` is set up with).
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { spawn } from 'child_process';
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

class Client {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderrRaw = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', c => { this.stderrRaw += c; });
  }

  send(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args, timeoutMs) {
    const res = await this.send('tools/call', { name, arguments: args }, timeoutMs);
    return { text: res?.content?.[0]?.text ?? '', isError: res?.isError === true };
  }
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-submit-live-'));
const workLog = path.join(workdir, 'work.jsonl');
let child;

try {
  child = spawn(process.execPath, [entry, 'mcp-serve', '--cwd', workdir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: root,
    // A separate ledger, so this never touches the user's own running work.
    env: { ...process.env, AICO_WORK_LOG: workLog },
  });
  const client = new Client(child);

  await client.send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'submit-probe', version: '1.0.0' },
  }, 90_000);

  console.log('\n-- submit returns an id immediately, not an answer --');
  let workId;
  {
    const started = Date.now();
    const res = await client.call('aico_submit', {
      prompt: 'Reply with exactly the single word BANANA. No punctuation, no explanation, '
        + 'no tool calls. Just that word.',
      description: 'live submit probe',
      maxCostUsd: 0.5,
      timeoutSeconds: 240,
    });
    const elapsed = Date.now() - started;
    check(!res.isError, `submit accepted (${res.text.split('\n')[0]})`);
    workId = /\b(bg:[\w-]+)/.exec(res.text)?.[1];
    check(Boolean(workId), `it returns a work id (${workId})`);
    check(elapsed < 10_000,
      `and returns before the work finishes (${elapsed}ms) — delegation, not a blocking call`);
  }

  console.log('\n-- the job is visible, and marked as not ours --');
  {
    const res = await client.call('aico_status', { id: workId });
    check(/\[(queued|running|done)\]/.test(res.text), `status reports a live state (${res.text.split('\n')[0]})`);
    check(/started over MCP/.test(res.text),
      'and is tagged as remote, so a user reading their own ledger can see rows they did not cause');
  }

  console.log('\n-- wait blocks until it is really finished --');
  {
    const started = Date.now();
    const res = await client.call('aico_wait', { id: workId, timeoutSeconds: 240 }, 300_000);
    const elapsed = Date.now() - started;
    check(/\[done\]|\[failed\]|\[cancelled\]/.test(res.text),
      `wait returned a settled state after ${Math.round(elapsed / 1000)}s`);
    check(/\[done\]/.test(res.text), `the task succeeded (${res.text.split('\n')[0]})`);
    check(/BANANA/i.test(res.text),
      'and the model\'s actual answer came back through the pipe');
    check(/\$\d/.test(res.text), 'with real spend recorded against it');
  }

  console.log('\n-- the outcome is offered until acknowledged --');
  {
    const before = await client.call('aico_status', {});
    check(before.text.includes(workId), 'an unacked outcome is still listed');
    const acked = await client.call('aico_ack', { id: workId });
    check(/Acknowledged 1/.test(acked.text), `acking it reports one (${acked.text})`);
    const after = await client.call('aico_status', {});
    check(!after.text.includes(workId), 'and it stops being listed');
    const all = await client.call('aico_status', { all: true });
    check(all.text.includes(workId), 'but is still there when asked for everything');
  }

  console.log('\n-- a running job can be stopped from outside --');
  {
    // A generous ceiling on purpose: this test is about *our* stop landing, and
    // a tight one would let the supervisor get there first. The supervisor is
    // tested on its own below.
    const res = await client.call('aico_submit', {
      prompt: 'Count slowly from 1 to 400, writing out every number in full words, '
        + 'one per line. Do not stop early.',
      description: 'long job to stop',
      maxCostUsd: 20,
      timeoutSeconds: 600,
    });
    const longId = /\b(bg:[\w-]+)/.exec(res.text)?.[1];
    check(Boolean(longId), `started a long job (${longId})`);

    await new Promise(r => setTimeout(r, 3000));
    const stop = await client.call('aico_stop', { id: longId, reason: 'live probe cleanup' });
    check(/Stopped: /.test(stop.text), `our stop landed (${stop.text})`);

    const after = await client.call('aico_status', { id: longId, all: true });
    check(/\[cancelled\]/.test(after.text),
      `and the job is cancelled, not failed (${after.text.split('\n')[0]})`);
    check(/live probe cleanup/.test(after.text),
      `recording OUR reason rather than the agent's own "Cancelled by user" — `
      + `a reader has to be able to tell a deliberate stop from a crash `
      + `(${(/error: (.*)/.exec(after.text) ?? [])[1] ?? 'no reason recorded'})`);
  }

  console.log('\n-- the mandatory ceiling on remote work actually fires --');
  {
    // The whole safety claim for the MCP surface: work started by another
    // process, possibly unattended, cannot run up an unbounded bill. A ceiling
    // that is documented and unenforceable is worse than none, and this is
    // exactly the bug the first run of this probe found — background agents
    // reported no spend at all, so the limit compared against zero forever.
    const res = await client.call('aico_submit', {
      prompt: 'Write a detailed 2000-word essay about the history of the bicycle.',
      description: 'job that should breach its ceiling',
      maxCostUsd: 0.0001,
      timeoutSeconds: 600,
    });
    const id = /\b(bg:[\w-]+)/.exec(res.text)?.[1];
    check(Boolean(id), `started with a deliberately tiny ceiling (${id})`);

    // The supervisor sweeps every 5s, so give it two passes plus slack.
    const deadline = Date.now() + 45_000;
    let text = '';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      text = (await client.call('aico_status', { id, all: true })).text;
      if (/\[cancelled\]|\[done\]|\[failed\]/.test(text)) break;
    }
    check(/\[cancelled\]/.test(text),
      `the supervisor stopped it (${text.split('\n')[0]})`);
    // Read the recorded reason, not the whole blob. Matching against the full
    // text passed vacuously the first time round — the job's own *title* said
    // "ceiling", so the assertion was green while nothing had fired.
    const recorded = (/error: (.*)/.exec(text) ?? [])[1] ?? '';
    check(/Supervisor:/.test(recorded) && /ceiling/.test(recorded),
      `naming the limit it passed (${recorded || 'no reason recorded'})`);
  }

  console.log('\n-- the ledger is a real file that survives the process --');
  {
    child.stdin.end();
    await new Promise(resolve => {
      child.on('exit', resolve);
      setTimeout(resolve, 10_000);
    });
    child = undefined;

    check(fs.existsSync(workLog), 'the work log was written to disk');
    const lines = fs.readFileSync(workLog, 'utf8').trim().split('\n').filter(Boolean);
    check(lines.length > 0, `with ${lines.length} event(s)`);
    const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } });
    check(parsed.every(Boolean), 'every line is valid JSON — a crash mid-write would show here');

    const records = new Map();
    for (const e of parsed) {
      if (e.t === 'add') records.set(e.record.id, { ...e.record });
      else if (e.t === 'patch' && records.has(e.id)) Object.assign(records.get(e.id), e.patch);
    }
    const replayed = records.get(workId);
    check(Boolean(replayed), 'replaying the log finds the job we ran');
    check(replayed?.state === 'done', `in its final state (${replayed?.state})`);
    check(replayed?.origin === 'remote', 'still tagged remote after a round trip through disk');
    check(replayed?.reported === true, 'and still acknowledged — the ack was persisted, not just in memory');
    check((replayed?.cost?.usd ?? 0) > 0, `with its cost preserved ($${replayed?.cost?.usd?.toFixed(4)})`);
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
} finally {
  console.log(`\nmcp submit (live, real model): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  try { child?.kill(); } catch { /* gone */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
