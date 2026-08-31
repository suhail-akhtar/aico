/**
 * `aico mcp-serve` driven by a real MCP client over a real pipe.
 *
 * The dispatch logic is covered offline. This is not that: this spawns the
 * actual built binary as a child process and talks to it with aico's own
 * `McpStdioClient` — the same client that connects to the user's other MCP
 * servers. Every failure mode that only exists at the transport is in scope
 * here and nowhere else:
 *
 *   - a banner or a warning on stdout corrupting the JSON stream
 *   - the handshake disagreeing about protocol version or the initialized
 *     notification
 *   - message framing breaking when a response spans two chunks
 *   - the process not exiting when its client goes away
 *
 * Run: node scripts/mcp-server-live.mjs
 * Needs: npm run build  (this drives dist/index.js, the real entry point)
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

/**
 * A minimal JSON-RPC client over the child's pipes.
 *
 * Deliberately not importing aico's McpStdioClient: that class spawns its own
 * process and swallows stderr, and this probe needs to *see* stderr to prove
 * that startup chatter went there rather than into the protocol stream. The
 * framing below is the same newline-delimited JSON, written independently — so
 * agreement between the two is evidence rather than a tautology.
 */
class Client {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stdoutRaw = '';
    this.stderrRaw = '';
    this.parseErrors = 0;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.stdoutRaw += chunk;
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // The exact failure this probe exists to catch: something that is not
          // a protocol message arrived on the protocol stream.
          this.parseErrors++;
          continue;
        }
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderrRaw += chunk; });
  }

  send(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); },
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Write raw bytes, for the framing tests. */
  raw(text) { this.child.stdin.write(text); }
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-mcp-live-'));
let child;

try {
  console.log('\n-- the process starts and speaks the protocol --');
  child = spawn(process.execPath, [entry, 'mcp-serve', '--cwd', workdir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: root,
  });
  const client = new Client(child);

  // Startup loads settings, skills, MCP clients and the cron scheduler, all of
  // which warn through console. Give it room, then check where that went.
  const init = await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-probe', version: '1.0.0' },
  }, 90_000);

  check(init?.protocolVersion === '2024-11-05', 'initialize agrees on the protocol version');
  check(init?.serverInfo?.name === 'aico', 'and identifies itself as aico');
  check(init?.capabilities?.tools !== undefined, 'declaring a tools capability');

  const initialized = await client.send('notifications/initialized', {});
  check(initialized !== undefined,
    'answers the initialized notification when it arrives with an id — aico\'s own '
    + 'client sends it that way and would otherwise wait for a reply forever');

  console.log('\n-- stdout carries the protocol and nothing else --');
  {
    check(client.parseErrors === 0,
      `every line on stdout parsed as JSON (${client.parseErrors} did not) — a banner `
      + 'or a warning here is a parse error at the client, not a cosmetic problem');
    check(/ready on stdio/.test(client.stderrRaw),
      'the readiness line went to stderr where it belongs');
    check(!/ready on stdio/.test(client.stdoutRaw),
      'and specifically not to stdout');
  }

  console.log('\n-- tools/list --');
  const listed = await client.send('tools/list', {});
  const names = (listed?.tools ?? []).map(t => t.name).sort();
  check(names.length >= 6, `advertises its tools (${names.length}): ${names.join(', ')}`);
  for (const expected of ['aico_submit', 'aico_status', 'aico_wait', 'aico_stop', 'aico_ack', 'aico_sessions']) {
    check(names.includes(expected), `  ${expected} is present`);
  }
  check((listed?.tools ?? []).every(t => t.inputSchema?.type === 'object'),
    'every tool carries an object input schema, so a client can validate before calling');
  check((listed?.tools ?? []).every(t => typeof t.description === 'string' && t.description.length > 40),
    'and a description long enough to choose from');

  console.log('\n-- status on an idle instance --');
  {
    const res = await client.send('tools/call', { name: 'aico_status', arguments: {} });
    const text = res?.content?.[0]?.text ?? '';
    check(res?.content?.[0]?.type === 'text', 'results come back as MCP text content');
    check(/idle/i.test(text), `an idle instance says so (${text.slice(0, 60)})`);
    check(res?.isError !== true, 'and it is not an error');
  }

  console.log('\n-- argument validation is the caller\'s fault, not a crash --');
  {
    const res = await client.send('tools/call', { name: 'aico_submit', arguments: {} });
    check(res?.isError === true, 'a missing required argument comes back as isError');
    check(/prompt is required/i.test(res?.content?.[0]?.text ?? ''),
      'saying which argument');

    const stop = await client.send('tools/call', {
      name: 'aico_stop', arguments: { id: 'nope' },
    });
    check(/reason is required/i.test(stop?.content?.[0]?.text ?? ''),
      'stop still refuses to run without a reason over MCP');

    let threw = false;
    try {
      await client.send('tools/call', { name: 'aico_does_not_exist', arguments: {} });
    } catch (err) {
      threw = true;
      check(/Unknown tool/i.test(err.message), 'an unknown tool is a protocol error, not a result');
    }
    check(threw, 'and it does raise rather than answering');
  }

  console.log('\n-- unknown ids are reported, never invented --');
  {
    const res = await client.send('tools/call', {
      name: 'aico_status', arguments: { id: 'bg:does-not-exist' },
    });
    check(/No work with id/i.test(res?.content?.[0]?.text ?? ''),
      'asking about work that does not exist says so');

    const acked = await client.send('tools/call', {
      name: 'aico_ack', arguments: { id: ['bg:nope'] },
    });
    check(/Nothing to acknowledge/i.test(acked?.content?.[0]?.text ?? ''),
      'and acking nothing claims nothing');

    const stopped = await client.send('tools/call', {
      name: 'aico_stop', arguments: { id: 'bg:nope', reason: 'testing' },
    });
    check(/Not found/i.test(stopped?.content?.[0]?.text ?? ''),
      'stopping something that does not exist reports the miss rather than a kill');
  }

  console.log('\n-- wait on a nonexistent id returns rather than hanging --');
  {
    const started = Date.now();
    const res = await client.send('tools/call', {
      name: 'aico_wait', arguments: { id: 'bg:nope', timeoutSeconds: 30 },
    }, 20_000);
    check(Date.now() - started < 5000,
      `returns immediately instead of waiting out the timeout (${Date.now() - started}ms)`);
    check(/No work with id/i.test(res?.content?.[0]?.text ?? ''), 'and says why');
  }

  console.log('\n-- sessions --');
  {
    const res = await client.send('tools/call', { name: 'aico_sessions', arguments: { limit: 5 } });
    const text = res?.content?.[0]?.text ?? '';
    check(typeof text === 'string' && text.length > 0, 'reports sessions or says there are none');
    check(res?.isError !== true, `without erroring (${text.split('\n')[0].slice(0, 70)})`);
  }

  console.log('\n-- framing: a message split across two writes --');
  {
    // The client's own buffer handles this on the way back; this proves the
    // *server's* does on the way in. A real pipe splits wherever it likes.
    const id = client.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: {} });
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: split ping')), 15_000);
      client.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
    });
    client.raw(payload.slice(0, 12));
    await new Promise(r => setTimeout(r, 150));
    client.raw(payload.slice(12) + '\n');
    await answer;
    check(true, 'a request arriving in two chunks is still handled as one message');
  }

  console.log('\n-- garbage in does not take the server down --');
  {
    client.raw('this is not json\n');
    await new Promise(r => setTimeout(r, 200));
    const res = await client.send('tools/call', { name: 'aico_status', arguments: {} }, 15_000);
    check(res?.content?.[0]?.text !== undefined,
      'an unparseable line is answered with an error and the server keeps serving');

    // A notification — no id — must never be answered.
    const before = client.stdoutRaw.length;
    client.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }) + '\n');
    await new Promise(r => setTimeout(r, 300));
    check(client.stdoutRaw.length === before,
      'a notification with no id gets no response — answering one is a protocol violation');
  }

  console.log('\n-- the server\'s lifetime is its client\'s --');
  {
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise(r => setTimeout(() => r('TIMEOUT'), 15_000)),
    ]);
    check(code !== 'TIMEOUT', 'closing stdin ends the process rather than orphaning it');
    check(code === 0 || code === null, `exiting cleanly (code ${code})`);
    child = undefined;
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
} finally {
  // Report first, tidy up afterwards. A cleanup failure must never be the
  // reason a passing run has no verdict.
  console.log(`\nmcp-serve (live): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  try { child?.kill(); } catch { /* already gone */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
