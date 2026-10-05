/**
 * Certificate exceptions — unit tests for electron/browser-certs-core.ts (ADR 0029).
 *
 * The browser used to refuse every broken certificate; people with internal
 * CAs and dev servers could not open their own sites. Proceeding is now
 * possible, but only by the person, only for the exact certificate, and with
 * passwords kept out. Tested here: the exception store (fingerprint binding,
 * session vs persisted, removal), the decision (bypassable errors, revoked
 * and HSTS refusals, the localhost setting), "Proceed" needing the warning's
 * token and a real input on the AICO window, the password rule, and that no
 * agent-reachable path names the proceed channels.
 *
 *   node scripts/test-browser-certs.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-certs-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const c = await load(path.join(desktop, 'electron/browser-certs-core.ts'), 'certs');
const store = await load(path.join(desktop, 'electron/browser-store.ts'), 'store');
const sec = await load(path.join(desktop, 'electron/security-core.ts'), 'sec');

const FP_A = 'sha256/' + Buffer.alloc(32, 1).toString('base64');
const FP_B = 'sha256/' + Buffer.alloc(32, 2).toString('base64');
const base = { error: 'net::ERR_CERT_AUTHORITY_INVALID', issuer: 'Hec Internal CA', subject: 'console.heccloud.com', validTo: 2e12, addedAt: 1 };
const mem = () => { let list = []; return { get: () => list, set: (l) => { list = l; }, raw: () => list }; };

// ── The store ──
console.log('\nException store');
{
  const p = mem();
  const s = new c.CertExceptions(p);
  ok(s.match('console.heccloud.com', FP_A) === null, 'nothing is trusted before the person proceeds');
  s.add({ host: 'Console.HecCloud.com', fingerprint: FP_A, ...base }, 'session');
  ok(s.match('console.heccloud.com', FP_A)?.scope === 'session', 'a session exception matches its host (case-insensitive) and fingerprint');
  ok(s.match('console.heccloud.com', FP_B) === null, 'a different certificate for the same host is not trusted');
  ok(s.match('other.heccloud.com', FP_A) === null, 'the same certificate on another host is not trusted');
  ok(p.raw().length === 0, 'a session exception is never written to settings');
  const fresh = new c.CertExceptions(p);
  ok(fresh.match('console.heccloud.com', FP_A) === null, 'a session exception is gone after a restart');

  s.add({ host: 'dev.internal', fingerprint: FP_A, ...base }, 'always');
  ok(p.raw().length === 1 && p.raw()[0].host === 'dev.internal' && !('scope' in p.raw()[0]), '"Always trust" is persisted (without a scope field)');
  ok(new c.CertExceptions(p).match('dev.internal', FP_A)?.scope === 'always', 'an "always" exception survives a restart');
  s.add({ host: 'dev.internal', fingerprint: FP_B, ...base }, 'always');
  ok(p.raw().length === 1 && p.raw()[0].fingerprint === FP_B, 'a new "always" certificate for a host replaces the old one');
  ok(s.list().length === 2 && s.list().map(e => e.scope).sort().join() === 'always,session', 'list shows session and always exceptions');

  ok(!s.confirmCredentials('dev.internal', FP_A), 'confirming passwords needs the exact persisted certificate');
  ok(s.confirmCredentials('dev.internal', FP_B) && s.match('dev.internal', FP_B).credentialsConfirmed === true, 'the one-time password confirmation is recorded');

  ok(s.remove('dev.internal', FP_A) === false, 'removing with the wrong fingerprint removes nothing');
  ok(s.remove('dev.internal') && s.match('dev.internal', FP_B) === null && p.raw().length === 0, 'removal drops the persisted exception');
  ok(s.remove('console.heccloud.com', FP_A) && s.list().length === 0, 'removal drops a session exception');
}

console.log('\nSettings file');
{
  const n = store.normaliseSettings({
    certExceptions: [
      { host: 'A.internal', fingerprint: FP_A, issuer: 'x', addedAt: 3, credentialsConfirmed: true, scope: 'session' },
      { host: 'a.internal', fingerprint: FP_A },
      { host: 'b.internal', fingerprint: 'not-a-fingerprint' },
      'junk',
    ],
    allowInsecureLocalhost: 'yes',
  });
  ok(n.certExceptions?.length === 1 && n.certExceptions[0].host === 'a.internal' && n.certExceptions[0].credentialsConfirmed === true, 'settings keep well-formed exceptions only, de-duplicated', n.certExceptions);
  ok(n.allowInsecureLocalhost === undefined, 'the localhost setting is on only when it is literally true');
  ok(store.normaliseSettings({ allowInsecureLocalhost: true }).allowInsecureLocalhost === true, 'the localhost setting is kept when on');
  ok(store.normaliseSettings({}).certExceptions === undefined, 'no exceptions by default');
}

// ── Decisions ──
console.log('\nDecisions');
{
  const p = mem();
  const s = new c.CertExceptions(p);
  const d = (o) => c.decideCertError({ host: 'console.heccloud.com', fingerprint: FP_A, error: 'net::ERR_CERT_AUTHORITY_INVALID', exceptions: s, allowInsecureLocalhost: false, hsts: {}, now: 1000, ...o });

  const first = d({});
  ok(first.kind === 'block' && first.bypassable === true, 'an unknown authority shows the warning, with Proceed offered', first);
  for (const e of ['ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID']) ok(d({ error: `net::${e}` }).bypassable === true, `${e} may be bypassed by the person`);
  const revoked = d({ error: 'net::ERR_CERT_REVOKED' });
  ok(revoked.kind === 'block' && revoked.bypassable === false && /revoked/i.test(revoked.reason), 'a revoked certificate can never be bypassed', revoked);
  for (const e of ['ERR_CERT_INVALID', 'ERR_CERT_CONTAINS_ERRORS', 'ERR_CERT_KNOWN_INTERCEPTION_BLOCKED', 'ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN']) {
    ok(d({ error: `net::${e}` }).bypassable === false, `${e} cannot be bypassed`);
  }

  s.add({ host: 'console.heccloud.com', fingerprint: FP_A, ...base }, 'session');
  const after = d({});
  ok(after.kind === 'accept' && after.via === 'exception', 'once the person proceeded, the same certificate is let through (for the agent too)', after);
  ok(d({ fingerprint: FP_B }).kind === 'block', 'a different certificate for that host shows the warning again');
  ok(d({ error: 'net::ERR_CERT_REVOKED' }).kind === 'block', 'an exception never covers a revoked certificate');

  // HSTS: preloaded and learned.
  const pre = d({ host: 'internal.dev' });
  ok(pre.kind === 'block' && pre.bypassable === false && /HSTS/.test(pre.reason), 'a host under an HSTS-preloaded TLD (.dev) cannot be bypassed', pre);
  ok(d({ host: 'gist.github.com' }).bypassable === false, 'a subdomain of a preloaded site cannot be bypassed');
  let h = c.noteHsts({}, 'secure.corp.example', 'max-age=31536000; includeSubDomains', 1000);
  ok(d({ host: 'secure.corp.example', hsts: h }).bypassable === false, 'a host that sent HSTS before cannot be bypassed');
  ok(d({ host: 'a.secure.corp.example', hsts: h }).bypassable === false, 'includeSubDomains covers its subdomains');
  const noSub = c.noteHsts({}, 'plain.example', 'max-age=600', 1000);
  ok(d({ host: 'x.plain.example', hsts: noSub }).bypassable === true, 'without includeSubDomains a subdomain is not covered');
  ok(d({ host: 'plain.example', hsts: noSub, now: 1000 + 601_000 }).bypassable === true, 'an expired HSTS record no longer applies');
  ok(Object.keys(c.noteHsts(h, 'secure.corp.example', 'max-age=0', 2000)).length === 0, 'max-age=0 forgets the host');
  ok(Object.keys(c.noteHsts({}, 'localhost', 'max-age=600', 1)).length === 0 && Object.keys(c.noteHsts({}, '10.0.0.5', 'max-age=600', 1)).length === 0, 'HSTS is not recorded for localhost or bare IPs');
  ok(c.parseHsts('includeSubDomains') === null && c.parseHsts('max-age="60"').maxAge === 60, 'HSTS headers parse (quoted max-age; missing max-age ignored)');
  s.add({ host: 'secure.corp.example', fingerprint: FP_A, ...base }, 'always');
  ok(d({ host: 'secure.corp.example', hsts: h }).kind === 'block', 'HSTS wins over a stored exception');

  // Loopback.
  for (const host of ['localhost', '127.0.0.1', '::1', 'app.localhost']) {
    ok(d({ host }).kind === 'block', `${host}: a warning while the localhost setting is off (the default)`);
    const on = d({ host, allowInsecureLocalhost: true });
    ok(on.kind === 'accept' && on.via === 'loopback', `${host}: let through when the person turned the localhost setting on`);
  }
  ok(d({ host: '192.168.1.10', allowInsecureLocalhost: true }).kind === 'block', 'the localhost setting does not cover the LAN');
  ok(d({ host: 'localhost.evil.com', allowInsecureLocalhost: true }).kind === 'block', 'nor a name that only starts with localhost');
  ok(d({ host: 'localhost', allowInsecureLocalhost: true, error: 'net::ERR_CERT_REVOKED' }).kind === 'block', 'nor a revoked certificate on localhost');
}

// ── Who may proceed ──
console.log('\nProceed: only the person, only on the warning shown');
{
  const pending = { token: 'k1', tabId: 't1', url: 'https://console.heccloud.com/', host: 'console.heccloud.com', fingerprint: FP_A, bypassable: true };
  const now = 50_000;
  ok(c.decideProceed({ pending, token: 'k1', now, lastPersonInputAt: now - 200 }).ok === true, 'the warning\'s token plus a click on the AICO window moments ago proceeds');
  ok(c.decideProceed({ pending, token: 'k1', now, lastPersonInputAt: 0 }).ok === false, 'no input on the AICO window (an agent, a script): refused');
  ok(c.decideProceed({ pending, token: 'k1', now, lastPersonInputAt: now - 10_000 }).ok === false, 'an old click does not count');
  ok(c.decideProceed({ pending, token: 'k0', now, lastPersonInputAt: now }).ok === false, 'a stale or guessed token is refused');
  ok(c.decideProceed({ pending, token: undefined, now, lastPersonInputAt: now }).ok === false, 'a missing token is refused');
  ok(c.decideProceed({ pending: undefined, token: 'k1', now, lastPersonInputAt: now }).ok === false, 'no warning on screen: refused');
  ok(c.decideProceed({ pending: { ...pending, bypassable: false }, token: 'k1', now, lastPersonInputAt: now }).ok === false, 'a non-bypassable warning cannot be proceeded past');

  // The IPC: ctx.handle answers only the AICO window's top frame — never a web page or an iframe.
  ok(sec.appFrameAllowed({ url: 'aico://app/index.html', isTopFrame: true }) === true, 'the AICO window may call browser:certProceed');
  ok(sec.appFrameAllowed({ url: 'https://console.heccloud.com/', isTopFrame: true }) === false, 'a web page may not');
  ok(sec.appFrameAllowed({ url: 'aico://app/index.html', isTopFrame: false }) === false, 'an iframe inside the AICO window may not');

  // No agent tool reaches the proceed or settings channels; the agent is told the person must allow it.
  const mcp = fs.readFileSync(path.join(desktop, 'electron/mcp.ts'), 'utf8');
  const browserTs = fs.readFileSync(path.join(desktop, 'electron/browser.ts'), 'utf8');
  ok(!/certProceed|certs:localhost|certs:remove|certStore/.test(mcp), 'the agent\'s browser tools name no certificate channel');
  const service = browserTs.slice(browserTs.indexOf('export interface BrowserService'), browserTs.indexOf('}', browserTs.indexOf('export interface BrowserService') + 2000));
  ok(!/cert/i.test(service), 'the BrowserService the tools call has no certificate method');
  ok(/the person must allow this certificate/.test(browserTs), 'browser_open tells the agent the person must allow the certificate');
  ok(/certificate-error/.test(browserTs) && /exceptions: certStore/.test(browserTs) && !/certificate-error[\s\S]{0,200}app\.on/.test(browserTs), 'exceptions are decided in the browser tab\'s certificate-error handler');
  const appCert = /app\.on\(\s*['"]certificate-error/.test(fs.readdirSync(path.join(desktop, 'electron')).filter(f => f.endsWith('.ts')).map(f => fs.readFileSync(path.join(desktop, 'electron', f), 'utf8')).join('\n'));
  ok(!appCert, 'no app-wide certificate-error handler: exceptions never reach aico:// pages or the engine');
}

// ── Passwords on an excepted site ──
console.log('\nPasswords');
{
  const ex = (o = {}) => ({ host: 'console.heccloud.com', fingerprint: FP_A, ...base, scope: 'session', ...o });
  ok(c.credentialGate({ host: 'x.com', certOk: true, exception: null }).ok === true, 'a valid certificate: passwords as usual');
  const s1 = c.credentialGate({ host: 'console.heccloud.com', certOk: false, via: 'exception', exception: ex() });
  ok(s1.ok === false && /this session only/.test(s1.reason) && /intercepted/.test(s1.reason), 'a session exception: the vault never fills and browser_login refuses', s1);
  const a1 = c.credentialGate({ host: 'console.heccloud.com', certOk: false, via: 'exception', exception: ex({ scope: 'always' }) });
  ok(a1.ok === 'confirm', '"always trust": the person is asked once for the host', a1);
  ok(c.credentialGate({ host: 'console.heccloud.com', certOk: false, via: 'exception', exception: ex({ scope: 'always', credentialsConfirmed: true }) }).ok === true, 'after that one confirmation, passwords may be used');
  ok(c.credentialGate({ host: 'console.heccloud.com', certOk: false, via: null, exception: null }).ok === false, 'an invalid certificate with no exception: refused');
  ok(c.credentialGate({ host: 'localhost', certOk: false, via: 'loopback', exception: null }).ok === true, 'loopback under the localhost setting: the traffic never leaves the machine');
  ok(c.credentialGate({ host: 'evil.com', certOk: false, via: 'loopback', exception: null }).ok === false, '"loopback" for a non-loopback host is not believed');
  const vault = fs.readFileSync(path.join(desktop, 'electron/browser-vault.ts'), 'utf8');
  ok(/certCheck \? await deps\.certCheck/.test(vault), 'the vault\'s person fill asks the certificate rule before filling');
  const bt = fs.readFileSync(path.join(desktop, 'electron/browser.ts'), 'utf8');
  const login = bt.slice(bt.indexOf('async function loginImpl'), bt.indexOf('requestFill', bt.indexOf('async function loginImpl')));
  ok(/certCredentialCheck/.test(login), 'browser_login checks the certificate rule before asking the vault');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(out, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
