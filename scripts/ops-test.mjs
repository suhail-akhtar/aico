/**
 * The ops tools (SSH, HTTP APIs, WinRM, SNMP) tested offline: every pure part
 * (destructive-command classifier, known_hosts, remote command planning,
 * SSRF/redirect policy, auth header construction, masking) and then the real
 * tools against real local servers — an `ssh2` SSH server with exec, SFTP and
 * forwarding (scripts/lib/ssh-test-server.mjs), Node HTTP(S) servers, and
 * net-snmp's own SNMP agent — all on 127.0.0.1, all started and stopped here.
 *
 * Part of `npm test`. No model, no network beyond loopback, no Docker, no
 * system service; the store is this process's own AICO_HOME and the vault key
 * lives in memory. Canary values only (standards-allow: secret on each).
 *
 * The invariant under test is the credential broker's: the tools USE
 * credentials and never RETURN them. Checked with the redactor switched OFF
 * (so a tool that echoed a value would be caught, not hidden), and then
 * through a real agent turn whose session log, stream callbacks, ledger file
 * and audit log are decoded and searched for every canary.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import { testHome } from './lib/test-home.mjs';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import {
  configureVault, memoryKeyProvider, Redactor, setActiveRedactor, activeRedactor, generateSshKeyPair,
  classifyRemoteCommand, isDestructiveHttpMethod,
  parseKnownHosts, checkHostKey, hasEntryFor, formatEntry, fingerprintOf, keyTypeOf, hostToken, trustHostKey, knownHostsPath,
  planRemoteCommand, MarkerWatch, shQuote,
  classifyAddress, decideTarget, expandV6,
  parseAuth, applyAuth, originOf, redirectPlan, maskJsonSecrets, shownHeaders, jsonPath, httpRequest,
  sshExec, sshCopy, sshTunnel, sshPurpose, parseMode, activeTunnelPorts,
  bindPowerShellPlaceholders, buildWinRmDriver, runPowerShellDriver, psQuote, winRmExec,
  snmpQuery, validOid, renderValue,
  maskUnknownSecrets, checkRate, resetOpsRateForTest, runWithOpsPrompter, MAX_APPROVAL_PURPOSE,
  OPS_TOOL_NAMES, opsToolDefinitions, isOpsTool, VAULT_TOOL_CLASSES, toolDefinitions, toolRequiresPermission, timeoutFor,
  callbackPrompter, ledger, invokeStop, runAgent, Session, createRootContext, ToolPipeline, installOpsStages,
} from '../dist-test/test-exports.js';
import { startSshServer, localBackend, sha256, findPosixShell } from './lib/ssh-test-server.mjs';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`); }
}
function skip(name, why) { skipped++; console.log(`  - SKIP ${name} (${why})`); }
async function attempt(fn) {
  try { return await fn(); } catch (err) { return { error: err?.message ?? String(err) }; }
}

// ── canaries and a decoding leak detector (same method as vault-test) ──
const SSH_PW = 'Ssh-Can4ry-Pw-5e6f7a8b9c01'; // standards-allow: secret (test canary)
const VALUE_PW = 'Svc-Can4ry-Pw-1a2b3c4d5e6f'; // standards-allow: secret (test canary)
const WRONG_PW = 'Wrong-Can4ry-Pw-000111222'; // standards-allow: secret (test canary)
const API_TOKEN = 'Api-Can4ry-Tok-0f1e2d3c4b5a69'; // standards-allow: secret (test canary)
const BASIC_PW = 'Basic-Can4ry-Pw-a1b2c3d4e5'; // standards-allow: secret (test canary)
const SNMP_COMM = 'Snmp-Can4ry-Comm-77aa88bb'; // standards-allow: secret (test canary)
const SNMP_AUTH = 'Snmp-Can4ry-Auth-11223344'; // standards-allow: secret (test canary)
const SNMP_PRIV = 'Snmp-Can4ry-Priv-55667788'; // standards-allow: secret (test canary)
const GENERATED = 'Gen3rated-Adm1n-Pw-778899aa'; // standards-allow: secret (test canary)
const CANARIES = [SSH_PW, VALUE_PW, WRONG_PW, API_TOKEN, BASIC_PW, SNMP_COMM, SNMP_AUTH, SNMP_PRIV];

function encodingsOf(v) {
  const b = Buffer.from(v);
  return [v, b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex'),
    encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(`deploy:${v}`).toString('base64')];
}
function leaks(value, canaries = CANARIES) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  for (const c of canaries) {
    if (encodingsOf(c).some(e => text.includes(e))) return `literal ${c.slice(0, 8)}…`;
    for (const run of text.match(/[A-Za-z0-9+/_=-]{12,}/g) ?? []) {
      for (let skip = 0; skip < 4; skip++) {
        for (const alphabet of ['base64', 'base64url']) {
          if (Buffer.from(run.slice(skip), alphabet).toString('latin1').includes(c)) return `base64 ${c.slice(0, 8)}…`;
        }
      }
    }
    for (const run of text.match(/(?:[0-9a-fA-F]{2}){8,}/g) ?? []) {
      for (const s of [run, run.slice(1)]) if (Buffer.from(s, 'hex').toString('latin1').includes(c)) return `hex ${c.slice(0, 8)}…`;
    }
  }
  return null;
}
/** Run `fn` with the redactor off, so a tool that echoed a value would be caught rather than hidden. */
async function unredacted(fn) {
  const saved = activeRedactor();
  setActiveRedactor(Redactor.EMPTY);
  try { return await fn(); } finally { setActiveRedactor(saved); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-ops-test-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── the vault, with a test prompter standing in for the person ──
const vault = configureVault({ dir: path.join(testHome, 'vault'), keyProvider: memoryKeyProvider() });
const asked = [];
let answer = true;
vault.setApprovalPrompter({ kind: 'test', ask: async (r) => { asked.push(r); return answer; } });

// ═══════════════════════════════════════════════════════════
console.log('\n══ O1. DESTRUCTIVE COMMAND CLASSIFIER ══');
{
  const yes = [
    ['rm -rf /var/lib/grafana', 'recursive delete'], ['sudo rm -r ./build', 'recursive delete'], ['find /tmp -name "*.log" -delete', 'find -delete'],
    ['mkfs.ext4 /dev/sdb1', 'formatting'], ['dd if=/dev/zero of=/dev/sda bs=1M', 'raw write'], ['psql -c "DROP DATABASE app"', 'dropping'],
    ['mysql -e "truncate table users"', 'truncating'], ['redis-cli FLUSHALL', 'flushing'], ['systemctl stop nginx', 'stopping'],
    ['sudo systemctl disable --now postgresql', 'stopping'], ['docker compose down -v', 'containers'], ['docker rm -f web', 'containers'],
    ['kubectl delete ns prod', 'cluster'], ['reboot', 'rebooting'], ['shutdown -h now', 'rebooting'], ['iptables -F', 'firewall'],
    ['iptables -P INPUT DROP', 'firewall'], ['ufw deny 22', 'firewall'], ['ufw enable', 'firewall'], ['nft flush ruleset', 'firewall'],
    ['sed -i "s/^PermitRootLogin.*/PermitRootLogin no/" /etc/ssh/sshd_config', 'SSH daemon'], ['systemctl restart sshd', 'restarting SSH'],
    ['userdel -r olduser', 'deleting an account'], ['passwd -l root', 'locking'], ['echo "x ALL=(ALL) ALL" >> /etc/sudoers', 'sudoers'],
    ['apt-get purge -y nginx', 'removing packages'], ['Stop-Service -Name W3SVC', 'stopping'], ['Remove-Item C:\\data -Recurse -Force', 'recursive delete'],
    ['netsh advfirewall set allprofiles state off', 'firewall'], ['Restart-Computer -Force', 'rebooting'], ['crontab -r', 'cron'],
    ['DELETE FROM sessions;', 'every row'], ['zfs destroy tank/data', 'volume'],
  ];
  const missed = yes.filter(([c, why]) => { const v = classifyRemoteCommand(c); return !v.destructive || !v.reasons.join(' ').includes(why.split(' ')[0]); });
  assert(missed.length === 0, `flags ${yes.length} destructive commands with a readable reason (missed: ${missed.map(m => m[0]).join(' | ') || 'none'})`);
  const no = ['ls -la /var/lib', 'systemctl status nginx', 'systemctl restart nginx', 'docker ps', 'cat /etc/os-release', 'apt-get install -y nginx',
    'useradd -m svc', 'chmod 600 /srv/app/.env', 'psql -c "select 1"', 'DELETE FROM sessions WHERE expires < now();', 'Get-Service W3SVC', 'kubectl get pods'];
  const wrong = no.filter(c => classifyRemoteCommand(c).destructive);
  assert(wrong.length === 0, `leaves ${no.length} routine commands alone (wrongly flagged: ${wrong.join(' | ') || 'none'})`);
  assert(classifyRemoteCommand('rm \\\n -rf /data').destructive, 'a line continuation does not hide a delete');
  assert(isDestructiveHttpMethod('delete') && !isDestructiveHttpMethod('POST'), 'HTTP DELETE is destructive, POST is not');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O2. KNOWN_HOSTS ══');
{
  const kp = generateSshKeyPair('t');
  const blob = Buffer.from(kp.publicKey.split(' ')[1], 'base64');
  const other = Buffer.from(generateSshKeyPair('u').publicKey.split(' ')[1], 'base64');
  assert(keyTypeOf(blob) === 'ssh-ed25519', 'reads the key type out of a public key blob');
  assert(fingerprintOf(blob) === kp.fingerprint, 'fingerprints like ssh-keygen -l (SHA256:…)');
  assert(hostToken('Host.Lan', 22) === 'host.lan' && hostToken('10.0.0.5', 2222) === '[10.0.0.5]:2222', 'host tokens: bare for 22, [host]:port otherwise');
  const entries = parseKnownHosts(`# comment\n${formatEntry('10.0.0.5', 22, blob)}\n@revoked * ${keyTypeOf(other)} ${other.toString('base64')}\nbroken line\n`);
  assert(entries.length === 2, 'parses entries, skipping comments and malformed lines');
  assert(checkHostKey(entries, '10.0.0.5', 22, blob).status === 'match', 'the pinned key matches');
  const mm = checkHostKey(entries.filter(e => !e.marker), '10.0.0.5', 22, Buffer.from(generateSshKeyPair('v').publicKey.split(' ')[1], 'base64'));
  assert(mm.status === 'mismatch' && mm.expected[0].includes(kp.fingerprint), 'a different key for a pinned host is a mismatch naming the expected fingerprint');
  assert(checkHostKey(entries, '10.0.0.6', 22, blob).status === 'unknown', 'another host is unknown');
  assert(checkHostKey(entries, '10.0.0.5', 2222, blob).status === 'unknown', 'the same host on another port is a different entry');
  assert(checkHostKey(entries, '10.0.0.9', 22, other).status === 'revoked', '@revoked keys are refused for every host they name');
  // A hashed entry, as ssh-keygen -H writes them.
  const salt = crypto.randomBytes(20);
  const hash = crypto.createHmac('sha1', salt).update('nas.lan').digest('base64');
  const hashed = parseKnownHosts(`|1|${salt.toString('base64')}|${hash} ${keyTypeOf(blob)} ${blob.toString('base64')}`);
  assert(checkHostKey(hashed, 'nas.lan', 22, blob).status === 'match' && checkHostKey(hashed, 'nas2.lan', 22, blob).status === 'unknown', 'hashed (|1|) entries are understood');
  assert(hasEntryFor(entries, '10.0.0.5', 22) && !hasEntryFor(entries, '10.0.0.7', 22), 'hasEntryFor tells a pinned host from a new one');
  // Found by the live SSH section: `[host]:port` was read as a regex character class, so a
  // key pinned on a non-22 port was never found again and every connection re-asked.
  const onPort = parseKnownHosts(formatEntry('10.0.0.5', 2222, blob));
  assert(hasEntryFor(onPort, '10.0.0.5', 2222) && checkHostKey(onPort, '10.0.0.5', 2222, blob).status === 'match'
    && !hasEntryFor(onPort, '1', 2222), 'an entry for [host]:port is found on that port (brackets are literal)');
  const file = path.join(tmp, 'kh', 'known_hosts');
  trustHostKey('10.0.0.5', 22, blob, 'test', file);
  trustHostKey('10.0.0.5', 22, blob, 'test', file);
  assert(fs.readFileSync(file, 'utf8').trim().split('\n').length === 1, 'trusting the same key twice writes one line');
  let refused = false;
  try { trustHostKey('10.0.0.5', 22, other, 'test', file); } catch { refused = true; }
  assert(refused, 'a second key for a pinned host is refused: replacing a pin is a person editing the file');
  if (process.platform !== 'win32') assert((fs.statSync(file).mode & 0o777) === 0o600, 'known_hosts is written 0600');
  assert(knownHostsPath().startsWith(testHome), 'AICO keeps its own known_hosts under AICO_HOME, never ~/.ssh');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O3. REMOTE COMMAND PLANNING (sudo, {{secret}} over stdin) ══');
{
  const plain = await planRemoteCommand('uname -a');
  assert(plain.exec === 'uname -a' && !plain.readyMarker && plain.secrets.length === 0, 'a plain command is sent as is, stdin closed at once');
  const markers = { ready: 'AICO-READY-test', sudo: 'AICO-SUDO-test' };
  const withRef = await planRemoteCommand(`echo "svc:{{secret:svc-pass}}" | chpasswd && x={{secret:svc-pass}} && y='{{secret:other.password}}'`, { markers });
  assert(withRef.secrets.length === 2 && withRef.secrets[0].variable === 'AICO_SECRET_1' && withRef.secrets[1].ref.field === 'password', 'one variable per distinct reference, in order, with its field');
  assert(withRef.exec.startsWith("sh -c '") && withRef.exec.includes('IFS= read -r AICO_SECRET_1 || exit 97') && !withRef.exec.includes('{{secret:'), 'references become shell variables read from stdin; none left in the exec string');
  assert(withRef.exec.includes('${AICO_SECRET_1}') && withRef.readyMarker === markers.ready, 'the ready marker is printed before the reads');
  const sudo = await planRemoteCommand('systemctl restart grafana-server', { sudo: true, markers });
  assert(sudo.exec.startsWith(`sudo -S -p 'AICO-SUDO-test' -- sh -c `) && sudo.sudoPrompt === markers.sudo && sudo.readyMarker, 'sudo: -S with a random prompt marker, and a ready marker so stdin can close');
  const cwd = await planRemoteCommand('ls', { cwd: "/srv/it's here" });
  assert(cwd.exec === `cd -- '/srv/it'\\''s here' && ls`, 'cwd is single-quoted safely');
  assert(shQuote("a'b") === `'a'\\''b'`, 'POSIX single quoting');
  // Markers split across chunks, twice-prompting sudo, and cleaning.
  const events = [];
  const w = new MarkerWatch({ sudoPrompt: 'AICO-SUDO-xyz', readyMarker: 'AICO-READY-xyz' }, { onSudoPrompt: n => events.push(`sudo${n}`), onReady: () => events.push('ready') });
  for (const chunk of ['warn: lecture\nAICO-SU', 'DO-xyzSorry, try again.\nAICO-SUDO-', 'xyz', 'AICO-READY-x', 'yz\nreal output']) w.push(chunk);
  assert(events.join(',') === 'sudo1,sudo2,ready', 'markers are found across chunk boundaries, in order, each counted');
  assert(w.clean('a\nAICO-READY-xyz\nb AICO-SUDO-xyz') === 'a\nb ', 'marker text is stripped from what the model sees');
  // The planned script really works in a POSIX shell: values arrive over stdin, not argv.
  const shell = findPosixShell();
  if (shell) {
    const p = await planRemoteCommand(`printf '%s|%s' {{secret:a}} "{{secret:b}}"`, { markers });
    const r = spawnSync(shell, ['-c', p.exec.replace(/^sh -c /, 'eval ')], { input: `${VALUE_PW}\nsecond value\n`, encoding: 'utf8' });
    assert(r.stdout === `${VALUE_PW}|second value` && r.stderr.includes(markers.ready), 'a real sh reads the values from stdin and substitutes them (spaces kept)');
    assert(!p.exec.includes(VALUE_PW), 'the exec string never held the value');
  } else skip('real sh execution of a plan', 'no POSIX shell on this machine');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O4. SSRF POLICY ══');
{
  const cls = {
    '8.8.8.8': 'public', '10.1.2.3': 'private', '172.20.0.1': 'private', '192.168.1.10': 'private', '127.0.0.1': 'loopback',
    '169.254.169.254': 'metadata', '169.254.170.2': 'metadata', '100.100.100.200': 'metadata', '168.63.129.16': 'metadata',
    '169.254.10.1': 'link-local', '100.64.1.1': 'cgnat', '0.0.0.0': 'unspecified', '224.0.0.1': 'multicast', '255.255.255.255': 'multicast',
    '::1': 'loopback', 'fe80::1': 'link-local', 'fd12:3456::1': 'unique-local', 'fd00:ec2::254': 'metadata', '::ffff:169.254.169.254': 'metadata',
    '::ffff:10.0.0.5': 'private', '64:ff9b::a9fe:a9fe': 'metadata', '2606:4700::1111': 'public', '::': 'unspecified', 'ff02::1': 'multicast',
  };
  const bad = Object.entries(cls).filter(([ip, c]) => classifyAddress(ip) !== c);
  assert(bad.length === 0, `classifies ${Object.keys(cls).length} addresses incl. IPv4-mapped and NAT64 forms (wrong: ${bad.map(([ip]) => `${ip}=${classifyAddress(ip)}`).join(', ') || 'none'})`);
  assert(expandV6('::1') === '0000:0000:0000:0000:0000:0000:0000:0001', 'expands IPv6');
  const base = { port: 80, credentialAdmits: false, knownTarget: false, tunnelPort: false };
  assert(decideTarget({ ...base, host: 'api.example.com', addresses: ['93.184.216.34'] }).allowed, 'public targets are allowed');
  for (const f of [
    { host: '169.254.169.254', addresses: ['169.254.169.254'] },
    { host: 'metadata.google.internal', addresses: ['8.8.8.8'] },
    { host: 'evil.example', addresses: ['93.184.216.34', '169.254.169.254'] },
  ]) {
    const d = decideTarget({ ...base, ...f, credentialAdmits: true, knownTarget: true, tunnelPort: true });
    assert(!d.allowed && /metadata/.test(d.reason), `metadata is refused even with everything vouching (${f.host} → ${f.addresses.join(',')})`);
  }
  const lan = decideTarget({ ...base, host: '10.0.0.5', addresses: ['10.0.0.5'] });
  assert(!lan.allowed && /stored credential bound/.test(lan.reason), 'a LAN address nothing vouches for is refused, with the fix named');
  assert(decideTarget({ ...base, host: '10.0.0.5', addresses: ['10.0.0.5'], credentialAdmits: true }).allowed, 'a LAN address the credential is bound to is allowed');
  assert(decideTarget({ ...base, host: 'nas.lan', addresses: ['192.168.1.4'], knownTarget: true }).allowed, 'a LAN host some stored credential names is allowed');
  const rebind = decideTarget({ ...base, host: 'rebind.example', addresses: ['93.184.216.34', '127.0.0.1'] });
  assert(!rebind.allowed, 'a name resolving to public AND loopback is judged by the loopback one');
  assert(decideTarget({ ...base, host: '127.0.0.1', addresses: ['127.0.0.1'], tunnelPort: true }).allowed, 'the loopback end of an AICO tunnel is allowed');
  assert(!decideTarget({ ...base, host: '10.0.0.5', addresses: ['10.0.0.5'], tunnelPort: true }).allowed, 'a tunnel port does not vouch for a non-loopback address');
  const pinned = decideTarget({ ...base, host: 'x', addresses: ['8.8.8.8', '10.0.0.5'], knownTarget: true });
  assert(pinned.allowed && pinned.address === '10.0.0.5', 'the request is pinned to the address that was vouched for');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O5. HTTP AUTH, REDIRECTS AND RESPONSE SHAPING ══');
{
  assert(parseAuth(undefined, 'api-token').kind === 'bearer' && parseAuth(undefined, 'basic-auth').kind === 'basic' && parseAuth(undefined).kind === 'none', 'auth defaults by credential kind');
  assert(parseAuth('header:X-Api-Key').name === 'X-Api-Key' && parseAuth('query:api_key').name === 'api_key', 'header: and query: modes parse');
  for (const bad of ['header:Host', 'header:bad name', 'query:a&b', 'cookie']) {
    let threw = false; try { parseAuth(bad); } catch { threw = true; }
    assert(threw, `refuses auth "${bad}"`);
  }
  const u = new URL('https://api.example.com/v1?x=1');
  assert(applyAuth({ kind: 'bearer' }, u, 'tok').headers.Authorization === 'Bearer tok', 'bearer header');
  assert(applyAuth({ kind: 'basic' }, u, 'pw', 'admin').headers.Authorization === `Basic ${Buffer.from('admin:pw').toString('base64')}`, 'basic header is base64(user:password)');
  const q = applyAuth({ kind: 'query', name: 'api_key' }, u, 'tok');
  assert(q.url.searchParams.get('api_key') === 'tok' && u.searchParams.get('api_key') === null, 'query auth sets the parameter on a copy, never the original URL');
  let threw = false; try { applyAuth({ kind: 'basic' }, u, 'pw', 'a:b'); } catch { threw = true; }
  assert(threw, 'a basic username with ":" is refused');
  assert(originOf(new URL('http://10.0.0.5/x')) === 'http://10.0.0.5:80' && originOf(new URL('https://h:8443/')) === 'https://h:8443', 'origins carry explicit ports');
  const same = redirectPlan(new URL('http://h/a'), new URL('http://h/b'), { hasAuth: true, bodyHasSecrets: false, method: 'POST', status: 302 });
  assert(same.follow && same.sameOrigin && same.method === 'GET' && !same.keepBody, '302 same-origin: follow as GET without the body');
  const keep = redirectPlan(new URL('http://h/a'), new URL('http://other/b'), { hasAuth: true, bodyHasSecrets: true, method: 'POST', status: 307 });
  assert(!keep.follow && /not re-sent/.test(keep.reason), '307 cross-origin with stored values in the body: not followed');
  assert(!redirectPlan(new URL('http://h/a'), new URL('file:///etc/passwd'), { hasAuth: false, bodyHasSecrets: false, method: 'GET', status: 302 }).follow, 'a redirect to file: is not followed');
  const m = maskJsonSecrets({ user: 'admin', token: 'Srv-Tok-abcdef123', data: [{ refresh_token: 'R-123456789' }], apiKey: 'K-99887766', short: 'ok', password: 'x' });
  assert(m.masked === 3 && m.value.token.startsWith('[masked') && m.value.data[0].refresh_token.startsWith('[masked') && m.value.user === 'admin', 'secret-looking JSON keys are masked at any depth; other fields kept');
  const hdrs = shownHeaders({ 'set-cookie': ['session=abc123; HttpOnly', 'csrf=zzz'], 'content-type': 'application/json', 'x-api-key': 'k' });
  assert(hdrs['set-cookie'].includes('session, csrf') && !hdrs['set-cookie'].includes('abc123') && hdrs['x-api-key'] === '[hidden]', 'cookies show their names only; key headers are hidden');
  assert(jsonPath({ a: { items: [{ t: 'v' }] } }, 'a.items[0].t') === 'v', 'json paths with indexes');
  const mu = maskUnknownSecrets('ok\nDB_PASSWORD=Xy7-unknown-Sekr3t\ntoken: ghp_' + 'a'.repeat(36));
  assert(mu.masked === 2 && !mu.text.includes('Xy7-unknown-Sekr3t'), 'unknown secret shapes in output are masked');
  const paths = maskUnknownSecrets('mkpasswd: /usr/bin/mkpasswd\npasswd_file=/etc/passwd');
  assert(paths.masked === 0, 'file paths after a password-ish word are not masked (seen live: `mkpasswd: /usr/bin/mkpasswd`)');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O6. WINRM (POWERSHELL REMOTING) ══');
{
  const b = bindPowerShellPlaceholders('$p = ConvertTo-SecureString "{{secret:svc}}" -AsPlainText -Force; Set-X -Token {{secret:api.token}}; "{{secret:svc}}"');
  assert(b.refs.length === 2 && b.script.includes('"$($AICO_SECRET_1)"') && b.script.includes('-Token $AICO_SECRET_2') && !b.script.includes('{{secret'), 'references become $AICO_SECRET_n parameters (expanded form inside double quotes)');
  let refused = false; try { bindPowerShellPlaceholders("Write-Output '{{secret:svc}}'"); } catch { refused = true; }
  assert(refused, 'a reference inside a single-quoted PowerShell string is refused (it would not expand)');
  assert(psQuote("O'Brien") === "'O''Brien'", 'PowerShell single quoting');
  const driver = buildWinRmDriver({ host: '10.0.0.7', port: 5986, user: 'CORP\\ops', useSsl: true, auth: 'Negotiate', skipCertChecks: false, secretCount: 1 });
  assert(driver.includes("ComputerName = '10.0.0.7'") && driver.includes('$o.UseSSL = $true') && !driver.includes('SkipCACheck') && driver.includes('[Console]::In'), 'the driver remotes over SSL, checks certificates, and reads its values from stdin');
  if (process.platform === 'win32') {
    const loop = buildWinRmDriver({ host: 'x', port: 5985, user: 'u', useSsl: false, auth: 'Negotiate', skipCertChecks: false, secretCount: 1, loopback: true });
    const body = '$h = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($AICO_SECRET_1))).Replace("-","").ToLower(); "hash=$h"; Write-Error "boom"';
    const r = await runPowerShellDriver(loop, [SSH_PW, VALUE_PW, body], { timeoutMs: 60_000 });
    assert(r.stdout.includes(`hash=${sha256(VALUE_PW)}`), 'real PowerShell received the value over stdin intact (checked by hash, never printed)');
    assert(r.code === 1 && /boom/.test(r.stderr), 'errors go to stderr and set exit 1');
    assert(!leaks(r.stdout + r.stderr), 'nothing it printed holds a value');
  } else {
    skip('PowerShell stdin round trip', 'not Windows');
    const r = await attempt(() => winRmExec({ host: '10.0.0.7', credential: 'x', script: 'hostname' }));
    assert(/needs AICO running on Windows/.test(r.error ?? ''), 'off Windows, WinRmExec says what to use instead');
  }
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O7. REGISTRY, CLASSIFICATION AND SOURCE INVARIANTS ══');
{
  const names = toolDefinitions.map(t => t.name);
  assert(OPS_TOOL_NAMES.every(n => names.includes(n)), `all ${OPS_TOOL_NAMES.length} ops tools are registered`);
  assert(OPS_TOOL_NAMES.every(n => VAULT_TOOL_CLASSES[n] === 'consumer'), 'each is classified as a vault consumer');
  assert(OPS_TOOL_NAMES.every(n => toolRequiresPermission(n)), 'each asks permission in "ask" mode');
  assert(OPS_TOOL_NAMES.every(n => timeoutFor(n) > 5 * 60 * 1000 && timeoutFor(n) <= 36 * 60 * 1000), 'each has a dispatcher backstop past its own deadline plus an approval wait');
  assert(opsToolDefinitions.every(d => !/password"?\s*:\s*\{\s*type/.test(JSON.stringify(d.inputSchema))), 'no ops tool schema takes a raw password argument');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const importing = walk('src/tools').filter(f => f.endsWith('.ts'))
    .filter(f => /from '(?:\.\.\/)+vault\/(?!sink\.js)/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative('src/tools', f).split(path.sep).join('/'));
  assert(importing.every(f => f === 'credentials.ts' || f.startsWith('ops/')), `only credentials.ts and the ops consumers reach into the vault (found: ${importing.join(', ')})`);
  const accessors = walk('src/tools/ops').filter(f => /\.(secretOf|revealForOwner|secretEntries|reveal)\(/.test(fs.readFileSync(f, 'utf8')));
  assert(accessors.length === 0, 'no ops module calls a value accessor; they only resolve()');
  // Code only: the module headers name what is refused, and why.
  const opsSrc = walk('src/tools/ops').map(f => fs.readFileSync(f, 'utf8')).join('\n')
    .split('\n').filter(l => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join('\n');
  assert(!/StrictHostKeyChecking|rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(opsSrc), 'no ops module disables host-key or TLS verification wholesale');
  assert(isOpsTool('SshExec') && !isOpsTool('Bash'), 'isOpsTool');
  resetOpsRateForTest();
  let hit = 0;
  for (let i = 0; i < 70; i++) { try { checkRate('SshExec', 'h'); } catch { hit++; } }
  assert(hit === 10, 'per-target rate limit: 60 SshExec calls a minute, then refused');
  resetOpsRateForTest();
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O8. SSH AGAINST A REAL LOCAL SSH SERVER ══');
const backend = localBackend();
let server;
const sshKey = await vault.generate({ name: 'box-key', kind: 'ssh-key', username: 'keyuser', host: '127.0.0.1' }, 'agent:ops-test');
if (!backend) {
  skip('the SSH section', 'no POSIX shell to act as the remote machine');
} else {
  server = await startSshServer({ backend, users: { deploy: { password: SSH_PW }, keyuser: { publicKey: sshKey.publicKey } } });
  const port = server.port;
  const T = { host: '127.0.0.1', port, credential: 'box-ssh' };
  await vault.create({ name: 'box-ssh', kind: 'ssh-password', secret: { password: SSH_PW }, username: 'deploy', host: '127.0.0.1', createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'svc-pass', kind: 'login', secret: { password: VALUE_PW }, username: 'svc', host: '127.0.0.1', createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'bad-sudo', kind: 'login', secret: { password: WRONG_PW }, host: '127.0.0.1', createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'elsewhere', kind: 'login', secret: { password: 'Elsewhere-Pw-00998877' }, host: '10.9.9.9', createdBy: 'user', policy: { approval: 'auto' } }); // standards-allow: secret (test canary)

  // First contact: the host key is shown to a person before any credential leaves.
  asked.length = 0; answer = false;
  const declined = await attempt(() => sshExec({ ...T, command: 'echo hi' }));
  assert(/not approved/.test(declined.error ?? ''), 'unknown host key + declined approval: refused');
  assert(asked.length === 1 && asked[0].description.includes('FIRST CONNECTION') && asked[0].description.includes(server.fingerprint), 'the approval names the host key fingerprint');
  assert(server.authAttempts.length === 0, 'nothing authenticated: the credential never reached the server');
  assert(!fs.existsSync(knownHostsPath()) || !fs.readFileSync(knownHostsPath(), 'utf8').includes(`:${port}]`), 'a declined key is not trusted');

  answer = true; asked.length = 0;
  const first = await unredacted(() => sshExec({ ...T, command: 'echo hello; echo oops >&2; exit 3' }));
  assert(first.exit_code === 3 && first.stdout.trim() === 'hello' && first.stderr.trim() === 'oops', 'runs the command: stdout, stderr and the exit code come back');
  assert(first.host_key.startsWith('trusted now') && fs.readFileSync(knownHostsPath(), 'utf8').includes(`[127.0.0.1]:${port}`), 'approved key is pinned after the connection succeeds');
  assert(!leaks(first), 'the result holds no credential (redactor off)');
  asked.length = 0;
  const second = await sshExec({ ...T, command: 'echo again' });
  assert(second.stdout.trim() === 'again' && second.host_key === 'known' && asked.length === 0,
    `next time: known key, no prompt (the credential is auto within scope)${second.stdout.trim() === 'again' && second.host_key === 'known' && asked.length === 0 ? '' : ` — got ${JSON.stringify({ ...second, asked: asked.map(a => a.description) }).slice(0, 400)}`}`);

  // {{secret:…}} values: over stdin, never in the exec request.
  const execsBefore = server.execs.length;
  const hashed = await unredacted(() => sshExec({ ...T, command: `printf '%s' {{secret:svc-pass}} | sha256sum | cut -d' ' -f1; x="{{secret:svc-pass}}"; printf '%s' "$x" | sha256sum | cut -d' ' -f1` }));
  const lines = hashed.stdout.trim().split('\n');
  assert(lines.length === 2 && lines.every(l => l === sha256(VALUE_PW)), 'the remote command received the stored value (bare and inside double quotes)');
  assert(server.execs.slice(execsBefore).every(e => !leaks(e)), 'no exec request ever contained a value');
  assert(!leaks(hashed) && !/AICO-READY/.test(hashed.stderr), 'result clean; markers stripped');
  const outOfScope = await attempt(() => sshExec({ ...T, command: 'echo {{secret:elsewhere}}' }));
  assert(/not bound to 127\.0\.0\.1/.test(outOfScope.error ?? ''), 'a value bound to another host cannot be sent to this one');

  // sudo: the password answers the prompt only when asked.
  server.env.FAKE_SUDO_SHA256 = sha256(SSH_PW);
  const su = await unredacted(() => sshExec({ ...T, command: 'echo root-ok', sudo: true }));
  assert(su.exit_code === 0 && su.stdout.trim() === 'root-ok' && !/AICO-SUDO/.test(su.stderr), 'sudo -S: the prompt is answered from the credential, marker stripped');
  assert(!leaks(su) && server.execs.every(e => !leaks(e)), 'the sudo password was in neither the exec request nor the result');
  server.env.NOPASSWD = '1';
  const nop = await unredacted(() => sshExec({ ...T, command: 'cat; echo end', sudo: true }));
  assert(nop.stdout.trim() === 'end' && !leaks(nop), 'NOPASSWD sudo never prompts, so the password is never written to a command reading stdin');
  server.env.NOPASSWD = '';
  const wrong = await unredacted(() => sshExec({ ...T, command: 'echo nope', sudo: true, sudo_credential: 'bad-sudo' }));
  assert(wrong.exit_code !== 0 && (wrong.notes ?? []).some(n => /sudo rejected/.test(n)) && !wrong.stdout.includes('nope'), 'a wrong sudo password: reported, not retried, command not run');

  // Destructive commands need a person, whatever the credential's policy.
  asked.length = 0; answer = false;
  const n0 = server.execs.length;
  const rm = await attempt(() => sshExec({ ...T, command: 'rm -rf ./scratch' }));
  assert(/not approved/.test(rm.error ?? '') && asked.length === 1 && /DESTRUCTIVE \(recursive delete\)/.test(asked[0].description), 'rm -rf on an auto credential still asks, naming why');
  assert(asked[0].description.includes('rm -rf ./scratch'), 'the approval shows the exact command');
  assert(server.execs.length === n0, 'declined: nothing ran');
  answer = true; asked.length = 0;
  const rmOk = await sshExec({ ...T, command: 'mkdir -p scratch && rm -rf ./scratch && echo gone' });
  assert(rmOk.stdout.trim() === 'gone' && asked.length === 1 && /recursive delete/.test(rmOk.approved_as), 'approved: runs, and the result says it was approved as destructive');
  asked.length = 0;
  const longCmd = await attempt(() => sshExec({ ...T, command: `rm -rf ./a ${'x'.repeat(MAX_APPROVAL_PURPOSE)}` }));
  assert(/Split it/.test(longCmd.error ?? '') && asked.length === 0, 'a destructive command too long to show in full is refused, not shown truncated');

  // capture: a value the server made goes to the vault, not the conversation.
  server.env.GEN_VALUE = GENERATED; // what a service generated on the server, e.g. an initial admin password
  const cap = await unredacted(() => sshExec({ ...T, command: `printf '%s' "$GEN_VALUE"`, capture: { name: 'svc-admin' } }));
  assert(cap.captured === '{{secret:svc-admin}}' && !cap.stdout.includes(GENERATED) && !JSON.stringify(cap).includes(GENERATED), 'capture stores stdout in the vault and shows only the reference');
  const capMeta = (await vault.list({})).find(c => c.name === 'svc-admin');
  assert(capMeta?.host === '127.0.0.1' && capMeta.createdBy.startsWith('agent:'), 'the captured credential is bound to the host it came from');
  const reuse = await sshExec({ ...T, command: `printf '%s' {{secret:svc-admin}} | sha256sum | cut -d' ' -f1` });
  assert(reuse.stdout.trim() === sha256(GENERATED), 'and can be used by reference straight away');
  const masked = await sshExec({ ...T, command: `printf 'db_password=Xy7-unknown-Sekr3t\\n'` });
  assert(masked.stdout.includes('[masked') && !masked.stdout.includes('Xy7-unknown-Sekr3t') && masked.notes?.length, 'an unknown secret printed by the server is masked, with a note on capture');

  // Keys work too.
  const key = await sshExec({ host: '127.0.0.1', port, credential: 'box-key', command: 'echo key-ok' });
  assert(key.stdout.trim() === 'key-ok' && key.user === 'keyuser', 'an ssh-key credential (generated, ed25519) logs in');
  const wrongUser = await attempt(() => sshExec({ ...T, user: 'root', command: 'id' }));
  assert(/is for user "deploy"/.test(wrongUser.error ?? ''), 'a credential cannot be used as a different user');

  // Deadlines, cancellation, background runs, the ledger.
  const t0 = Date.now();
  const slow = await sshExec({ ...T, command: 'sleep 20', timeout: 1 });
  assert(slow.exit_code === 124 && slow.notes?.some(n => /Stopped after 1s/.test(n)) && Date.now() - t0 < 10_000, 'a timeout stops it and says so');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 400);
  const cancelled = await sshExec({ ...T, command: 'sleep 20' }, ac.signal);
  assert(cancelled.notes?.includes('Cancelled.'), 'cancellation is honoured');
  const bg = await sshExec({ ...T, command: 'sleep 1; echo done-bg', background: true });
  assert(bg.status === 'running in the background' && ledger.get(bg.work_id)?.state === 'running', 'background: returns a work id at once, recorded as running');
  const until = Date.now() + 20_000;
  while (Date.now() < until && ledger.get(bg.work_id)?.state === 'running') await new Promise(r => setTimeout(r, 100));
  const bgRec = ledger.get(bg.work_id);
  assert(bgRec?.state === 'done' && /exit 0/.test(bgRec.result ?? '') && !bgRec.reported, 'background run finishes as done, left unreported for Supervise to surface');
  assert(fs.readFileSync(bg.log, 'utf8').includes('done-bg'), 'its output is in the run log');
  const recs = ledger.all().filter(r => r.title.startsWith('SshExec'));
  assert(recs.length >= 10 && recs.every(r => r.title.includes('[cred box-ssh]') || r.title.includes('[cred box-key]')), 'every SshExec call is a ledger record naming the credential (never its value)');
  assert(recs.filter(r => r.state === 'failed').length >= 1 && recs.some(r => r.state === 'cancelled'), 'failures and cancellations are recorded as such');

  // SshCopy.
  const up = await sshCopy({ ...T, direction: 'upload', remote_path: '/app/config.env', content: 'API_KEY={{secret:svc-pass}}\nMODE=prod\n' });
  const written = fs.readFileSync(path.join(backend.root, 'app', 'config.env'), 'utf8');
  assert(up.mode === '0600' && written === `API_KEY=${VALUE_PW}\nMODE=prod\n`, 'content with {{secret}} is written with the value, mode 0600 by default');
  if (process.platform !== 'win32') assert((fs.statSync(path.join(backend.root, 'app', 'config.env')).mode & 0o777) === 0o600, 'the remote file really is 0600');
  assert(!leaks(up), 'the upload result holds no value');
  const world = await attempt(() => sshCopy({ ...T, direction: 'upload', remote_path: '/app/x.env', content: 'K={{secret:svc-pass}}', mode: '0644' }));
  assert(/must not be readable by everyone/.test(world.error ?? ''), 'a world-readable file holding a secret is refused');
  const srcDir = path.join(tmp, 'site');
  fs.mkdirSync(path.join(srcDir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(srcDir, 'css', 'a.css'), 'h1{}');
  const upDir = await sshCopy({ ...T, direction: 'upload', local_path: srcDir, remote_path: '/app/site' });
  assert(upDir.files === 2 && fs.existsSync(path.join(backend.root, 'app', 'site', 'css', 'a.css')), 'a directory uploads recursively');
  const dl = path.join(tmp, 'dl');
  const down = await sshCopy({ ...T, direction: 'download', remote_path: '/app/site', local_path: dl });
  assert(down.files === 2 && fs.readFileSync(path.join(dl, 'index.html'), 'utf8') === '<h1>hi</h1>', 'and downloads back');
  const again = await attempt(() => sshCopy({ ...T, direction: 'download', remote_path: '/app/site/index.html', local_path: path.join(dl, 'index.html') }));
  assert(/exists/.test(again.error ?? ''), 'a download does not overwrite a local file unless asked');
  const vaultUp = await attempt(() => sshCopy({ ...T, direction: 'upload', local_path: path.join(testHome, 'vault', 'vault.json'), remote_path: '/tmp/v' }));
  assert(/cannot be copied/.test(vaultUp.error ?? ''), 'the vault\'s own files cannot be uploaded anywhere');
  asked.length = 0; answer = false;
  const sshd = await attempt(() => sshCopy({ ...T, direction: 'upload', remote_path: '/etc/ssh/sshd_config', content: 'PermitRootLogin no\n' }));
  assert(/not approved/.test(sshd.error ?? '') && /SSH daemon config/.test(asked[0]?.description ?? ''), 'replacing sshd_config asks a person first');
  answer = true;

  // SshTunnel.
  const svc = http.createServer((req, res) => { res.end(`svc:${req.url}`); });
  await new Promise(r => svc.listen(0, '127.0.0.1', r));
  const tun = await sshTunnel({ ...T, remote_port: svc.address().port });
  assert(tun.status === 'open' && activeTunnelPorts().includes(Number(tun.local.split(':')[1])), 'a tunnel opens on loopback and is registered');
  const through = await httpRequest({ url: `${tun.local_url}/health` });
  assert(through.status === 200 && through.body === 'svc:/health', 'HttpRequest reaches the forwarded service through it');
  assert(ledger.get(tun.work_id)?.state === 'running', 'the tunnel is live work in the ledger');
  await invokeStop(tun.work_id, 'stop', 'test done');
  assert(!activeTunnelPorts().includes(Number(tun.local.split(':')[1])) && ledger.get(tun.work_id)?.state !== 'running', 'Supervise stop closes it');
  asked.length = 0; answer = false;
  const pivot = await attempt(() => sshTunnel({ ...T, remote_port: 22, remote_host: '10.1.1.1' }));
  assert(/not approved/.test(pivot.error ?? '') && /another machine/.test(asked[0]?.description ?? ''), 'forwarding through the server to another machine asks first');
  answer = true;
  svc.close();

  // The ops:prompter stage: the run's own dialog when no process-wide prompter exists.
  vault.setApprovalPrompter(undefined);
  const dialogs = [];
  const viaDialog = await runWithOpsPrompter(callbackPrompter(async (title, detail) => { dialogs.push(detail); return false; }),
    () => attempt(() => sshExec({ ...T, command: 'systemctl stop grafana-server' })));
  assert(/not approved/.test(viaDialog.error ?? '') && /DESTRUCTIVE/.test(dialogs[0] ?? ''), 'without a server prompter, the run\'s own permission dialog is asked');
  const nobody = await attempt(() => sshExec({ ...T, command: 'reboot' }));
  assert(/nobody is available/.test(nobody.error ?? ''), 'with nobody to ask (headless), a destructive command is refused');
  const pipeline = new ToolPipeline();
  installOpsStages(pipeline, {});
  installOpsStages(pipeline, {});
  assert(pipeline.describe().around.filter(s => s === 'ops:prompter').length === 1, 'the stage installs once');
  vault.setApprovalPrompter({ kind: 'test', ask: async (r) => { asked.push(r); return answer; } });

  // A new key on a pinned host: refused before anything is sent.
  await server.close();
  const impostor = await startSshServer({ backend, users: { deploy: { password: SSH_PW } }, port });
  const mitm = await attempt(() => sshExec({ ...T, command: 'echo hi' }));
  assert(/HOST KEY MISMATCH/.test(mitm.error ?? '') && mitm.error.includes(server.fingerprint), 'a changed host key is refused as a possible interception, naming the pinned key');
  assert(impostor.authAttempts.length === 0, 'the impostor received no authentication at all');
  await impostor.close();
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O9. HTTP API AGAINST LOCAL SERVERS ══');
{
  const seen = { b: [], bodies: [] };
  const serverB = http.createServer((req, res) => { seen.b.push(req.headers.authorization ?? '(none)'); res.end('b'); });
  await new Promise(r => serverB.listen(0, '127.0.0.1', r));
  const pb = serverB.address().port;
  const serverA = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url, 'http://x');
    const bearer = req.headers.authorization === `Bearer ${API_TOKEN}`;
    const json = (code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/api/me') return bearer ? json(200, { user: 'admin', token: 'Srv-Issued-Tok-9z8y7x6w', refresh_token: 'Rf-abc123XYZ-456' }, { 'set-cookie': 'session=Sess-99887766; HttpOnly' }) : json(401, { error: 'no' });
    if (u.pathname === '/basic') return req.headers.authorization === `Basic ${Buffer.from(`deploy:${BASIC_PW}`).toString('base64')}` ? json(200, { ok: 'basic' }) : json(401, {});
    if (u.pathname === '/hdr') return req.headers['x-api-key'] === API_TOKEN ? json(200, { ok: 'hdr' }) : json(401, {});
    if (u.pathname === '/query') return u.searchParams.get('api_key') === API_TOKEN ? json(200, { ok: 'query' }) : json(401, {});
    if (u.pathname === '/users' && req.method === 'POST') { seen.bodies.push(body); const p = JSON.parse(body); return json(201, { created: p.name, sha: sha256(p.password) }); }
    if (u.pathname === '/redir-same') { res.writeHead(302, { location: '/api/me' }); return res.end(); }
    if (u.pathname === '/redir-cross') { res.writeHead(307, { location: `http://127.0.0.1:${pb}/steal` }); return res.end(); }
    if (u.pathname === '/item' && req.method === 'DELETE') { res.writeHead(bearer ? 204 : 401); return res.end(); }
    if (u.pathname === '/health') return json(200, { status: 'ok' });
    json(404, {});
  });
  await new Promise(r => serverA.listen(0, '127.0.0.1', r));
  const pa = serverA.address().port;
  const A = `http://127.0.0.1:${pa}`;
  await vault.create({ name: 'api-tok', kind: 'api-token', secret: { token: API_TOKEN }, url: A, createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'api-basic', kind: 'basic-auth', secret: { password: BASIC_PW }, username: 'deploy', url: A, createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'other-tok', kind: 'api-token', secret: { token: 'Other-Can4ry-Tok-6655443322' }, url: 'https://api.example.com', createdBy: 'user', policy: { approval: 'auto' } }); // standards-allow: secret (test canary)

  const me = await unredacted(() => httpRequest({ url: `${A}/api/me`, credential: 'api-tok' }));
  assert(me.status === 200 && /"user": "admin"/.test(me.body), 'bearer auth from the vault works');
  assert(me.body.includes('[masked token]') && me.body.includes('[masked refresh_token]') && !me.body.includes('Srv-Issued-Tok'), 'tokens the server returns are masked');
  assert(me.headers['set-cookie'].includes('session') && !me.headers['set-cookie'].includes('Sess-99887766'), 'Set-Cookie shows names only');
  assert(!leaks(me), 'the result holds no credential (redactor off)');
  const cap = await httpRequest({ url: `${A}/api/me`, credential: 'api-tok', capture: [{ name: 'srv-token', from: 'json:token' }] });
  assert(cap.captured?.[0] === '{{secret:srv-token}}' && !JSON.stringify(cap).includes('Srv-Issued-Tok'), 'capture moves a returned token into the vault');
  assert((await vault.list({})).find(c => c.name === 'srv-token')?.url === `http://127.0.0.1:${pa}`, 'bound to the origin it came from');
  assert((await unredacted(() => httpRequest({ url: `${A}/basic`, credential: 'api-basic' }))).status === 200, 'basic auth uses the credential\'s username and password');
  assert((await httpRequest({ url: `${A}/hdr`, credential: 'api-tok', auth: 'header:X-Api-Key' })).status === 200, 'header:<Name> auth');
  const qr = await unredacted(() => httpRequest({ url: `${A}/query`, credential: 'api-tok', auth: 'query:api_key' }));
  assert(qr.status === 200 && !qr.url.includes('api_key') && !leaks(qr), 'query auth works and the returned URL does not carry the key');
  const created = await unredacted(() => httpRequest({ method: 'POST', url: `${A}/users`, credential: 'api-tok', json: { name: 'svc', password: '{{secret:svc-pass}}' } }));
  assert(created.status === 201 && JSON.parse(created.body).sha === sha256(VALUE_PW), '{{secret}} in a JSON body reaches the API as the value (checked by hash)');
  assert(!leaks(created), 'and not the result');
  const red = await httpRequest({ url: `${A}/redir-same`, credential: 'api-tok' });
  assert(red.status === 200 && red.redirects === 1, 'a same-origin redirect is followed with the auth');
  const cross = await httpRequest({ method: 'POST', url: `${A}/redir-cross`, credential: 'api-tok', json: { a: 1 } });
  assert(cross.status === 307 && seen.b.length === 0 && cross.notes?.some(n => /not followed/.test(n)), 'a cross-origin redirect the credential is not bound to is not followed; the other server saw nothing');
  const noCredCross = await httpRequest({ url: `${A}/redir-cross`, method: 'GET' });
  assert(noCredCross.status === 200 && seen.b.every(h => h === '(none)'), 'without a credential it may follow, and nothing carries auth');
  const wrongOrigin = await attempt(() => httpRequest({ url: `${A}/api/me`, credential: 'other-tok' }));
  assert(/not bound to/.test(wrongOrigin.error ?? ''), 'a credential bound to another origin is refused for this one');
  asked.length = 0; answer = false;
  const del = await attempt(() => httpRequest({ method: 'DELETE', url: `${A}/item`, credential: 'api-tok' }));
  assert(/not approved/.test(del.error ?? '') && /DESTRUCTIVE/.test(asked[0]?.description ?? ''), 'DELETE asks a person');
  answer = true;
  assert((await httpRequest({ method: 'DELETE', url: `${A}/item`, credential: 'api-tok' })).status === 204, 'approved DELETE runs');
  const delNoCred = await attempt(() => httpRequest({ method: 'DELETE', url: `${A}/item` }));
  assert(/needs a person/.test(delNoCred.error ?? ''), 'DELETE without a credential is refused (no one could approve it)');
  const meta = await attempt(() => httpRequest({ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }));
  assert(/metadata/.test(meta.error ?? ''), 'the cloud metadata endpoint is refused');
  const unknownLan = await attempt(() => httpRequest({ url: `http://127.0.0.2:${pa}/health` }));
  assert(/loopback address/.test(unknownLan.error ?? ''), 'a loopback/LAN target nothing vouches for is refused');
  const known = await httpRequest({ url: `${A}/health` });
  assert(known.status === 200, 'a host a stored credential is bound to is reachable without auth (health checks)');
  for (const [u, why] of [[`http://deploy:pw@127.0.0.1:${pa}/`, 'userinfo'], [`${A}/?k={{secret:api-tok}}`, 'placeholder in URL'], ['ftp://x/', 'non-http']]) {
    const r = await attempt(() => httpRequest({ url: u }));
    assert(!!r.error, `refused: ${why}`);
  }
  const hdrRef = await attempt(() => httpRequest({ url: `${A}/health`, headers: { Host: 'evil' } }));
  assert(/cannot be set/.test(hdrRef.error ?? ''), 'transport headers cannot be set');

  // TLS: self-signed only when the credential says so.
  const certDir = path.join(tmp, 'tls');
  fs.mkdirSync(certDir, { recursive: true });
  const opensslArgs = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', 'key.pem', '-out', 'cert.pem'];
  let gen = { status: 1 };
  for (const bin of ['openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe']) {
    gen = spawnSync(bin, opensslArgs, { cwd: certDir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    if (gen.status === 0) break;
  }
  if (gen.status === 0 && fs.existsSync(path.join(certDir, 'cert.pem'))) {
    const tls = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
      (req, res) => { res.writeHead(req.headers.authorization === `Bearer ${API_TOKEN}` ? 200 : 401); res.end('tls'); });
    await new Promise(r => tls.listen(0, '127.0.0.1', r));
    const S = `https://127.0.0.1:${tls.address().port}`;
    await vault.create({ name: 'tls-strict', kind: 'api-token', secret: { token: API_TOKEN }, url: S, createdBy: 'user', policy: { approval: 'auto' } });
    await vault.create({ name: 'tls-selfsigned', kind: 'api-token', secret: { token: API_TOKEN }, url: S, createdBy: 'user', policy: { approval: 'auto', allowSelfSigned: true } });
    const strict = await attempt(() => httpRequest({ url: `${S}/`, credential: 'tls-strict' }));
    assert(/not trusted/.test(strict.error ?? ''), 'a self-signed certificate is refused by default, with the owner\'s fix named');
    assert((await httpRequest({ url: `${S}/`, credential: 'tls-selfsigned' })).status === 200, 'accepted only for a credential whose owner allowed self-signed');
    const anon = await attempt(() => httpRequest({ url: `${S}/` }));
    assert(!!anon.error, 'never without such a credential');
    tls.close();
  } else skip('TLS self-signed handling', 'openssl not available to make a test certificate');
  serverA.close();
  serverB.close();
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O10. SNMP AGAINST net-snmp\'s AGENT ══');
{
  const snmp = (await import('net-snmp')).default;
  const sp = 30000 + Math.floor(Math.random() * 20000);
  const agent = snmp.createAgent({ port: sp, address: '127.0.0.1', accessControlModelType: snmp.AccessControlModelType.Simple }, () => {});
  const authz = agent.getAuthorizer();
  authz.addCommunity(SNMP_COMM);
  authz.addUser({ name: 'snmpops', level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha, authKey: SNMP_AUTH, privProtocol: snmp.PrivProtocols.aes, privKey: SNMP_PRIV });
  const acm = authz.getAccessControlModel();
  acm.setCommunityAccess(SNMP_COMM, snmp.AccessLevel.ReadWrite);
  acm.setUserAccess('snmpops', snmp.AccessLevel.ReadWrite);
  const mib = agent.getMib();
  mib.registerProvider({ name: 'sysDescr', type: snmp.MibProviderType.Scalar, oid: '1.3.6.1.2.1.1.1', scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-only'] });
  mib.registerProvider({ name: 'sysName', type: snmp.MibProviderType.Scalar, oid: '1.3.6.1.2.1.1.5', scalarType: snmp.ObjectType.OctetString, maxAccess: snmp.MaxAccess['read-write'] });
  mib.setScalarValue('sysDescr', 'AICO test agent');
  mib.setScalarValue('sysName', 'switch-01');
  await vault.create({ name: 'snmp-v2', kind: 'snmp', secret: { community: SNMP_COMM }, host: '127.0.0.1', createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'snmp-v3', kind: 'snmp', secret: { authKey: SNMP_AUTH, privKey: SNMP_PRIV }, username: 'snmpops', host: '127.0.0.1', createdBy: 'user', policy: { approval: 'auto' } });
  await vault.create({ name: 'snmp-bad', kind: 'snmp', secret: { community: 'Wrong-Comm-9988' }, host: '127.0.0.1', createdBy: 'user', policy: { approval: 'auto' } }); // standards-allow: secret (test canary)
  const S = { host: '127.0.0.1', port: sp };
  const g = await unredacted(() => snmpQuery({ ...S, credential: 'snmp-v2', action: 'get', oids: ['1.3.6.1.2.1.1.5.0'] }));
  assert(g.version === 'v2c' && g.rows[0]?.value === 'switch-01' && g.rows[0].type === 'OctetString', 'v2c get returns a typed row');
  assert(!leaks(g), 'no community string in the result (redactor off)');
  const w = await snmpQuery({ ...S, credential: 'snmp-v2', action: 'walk', oid: '1.3.6.1.2.1.1' });
  assert(w.rows.length >= 2 && w.rows.some(r => r.value === 'AICO test agent'), 'walk returns the subtree as a table');
  const w1 = await snmpQuery({ ...S, credential: 'snmp-v2', action: 'walk', oid: '1.3.6.1.2.1.1', max_rows: 1 });
  assert(w1.rows.length === 1 && w1.truncated, 'max_rows caps a walk and says so');
  const v3 = await unredacted(() => snmpQuery({ ...S, credential: 'snmp-v3', action: 'get', oids: ['1.3.6.1.2.1.1.1.0'] }));
  assert(v3.version === 'v3' && v3.rows[0]?.value === 'AICO test agent' && !leaks(v3), 'v3 authPriv (SHA/AES) get works with keys from the vault');
  asked.length = 0; answer = false;
  const denied = await attempt(() => snmpQuery({ ...S, credential: 'snmp-v2', action: 'set', set: [{ oid: '1.3.6.1.2.1.1.5.0', type: 'OctetString', value: 'renamed' }] }));
  assert(/not approved/.test(denied.error ?? '') && /CHANGE DEVICE CONFIG/.test(asked[0]?.description ?? '') && mib.getScalarValue('sysName') === 'switch-01', 'set asks a person; declined leaves the device unchanged');
  answer = true;
  const set = await snmpQuery({ ...S, credential: 'snmp-v2', action: 'set', set: [{ oid: '1.3.6.1.2.1.1.5.0', type: 'OctetString', value: 'renamed' }] });
  assert(set.approved_as && mib.getScalarValue('sysName') === 'renamed', 'approved set changes the value');
  const bad = await attempt(() => snmpQuery({ ...S, credential: 'snmp-bad', action: 'get', oids: ['1.3.6.1.2.1.1.5.0'], timeout: 1 }));
  assert(/did not answer|SNMP/.test(bad.error ?? ''), 'a wrong community fails cleanly');
  assert(!validOid('sysName.0') && validOid('.1.3.6.1.2.1.1.5.0'), 'only numeric OIDs');
  assert(renderValue(Buffer.from([0, 1, 255])) === '0x0001ff' && renderValue(Buffer.from('text')) === 'text', 'binary octet strings render as hex');
  agent.close();
}

// ═══════════════════════════════════════════════════════════
console.log('\n══ O11. A REAL AGENT TURN: EVERY SINK SCANNED ══');
if (!backend) {
  skip('the agent-turn canary scan', 'no POSIX shell for the SSH server');
} else {
  server = await startSshServer({ backend, users: { deploy: { password: SSH_PW } } });
  // A new server key on a new port: approve it, like the first time.
  const port = server.port;
  server.env.FAKE_LEAK = SSH_PW; // the remote machine prints a value the vault holds
  const ctx = createRootContext({});
  const session = new Session({ id: 'ops-canary', cwd: process.cwd(), startedAt: Date.now() });
  const calls = [
    { name: 'SshExec', input: { host: '127.0.0.1', port, credential: 'box-ssh', command: `printf 'leak:%s\\n' "$FAKE_LEAK"; printf '%s' {{secret:svc-pass}} | sha256sum` } },
    { name: 'SshCopy', input: { host: '127.0.0.1', port, credential: 'box-ssh', direction: 'upload', remote_path: '/app/turn.env', content: 'PW={{secret:svc-pass}}\n' } },
  ];
  const seenByModel = [];
  const provider = {
    id: 'mock', displayName: 'Mock',
    async *chat(opts) {
      seenByModel.push(JSON.stringify(opts.messages));
      if (seenByModel.length === 1) {
        for (const [i, c] of calls.entries()) yield { type: 'tool_call', id: `ops-${i}`, name: c.name, input: c.input };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield { type: 'text', content: 'done' };
        yield { type: 'finish', reason: 'stop' };
      }
    },
  };
  const streamed = [];
  await runAgent({
    task: 'deploy the config', model: 'mock-model', showPlan: false, autoApprove: true, verbose: false, silent: true,
    conversationHistory: [], sessionId: session.header.id, session, provider, context: ctx,
    settings: { completionGate: { enabled: false }, cron: { enabled: false }, repeatGuard: { enabled: false } },
    onToolDone: (n, r) => streamed.push(r), onToolCall: (n, a) => streamed.push(a),
  });
  const results = session.events.filter(e => e.type === 'tool/result');
  const sshOut = JSON.stringify(results[0] ?? '');
  assert(results.length === 2 && sshOut.includes('leak:[secret:box-ssh]'), 'the remote printed a stored value; the model saw [secret:box-ssh] instead');
  assert(sshOut.includes(sha256(VALUE_PW)), 'and the {{secret}} value reached the remote command');
  const everything = [
    ['session log', JSON.stringify(session.events)],
    ['requests to the model', seenByModel.join('\n')],
    ['stream callbacks', JSON.stringify(streamed)],
    ['work ledger file', fs.existsSync(path.join(testHome, 'work.jsonl')) ? fs.readFileSync(path.join(testHome, 'work.jsonl'), 'utf8') : ''],
    ['vault audit log', fs.readFileSync(path.join(testHome, 'vault', 'audit.jsonl'), 'utf8')],
    ['ops run logs', fs.existsSync(path.join(testHome, 'ops', 'runs')) ? fs.readdirSync(path.join(testHome, 'ops', 'runs')).map(f => fs.readFileSync(path.join(testHome, 'ops', 'runs', f), 'utf8')).join('\n') : ''],
    ['known_hosts', fs.readFileSync(knownHostsPath(), 'utf8')],
  ];
  for (const [where, text] of everything) assert(!leaks(text), `no canary in any encoding in the ${where}`);
  const audit = everything[4][1];
  assert(/"tool":"SshExec"/.test(audit) && /"tool":"SshCopy"/.test(audit), 'the audit log records each credential use by tool');
  await ctx.dispose();
  await server.close();
}

backend?.close();
console.log(`\n${failed ? '✗' : '✓'} ops tools: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
