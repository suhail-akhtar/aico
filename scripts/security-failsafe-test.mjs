/**
 * Every guard fails CLOSED, tested offline.
 *
 * The per-feature suites (sentinel-test, vault-test, credential-ux-test,
 * ops-test, phase0/phase1/phase7, deck-visual-test) prove each guard does its
 * job on the inputs it was designed for. What they mostly do not prove is the
 * other half of a guard's contract: what happens when the thing it depends on
 * breaks — a reviewer model that throws or answers in a malformed shape, a
 * permission callback that rejects, a gate fed a number where it expects a
 * string, a vault file that is corrupt, a DNS lookup that fails, a pipeline
 * stage that returns garbage. A guard written as `try { check } catch { allow }`
 * passes every happy-path test and is still a hole, so this suite feeds each
 * guard the failure and asserts the call is refused (or a person is asked),
 * never let through.
 *
 * Only what the other suites do not already cover is here; the header of each
 * block names the existing coverage it builds on. An assertion that fails here
 * is a guard that fails OPEN — it is left failing on purpose, never relaxed to
 * pass.
 *
 * Offline and free: scripted providers, an in-memory vault key, servers on
 * 127.0.0.1 only, and nothing touches ~/.aico.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const T = await import('../dist-test/test-exports.js');

let passed = 0;
let failed = 0;
const failures = [];
const notes = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
/** Behaviour worth recording that is not (yet) a contract: printed, never counted. */
function note(text) { notes.push(text); console.log(`  · NOTE ${text}`); }
async function block(title, fn) {
  console.log(`\n══ ${title} ══`);
  try { await fn(); } catch (err) { assert(false, `${title}: threw ${err?.stack ?? err}`); }
}
async function errorOf(fn) {
  try { await fn(); return undefined; } catch (err) { return err ?? new Error('(thrown undefined)'); }
}
/** Settles within `ms`? Resolves to { settled, value?, error? }. */
async function within(promise, ms) {
  let timer;
  const t = new Promise(r => { timer = setTimeout(() => r({ settled: false }), ms); });
  const p = promise.then(value => ({ settled: true, value }), error => ({ settled: true, error }));
  const out = await Promise.race([p, t]);
  clearTimeout(timer);
  return out;
}

// Several timers under test are unref'd (approval timeouts): keep the loop alive
// while they run, or Node exits mid-await. Every exit path is process.exit().
setInterval(() => {}, 60_000);

// The copied settings.json carries the reader's real hooks and MCP servers; none may run here.
fs.writeFileSync(path.join(process.env.AICO_HOME, 'settings.json'), '{}');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico failsafe '));   // a space on purpose
const startCwd = process.cwd();
process.on('exit', () => {
  try { process.chdir(startCwd); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// Obviously fake canaries. standards-allow: secret
const CANARY = 'Fs4fe-Can4ry-Value-0a1b2c3d4e';   // standards-allow: secret
const leaks = (x) => {
  const s = typeof x === 'string' ? x : JSON.stringify(x ?? '');
  return s.includes(CANARY) || s.includes(Buffer.from(CANARY).toString('base64').replace(/=+$/, ''));
};

/** A bare pipeline and a body that records whether it ran. */
function bare() {
  const pipeline = new T.ToolPipeline();
  const run = async (name = 'Bash', args = { command: 'rm -rf build' }, agentId = 'a1') => {
    let ran = false;
    let r;
    let rejected;
    try {
      r = await pipeline.execute({ callId: 'c1', name, arguments: args, agentId, state: new Map() }, async () => { ran = true; return 'ran'; });
    } catch (err) { rejected = err; }
    return { ...(r ?? {}), ran, rejected };
  };
  return { pipeline, run };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. SENTINEL. Already covered (sentinel-test): reviewer throws, times out,
//    provider error, prose reply, "approve", empty reply → escalate; the
//    stage's escalate/park/no-one paths. Added: malformed-but-JSON shapes,
//    a stub that resolves to nothing, case/shape tricks at the stage, a
//    person-prompt or inbox that throws, and an `active()` that throws.
// ═══════════════════════════════════════════════════════════════════════
await block('1a. Sentinel: a reply in a malformed shape never reads as allow', async () => {
  const p = T.parseSentinelReply;
  const shapes = {
    'truncated JSON': '{"verdict":"allow"',
    'bare word allow': 'allow',
    'ALLOW in prose': 'Verdict: ALLOW. Reason: fine.',
    'nested verdict': '{"result":{"verdict":"allow"}}',
    'verdict as object': '{"verdict":{"value":"allow"}}',
    'verdict as number': '{"verdict":1}',
    'verdict as boolean': '{"verdict":true}',
    'verdict null': '{"verdict":null,"reason":"allow"}',
    'two objects (deny, then allow)': '{"verdict":"deny"} and also {"verdict":"allow"}',
    'allow with a NUL byte': '{"verdict":"allow\\u0000"}',
    'allow with trailing text in value': '{"verdict":"allow, but check first"}',
  };
  for (const [what, text] of Object.entries(shapes)) {
    const r = p(text);
    assert(r.verdict !== 'allow', `${what} → ${r.verdict} (never allow)`);
  }
  // The array case: String(["allow"]) === "allow". The reviewer's output is
  // steerable by injected text, so a shape the parser does not expect must
  // not be read as a yes.
  const arr = p('{"verdict":["allow"],"reason":"ok"}');
  assert(arr.verdict !== 'allow', `verdict as an array ["allow"] → ${arr.verdict} (must not be allow; src/sentinel/policy.ts parseSentinelReply coerces with String(), line 400)`);
});

await block('1b. Sentinel: reviewCall with a provider that misbehaves', async () => {
  const provider = (events, opts = {}) => ({
    id: 'stub', displayName: 'Stub', promptDialect: 'markdown',
    async *chat(o) {
      for (const e of events) yield e;
      if (opts.throwAfter) throw new Error('stream reset after partial reply');
      if (opts.hangAfter) await new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  });
  let r = await T.reviewCall('x', { model: 'stub', timeoutMs: 1000, provider: provider([{ type: 'text', content: '{"verdict":"allow","reason":"ok"}' }], { throwAfter: true }) });
  assert(r.verdict === 'escalate' && r.failure, 'a full "allow" followed by a stream error: escalate (the reply is not trusted half-way)');
  r = await T.reviewCall('x', { model: 'stub', timeoutMs: 80, provider: provider([{ type: 'text', content: '{"verdict":"allow","reason":"ok"}' }], { hangAfter: true }) });
  assert(r.verdict === 'escalate' && /no answer within/.test(r.failure ?? ''), 'an "allow" that arrives but the stream never ends: escalate on the deadline');
  r = await T.reviewCall('x', { model: 'stub', timeoutMs: 1000, provider: provider([{ type: 'error', error: 'overloaded' }]) });
  assert(r.verdict === 'escalate', 'an error event and no text: escalate');
  r = await T.reviewCall('x', { model: 'stub', timeoutMs: 1000, provider: provider([{ type: 'text', content: '{"verdict":' }, { type: 'text', content: '"allow"' }]) });
  assert(r.verdict === 'escalate', 'a reply cut off mid-object: escalate');
  r = await T.reviewCall('x', { model: 'stub', timeoutMs: 1000, provider: { id: 'broken', displayName: 'Broken', chat() { throw new Error('chat is not iterable'); } } });
  assert(r.verdict === 'escalate', 'a provider whose chat() throws synchronously: escalate');
});

function sentinelStage(o = {}) {
  const pipeline = new T.ToolPipeline();
  T.installSentinel(pipeline, {
    agentId: 'a1', active: o.active ?? (() => true), model: 'stub', cwd: () => tmp, tainted: () => false,
    requests: () => ['Clean the build output'], intent: () => 'cleaning up', recent: () => [], untrusted: () => [],
    customEffect: () => undefined,
    ...(o.ask ? { ask: o.ask } : {}),
    ...(o.park ? { park: o.park } : {}),
    unattended: Boolean(o.unattended), sessionId: 's-failsafe',
    review: o.review,
  });
  const run = async () => {
    let ran = false;
    let r;
    let rejected;
    try {
      r = await pipeline.execute({ callId: 'c', name: 'Bash', arguments: { command: 'rm -rf build' }, agentId: 'a1', state: new Map() }, async () => { ran = true; return 'ok'; });
    } catch (err) { rejected = err; }
    return { ...(r ?? {}), ran, rejected };
  };
  return { run };
}

await block('1c. Sentinel stage: a reviewer stub that answers nonsense', async () => {
  const cases = {
    'resolves undefined': async () => undefined,
    'resolves null': async () => null,
    'resolves a string "allow"': async () => 'allow',
    'verdict "ALLOW" (wrong case)': async () => ({ verdict: 'ALLOW', reason: 'x', model: 'stub', costUsd: 0, ms: 1 }),
    'verdict ["allow"]': async () => ({ verdict: ['allow'], reason: 'x', model: 'stub', costUsd: 0, ms: 1 }),
    'verdict " allow"': async () => ({ verdict: ' allow', reason: 'x', model: 'stub', costUsd: 0, ms: 1 }),
    'no verdict field': async () => ({ reason: 'x', model: 'stub', costUsd: 0, ms: 1 }),
    'rejects with a non-Error': async () => { throw 'string thrown'; },   // eslint-disable-line no-throw-literal
  };
  for (const [what, review] of Object.entries(cases)) {
    const r = await sentinelStage({ review }).run();
    assert(!r.ran, `reviewer ${what}: the call does not run (nobody to ask)`);
  }
});

await block('1d. Sentinel stage: the person-prompt, the inbox and the switch throwing', async () => {
  const escalate = async () => ({ verdict: 'escalate', reason: 'unsure', model: 'stub', costUsd: 0, ms: 1 });
  let r = await sentinelStage({ review: escalate, ask: async () => { throw new Error('approval card crashed'); } }).run();
  assert(!r.ran && r.denied, 'escalate + the approval prompt throws: refused');
  r = await sentinelStage({ review: escalate, ask: async () => undefined }).run();
  assert(!r.ran && r.denied, 'escalate + the approval prompt resolves undefined: refused');
  r = await sentinelStage({ review: escalate, unattended: true, park: async () => { throw new Error('inbox disk full'); } }).run();
  assert(!r.ran && r.denied && /nobody is available/.test(r.denialReason ?? ''), 'unattended + the inbox throws: refused, not run');
  r = await sentinelStage({ review: escalate, unattended: true, park: async () => ({ error: 'not replayable' }) }).run();
  assert(!r.ran && r.denied, 'unattended + the inbox reports an error: refused');
  r = await sentinelStage({ review: async () => ({ verdict: 'allow', reason: 'ok', model: 'stub', costUsd: 0, ms: 1 }), active: () => { throw new Error('settings unreadable'); } }).run();
  assert(!r.ran, 'active() throws (settings unreadable): the call does not run unreviewed');
});

// ═══════════════════════════════════════════════════════════════════════
// 2. DECISION GATE. Already covered (credential-ux-test U1/U5, phase1,
//    phase7): token alone, wrong/missing/off-by-one key, cross-site, forged
//    nonce, nonce without a stream, other session, the one-minute grace,
//    desktop attached refuses HTTP yeses, host grant once / late arrival.
//    Added: non-string and empty inputs of every field, wrong-length keys,
//    exact grace boundary, expired / short / flooded host grants, the
//    ten-minute human window, a missing or throwing host decider, and the
//    HTTP routes fed malformed bodies.
// ═══════════════════════════════════════════════════════════════════════
const KEY = 'ui-key-failsafe-0123456789abcdefXYZ';
await block('2a. checkAllow: garbage in every field', async () => {
  let now = 5_000_000;
  const gate = new T.DecisionGate(() => now, KEY);
  const junk = [undefined, null, '', 0, 1, true, {}, [], [KEY], { toString: () => KEY }, Buffer.from(KEY), NaN];
  for (const j of junk) {
    const label = Buffer.isBuffer(j) ? 'Buffer(key)' : Array.isArray(j) ? `[${j.length ? 'key' : ''}]` : typeof j === 'object' && j ? 'object' : String(j);
    assert(!gate.checkAllow({ sessionId: 's1', uiKey: j }).ok, `uiKey ${label}: refused`);
    assert(!gate.checkAllow({ sessionId: 's1', client: j }).ok, `client ${label}: refused`);
  }
  for (const k of [KEY.slice(0, -1), `${KEY}x`, KEY.slice(0, 8), `${KEY}${KEY}`, KEY.toUpperCase(), ` ${KEY}`, `${KEY}\n`]) {
    assert(!gate.checkAllow({ sessionId: 's1', uiKey: k }).ok, `a key of length ${k.length} (real ${KEY.length}) that is not the key: refused`);
  }
  assert(!gate.checkAllow({ sessionId: 's1', uiKey: 'é'.repeat(KEY.length / 2) }).ok, 'a multi-byte key with the same byte length: refused');
  assert('error' in gate.attach(''), 'attach with an empty key: refused');
  assert('error' in gate.attach(Buffer.from(KEY)) && 'error' in gate.attach([KEY]) && 'error' in gate.attach({ toString: () => KEY }), 'attach with the key in a non-string wrapper: refused');
  assert(!gate.checkAllow({ sessionId: 's1', uiKey: KEY, fetchSite: 'cross-site' }).ok, 'the real key from a cross-site page: refused');
  // Prototype names must not look up as a client.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert(!gate.checkAllow({ sessionId: name, client: name }).ok, `client and session "${name}": refused`);
  }
});

await block('2b. checkAllow: nonce lifetime at the boundaries', async () => {
  let now = 9_000_000;
  const gate = new T.DecisionGate(() => now, KEY);
  const { client } = gate.attach(KEY);
  assert(!gate.checkAllow({ sessionId: 's1', client }).ok, 'attached but never connected: refused (no grace without a stream ever opened)');
  const r1 = gate.connect(client, 's1');
  const r2 = gate.connect(client, 's1');
  r1(); r1();   // a double close must not close the other stream
  assert(gate.checkAllow({ sessionId: 's1', client }).ok, 'two streams, one closed twice: still connected (the counter is per stream)');
  r2();
  now += 59_999;
  assert(gate.checkAllow({ sessionId: 's1', client }).ok, 'just inside the grace: allowed');
  now += 1;
  assert(!gate.checkAllow({ sessionId: 's1', client }).ok, 'exactly at the 60 s grace: refused');
  now += 10 * 60_000;
  assert(!gate.checkAllow({ sessionId: 's1', client }).ok, 'long after: refused');
  const other = gate.attach(KEY).client;
  gate.connect(other, 's2');
  assert(!gate.checkAllow({ sessionId: 's1', client: other }).ok, 'connected to another session only: refused for this one');
  assert(gate.connect(12345, 's1') && !gate.checkAllow({ sessionId: 's1', client: 12345 }).ok, 'connect with a non-string nonce is a no-op and grants nothing');
  gate.connect('forged-nonce-never-issued', 's1');
  assert(!gate.checkAllow({ sessionId: 's1', client: 'forged-nonce-never-issued' }).ok, 'connecting a forged nonce does not make it valid');
});

await block('2c. checkHuman: grants and the ten-minute window', async () => {
  let now = 20_000_000;
  const gate = new T.DecisionGate(() => now, KEY);
  for (const g of [12345, {}, [], true]) {
    assert(!(await gate.checkHuman({ grant: g })).ok, `grant ${Array.isArray(g) ? '[]' : typeof g}: refused`);
  }
  gate.registerHostGrant('short');   // under 16 chars: never registered
  assert(!(await gate.checkHuman({ grant: 'short' })).ok, 'a grant shorter than 16 characters is never registered (refused)');
  gate.registerHostGrant('g'.repeat(20), 1000);
  now += 1001;
  assert(!(await gate.checkHuman({ grant: 'g'.repeat(20) })).ok, 'an expired host grant: refused');
  gate.registerHostGrant('h'.repeat(20), 1e12);
  now += 10 * 60_000 + 1;
  assert(!(await gate.checkHuman({ grant: 'h'.repeat(20) })).ok, 'a grant asked for with a huge TTL is capped at ten minutes');
  // Flood: past 256 live grants, new ones are not stored (a loop cannot make the table unbounded).
  for (let i = 0; i < 300; i++) gate.registerHostGrant(`flood-grant-${String(i).padStart(6, '0')}`);
  assert(!(await gate.checkHuman({ grant: 'flood-grant-000299' })).ok, 'a grant registered past the 256 cap is not honoured');
  assert(!(await gate.checkHuman({ grant: 'never-registered-grant-xyz' })).ok, 'an unknown grant: refused after the short wait');

  const { client } = gate.attach(KEY);
  now += 10 * 60_000;
  assert(!(await gate.checkHuman({ client })).ok, 'a nonce with no stream, ten minutes after issue: refused');
  for (const j of [undefined, null, '', 0, {}, [client]]) {
    assert(!(await gate.checkHuman({ client: j, uiKey: j })).ok, `client/uiKey ${Array.isArray(j) ? '[nonce]' : JSON.stringify(j) ?? 'undefined'}: refused`);
  }
  gate.setHostAttached(true);
  const live = gate.attach(KEY).client;
  gate.connect(live, 's1');
  assert(!(await gate.checkHuman({ uiKey: KEY })).ok && !(await gate.checkHuman({ client: live })).ok, 'desktop attached: neither the key nor a live nonce is a person');
});

await block('2d. The host decider: missing or throwing → no allow', async () => {
  const gate = new T.DecisionGate(() => 1, KEY);
  assert(gate.decideFromHost('s1', 'p1', true) === false, 'no decider wired: false, nothing allowed');
  gate.setDecider(() => { throw new Error('run manager gone'); });
  const err = await errorOf(() => gate.decideFromHost('s1', 'p1', true));
  assert(err !== undefined, 'a throwing decider propagates (desktop/engine/entry.ts posts nothing; the run stays waiting) — never reports an allow');
  gate.setDecider(() => undefined);
  assert(!gate.decideFromHost('s1', 'p1', true), 'a decider that returns nothing: falsy');
});

await block('2e. Routes that need a person: malformed bodies and a throwing check', async () => {
  // handleSystemRoute: approving a parked action with no person, and with a check that throws.
  let r = await T.handleSystemRoute('inbox/decide', 'POST', { id: 'act-none', decision: 'approve' });
  assert(r?.status === 403 && r.body?.code === 'human-required', 'inbox approve with the default (absent) person check: 403');
  const thrown = await errorOf(() => T.handleSystemRoute('inbox/decide', 'POST', { id: 'act-none', decision: 'approve' }, new URLSearchParams(), async () => { throw new Error('gate exploded'); }));
  assert(thrown !== undefined, 'inbox approve when the person check throws: the route rejects (the server answers 500), it does not approve');
  r = await T.handleSystemRoute('inbox/decide', 'POST', { id: 'act-none', decision: 'APPROVE' });
  assert(r?.status === 400, 'decision "APPROVE" (wrong case): 400, not an approval');
  r = await T.handleSystemRoute('settings', 'POST', { sentinel: { onEscalate: 'proceed' } }, new URLSearchParams(), async () => ({ ok: false }));
  assert(r?.status === 403, 'weakening safety settings when the person check says no: 403');

  // The real server, over HTTP.
  T.resetDecisionGate();
  const project = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = await T.serve({ port: 0, cwd: project, open: false });
  const u = new URL(server.url);
  const token = u.searchParams.get('token');
  const uiKey = new URLSearchParams(u.hash.slice(1)).get('ui');
  const base = `${u.origin}/api/`;
  const post = async (route, body, headers = {}) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'x-aico-token': token, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  try {
    for (const allow of ['true', 1, 'yes', [true], { v: true }, null]) {
      const res = await post('permission', { sessionId: 's1', id: 'x', allow });
      assert(res.status === 400, `allow: ${JSON.stringify(allow)} → ${res.status} (only a real boolean is read)`);
    }
    assert((await post('permission', '{"sessionId":"s1","id":"x","allow":tru')).status !== 200, 'a truncated JSON body: not 200');
    assert((await post('permission', { sessionId: 's1', id: 'x', allow: true, client: { $ne: null } })).status === 403, 'client as an object: 403');
    assert((await post('permission', { sessionId: 's1', id: 'x', allow: true, client: [] })).status === 403, 'client as an array: 403');
    assert((await post('permission', { sessionId: 's1', id: 'x', allow: true }, { 'x-aico-ui-key': `${uiKey}x` })).status === 403, 'a UI key one character long: 403');
    assert((await post('permission', { sessionId: 's1', id: 'x', allow: true }, { 'x-aico-ui-key': '' })).status === 403, 'an empty UI key header: 403');
    assert((await post('permission', { sessionId: 's1', id: 'x', allow: true }, { 'x-aico-client': 'forged-nonce-0000000000' })).status === 403, 'a forged client header: 403');
    for (const k of [{ uiKey: 12345 }, { uiKey: [uiKey] }, { uiKey: { k: uiKey } }, {}]) {
      assert((await post('ui/attach', k)).status === 403, `ui/attach with ${JSON.stringify(k).replace(uiKey, 'KEY')}: 403`);
    }
    const noToken = await fetch(base + 'permission', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aico-ui-key': uiKey }, body: JSON.stringify({ sessionId: 's1', id: 'x', allow: true }) });
    assert(noToken.status === 401 || noToken.status === 403, `the UI key without the API token: ${noToken.status} (not 200)`);
  } finally {
    await server.close();
    T.resetDecisionGate();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. VAULT. Already covered (vault-test V2/V3/V10, credential-ux-test):
//    locked store refuses list, wrong passphrase refused, tampered record /
//    file MAC, wrong key provider, person says no, deny prompter.
//    Added: the broker (`resolve`) and shell injection on a LOCKED vault,
//    no value in any refusal, a corrupt vault/key file (refused AND not reset),
//    a prompter that throws / hangs / times out, and an ops tool on a locked
//    vault.
// ═══════════════════════════════════════════════════════════════════════
await block('3a. A locked passphrase vault: resolve, read and inject all refused', async () => {
  const dir = path.join(testHome, 'vault-locked');
  const vault = T.configureVault({ dir, keyProvider: T.passphraseKeyProvider, autoLockMs: 0 });
  await vault.store.init({ passphrase: 'correct horse battery' });
  await vault.create({ name: 'locked-db', kind: 'login', secret: { password: CANARY }, host: '10.0.0.5', createdBy: 'user', policy: { approval: 'auto', allowShell: true } });
  vault.lock();
  assert(!vault.store.isUnlocked(), 'locked');
  const e1 = await errorOf(() => vault.resolve('locked-db', { tool: 'SSH', host: '10.0.0.5', purpose: 'check', sessionId: 's1' }));
  assert(e1?.code === 'locked' && !leaks(e1.message) && !leaks(e1), `resolve on a locked vault: refused with code "locked", no value (got ${e1?.code})`);
  const e2 = await errorOf(() => vault.get('locked-db'));
  assert(e2 !== undefined && !leaks(e2), 'get on a locked vault: refused');
  const e3 = await errorOf(() => vault.list({}));
  assert(e3 !== undefined, 'list on a locked vault: refused');

  // Wrong passphrase: refused, still locked, still unusable.
  const e4 = await errorOf(() => vault.unlock('wrong passphrase'));
  assert(e4?.code === 'wrong-passphrase' && !vault.store.isUnlocked(), 'a wrong passphrase: refused and the vault stays locked');
  const e5 = await errorOf(() => vault.resolve('locked-db', { tool: 'SSH', host: '10.0.0.5', purpose: 'check' }));
  assert(e5?.code === 'locked', 'after a wrong passphrase, resolve is still refused');
  const e6 = await errorOf(() => vault.unlock(undefined));
  assert(e6 !== undefined && !vault.store.isUnlocked(), 'unlock with no passphrase: refused');

  // Injection through the pipeline: the Bash body never runs, no value anywhere.
  const pipeline = new T.ToolPipeline();
  T.installVaultStages(pipeline, { cwd: () => tmp, sessionId: 's1' });
  let ran = false;
  const r = await pipeline.execute({ callId: 'v1', name: 'Bash', arguments: { command: 'echo {{secret:locked-db}}' }, agentId: 'a', state: new Map() }, async () => { ran = true; return 'ran'; });
  assert(!ran && r.outcome.isError && /locked/i.test(JSON.stringify(r.outcome.result)), 'a {{secret:…}} Bash command on a locked vault: not run, error names the lock');
  assert(!leaks(r), 'and the refusal carries no value (not even partially)');
  const partial = CANARY.slice(0, 10);
  assert(!JSON.stringify(r).includes(partial), 'no prefix of the value either');
});

await block('3b. Broker approval: a prompter that throws, hangs or times out', async () => {
  const dir = path.join(testHome, 'vault-prompter');
  const vault = T.configureVault({ dir, keyProvider: T.memoryKeyProvider() });
  await vault.store.init();
  await vault.create({ name: 'ask-db', kind: 'login', secret: { password: CANARY }, host: '10.0.0.5', createdBy: 'user', policy: { approval: 'every-use' } });
  const use = { tool: 'SSH', host: '10.0.0.5', purpose: 'check', sessionId: 's1' };

  vault.setApprovalPrompter({ kind: 'test', ask: async () => { throw new Error('dialog crashed'); } });
  let e = await errorOf(() => vault.resolve('ask-db', use));
  assert(e?.code === 'approval-denied' && !leaks(e), 'a prompter that throws: approval-denied');
  vault.setApprovalPrompter({ kind: 'test', ask: () => { throw new Error('sync throw'); } });
  e = await errorOf(() => vault.resolve('ask-db', use));
  assert(e?.code === 'approval-denied', 'a prompter that throws synchronously: approval-denied');
  vault.setApprovalPrompter({ kind: 'test', ask: async () => undefined });
  e = await errorOf(() => vault.resolve('ask-db', use));
  assert(e?.code === 'approval-denied', 'a prompter that resolves undefined: approval-denied');
  vault.setApprovalPrompter(undefined);
  e = await errorOf(() => vault.resolve('ask-db', use));
  assert(e?.code === 'approval-denied' && /nobody is available/.test(e.message), 'no prompter at all: the deny prompter refuses');

  const cb = T.callbackPrompter(async () => { throw new Error('ui gone'); });
  assert((await cb.ask({ credential: { name: 'x' }, description: 'd' })) === false, 'callbackPrompter whose callback throws: false');

  // Hang: no allow, ever. (There is no broker-level deadline; the prompter owns it.)
  vault.setApprovalPrompter({ kind: 'test', ask: () => new Promise(() => {}) });
  const hung = await within(vault.resolve('ask-db', use), 200);
  assert(!hung.settled || hung.error, 'a prompter that never answers: resolve does not return a value');
  if (!hung.settled) note('vault.resolve has no deadline of its own: a prompter that never settles leaves the call waiting (fails closed, but hangs) — src/vault/service.ts resolve(); PendingApprovals supplies the 5-minute timeout for the server/host path.');
  vault.setApprovalPrompter(undefined);

  const pa = new T.PendingApprovals(30);
  const req = { id: 'appr-t1', credential: { id: 'c', name: 'ask-db', kind: 'login' }, tool: 'SSH', purpose: 'p', description: 'd', mode: 'every-use' };
  assert((await pa.open(req, () => {})) === false, 'a pending approval nobody answers times out to false');
  assert((await new T.PendingApprovals(5000).open({ ...req, id: 'appr-t2' }, () => { throw new Error('cannot announce'); })) === false, 'an approval that cannot be shown resolves false at once');
  const pb = new T.PendingApprovals(5000);
  const waiting = pb.open({ ...req, id: 'appr-t3' }, () => {});
  pb.denyAll();
  assert((await waiting) === false, 'locking (denyAll) answers every pending approval with false');
});

await block('3c. A corrupt vault file: refused, and not silently reset', async () => {
  const dir = path.join(testHome, 'vault-corrupt');
  const key = T.memoryKeyProvider();
  const first = new T.VaultService({ dir, keyProvider: key });
  await first.store.init();
  await first.create({ name: 'keep-me', kind: 'login', secret: { password: CANARY }, host: '10.0.0.5', createdBy: 'user', policy: { approval: 'auto' } });
  const dataFile = path.join(dir, 'vault.json');
  const keyFile = path.join(dir, 'key.json');
  const good = fs.readFileSync(dataFile, 'utf8');
  const goodKey = fs.readFileSync(keyFile, 'utf8');
  first.lock();

  for (const [what, bytes] of [['not JSON', '{"format":"aico-vault", trunc'], ['empty', ''], ['valid JSON, wrong shape', '{"hello":1}'], ['records stripped', JSON.stringify({ ...JSON.parse(good), records: [] })]]) {
    fs.writeFileSync(dataFile, bytes);
    const svc = new T.VaultService({ dir, keyProvider: key });
    const e = await errorOf(() => svc.resolve('keep-me', { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }));
    assert(e !== undefined && !leaks(e), `vault.json ${what}: resolve refused (${e?.code})`);
    const c = await errorOf(() => svc.create({ name: 'new-one', kind: 'login', secret: { password: 'another-1234567' }, createdBy: 'user' }));
    assert(c !== undefined && fs.readFileSync(dataFile, 'utf8') === bytes, `vault.json ${what}: storing a new credential is refused and the file is left as it was (not reset to empty)`);
  }
  fs.writeFileSync(dataFile, good);
  fs.writeFileSync(keyFile, '{ not json');
  let svc = new T.VaultService({ dir, keyProvider: key });
  let e = await errorOf(() => svc.resolve('keep-me', { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }));
  const c = await errorOf(() => svc.create({ name: 'new-two', kind: 'login', secret: { password: 'another-1234567' }, createdBy: 'user' }));
  assert(e !== undefined && c !== undefined && fs.readFileSync(dataFile, 'utf8') === good, 'key.json corrupt: refused, and vault.json is not overwritten by a fresh vault');
  fs.writeFileSync(keyFile, goodKey);
  svc = new T.VaultService({ dir, keyProvider: key });
  const back = await svc.resolve('keep-me', { tool: 'SSH', host: '10.0.0.5', purpose: 'x' });
  assert(back.value() === CANARY, 'with the files restored, the credential is intact (nothing was lost by the refusals)');
  back.release();

  // Recorded, not asserted: key.json missing while vault.json is present.
  fs.rmSync(keyFile);
  svc = new T.VaultService({ dir, keyProvider: key });
  const made = await errorOf(() => svc.create({ name: 'new-three', kind: 'login', secret: { password: 'another-1234567' }, createdBy: 'user' }));
  const replaced = fs.readFileSync(dataFile, 'utf8') !== good;
  if (!made && replaced) {
    note('key.json missing + vault.json present: storing a credential creates a fresh vault and OVERWRITES vault.json (old records gone) — src/vault/store.ts init() checks only key.json via exists(). Not a fail-open (the old file is unreadable without its key), but a data-loss path if key.json was only temporarily absent.');
  } else {
    note(`key.json missing + vault.json present: create ${made ? `refused (${made.code})` : 'succeeded'}; vault.json ${replaced ? 'replaced' : 'kept'}.`);
  }
});

await block('3d. An ops tool on a locked vault refuses before any request is made', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.end('ok'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const A = `http://127.0.0.1:${srv.address().port}`;
  const dir = path.join(testHome, 'vault-ops-locked');
  const vault = T.configureVault({ dir, keyProvider: T.passphraseKeyProvider, autoLockMs: 0 });
  await vault.store.init({ passphrase: 'correct horse battery' });
  await vault.create({ name: 'api-locked', kind: 'api-token', secret: { token: CANARY }, url: A, createdBy: 'user', policy: { approval: 'auto' } });
  vault.lock();
  try {
    const e = await errorOf(() => T.httpRequest({ url: `${A}/x`, credential: 'api-locked' }));
    assert(e !== undefined && hits === 0 && !leaks(e), `HttpRequest with a credential on a locked vault: refused, server never contacted (${(e?.message ?? '').slice(0, 70)})`);
  } finally {
    srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 4. SSRF. Already covered (ops-test, deck-visual-test): classifyAddress of
//    IPv4-mapped/NAT64 dotted forms, metadata by name and address even when
//    vouched, a mixed public+loopback answer, the metadata URL refused by
//    HttpRequest and by the deck fetcher.
//    Added: DNS failure, empty/garbage resolutions, numeric host spellings
//    (decimal, hex, octal, short), hex IPv4-mapped / -compatible IPv6, and a
//    redirect from an allowed host to the metadata service.
// ═══════════════════════════════════════════════════════════════════════
await block('4a. decideTarget / classifyAddress with nothing or garbage to go on', async () => {
  const base = { host: 'x.example', port: 443, credentialAdmits: true, knownTarget: true, tunnelPort: true };
  assert(!T.decideTarget({ ...base, addresses: [] }).allowed, 'no addresses (DNS failed), even with everything vouching: refused');
  for (const a of ['', 'not-an-ip', '2852039166', '0xa9fea9fe', '0251.0376.0251.0376', '169.254.43518', '1.2.3', '::ffff:zzzz']) {
    const d = T.decideTarget({ ...base, addresses: [a] });
    assert(!d.allowed, `an "address" that is not an IP (${JSON.stringify(a)}) is never contacted`);
  }
  for (const ip of ['::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:a9fe:a9fe', '::ffff:169.254.169.254', '::169.254.169.254', '::a9fe:a9fe', '64:ff9b::169.254.169.254', '[::ffff:a9fe:a9fe]', 'fd00:ec2:0:0:0:0:0:254', '::ffff:100.100.100.200']) {
    assert(T.classifyAddress(ip) === 'metadata', `${ip} → metadata (got ${T.classifyAddress(ip)})`);
    assert(!T.decideTarget({ ...base, addresses: [ip] }).allowed, `${ip}: refused even when vouched`);
  }
  for (const ip of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a00:5']) {
    const d = T.decideTarget({ ...base, credentialAdmits: false, knownTarget: false, tunnelPort: false, addresses: [ip] });
    assert(!d.allowed, `${ip} (mapped loopback/private), nothing vouching: refused`);
  }
  const mixed = T.decideTarget({ ...base, credentialAdmits: false, knownTarget: false, tunnelPort: false, addresses: ['93.184.216.34', '10.0.0.5'] });
  assert(!mixed.allowed, 'public + private answer with nothing vouching: judged by the private one');
  const mixedMeta = T.decideTarget({ ...base, addresses: ['93.184.216.34', '::ffff:a9fe:a9fe'] });
  assert(!mixedMeta.allowed && /metadata/.test(mixedMeta.reason), 'public + hex-mapped metadata, everything vouching: refused as metadata');
  assert(!T.decideTarget({ ...base, host: 'METADATA.google.internal.'.toLowerCase(), addresses: ['8.8.8.8'] }).allowed, 'metadata by name with a trailing dot: refused');
  const nx = await T.resolveAll('nonexistent-host-for-aico-failsafe.invalid');
  assert(Array.isArray(nx) && nx.length === 0, 'resolveAll of a name that does not exist: [] (the decision then refuses), not a throw that a caller might swallow');
});

await block('4b. The deck fetcher (guardedFetch) on every metadata spelling and on DNS failure', async () => {
  const refuse = async (u) => (await errorOf(() => T.DeckMedia.guardedFetch(u, { timeoutMs: 3000 })))?.message ?? '(fetched!)';
  for (const u of [
    'http://2852039166/latest/meta-data/', 'http://0xa9fea9fe/', 'http://0251.0376.0251.0376/', 'http://169.254.43518/',
    'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:169.254.169.254]/', 'http://[::169.254.169.254]/', 'http://[64:ff9b::a9fe:a9fe]/',
    'http://metadata.google.internal./computeMetadata/v1/', 'http://METADATA.GOOGLE.INTERNAL/', 'http://[fd00:ec2::254]/',
  ]) {
    const m = await refuse(u);
    assert(/refused/.test(m) && /metadata/.test(m), `${u} → refused as metadata (${m.slice(0, 60)})`);
  }
  for (const u of ['http://127.1/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'http://[::1]/', 'http://localhost/', 'http://10.1/']) {
    assert(/refused/.test(await refuse(u)), `${u} → refused (not public)`);
  }
  const nx = await refuse('http://nonexistent-host-for-aico-failsafe.invalid/pic.jpg');
  assert(/refused/.test(nx) && /did not resolve/.test(nx), `a name that does not resolve: refused by the guard (${nx.slice(0, 60)})`);
});

await block('4c. HttpRequest: DNS failure and redirects to forbidden targets', async () => {
  const dir = path.join(testHome, 'vault-ssrf');
  const vault = T.configureVault({ dir, keyProvider: T.memoryKeyProvider() });
  await vault.store.init();
  const hops = [];
  const srv = http.createServer((req, res) => {
    hops.push(req.url);
    const to = {
      '/r-meta': 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      '/r-hexmapped': 'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      '/r-decimal': 'http://2852039166/latest/meta-data/',
      '/r-name': 'http://metadata.google.internal/computeMetadata/v1/',
      '/r-nx': 'http://nonexistent-host-for-aico-failsafe.invalid/',
      '/r-loop2': `http://127.0.0.2:${srv.address().port}/landed`,
    }[req.url];
    if (to) { res.writeHead(302, { location: to }); res.end(); return; }
    res.end('landed');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const A = `http://127.0.0.1:${srv.address().port}`;
  // A credential bound to A makes A a known target (reachable without auth); nothing vouches for anywhere else.
  await vault.create({ name: 'local-api', kind: 'api-token', secret: { token: CANARY }, url: A, createdBy: 'user', policy: { approval: 'auto' } });
  try {
    const nx = await errorOf(() => T.httpRequest({ url: 'http://nonexistent-host-for-aico-failsafe.invalid/' }));
    assert(/did not resolve/.test(nx?.message ?? ''), `HttpRequest to a name that does not resolve: refused (${(nx?.message ?? 'fetched!').slice(0, 60)})`);
    for (const [p, re] of [['/r-meta', /metadata/], ['/r-hexmapped', /metadata/], ['/r-decimal', /metadata/], ['/r-name', /metadata/], ['/r-nx', /did not resolve/], ['/r-loop2', /loopback/]]) {
      const e = await errorOf(() => T.httpRequest({ url: `${A}${p}` }));
      assert(e !== undefined && re.test(e.message) && !hops.includes('/landed'), `a redirect ${p} → refused at the hop (${(e?.message ?? 'followed!').slice(0, 70)})`);
    }
    // With the credential, a cross-origin hop is followed only where the broker admits the new origin too.
    let viaCred;
    let viaCredErr;
    try { viaCred = await T.httpRequest({ url: `${A}/r-meta`, credential: 'local-api' }); } catch (err) { viaCredErr = err; }
    const refused = viaCredErr ? /metadata|not bound/.test(viaCredErr.message) : (viaCred?.status === 302 && (viaCred.notes ?? []).some(n => /not followed/.test(n)));
    assert(refused && !hops.includes('/landed'), `with the credential: the metadata redirect is refused or not followed (${viaCredErr ? viaCredErr.message.slice(0, 60) : (viaCred?.notes ?? []).join(' ').slice(0, 60)})`);
  } finally {
    srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 5. TOOL PIPELINE. Already covered (vault-test, phase0, sentinel-test): a
//    throwing tool body is redacted; guards are monotonic; a PreToolUse hook
//    that blocks stops an MCP call. Added: a pre-execute stage / guard that
//    throws, rejects, or returns a malformed decision; and the agent's real
//    permission stage with a callback that throws, rejects or answers nothing.
// ═══════════════════════════════════════════════════════════════════════
await block('5a. A stage that throws or answers nonsense never lets the body run', async () => {
  let s = bare();
  s.pipeline.onPreExecute('boom', async () => { throw new Error('pre exploded'); });
  let r = await s.run();
  assert(!r.ran && r.denied, 'pre-execute stage throws: denied, not run');
  s = bare();
  s.pipeline.onPreExecute('reject', () => Promise.reject(new Error('rejected')));
  r = await s.run();
  assert(!r.ran && r.denied, 'pre-execute stage rejects: denied, not run');
  s = bare();
  s.pipeline.onGuard('boom', () => { throw new Error('guard exploded'); });
  r = await s.run();
  assert(!r.ran && r.denied, 'guard throws synchronously: denied, not run');
  s = bare();
  s.pipeline.onGuard('reject', async () => { throw new Error('guard rejected'); });
  r = await s.run();
  assert(!r.ran && r.denied, 'guard rejects: denied, not run');
  s = bare();
  s.pipeline.onGuard('null', () => null);
  r = await s.run();
  assert(!r.ran && r.denied, 'guard returns null: denied, not run');
  s = bare();
  s.pipeline.onGuard('undef', () => undefined);
  r = await s.run();
  assert(!r.ran && r.denied, 'guard returns undefined: denied, not run');
  s = bare();
  s.pipeline.onGuard('allow', () => ({ kind: 'abstain' }));
  s.pipeline.onGuard('boom-after', () => { throw new Error('later guard exploded'); });
  r = await s.run();
  assert(!r.ran && r.denied, 'an earlier guard abstains, a later one throws: denied (the throw is not skipped)');
  s = bare();
  s.pipeline.onPreExecute('undef', async () => undefined);
  r = await s.run();
  assert(!r.ran, `pre-execute returns undefined: not run${r.rejected ? ' (execute rejected — breaks its own "never rejects" contract, but fails closed)' : ''}`);
  s = bare();
  let guardSaw = false;
  s.pipeline.onPreExecute('malformed', async () => ({ kind: 'maybe' }));
  s.pipeline.onGuard('policy', () => { guardSaw = true; return { kind: 'deny', reason: 'policy says no' }; });
  r = await s.run();
  assert(!r.ran, `pre-execute returns a malformed decision {kind:"maybe"}: not run (src/tools/pipeline.ts:206/220: anything but "allow" skips the guards, anything but "deny" runs the body)${guardSaw ? '' : ' — the deny guard was never consulted'}`);
  s = bare();
  s.pipeline.onAroundExecute('boom', async () => { throw new Error('around exploded'); });
  r = await s.run();
  assert(!r.ran && r.outcome?.isError, 'around stage throws before next(): body not run, error result');
});

await block('5b. The agent\'s permission stage: a callback that throws, rejects or answers nothing', async () => {
  process.chdir(tmp);
  try {
    const mock = (steps) => {
      let i = 0;
      return {
        id: 'mock', displayName: 'Mock',
        async *chat() { const step = steps[Math.min(i++, steps.length - 1)]; for (const ev of step) yield ev; },
      };
    };
    let n = 0;
    const turn = async (onPermissionRequest) => {
      const target = path.join(tmp, `perm-${++n}.txt`);
      const steps = [
        [{ type: 'tool_call', id: `c-${n}`, name: 'Write', input: { file_path: target, content: 'should not exist' } }, { type: 'finish', reason: 'tool_calls' }],
        [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop' }],
      ];
      const session = new T.Session({ id: `failsafe-${n}`, cwd: tmp, startedAt: Date.now() });
      await T.runAgent({
        task: 'write the file', model: 'mock-model', showPlan: false, autoApprove: false, verbose: false, silent: true,
        conversationHistory: [], sessionId: session.header.id, session, provider: mock(steps),
        settings: { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, deferTools: false },
        onPermissionRequest,
      });
      return { written: fs.existsSync(target), results: session.events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data)) };
    };
    let r = await turn(async () => { throw new Error('permission dialog crashed'); });
    assert(!r.written && r.results.length === 1, 'permission callback throws: Write does not run (and the call still gets a result)');
    r = await turn(() => Promise.reject(new Error('client disconnected')));
    assert(!r.written, 'permission callback rejects: Write does not run');
    r = await turn(async () => undefined);
    assert(!r.written, 'permission callback resolves undefined: Write does not run');
    r = await turn(async () => false);
    assert(!r.written, 'permission callback says false: Write does not run');
    r = await turn(async () => true);
    assert(r.written, 'control: permission callback says true: Write runs (the harness is real)');
  } finally {
    process.chdir(startCwd);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Defaults recorded for the report (behaviour, not assertions).
// ═══════════════════════════════════════════════════════════════════════
await block('6. Lenient defaults worth knowing (recorded, not asserted)', async () => {
  const s = bare();
  s.pipeline.onGuard('garbage', () => 'deny');
  const r = await s.run();
  if (r.ran) note('a guard returning a non-object ("deny" as a string) is read as abstain and the call runs — src/tools/pipeline.ts execute() checks only verdict.kind === "deny".');
  const vault = T.configureVault({ dir: path.join(testHome, 'vault-truthy'), keyProvider: T.memoryKeyProvider() });
  await vault.store.init();
  await vault.create({ name: 'truthy-db', kind: 'login', secret: { password: CANARY }, host: '10.0.0.5', createdBy: 'user', policy: { approval: 'every-use' } });
  vault.setApprovalPrompter({ kind: 'test', ask: async () => 'no' });
  const got = await errorOf(async () => { const v = await vault.resolve('truthy-db', { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }); v.release(); });
  if (!got) note('an approval prompter resolving a truthy non-boolean ("no") is read as approval — src/vault/service.ts resolve() uses `if (!approved)`. Every shipped prompter returns a boolean; the HTTP and host paths check `typeof approved === "boolean"`.');
  vault.setApprovalPrompter(undefined);
});

console.log(`\n${passed} passed, ${failed} failed${notes.length ? `, ${notes.length} notes` : ''}`);
if (failed) {
  console.log('\nGUARDS THAT FAIL OPEN (or assertions that need a look):');
  console.log(failures.map(f => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
