/**
 * aico's MCP **client** against real stdio servers.
 *
 * Two servers, on purpose:
 *
 *   1. `aico mcp-serve` — our own server, driven by our own client. Both halves
 *      of the wire were written here, so agreement between them proves the
 *      framing round-trips but not that it matches anybody else's idea of MCP.
 *   2. `src/mcp-servers/web-search-server.mjs` — a separate implementation that
 *      predates this work and was written without reference to it. If the
 *      client still drives that, the client is intact.
 *
 * The second is the one that matters for a user with their own local MCP
 * servers: it is evidence that nothing in the ledger/supervisor work disturbed
 * the path their servers are loaded through.
 *
 * Run: npm run build && node scripts/mcp-client-live.mjs
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { McpStdioClient, McpHttpClient } from '../dist-test/test-exports.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-mcp-client-'));
const clients = [];
const httpProcs = [];

try {
  console.log('\n-- aico\'s client against aico\'s server --');
  {
    const entry = path.join(root, 'dist', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`No build at ${entry}. Run: npm run build`);

    const client = new McpStdioClient({
      command: process.execPath,
      args: [entry, 'mcp-serve', '--cwd', workdir],
      env: {
        AICO_WORK_LOG: path.join(workdir, 'work.jsonl'),
        AICO_CRON_STORE: path.join(workdir, 'cron.json'),
      },
    });
    clients.push(client);

    await client.initialize();
    check(true, 'the handshake completes — including the initialized notification, '
      + 'which this client sends WITH an id and would otherwise block on forever');

    const tools = await client.listTools();
    const names = tools.map(t => t.name).sort();
    check(names.length === 6, `discovers all six tools (${names.join(', ')})`);
    check(tools.every(t => typeof t.execute === 'function'),
      'each arriving as something callable');
    check(tools.every(t => t.inputSchema && typeof t.inputSchema === 'object'),
      'with a schema attached');

    const status = await client.callTool('aico_status', {});
    check(typeof status === 'string' && /idle/i.test(status),
      `a tool call round-trips text content (${String(status).slice(0, 50)})`);

    // The registry namespaces tools as mcp__<server>__<tool>; this is what an
    // agent would actually invoke, so exercise the same execute path.
    const viaExecute = await tools.find(t => t.name === 'aico_status').execute({});
    check(typeof viaExecute === 'string' && viaExecute === status,
      'and the execute() handle the registry hands the model gives the same answer');

    const health = client.getHealth();
    check(health === 'healthy' || health === 'ok' || typeof health === 'string',
      `health is reported (${health})`);
  }

  console.log('\n-- aico\'s client against an unrelated local server --');
  {
    // Written before any of this work and never touched by it. If the client
    // drives this, a user's own local servers are unaffected.
    const server = path.join(root, 'src', 'mcp-servers', 'web-search-server.mjs');
    check(fs.existsSync(server), 'the bundled web-search server is present');

    const client = new McpStdioClient({
      command: process.execPath,
      args: [server],
    });
    clients.push(client);

    await client.initialize();
    check(true, 'handshake completes against a foreign implementation');

    const tools = await client.listTools();
    check(tools.length > 0, `it advertises ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
    check(tools.every(t => typeof t.name === 'string' && t.name.length > 0),
      'every tool has a usable name');
    check(tools.every(t => typeof t.execute === 'function'),
      'and is callable through the same interface');
  }

  console.log('\n-- a server that dies is reported, not hung on --');
  {
    const client = new McpStdioClient({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    });
    clients.push(client);

    let message = '';
    try {
      await client.initialize();
    } catch (err) {
      message = err.message;
    }
    check(message.length > 0,
      `a server that exits immediately raises rather than hanging (${message.slice(0, 60)})`);
  }

  /*
    Phase 6: both protocol eras, over both transports, against a fixture
    written from the spec pages (scripts/fixtures/mcp-era-server.mjs).
  */
  const fixture = path.join(root, 'scripts', 'fixtures', 'mcp-era-server.mjs');
  const startHttp = async (era) => {
    const proc = spawn(process.execPath, [fixture, '--era', era, '--http'], { stdio: ['ignore', 'pipe', 'inherit'] });
    httpProcs.push(proc);
    const port = await new Promise((resolve, reject) => {
      let out = '';
      proc.stdout.on('data', d => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
      proc.on('exit', () => reject(new Error('fixture exited')));
    });
    return `http://127.0.0.1:${port}/mcp`;
  };

  for (const era of ['legacy', 'modern']) {
    console.log(`\n-- ${era} era over stdio (${era === 'modern' ? '2026-07-28' : '2025-11-25'}) --`);
    const client = new McpStdioClient({ command: process.execPath, args: [fixture, '--era', era] });
    clients.push(client);
    const started = Date.now();
    await client.initialize();
    check(client.era === era, `negotiated the ${era} era (${client.era} ${client.protocolVersion}) in ${Date.now() - started} ms`);
    check(Date.now() - started < 4000, 'without waiting out the probe timeout');
    check(/fixture manual/.test(client.instructions ?? ''), 'instructions arrive from ' + (era === 'modern' ? 'server/discover' : 'initialize'));
    const tools = await client.listTools();
    check(tools.length === 5, `lists the fixture's tools (${tools.map(t => t.name).join(', ')})`);
    const weather = tools.find(t => t.name === 'weather');
    check(weather?.annotations?.readOnlyHint === true && weather?.outputSchema && weather?.title === 'Weather',
      'reads annotations, outputSchema and title');
    check(await client.callTool('echo', { text: 'hi' }) === 'echo: hi', 'a call round-trips text');
    const structured = await client.callTool('weather', { city: 'Oslo' });
    check(structured === '{"tempC":21,"sky":"clear","city":"Oslo"}', `structured content is shown compactly (${structured})`);
    let failed = '';
    try { await client.callTool('fail', {}); } catch (err) { failed = err.message; }
    check(/failed on purpose/.test(failed), 'isError results throw with the server\'s message');
    if (era === 'modern') {
      check(await client.callTool('confirm', {}) === 'confirm: decline state=state-123',
        'MRTR: input_required is answered (declined, no handler) and requestState echoed on the retry');
      client.elicit = async (req) => ({ action: 'accept', content: { yes: req.message === 'Proceed?' } });
      check(await client.callTool('confirm', {}) === 'confirm: accept state=state-123', 'MRTR: an elicitation handler\'s answer reaches the server');
      client.elicit = undefined;
    }
    let changed = false;
    client.onToolsChanged = () => { changed = true; };
    await client.callTool('mutate', {});
    for (let i = 0; i < 50 && !changed; i++) await new Promise(r => setTimeout(r, 20));
    check(changed, `notifications/tools/list_changed reaches the client (${era === 'modern' ? 'via subscriptions/listen' : 'plain notification'})`);
    const relisted = await client.listTools();
    check(/id_rsa/.test(relisted.find(t => t.name === 'echo').description), 'and the re-listing shows the changed description');
  }

  for (const era of ['legacy', 'modern']) {
    console.log(`\n-- ${era} era over Streamable HTTP --`);
    const url = await startHttp(era);
    const client = new McpHttpClient({ type: 'http', url });
    await client.initialize();
    check(client.era === era, `negotiated the ${era} era over HTTP (${client.protocolVersion})`);
    const tools = await client.listTools();
    check(tools.length === 5, era === 'legacy' ? 'lists tools, echoing the minted Mcp-Session-Id' : 'lists tools statelessly');
    check(await client.callTool('echo', { text: 'hi' }) === 'echo: hi',
      era === 'modern' ? 'tools/call with MCP-Protocol-Version/Mcp-Method/Mcp-Name headers, answered as an SSE stream' : 'tools/call inside the session');
    if (era === 'modern') {
      const structured = await client.callTool('weather', { city: 'Oslo' });
      check(/"city":"Oslo"/.test(String(structured)), 'x-mcp-header parameters are mirrored as Mcp-Param-* headers');
    }
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
} finally {
  console.log(`\nmcp client (live): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  for (const c of clients) { try { c.stop?.(); } catch { /* gone */ } }
  for (const p of httpProcs) { try { p.kill(); } catch { /* gone */ } }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
