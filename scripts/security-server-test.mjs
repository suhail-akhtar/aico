/**
 * The loopback server's own holes, tested as the findings that named them.
 *
 * Why this suite exists: the API token authenticates a *client*, not a
 * *person*, and the model can hold it (it runs `curl` like anyone). A review
 * of `aico serve` found routes that still treated the token as enough — adding
 * an MCP server (which starts a command), settings writes that widen what the
 * agent may do, `submit` with full autonomy, writing a skill or adopting a
 * learned rule — plus settings that reached the client unredacted, session ids
 * that walked out of the store, an Origin check that matched by prefix, no
 * Host check (DNS rebinding), and errors that echoed absolute paths.
 *
 * Each block below was written against the code before the fix and failed
 * there. Offline: no model is called, nothing leaves the machine. The store is
 * this process's own (scripts/lib/test-home.mjs); the real ~/.aico is never
 * touched.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';

// The copied settings.json carries the reader's real MCP servers, hooks and keys.
fs.writeFileSync(path.join(testHome, 'settings.json'), '{}');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-secsrv-'));
// Routes resolve a project from process.cwd(); run in a temp project, never the repository.
const workDir = path.join(tmp, 'project');
fs.mkdirSync(workDir, { recursive: true });
const startCwd = process.cwd();
process.chdir(workDir);
process.on('exit', () => {
  try { process.chdir(startCwd); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const settingsFile = path.join(testHome, 'settings.json');
const readStored = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const writeStored = (v) => fs.writeFileSync(settingsFile, JSON.stringify(v, null, 2));
const q = new URLSearchParams();
const NO = async () => ({ ok: false, reason: 'no person' });
const YES = async () => ({ ok: true, via: 'ui-key' });

// ── 1. MCP: adding a server starts a command ──────────────────────────
await block('1. mcp/add and manage mcp add/update need a person', async () => {
  writeStored({});
  const cfg = { name: 'evil', command: process.execPath, args: ['-e', 'require("fs").writeFileSync("pwned","1")'] };
  const r = await T.handleSystemRoute('mcp/add', 'POST', cfg, q, NO);
  assert(r?.status === 403 && r.body?.code === 'human-required', 'mcp/add with the token alone → 403 human-required');
  assert(!readStored().mcpServers?.evil, 'and nothing was written to settings');
  for (const action of ['add', 'update', 'paste', 'import']) {
    const m = await T.handleSystemRoute('manage', 'POST', { registry: 'mcp', action, name: 'evil', command: 'node x.js', json: '{"evil":{"command":"node"}}', path: path.join(tmp, 'x.json') }, q, NO);
    assert(m?.status === 403 && m.body?.code === 'human-required', `manage mcp ${action} with the token alone → 403`);
  }
  const projectSettings = ['settings.json', 'settings.local.json'].map(f => path.join(workDir, '.aico', f));
  assert(projectSettings.every(f => !fs.existsSync(f)), 'no project settings file was written in the temp project');
  assert(JSON.stringify(readStored()) === '{}', 'the user settings file is untouched');
  for (const scope of ['user', 'project']) {
    const m = await T.handleSystemRoute('manage', 'POST', { registry: 'mcp', action: 'add', scope, name: 'evil2', command: 'node x.js' }, q, NO);
    assert(m?.status === 403, `manage mcp add scope:${scope} with the token alone → 403`);
  }
  assert(projectSettings.every(f => !fs.existsSync(f)) && !readStored().mcpServers, 'still nothing written, in either scope');
  const list = await T.handleSystemRoute('manage', 'POST', { registry: 'mcp', action: 'list' }, q, NO);
  assert(list?.status === 200, 'manage mcp list stays a token-level read');
  for (const route of ['mcp/add', 'settings', 'settings/path', 'skills/create', 'learning/adopt', 'manage']) {
    const cmd = `curl -s -X POST -H "x-aico-token: abc" http://127.0.0.1:7340/api/${route} -d "{}"`;
    assert(/BLOCKED/.test(T.shellDenial(cmd) ?? ''), `the agent's shell is refused curl to /api/${route} with the token`);
  }
  assert(T.shellDenial('curl http://localhost:3000/api/settings') === undefined, 'a project\'s own /api/settings without AICO\'s token is not caught');
});

// ── 2. Settings writes that widen what the agent may do ──────────────
await block('2. safetyWeakening flags every widening write', async () => {
  const W = T.safetyWeakening;
  const cur = {
    hooks: { PreToolUse: [] }, env: { A: '1' }, mcpServers: { a: { command: 'x' } },
    disabledTools: ['Bash', 'WebFetch'], autoApprove: false, sandbox: { mode: 'workspace-write' },
    safetyLimits: { maxCostPerSession: 5, maxTokensPerSession: 1000 }, agents: { maxConcurrent: 2, directChat: true },
    skills: { dirs: [] },
    provider: 'deepseek', activeProvider: 'ds-1', providers: { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'm' } },
    providerInstances: [{ id: 'ds-1', type: 'deepseek', baseUrl: 'https://api.deepseek.com' }],
  };
  const flagged = (patch, why) => assert(typeof W(cur, patch) === 'string', `flagged: ${why}`);
  const clean = (patch, why) => assert(W(cur, patch) === undefined, `not flagged: ${why}`);
  flagged({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'calc' }] }] } }, 'a hook added');
  flagged({ env: { A: '1', NODE_OPTIONS: '--require x' } }, 'env changed');
  flagged({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }, 'an MCP server added');
  flagged({ customTools: { x: 1 } }, 'custom tools touched');
  flagged({ toolPacks: ['x'] }, 'tool packs touched');
  flagged({ disabledTools: ['WebFetch'] }, 'a tool removed from disabledTools');
  flagged({ disabledTools: null }, 'disabledTools removed');
  flagged({ autoApprove: true }, 'autoApprove: true');
  flagged({ sandbox: { mode: 'danger-full-access' } }, 'a looser sandbox');
  flagged({ sandbox: { mode: 'workspace-write', additionalWritableRoots: ['C:\\'] } }, 'a new writable root');
  flagged({ safetyLimits: { maxCostPerSession: 50, maxTokensPerSession: 1000 } }, 'a cost ceiling raised');
  flagged({ safetyLimits: { maxTokensPerSession: 1000 } }, 'a cost ceiling removed');
  flagged({ safetyLimits: null }, 'all limits removed');
  flagged({ trust: { x: true } }, 'trust touched');
  flagged({ permissions: { allow: ['Bash(*)'] } }, 'a permissions allow list');
  flagged({ skills: { dirs: ['C:\\elsewhere'] } }, 'a new skills directory');
  flagged({ agents: { maxConcurrent: 2, directChat: true, allowAll: true } }, 'agents widened by an unknown key');
  flagged({ provider: 'openai' }, 'the active provider changed');
  flagged({ activeProvider: 'other' }, 'activeProvider changed');
  flagged({ providers: { deepseek: { baseUrl: 'https://evil.example/v1', model: 'm' } } }, 'a provider baseUrl changed');
  flagged({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'm' }, openai: { baseUrl: 'https://evil.example' } } }, 'a provider baseUrl added');
  flagged({ providerInstances: [{ id: 'ds-1', type: 'deepseek', baseUrl: 'https://evil.example' }] }, 'an instance baseUrl changed');
  flagged({ providerInstances: [{ id: 'ds-1', type: 'openai', baseUrl: 'https://api.deepseek.com' }] }, 'an instance type changed');
  flagged({ providerInstances: [{ id: 'ds-1', type: 'deepseek', baseUrl: 'https://api.deepseek.com' }, { id: 'new', type: 'openai' }] }, 'a new instance');
  clean({ providers: { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'other' } } }, 'a provider model changed (same endpoint)');
  clean({ provider: 'deepseek', activeProvider: 'ds-1' }, 'provider sent back unchanged');
  clean({ theme: 'dark' }, 'the theme');
  clean({ disabledTools: ['Bash', 'WebFetch', 'Write'] }, 'a tool disabled');
  clean({ autoApprove: false }, 'autoApprove false');
  clean({ sandbox: { mode: 'read-only' } }, 'a stricter sandbox');
  clean({ safetyLimits: { maxCostPerSession: 2, maxTokensPerSession: 500 } }, 'limits lowered');
  clean({ agents: { maxConcurrent: 6, directChat: true } }, 'agents.maxConcurrent raised');
  clean({ hooks: { PreToolUse: [] }, env: { A: '1' } }, 'hooks/env sent back unchanged');

  writeStored({ hooks: {} });
  const r = await T.handleSystemRoute('settings', 'POST', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'calc.exe' }] }] } }, q, NO);
  assert(r?.status === 403 && r.body?.code === 'human-required', 'POST settings adding a hook with the token alone → 403');
  assert(JSON.stringify(readStored().hooks) === '{}', 'and the hook was not written');
  const p = await T.handleSystemRoute('settings/path', 'POST', { path: 'sandbox.mode', value: 'danger-full-access' }, q, NO);
  assert(p?.status === 403, 'settings/path loosening the sandbox with the token alone → 403');
  const ok = await T.handleSystemRoute('settings', 'POST', { theme: 'light' }, q, NO);
  assert(ok?.status === 200 && readStored().theme === 'light', 'an ordinary setting still saves on the token alone');
  const okPath = await T.handleSystemRoute('settings/path', 'POST', { path: 'theme', value: 'dark' }, q, NO);
  assert(okPath?.status === 200 && readStored().theme === 'dark', 'an ordinary setting by path still saves');
  const yes = await T.handleSystemRoute('settings', 'POST', { autoApprove: true }, q, YES);
  assert(yes?.status === 200 && readStored().autoApprove === true, 'with a person the widening write goes through');
});

// ── 4. GET settings redaction ────────────────────────────────────────
await block('4. settings reach the client masked, and a masked value posted back keeps the stored one', async () => {
  const secrets = ['envsecretvalue1', 'mcpenvvalue22', 'hdr-token-333', 'sk-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuv1234', 'xoxb-1111-2222-abcdef', 'cookie-val-44', 'pk-555'];
  writeStored({
    env: { MY_KEY: secrets[0] },
    mcpServers: { s: { command: 'node', args: ['server.js'], env: { TOKEN_X: secrets[1] }, headers: { 'X-Custom': secrets[2] } } },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `curl -H "Authorization: Bearer ${secrets[2]}" -d ${secrets[3]} ${secrets[4]} ${secrets[5]}` }] }] },
    misc: { cookie: secrets[6], private_key: secrets[7], Authorization: 'Bearer zzz' },
  });
  const r = await T.handleSystemRoute('settings', 'GET', {}, q, NO);
  const text = JSON.stringify(r.body);
  for (const s of secrets) assert(!text.includes(s), `GET settings does not carry ${s.slice(0, 6)}…`);
  assert(!/Bearer zzz/.test(text), 'an authorization field is dropped');
  assert(r.body.env && 'MY_KEY' in r.body.env, 'env names stay visible (values masked)');
  assert(r.body.mcpServers?.s?.command === 'node', 'an MCP server\'s command stays visible');

  // Posting the redacted view back (with a person) must not overwrite the stored values.
  const back = await T.handleSystemRoute('settings', 'POST', { env: r.body.env, mcpServers: r.body.mcpServers, hooks: r.body.hooks }, q, YES);
  assert(back?.status === 200, 'posting the redacted view back is accepted');
  const stored = readStored();
  assert(stored.env.MY_KEY === secrets[0], 'env value kept, not replaced by the marker');
  assert(stored.mcpServers.s.env.TOKEN_X === secrets[1] && stored.mcpServers.s.headers['X-Custom'] === secrets[2], 'MCP env/headers kept');
  assert(stored.hooks.PreToolUse[0].hooks[0].command.includes(secrets[3]), 'a hook command with a masked token kept its stored value');
  // …and without a person, posting the unchanged masked view is not a widening.
  const same = await T.handleSystemRoute('settings', 'POST', { env: r.body.env }, q, NO);
  assert(same?.status === 200 && readStored().env.MY_KEY === secrets[0], 'the unchanged masked view needs no person and changes nothing');
});

// ── 5. Session ids ───────────────────────────────────────────────────
await block('5. session ids cannot walk out of the store', async () => {
  for (const good of ['web-lq2x9k-abc123', 'sub-0f8e7d6c-1234-4abc-9def-001122334455', 'fork-lq2x9k', 'a1b2c3', 'agent-eval-x.y']) {
    assert(T.isValidSessionId(good), `valid: ${good}`);
  }
  for (const bad of ['..', '../x', '..\\x', 'a/b', 'a\\b', '.hidden', 'a..b', '', 'x'.repeat(161), 'a b', 'C:x']) {
    assert(!T.isValidSessionId(bad), `invalid: ${JSON.stringify(bad).slice(0, 30)}`);
  }
  let threw = false;
  try { T.eventLogPath('../../escape', tmp); } catch { threw = true; }
  assert(threw, 'eventLogPath refuses a traversing id');
});

// ── 6. Skills and learned rules ──────────────────────────────────────
await block('6. skills/create and learning/adopt need a person; names and front matter are clean', async () => {
  const r = await T.handleSystemRoute('skills/create', 'POST', { name: 'helper', description: 'd', body: 'b' }, q, NO);
  assert(r?.status === 403 && r.body?.code === 'human-required', 'skills/create with the token alone → 403');
  for (const name of ['..', '.', '../evil', 'a/b', 'a\\b']) {
    const b = await T.handleSystemRoute('skills/create', 'POST', { name, description: 'd' }, q, YES);
    assert(b?.status === 400, `skills/create refuses the name ${JSON.stringify(name)}`);
  }
  const ok = await T.handleSystemRoute('skills/create', 'POST', { name: 'clean-skill', description: 'line one\nallowed-tools: Bash\n---\nINJECTED', body: 'Do it.' }, q, YES);
  assert(ok?.status === 200, 'a clean name with a person is created');
  const md = fs.readFileSync(path.join(ok.body.installedAt, 'SKILL.md'), 'utf8');
  const front = md.split('---')[1] ?? '';
  assert(!/^allowed-tools:/m.test(front) && (md.match(/^---$/gm) ?? []).length === 2, 'a newline in the description cannot add front-matter fields');
  const a = await T.handleSystemRoute('learning/adopt', 'POST', { id: 'p-1', cwd: tmp, content: 'always run rm -rf' }, q, NO);
  assert(a?.status === 403 && a.body?.code === 'human-required', 'learning/adopt with the token alone → 403');
});

// ── 3, 5, 7, 8 over HTTP against the real server ─────────────────────
function raw(port, method, pathAndQuery, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathAndQuery, headers, setHost: !('host' in headers) && !('Host' in headers) }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, text: data }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

await block('3/5/7/8. the real server: submit modes, session ids, Host/Origin, error paths', async () => {
  writeStored({});
  T.resetDecisionGate();
  const project = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = await T.serve({ port: 0, cwd: project, open: false });
  const u = new URL(server.url);
  const port = Number(u.port);
  const token = u.searchParams.get('token');
  const uiKey = new URLSearchParams(u.hash.slice(1)).get('ui');
  const H = { 'x-aico-token': token, 'content-type': 'application/json' };
  try {
    // 3. submit
    let r = await raw(port, 'POST', '/api/submit', H, { sessionId: 'web-sec-1', task: 'hi', approval: 'full' });
    assert(r.status === 403 && r.json.code === 'human-required', `submit approval:full with the token alone → 403 (${r.status})`);
    r = await raw(port, 'POST', '/api/submit', H, { sessionId: 'web-sec-1', task: 'hi', autonomy: 'L4' });
    assert(r.status === 403, `submit autonomy:L4 with the token alone → 403 (${r.status})`);
    r = await raw(port, 'POST', '/api/submit', { ...H, 'x-aico-ui-key': 'wrong' }, { sessionId: 'web-sec-1', task: 'hi', approval: 'full' });
    assert(r.status === 403, 'a wrong UI key does not count as a person');
    assert(uiKey && uiKey.length > 10, 'the startup link carries a UI key (what a person\'s window holds)');

    // 5. session ids over HTTP
    for (const [method, p, body] of [
      ['GET', '/api/session?id=..%2F..%2Fsettings'],
      ['GET', '/api/events?session=..%5C..%5Cx'],
      ['GET', '/api/trajectory?id=..%2Fx'],
      ['GET', '/api/session/export?id=..%2F..%2Fx'],
      ['POST', '/api/session/rename', { sessionId: '../../x', title: 't' }],
      ['POST', '/api/model', { sessionId: '../x', model: 'm' }],
      ['POST', '/api/agent', { sessionId: '..\\x', name: null }],
      ['POST', '/api/feedback', { sessionId: '../x', targetSeq: 1, rating: 'up' }],
      ['POST', '/api/submit', { sessionId: '../../x', task: 'hi' }],
      ['POST', '/api/sessions/delete', { ids: ['..'] }],
      ['GET', '/api/canvas/list?session=..'],
    ]) {
      const res = await raw(port, method, p, H, body);
      assert(res.status === 400, `${method} ${p.split('?')[0]} with a traversing session id → 400 (${res.status})`);
    }
    r = await raw(port, 'GET', '/api/session?id=sub-0f8e7d6c-1234-4abc-9def-001122334455', H);
    assert(r.status === 200, `a sub-agent id still reads (${r.status})`);

    // 7. Host and Origin
    r = await raw(port, 'GET', '/', { host: `evil.example:${port}` });
    assert(r.status === 403, `static file with a rebinding Host → 403 (${r.status})`);
    r = await raw(port, 'GET', '/api/settings', { ...H, host: `evil.example:${port}` });
    assert(r.status === 403, `API with a rebinding Host → 403 (${r.status})`);
    r = await raw(port, 'GET', '/api/settings', { ...H, host: `127.0.0.1:${port + 1}` });
    assert(r.status === 403, `API with a loopback Host on another port → 403 (${r.status})`);
    for (const origin of [`http://127.0.0.1:${port}.evil.example`, `http://127.0.0.1:${port}0`, `http://localhost:${port}@evil.example`, 'null', `https://127.0.0.1:${port}`]) {
      r = await raw(port, 'GET', '/api/settings', { ...H, origin });
      assert(r.status === 403, `Origin ${origin} → 403 (${r.status})`);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      r = await raw(port, 'GET', '/api/settings', { ...H, host, origin: `http://${host}` });
      assert(r.status === 200, `Host/Origin ${host} → 200 (${r.status})`);
    }

    // 8. error responses carry no absolute path
    const missing = path.join(tmp, 'deep', 'no-such-dir-xyz');
    r = await raw(port, 'POST', '/api/projects/add', H, { path: missing });
    assert(r.status === 400 && /no-such-dir-xyz/.test(r.text) && !r.text.includes(path.dirname(missing).replace(/\\/g, '\\\\')) && !r.text.includes(tmp.replace(/\\/g, '\\\\')),
      `an error names the folder, not its absolute path (${r.text.slice(0, 120)})`);
    assert(T.publicErrorMessage('ENOENT: open \'C:\\Users\\Some One\\.aico\\settings.json\'') === 'ENOENT: open \'…/settings.json\'', 'a Windows path with a space is cut to its last part');
    assert(T.publicErrorMessage('EACCES /home/alice/.aico/vault/key.json') === 'EACCES …/key.json', 'a POSIX path is cut to its last part');
    assert(T.publicErrorMessage('sessionId and task required') === 'sessionId and task required', 'a validation message is unchanged');
    assert(T.publicErrorMessage('POST /api/settings failed') === 'POST /api/settings failed', 'an API route is not mistaken for a path');
  } finally {
    await server.close();
  }
});

// ── D1. providers/test never sends a stored key to a caller-chosen URL ─
await block('D1. providers/test attaches a stored key only to the stored endpoint', async () => {
  const seen = [];
  const capture = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: String(req.headers.authorization ?? '') + String(req.headers['x-api-key'] ?? '') });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}');
  });
  await new Promise(r => capture.listen(0, '127.0.0.1', r));
  const cap = `http://127.0.0.1:${capture.address().port}`;
  const legacyKey = 'sk-or-v1-securitytestcanary0000000000';
  const instanceKey = 'instance-canary-key-d1';
  try {
    writeStored({
      providers: { openrouter: { apiKey: legacyKey } },
      providerInstances: [{ id: 'mine', type: 'openai', name: 'Mine', baseUrl: `${cap}/v1`, apiKey: instanceKey }],
    });
    const leaked = () => seen.some(s => s.auth.includes(legacyKey) || s.auth.includes(instanceKey));

    seen.length = 0;
    let r = await T.handleSystemRoute('providers/test', 'POST', { type: 'openrouter', baseUrl: `${cap}/api/v1` }, q, NO);
    assert(!leaked(), 'a blank key with a caller-chosen baseUrl does not send the stored key');
    assert(r?.status === 200 && r.body?.ok === false && /key/i.test(String(r.body?.error)), `…and the answer asks for a key (${r?.body?.error})`);

    seen.length = 0;
    await T.handleSystemRoute('provider-test', 'POST', { provider: 'openai', baseUrl: `${cap}/evil/v1` }, q, NO);
    assert(!leaked(), 'the provider-test alias with a different baseUrl does not send the instance key');

    seen.length = 0;
    await T.handleSystemRoute('providers/test', 'POST', { type: 'openai-compatible', baseUrl: `${cap}/v1` }, q, NO);
    assert(!leaked(), 'a different type at the stored URL does not borrow another type\'s key');

    seen.length = 0;
    r = await T.handleSystemRoute('providers/test', 'POST', { type: 'openai', baseUrl: `${cap}/v1/` }, q, NO);
    assert(seen.some(s => s.auth.includes(instanceKey)) && r?.body?.ok === true, 'the stored key still tests against its own stored baseUrl');

    seen.length = 0;
    r = await T.handleSystemRoute('providers/test', 'POST', { type: 'openrouter', baseUrl: `${cap}/api/v1`, apiKey: 'typed-key-d1' }, q, NO);
    assert(seen.some(s => s.auth.includes('typed-key-d1')) && !leaked(), 'a typed key goes to the typed URL');

    seen.length = 0;
    r = await T.handleSystemRoute('providers/test', 'POST', { id: 'mine', baseUrl: `${cap}/evil/v1` }, q, NO);
    assert(seen.every(s => !s.url.startsWith('/evil')), 'testing by id ignores a caller-supplied baseUrl');
  } finally {
    await new Promise(r => capture.close(r));
  }
});

// ── D3. hook commands: secret-looking parts are masked ────────────────
await block('D3. hook commands reach the client with tokens, flags and URL passwords masked', async () => {
  const canary = 'dast-hook-canary-0f3a9c1d2b7e4f5a6c8d9e0b';
  const cmds = [
    `echo ${canary}`,
    'deploy --token abc123secretvalue --verbose',
    'deploy --api-key=k3y-val-778899',
    'curl https://alice:pa55w0rd-x@example.com/hook',
    'API_TOKEN=tok-value-5566 node notify.js',
  ];
  const secrets = [canary, 'abc123secretvalue', 'k3y-val-778899', 'pa55w0rd-x', 'tok-value-5566'];
  writeStored({ hooks: { PreToolUse: cmds.map(command => ({ matcher: 'X', command })) } });
  const r = await T.handleSystemRoute('settings', 'GET', {}, q, NO);
  const text = JSON.stringify(r.body);
  for (const s of secrets) assert(!text.includes(s), `GET settings hides ${s.slice(0, 10)}… in a hook command`);
  const shown = r.body.hooks.PreToolUse.map(h => h.command);
  assert(shown[0].startsWith('echo ') && shown[1].includes('--verbose') && shown[3].includes('example.com/hook') && shown[4].includes('node notify.js'),
    `the rest of each command stays readable (${shown.join(' | ')})`);
  const back = await T.handleSystemRoute('settings', 'POST', { hooks: r.body.hooks }, q, YES);
  assert(back?.status === 200, 'posting the masked hooks back is accepted');
  const stored = readStored().hooks.PreToolUse.map(h => h.command);
  assert(cmds.every((c, i) => stored[i] === c), 'every stored hook command is kept, not replaced by the masked view');
});

// ── D7. malformed and oversized bodies: 400 / 413, never 500 ─────────
function rawBody(port, method, p, headers, body, { declaredLength } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: declaredLength ? { ...headers, 'content-length': String(declaredLength) } : headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', (err) => resolve({ status: 0, text: String(err) }));
    // A server that waits for a body that never comes is a failure, not a hang.
    req.setTimeout(15_000, () => { resolve({ status: -1, text: 'no answer within 15 s' }); req.destroy(); });
    if (typeof body === 'function') body(req); else { if (body !== undefined) req.write(body); if (!declaredLength) req.end(); }
  });
}

await block('D7. a malformed body is 400, an oversized one 413, with no stack or path', async () => {
  writeStored({});
  const project = fs.mkdtempSync(path.join(tmp, 'srv7-'));
  const server = await T.serve({ port: 0, cwd: project, open: false });
  const u = new URL(server.url);
  const port = Number(u.port);
  const H = { 'x-aico-token': u.searchParams.get('token'), 'content-type': 'application/json' };
  const leaks = (t) => /\bat [\w.<>]+ \(|[A-Za-z]:\\|\/(home|Users|tmp)\/|\.ts:\d|\.js:\d/.test(t);
  try {
    for (const route of ['session/rename', 'settings', 'submit', 'permission', 'canvas/create', 'agents/stop', 'providers/test']) {
      const r = await rawBody(port, 'POST', `/api/${route}`, H, '{"a": [1, 2,,, }');
      assert(r.status === 400 && !leaks(r.text), `malformed JSON on ${route} → 400 without internals (${r.status} ${r.text.slice(0, 60)})`);
    }
    // Declared too large: refused from the header, before any of it is read.
    let r = await rawBody(port, 'POST', '/api/session/rename', H, '{', { declaredLength: 100 * 1024 * 1024 });
    assert(r.status === 413 && !leaks(r.text), `a declared 100 MB body → 413 (${r.status} ${r.text.slice(0, 60)})`);
    // Streamed too large (no length): refused once it passes the cap.
    r = await rawBody(port, 'POST', '/api/session/rename', { ...H, 'transfer-encoding': 'chunked' }, (req) => {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const pump = () => { while (sent < 10) { sent++; if (!req.write(chunk)) { req.once('drain', pump); return; } } req.end(); };
      req.on('error', () => { /* the server may stop reading once it has answered */ });
      pump();
    });
    assert(r.status === 413 && !leaks(r.text), `a streamed 10 MB body → 413 (${r.status} ${r.text.slice(0, 60)})`);
    const alive = await raw(port, 'GET', '/api/sessions', H);
    assert(alive.status === 200, `the server still answers afterwards (${alive.status})`);
  } finally {
    await server.close();
  }
});

// ── 3. the submit-mode rule itself ───────────────────────────────────
await block('3. submit modes: a token-only request is capped to the person\'s last choice', async () => {
  const D = T.decideSubmitMode;
  assert(D({}, 3, false).action === 'run', 'the default (auto) runs at the default ceiling');
  assert(D({ approval: 'full' }, 3, false).action === 'refuse', 'full above the ceiling without a person: refused');
  assert(D({ autonomy: 'L4' }, 3, false).action === 'refuse', 'L4 above the ceiling without a person: refused');
  assert(D({ approval: 'full' }, 3, true).action === 'run', 'full with a person: runs');
  assert(D({ approval: 'full' }, 4, false).action === 'run', 'full when a person already chose it in this chat: runs');
  const capped = D({ approval: 'auto' }, 1, false);
  assert(capped.action === 'run' && capped.mode.approval === 'ask', 'auto after a person chose ask: capped to ask');
  const cappedL = D({ autonomy: 'L3' }, 2, false);
  assert(cappedL.action === 'run' && cappedL.mode.autonomy === 'L2', 'L3 after a person chose L2: capped to L2');
  assert(D({ approval: 'ask' }, 3, false).action === 'run', 'asking for less is always allowed');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map(f => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
