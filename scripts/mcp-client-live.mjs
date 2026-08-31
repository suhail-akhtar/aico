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

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { McpStdioClient } from '../dist-test/test-exports.js';

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

try {
  console.log('\n-- aico\'s client against aico\'s server --');
  {
    const entry = path.join(root, 'dist', 'index.js');
    if (!fs.existsSync(entry)) throw new Error(`No build at ${entry}. Run: npm run build`);

    const client = new McpStdioClient({
      command: process.execPath,
      args: [entry, 'mcp-serve', '--cwd', workdir],
      env: { AICO_WORK_LOG: path.join(workdir, 'work.jsonl') },
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
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
} finally {
  console.log(`\nmcp client (live): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  for (const c of clients) { try { c.close?.(); c.kill?.(); } catch { /* gone */ } }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
