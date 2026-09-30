/**
 * The human side of credentials and tool permissions, tested offline.
 *
 * Why a suite of its own: the vault suite (vault-test.mjs) proves that values
 * never leak; this one proves that the *yes* comes from a person and not from
 * whoever holds the API token — the decision gate on `/api/permission`, the
 * host channel's "Allow once / for this session", the browser-login fill
 * request naming its tool, the events that let clients close a prompt that was
 * answered elsewhere, and encrypted backups that need a grant to leave.
 *
 * Canary values only, made-up strings shaped like secrets. Everything runs in
 * this process's own AICO_HOME (lib/test-home.mjs) with the in-memory key
 * provider: no keyring is touched.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  configureVault, memoryKeyProvider, attachVaultHostChannel, shellDenial, serve,
  DecisionGate, resetDecisionGate, sealExport, openExport,
} from '../dist-test/test-exports.js';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms));

const CANARY = 'Ux-C4nary-Pa55word-8d7c6b5a4f'; // standards-allow: secret
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-credux-test-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

console.log('\n══ U1. DECISION GATE (pure) ══');
{
  let now = 1_000_000;
  const gate = new DecisionGate(() => now, 'ui-key-for-tests-0123456789abcdef');
  assert(!gate.checkAllow({ sessionId: 's1' }).ok, 'token alone (no key, no client): a yes is refused');
  assert('error' in gate.attach('wrong-key'), 'attach with a wrong UI key is refused');
  assert('error' in gate.attach(undefined), 'attach with no UI key is refused');
  assert('error' in gate.attach('ui-key-for-tests-0123456789abcdef', 'cross-site'), 'attach from a cross-site page is refused');
  const a = gate.attach('ui-key-for-tests-0123456789abcdef', 'same-origin');
  assert(typeof a.client === 'string' && a.client.length >= 16, 'the UI key buys a per-client nonce');
  assert(!gate.checkAllow({ sessionId: 's1', client: a.client }).ok, 'a nonce with no open stream for the session cannot allow');
  const release = gate.connect(a.client, 's1');
  assert(gate.checkAllow({ sessionId: 's1', client: a.client }).ok, 'a nonce whose stream is open for the session can allow');
  assert(!gate.checkAllow({ sessionId: 's2', client: a.client }).ok, '…but not for a session it is not watching');
  assert(!gate.checkAllow({ sessionId: 's1', client: a.client, fetchSite: 'cross-site' }).ok, 'a cross-site request is refused even with a good nonce');
  release();
  now += 30_000;
  assert(gate.checkAllow({ sessionId: 's1', client: a.client }).ok, 'within a minute of the stream dropping (a reload) it may still answer');
  now += 40_000;
  assert(!gate.checkAllow({ sessionId: 's1', client: a.client }).ok, 'a minute after its stream closed, the nonce is useless');
  assert(!gate.checkAllow({ sessionId: 's1', client: 'forged-client-nonce-000000' }).ok, 'a forged nonce is refused');
  assert(gate.checkAllow({ sessionId: 's1', uiKey: 'ui-key-for-tests-0123456789abcdef' }).ok, 'a parent process holding the UI key itself (VS Code) may allow');
  assert(!gate.checkAllow({ sessionId: 's1', uiKey: 'ui-key-for-tests-0123456789abcdeX' }).ok, 'a UI key off by one character is refused');
  gate.setHostAttached(true);
  assert(!gate.checkAllow({ sessionId: 's1', uiKey: 'ui-key-for-tests-0123456789abcdef' }).ok, 'with AICO Desktop attached, no HTTP yes is accepted at all');
  let decided = null;
  gate.setDecider((s, id, allow) => { decided = { s, id, allow }; return true; });
  assert(gate.decideFromHost('s1', 'p1', true) && decided?.allow === true, 'the host channel decides through the run manager');
}

console.log('\n══ U2. SHELL GUARD: THE AGENT ANSWERING ITS OWN PROMPTS ══');
{
  const tok = 'x-aico-token: abcdefabcdefabcdef';
  for (const cmd of [
    `curl -s -X POST -H "${tok}" http://127.0.0.1:7340/api/permission -d '{"allow":true}'`,
    `curl "http://localhost:7340/api/vault/approve?token=abc" -d '{}'`,
    `curl -H "${tok}" http://127.0.0.1:7340/api/ui/attach`,
    `Invoke-RestMethod -Headers @{'x-aico-token'='t'} -Uri http://127.0.0.1:1/api/vault/reveal`,
  ]) assert(Boolean(shellDenial(cmd)), `blocked: ${cmd.slice(0, 60)}…`);
  assert(!shellDenial('curl http://localhost:3000/api/permission'), 'a project\'s own /api/permission route (no AICO token) is not caught');
  assert(!shellDenial('npm test'), 'ordinary commands pass');
}

console.log('\n══ U3. HOST CHANNEL: ALLOW ONCE / FOR THIS SESSION, BROWSER LOGIN ══');
const vault = configureVault({ dir: path.join(testHome, 'vault'), keyProvider: memoryKeyProvider() });
{
  await vault.create({ name: 'portal-admin', kind: 'login', username: 'admin', url: 'http://127.0.0.1:8443', secret: { password: CANARY }, createdBy: 'user', policy: { approval: 'session' } });
  const listeners = [];
  const posted = [];
  const notes = [];
  vault.setNotifier((sessionId, type, data) => notes.push({ sessionId, type, data }));
  attachVaultHostChannel({ postMessage: (m) => posted.push(m), on: (_e, l) => listeners.push(l) });
  const send = async (data) => { for (const l of listeners) l({ data }); await tick(); };
  vault.setApprovalPrompter(vault.serverPrompter());

  // "Allow once": approved, but the next use in the same session asks again.
  const use = () => vault.resolve('portal-admin', { tool: 'browser_login', origin: 'http://127.0.0.1:8443', purpose: 'sign in', sessionId: 'sx' }).then((r) => { r.release(); return 'ok'; }, (e) => e.code);
  let p = use();
  await tick();
  let req = posted.filter(m => m.type === 'vault/approve-request').pop();
  assert(req?.request.credential.name === 'portal-admin' && req.request.tool === 'browser_login' && req.request.mode === 'session',
    'a session-mode use asks the host, naming the credential and the tool');
  await send({ type: 'vault/approval', id: req.request.id, approved: true, scope: 'once' });
  assert(await p === 'ok', '"Allow once" lets this use through');
  assert(notes.some(n => n.type === 'vault-approval-done' && n.data.id === req.request.id && n.data.approved === true), 'clients hear the approval was answered');
  const before = posted.filter(m => m.type === 'vault/approve-request').length;
  p = use();
  await tick();
  assert(posted.filter(m => m.type === 'vault/approve-request').length === before + 1, '…and the next use asks again');
  req = posted.filter(m => m.type === 'vault/approve-request').pop();
  await send({ type: 'vault/approval', id: req.request.id, approved: true });
  assert(await p === 'ok', '"Allow for this session" lets it through');
  const count = posted.filter(m => m.type === 'vault/approve-request').length;
  assert(await use() === 'ok' && posted.filter(m => m.type === 'vault/approve-request').length === count, '…and later uses in the session do not ask');
  p = vault.resolve('portal-admin', { tool: 'browser_login', origin: 'http://127.0.0.1:8443', purpose: 'sign in', sessionId: 'other' }).then(() => 'ok', (e) => e.code);
  await tick();
  req = posted.filter(m => m.type === 'vault/approve-request').pop();
  await send({ type: 'vault/approval', id: req.request.id, approved: false });
  assert(await p === 'approval-denied', 'Deny refuses, and another session was asked afresh');

  // Browser login: main names its tool; the audit log tells a person's fill from the agent's.
  await send({ type: 'vault/fill-request', requestId: 'b1', origin: 'http://127.0.0.1:8443', name: 'portal-admin', tool: 'browser_login', sessionId: 'sx' });
  await tick(40);
  const fill = posted.find(m => m.type === 'vault/fill' && m.requestId === 'b1');
  assert(fill?.ok && fill.kind === 'login' && fill.username === 'admin' && fill.fields.password === CANARY, 'fill-request for browser_login: the value reaches main (and only main)');
  const trail = vault.auditTrail({ name: 'portal-admin', limit: 50 });
  assert(trail.some(e => e.tool === 'browser_login' && e.outcome === 'ok') && !JSON.stringify(trail).includes(CANARY), 'the audit log names browser_login, and holds no value');
  await send({ type: 'vault/fill-request', requestId: 'b2', origin: 'http://127.0.0.1:8443', name: 'not-bound', tool: 'browser_login' });
  await tick(40);
  const miss = posted.find(m => m.type === 'vault/fill' && m.requestId === 'b2');
  assert(miss && miss.ok === false && /not bound/.test(miss.reason) && miss.candidates?.includes('portal-admin') && !miss.fields,
    'a name not bound to the origin gets a reason and the names that are — no value');
  await send({ type: 'vault/fill-request', requestId: 'b3', origin: 'http://127.0.0.1:9999', tool: 'browser_login' });
  await tick(40);
  assert(posted.find(m => m.type === 'vault/fill' && m.requestId === 'b3')?.ok === false, 'another port of the same host gets nothing (exact origin)');

  // A credential request while the host is attached: clients are told not to prompt.
  const r = vault.requestFromHuman({ name: 'asked-for', kind: 'login', url: 'https://10.0.0.9', reason: 'test', sessionId: 'sx' });
  await tick();
  const ev = notes.find(n => n.type === 'vault-request' && n.data.name === 'asked-for');
  assert(ev?.data.hostPrompt === true && ev.data.url === 'https://10.0.0.9', 'with the host attached, the stream event says the host is prompting (hostPrompt: true), keeping the request fields');
  const hostReq = posted.find(m => m.type === 'vault/credential-request' && m.request.name === 'asked-for');
  await send({ type: 'vault/fulfil', requestId: hostReq.request.requestId, secret: { password: 'Typed-By-A-Person-42x' } });
  const outcome = await r;
  assert(outcome.status === 'stored', 'the host\'s secure prompt fulfils the request');
  assert(notes.some(n => n.type === 'vault-request-done' && n.data.requestId === hostReq.request.requestId), 'clients hear the request was settled');
  vault.setHostSender(undefined);
  vault.setApprovalPrompter(undefined);
}

console.log('\n══ U4. ENCRYPTED BACKUP ══');
{
  assert(await (async () => { try { await vault.exportEncrypted('long-enough-pass', 'no-grant'); return false; } catch (e) { return e.code === 'grant-required'; } })(),
    'export without a grant is refused');
  const grant = vault.grants.register({ action: 'export' });
  const out = await vault.exportEncrypted('long-enough-pass', grant);
  assert(out.count >= 2 && !out.file.includes(CANARY) && !out.file.includes(Buffer.from(CANARY).toString('base64')), 'export with a grant: ciphertext only');
  assert(await (async () => { try { await vault.exportEncrypted('long-enough-pass', grant); return false; } catch (e) { return e.code === 'grant-required'; } })(),
    'the grant is spent by one export');
  const recs = openExport(out.file, 'long-enough-pass');
  assert(recs.some(r => r.meta.name === 'portal-admin' && r.secret.password === CANARY), 'the file opens with the passphrase');
  assert(await (async () => { try { openExport(out.file, 'wrong-passphrase'); return false; } catch (e) { return e.code === 'wrong-passphrase'; } })(), 'and not without it');
  assert(await (async () => { try { sealExport([], 'short'); return false; } catch (e) { return e.code === 'invalid'; } })(), 'a short passphrase is refused');
  const r1 = await vault.importEncrypted(out.file, 'long-enough-pass');
  assert(r1.added === 0 && r1.skipped === out.count, 'import never replaces an existing name');
  vault.store.remove('asked-for');
  const r2 = await vault.importEncrypted(out.file, 'long-enough-pass');
  assert(r2.added === 1, 'import adds what is missing');
}

console.log('\n══ U5. /api/permission AND /api/ui/attach OVER HTTP ══');
{
  resetDecisionGate();
  const project = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = await serve({ port: 0, cwd: project, open: false });
  const u = new URL(server.url);
  const token = u.searchParams.get('token');
  const uiKey = new URLSearchParams(u.hash.slice(1)).get('ui');
  const base = `${u.origin}/api/`;
  const post = async (route, body, headers = {}) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'x-aico-token': token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  try {
    assert(typeof uiKey === 'string' && uiKey.length >= 20 && uiKey !== token, 'the printed link carries a UI key in its fragment, distinct from the token');
    const tokenOnly = await post('permission', { sessionId: 'nope', id: 'x', allow: true });
    assert(tokenOnly.status === 403 && tokenOnly.json.code === 'human-required', 'curl with the token alone cannot allow a permission (403)');
    const deny = await post('permission', { sessionId: 'nope', id: 'x', allow: false });
    assert(deny.status === 200, 'refusing needs only the token');
    assert((await post('ui/attach', { uiKey: 'guess' })).status === 403, 'attach with a guessed key: 403');
    const att = await post('ui/attach', { uiKey });
    assert(att.status === 200 && typeof att.json.client === 'string', 'attach with the key from the link: a client nonce');
    assert((await post('permission', { sessionId: 's-ui', id: 'x', allow: true, client: att.json.client })).status === 403, 'the nonce alone, with no open stream: 403');
    const ctl = new AbortController();
    const stream = await fetch(`${base}events?session=s-ui&since=0&client=${encodeURIComponent(att.json.client)}`, { headers: { 'x-aico-token': token }, signal: ctl.signal });
    const reader = stream.body.getReader();
    await reader.read();
    const ok = await post('permission', { sessionId: 's-ui', id: 'x', allow: true, client: att.json.client });
    assert(ok.status === 200 && ok.json.ok === false, 'with its stream open, the client may answer (nothing was pending, so ok:false)');
    assert((await post('permission', { sessionId: 's-ui', id: 'x', allow: true }, { 'x-aico-ui-key': uiKey })).status === 200, 'a parent process with the key (VS Code) may answer');
    assert((await post('permission', { sessionId: 's-ui', id: 'x', allow: true, client: att.json.client }, { 'sec-fetch-site': 'cross-site' })).status === 403, 'cross-site: 403');
    ctl.abort();
    const vaultExport = await post('vault/export', { passphrase: 'long-enough-pass' });
    assert(vaultExport.status === 403, 'vault/export with the token alone: 403');
  } finally {
    await server.close();
  }
}

console.log('\n' + '═'.repeat(50));
console.log(`  CREDENTIAL UX RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('═'.repeat(50) + '\n');
process.exit(failed ? 1 : 0);
