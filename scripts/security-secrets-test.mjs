/**
 * Secrets the engine holds outside the vault, tested as the leaks they were.
 *
 * Why this suite exists: a privacy review found that the provider API keys and
 * `settings.env` values `loadSettings` copies into `process.env` were inherited
 * by every child the agent starts (so `printenv` in its shell printed them into
 * the log), that the redactor only knew vault values, that AskUser answers
 * skipped the paste scanner, that a scan which threw passed the text through,
 * that a deck picture redirect carried the provider's Authorization header to
 * the next host, that two sinks clipped text before redacting it (a clipped
 * secret no longer matches), that the scanner missed several common token
 * formats, and that the vault's AES-GCM accepted a truncated tag. Each block is
 * one of those, written to fail on the code before the fix.
 *
 * Offline and free. Every value below is an obviously fake canary assembled at
 * runtime; settings are written only to this process's own AICO_HOME.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
/** One finding per block: a block that throws is one failure, and the rest still run. */
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}

// ── canaries (fake, built at runtime) ────────────────────────────────────
const KEY_CANARY = 'sk-FAKE' + 'CanaryOpenAiKey0'.repeat(3); // standards-allow: secret
const ENV_CANARY = 'FakeEnvCanary' + '7q'.repeat(10); // standards-allow: secret
const MCP_ENV_CANARY = 'FakeMcpEnvCanary' + '3w'.repeat(10); // standards-allow: secret
const MCP_HDR_CANARY = 'FakeMcpBearer' + '9z'.repeat(10); // standards-allow: secret
const GHP = 'ghp_' + 'FAKE0'.repeat(8); // standards-allow: secret

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-secrets-test-'));
const startCwd = process.cwd();
process.on('exit', () => {
  try { process.chdir(startCwd); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Settings of our own (the copied real file is replaced), loaded from a cwd
// with no project settings, and no provider key inherited from the shell.
for (const n of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[n];
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), JSON.stringify({
  env: { AICO_TEST_FAKE_SETTING: ENV_CANARY },
  providers: { openai: { apiKey: KEY_CANARY } },
  mcpServers: { fake: { command: 'node', args: ['x.js'], env: { FAKE_MCP_KEY: MCP_ENV_CANARY }, headers: { Authorization: `Bearer ${MCP_HDR_CANARY}` } } },
}));
process.chdir(tmp);
await T.loadSettings();

const nodeEcho = (name) => `node -p "process.env.${name} || 'ABSENT'"`;

await block('P1: provider keys and settings.env do not reach the agent\'s children', async () => {
  assert(process.env.OPENAI_API_KEY === KEY_CANARY, 'the engine itself still has the provider key (providers need it)');
  assert(process.env.AICO_TEST_FAKE_SETTING === ENV_CANARY, 'the engine itself still has settings.env');

  const key = await T.bash({ command: nodeEcho('OPENAI_API_KEY'), timeout: 30 });
  assert(key.stdout.trim() === 'ABSENT' && !key.stdout.includes(KEY_CANARY), 'Bash child does not see OPENAI_API_KEY');
  const env = await T.bash({ command: nodeEcho('AICO_TEST_FAKE_SETTING'), timeout: 30 });
  assert(env.stdout.trim() === 'ABSENT', 'Bash child does not see a settings.env value');

  const proc = await T.runProcess('node', ['-p', "process.env.OPENAI_API_KEY || 'ABSENT'"], { cwd: tmp, env: {}, timeoutMs: 30_000 });
  assert(proc.stdout.trim() === 'ABSENT', 'custom-tool child does not see OPENAI_API_KEY');

  const child = T.agentChildEnv({ AICO_AGENT_SHELL: '1' });
  assert(child.OPENAI_API_KEY === undefined, 'agentChildEnv drops the provider key');
  assert(child.AICO_TEST_FAKE_SETTING === undefined, 'agentChildEnv drops settings.env names');
  assert(Boolean(child.PATH ?? child.Path), 'agentChildEnv keeps PATH');
  assert(child.AICO_AGENT_SHELL === '1', 'agentChildEnv keeps what trusted code binds');

  const mcp = T.mcpServerEnv({ FAKE_MCP_KEY: 'mine' });
  assert(mcp.FAKE_MCP_KEY === 'mine', 'an MCP server gets its own configured env');
  assert(mcp.OPENAI_API_KEY === undefined && mcp.AICO_TEST_FAKE_SETTING === undefined, 'an MCP server gets no provider key or settings.env');
  assert(Boolean(mcp.PATH ?? mcp.Path), 'an MCP server keeps PATH');
});

await block('P1: settings-held secrets are redacted by every sink', async () => {
  for (const [label, v] of [['provider key', KEY_CANARY], ['settings.env value', ENV_CANARY], ['MCP env value', MCP_ENV_CANARY], ['MCP bearer header token', MCP_HDR_CANARY]]) {
    const out = T.sinkRedactText(`dump: X=${v} done`);
    assert(!out.includes(v), `sink redacts the ${label}`);
  }
  assert(T.sinkRedactText('nothing secret here') === 'nothing secret here', 'ordinary text passes unchanged');
});

await block('P1: environment dumps and settings reads are refused in the shell', async () => {
  for (const cmd of ['printenv', 'printenv OPENAI_API_KEY', 'env', 'env | grep KEY', 'ls; env > out.txt', 'set', 'export -p',
    'Get-ChildItem env:', 'gci Env:', 'dir env:', '[Environment]::GetEnvironmentVariables()',
    'cat ~/.aico/settings.json', 'type %USERPROFILE%\\.aico\\settings.local.json', 'cat "$AICO_HOME/settings.json"']) {
    assert(typeof T.shellDenial(cmd) === 'string', `refused: ${cmd}`);
  }
  for (const cmd of ['env NODE_ENV=test node app.js', '/usr/bin/env node a.js', 'set -e; make', 'npm run build', 'cat settings.json', 'echo $env:PATH']) {
    assert(T.shellDenial(cmd) === undefined, `allowed: ${cmd}`);
  }
});

await block('P2: AskUser answers are scanned like messages', async () => {
  const vault = T.configureVault({ dir: path.join(process.env.AICO_HOME, 'vault'), keyProvider: T.memoryKeyProvider() });
  const guarded = await T.guardAgentRun({ task: 'x', depth: 1, settings: {}, onAskUser: async () => `use this: ${GHP}` });
  const answer = await guarded.onAskUser('Which token?');
  assert(!answer.includes(GHP), 'a token typed as an AskUser answer never reaches the model');
  // Fail closed: a quarantine that throws withholds rather than passes through.
  vault.quarantineUserText = async () => { throw new Error('simulated vault failure'); };
  const q = await T.quarantineIfEnabled(`here ${GHP} ok`, {}, 's1');
  assert(!q.text.includes(GHP) && q.text.includes('here'), 'a failing quarantine strips the detected secret (fails closed)');
  const w = T.withholdDetected('anything', () => { throw new Error('scanner broke'); });
  assert(!w.text.includes('anything'), 'a failing scanner withholds the whole text');
});

await block('P8: a cross-origin redirect drops credential headers', async () => {
  const h = { Accept: 'image/png', Authorization: 'Client-ID fake', Cookie: 'a=b', 'X-Api-Key': 'fake' };
  const same = T.headersForHop(h, 'https://api.pexels.com', 'https://api.pexels.com');
  assert(same.Authorization === 'Client-ID fake', 'same-origin hop keeps Authorization');
  const cross = T.headersForHop(h, 'https://api.pexels.com', 'https://evil.example');
  assert(!('Authorization' in cross) && !('Cookie' in cross) && !('X-Api-Key' in cross), 'cross-origin hop drops Authorization/Cookie/API key');
  assert(cross.Accept === 'image/png', 'cross-origin hop keeps Accept');
});

await block('P9: redaction happens before clipping', async () => {
  const text = 'a'.repeat(50) + ' ' + GHP + ' tail';
  const cut = T.cleanTaskText(text, 62);
  assert(!/ghp_FAKE0/.test(cut ?? ''), 'task text: a secret straddling the clip is still redacted');
  const review = T.buildReviewInput({
    requests: ['b'.repeat(3990) + ' ' + GHP], tool: 'Bash', args: { command: 'c'.repeat(2470) + ' ' + GHP },
    trigger: { effect: 'exec', why: 'test' }, intent: 'd'.repeat(590) + ' ' + GHP, recent: [{ name: 'Bash', args: 'e'.repeat(190) + ' ' + GHP }],
  });
  assert(!/ghp_FAKE0/.test(review), 'sentinel review: a secret straddling any clip is still redacted');
});

await block('P10: scanner knows more token formats', async () => {
  const hex = 'abcdef0123456789'.repeat(2);
  const cases = {
    'zai-key': `${hex}.FakeZaiCanary123`, // standards-allow: secret
    'gitlab-token': 'glpat-' + 'FakeGitLab0'.repeat(2), // standards-allow: secret
    'huggingface-token': 'hf_' + 'FakeHugging'.repeat(3), // standards-allow: secret
    'npm-token': 'npm_' + 'FakeNpm0'.repeat(4) + 'Fake', // standards-allow: secret
    'sendgrid-key': 'SG.' + 'FakeSendGrid'.repeat(2).slice(0, 22) + '.' + 'FakeSendGridSecret0'.repeat(3).slice(0, 43), // standards-allow: secret
    'telegram-bot-token': '123456789:AA' + 'FakeTelegram'.repeat(3).slice(0, 33), // standards-allow: secret
    'discord-bot-token': 'M' + 'FakeDiscord0'.repeat(2).slice(0, 23) + '.FakeAa.' + 'FakeDiscordHmac0'.repeat(2).slice(0, 27), // standards-allow: secret
    'bearer-token': 'FakeBearer0123456789abc', // standards-allow: secret
  };
  for (const [label, value] of Object.entries(cases)) {
    const text = label === 'bearer-token' ? `curl -H "Authorization: Bearer ${value}" x` : `key ${value} here`;
    const found = T.scanForSecrets(text);
    assert(found.some(f => f.value === value), `scanner finds ${label}`);
  }
  assert(!T.scanForSecrets('curl -H "Authorization: Bearer $TOKEN"').length, 'Bearer $TOKEN is a reference, not found');
  assert(!T.scanForSecrets('Authorization: Bearer YOUR_TOKEN_HERE').length, 'Bearer YOUR_TOKEN_HERE is a placeholder, not found');
});

await block('P10: vault AES-GCM rejects a truncated tag', async () => {
  const key = Buffer.alloc(32, 7);
  const w = T.vaultWrap(key, Buffer.from('fake plaintext'), 'label');
  assert(T.vaultUnwrap(key, w, 'label')?.toString() === 'fake plaintext', 'a full tag opens');
  const short = { ...w, tag: Buffer.from(w.tag, 'base64').subarray(0, 4).toString('base64') };
  assert(T.vaultUnwrap(key, short, 'label') === undefined, 'a 4-byte tag is refused');
});

process.chdir(startCwd);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
