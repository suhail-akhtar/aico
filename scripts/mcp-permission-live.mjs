/**
 * What a submitted job is allowed to do, proved in both directions.
 *
 * The earlier probes used prompts that call no tools ("say BANANA"), so they
 * never reached the permission gate. This one asks for a file to be written,
 * with `autoApprove` off — the default for a fresh install.
 *
 * ## The bug this was written to catch
 *
 * `runAgent` falls back to `checkPermission` when no `onPermissionRequest` is
 * supplied, and background agents supplied none. `checkPermission` writes the
 * prompt to `process.stdout` and then blocks reading `stdin`. Under
 * `aico mcp-serve` those are both halves of the JSON-RPC stream, so the prompt
 * corrupted the protocol and the read then ate the client's own messages as an
 * answer. The job never returned — verified: `aico_wait` timed out at 200s
 * against a job asked to write a single file.
 *
 * ## Why both postures
 *
 * A permission control tested only in its safe state is not tested. "No file
 * was written" is also what a broken agent that never ran produces, and the two
 * have to be told apart — so the same prompt is run with `--allow-writes` and
 * must succeed.
 *
 * Run: npm run build && node scripts/mcp-permission-live.mjs
 */

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

const PROMPT = 'Create a file called result.txt in the current directory containing exactly '
  + 'the word DONE. Use the Write tool. Then stop and say what happened.';

const dirs = [];
const kids = [];

/** Start a server in a fresh workspace with auto-approval explicitly off. */
function start({ allowWrites }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-perm-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.aico'), { recursive: true });
  // The machine this was written on has `autoApprove` globally ON, so without
  // this the job sails past the gate and the test proves nothing.
  fs.writeFileSync(path.join(dir, '.aico', 'settings.json'),
    JSON.stringify({ autoApprove: false }, null, 2));

  const args = [entry, 'mcp-serve', '--cwd', dir];
  if (allowWrites) args.push('--allow-writes');
  const proc = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: root,
    env: { ...process.env, AICO_WORK_LOG: path.join(dir, 'work.jsonl') },
  });
  kids.push(proc);

  const state = { stdout: '', stderr: '', stray: [], pending: new Map(), nextId: 1, buffer: '' };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    state.stdout += chunk;
    state.buffer += chunk;
    const lines = state.buffer.split('\n');
    state.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const p = state.pending.get(msg.id);
        if (p) { state.pending.delete(msg.id); p(msg.result ?? msg.error); }
      } catch {
        // The exact failure this probe exists for: something that is not a
        // protocol message on the protocol stream.
        state.stray.push(line);
      }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', c => { state.stderr += c; });

  const send = (method, params, ms = 120_000) => {
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { state.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, ms);
      state.pending.set(id, v => { clearTimeout(t); resolve(v); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const call = async (name, args_, ms) => {
    const r = await send('tools/call', { name, arguments: args_ }, ms);
    return r?.content?.[0]?.text ?? JSON.stringify(r);
  };

  return { dir, proc, state, send, call };
}

async function runPosture({ allowWrites }) {
  const s = start({ allowWrites });
  await s.send('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'perm-probe', version: '1.0.0' },
  }, 90_000);

  const submitted = await s.call('aico_submit', {
    prompt: PROMPT, description: 'permission probe', maxCostUsd: 1, timeoutSeconds: 180,
  });
  const id = /\b(bg:[\w-]+)/.exec(submitted)?.[1];
  const final = await s.call('aico_wait', { id, timeoutSeconds: 150 }, 200_000);

  s.proc.stdin.end();
  await new Promise(r => { s.proc.on('exit', r); setTimeout(r, 8000); });

  return {
    ...s, id, final,
    wrote: fs.existsSync(path.join(s.dir, 'result.txt')),
  };
}

try {
  console.log('\n-- read-only, the default --');
  {
    const r = await runPosture({ allowWrites: false });
    check(Boolean(r.id), `the job was submitted (${r.id})`);
    check(r.state.stray.length === 0,
      `nothing but JSON reached stdout (${r.state.stray.length} stray line(s)`
      + `${r.state.stray.length ? ': ' + JSON.stringify(r.state.stray[0].slice(0, 100)) : ''})`);
    check(!/Permission needed/.test(r.state.stdout),
      'no permission prompt was written into the protocol stream');
    // The original symptom: it never came back at all.
    check(/\[done\]|\[failed\]|\[cancelled\]/.test(r.final),
      `it reached a decision rather than hanging (${r.final.split('\n')[0]})`);
    check(r.wrote === false, 'and the file was NOT written — the posture held');
    check(/read-only/.test(r.state.stderr),
      'the server announced its posture on stderr, so it is never a surprise');
  }

  console.log('\n-- --allow-writes, the explicit opt-in --');
  {
    const r = await runPosture({ allowWrites: true });
    check(Boolean(r.id), `the job was submitted (${r.id})`);
    check(r.state.stray.length === 0, 'the protocol stream stayed clean here too');
    check(/\[done\]|\[failed\]|\[cancelled\]/.test(r.final),
      `it reached a decision (${r.final.split('\n')[0]})`);
    // This is the half that proves the control is a control and not a
    // permanently-broken agent: same prompt, same everything, one flag.
    check(r.wrote === true,
      'and the file WAS written — so read-only was a decision, not a failure to run');
    check(/WRITE ACCESS/.test(r.state.stderr),
      'with the escalated posture announced just as loudly');
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
} finally {
  console.log(`\npermissions (live, real model): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } }
  process.exit(failed ? 1 : 0);
}
