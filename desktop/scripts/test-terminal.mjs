/**
 * Terminal integration tests (ADR 0019): the pure modules, a real shell
 * through the real launch code, and an SSH shell through ssh2 against the
 * in-process test server.
 *
 *   node scripts/test-terminal.mjs
 *
 * Covered: the OSC 133 / 633 parser (split marks, unknown OSCs), the command
 * record builder, redaction (and its parity with the engine's scanner), the
 * secret-prompt detector, the agent write policy, the error watcher's
 * debounce and dedupe, the export builders, a PowerShell (Windows) or bash
 * (elsewhere) spawned with integration reporting a failing command's exit
 * code, and the SSH terminal's host-key accept / refuse / mismatch path.
 *
 * Isolated: AICO_HOME is a temp store (scripts/lib/test-home.mjs); the shell
 * runs with HOME pointed at a temp folder so no real profile is involved
 * where that can be arranged.
 */

import '../../scripts/lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-term-'));
const require = createRequire(import.meta.url);

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron', 'ssh2'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}
const waitFor = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); }
  return fn();
};

const integ = await load(path.join(desktop, 'shared/terminal-integration.ts'), 'integration');
const redact = await load(path.join(desktop, 'shared/terminal-redact.ts'), 'redact');
const safety = await load(path.join(desktop, 'shared/terminal-safety.ts'), 'safety');
const exp = await load(path.join(desktop, 'shared/terminal-export.ts'), 'export');
const scan = await load(path.join(repo, 'src/vault/scan.ts'), 'scan');

const E = '\x1b';
const B = '\x07';
const osc = (p) => `${E}]${p}${B}`;

// ── OSC 133 / 633 parser ──
console.log('\nparser');
{
  const p = new integ.MarkParser();
  const all = [
    ...p.push(`hello ${osc('133;A')}PS> ${osc('133;B')}`),
    ...p.push(`ls${E}]633;E;ls -la \\x3b echo hi${B}${E}]13`), // a mark split across chunks
    ...p.push(`3;C${B}out\r\n${E}]0;window title${B}more${osc('133;D;2')}${osc('633;P;Cwd=C:\\\\work\\x3bx')}`),
  ];
  const marks = all.filter(x => x.kind === 'mark').map(x => x.mark);
  ok(marks.map(m => m.kind).join('') === 'ABECDP', 'marks come out in order, including one split across two chunks', marks);
  ok(marks[2].command === 'ls -la ; echo hi', '633;E unescapes \\x3b', marks[2]);
  ok(marks[4].exitCode === 2, 'D carries the exit code');
  ok(marks[5].cwd === 'C:\\work;x', '633;P Cwd unescapes \\\\ and \\x3b', marks[5]);
  const text = all.filter(x => x.kind === 'text').map(x => x.text).join('');
  ok(text.includes(`${E}]0;window title${B}`), 'an OSC we do not know stays in the text for xterm');
  ok(integ.unescapeValue(integ.escapeValue('a;b\\c\nd')) === 'a;b\\c\nd', 'escape/unescape round-trip');
  const q = new integ.MarkParser();
  const long = q.push(`${E}]133;` + 'x'.repeat(9000));
  ok(long.length === 1 && long[0].kind === 'text', 'an unterminated OSC longer than the limit is passed on as text, not held forever');
}

// ── command records ──
console.log('\nrecords');
{
  const p = new integ.MarkParser();
  const t = new integ.CommandTracker('/home/u');
  const feed = (s, now) => t.feed(p.push(s), now);
  ok(feed(`${osc('133;D;0')}${osc('633;P;Cwd=/srv/app')}${osc('133;A')}$ ${osc('133;B')}`, 1000).length === 0, 'the first prompt (D without C) makes no record');
  feed('npm tset', 1100);
  feed('\b\b\best', 1150); // typed correction: "npm tset" ⌫⌫⌫ "est"
  feed(`${osc('133;C')}\r\n${E}[31mnpm ERR! missing script: test${E}[0m\r\n`, 2000);
  const recs = feed(`${osc('133;D;1')}${osc('133;A')}$ ${osc('133;B')}`, 4500);
  ok(recs.length === 1, 'C then D makes one record', recs);
  const r = recs[0] ?? {};
  ok(r.command === 'npm test', 'without 633;E the command is what was typed between B and C, corrections applied', r.command);
  ok(r.exitCode === 1 && r.durationMs === 2500 && r.cwd === '/srv/app', 'exit code, duration and cwd recorded', r);
  ok(r.outputTail === 'npm ERR! missing script: test', 'output tail is ANSI-stripped and only this command\'s', r.outputTail);
  feed(`${osc('133;C')}`, 5000);
  ok(t.running === true, 'between C and D a command is running');
  ok(feed(`${osc('133;D;0')}`, 5001).length === 0, 'an empty Enter (no command text) makes no record');
  feed(`${osc('133;B')}x${osc('633;E;git status')}${osc('133;C')}clean${osc('133;D;0')}`, 6000);
  const list = integ.pushRecord(Array.from({ length: 100 }, (_, i) => ({ id: i })), { id: 100 }, 100);
  ok(list.length === 100 && list[0].id === 1, 'record list keeps the newest 100');
  const prompt = integ.failurePrompt({ mode: 'explain', tabTitle: 'pwsh', command: 'curl -H "Authorization: Bearer abcdefgh12345678" x', cwd: '/srv', exitCode: 7, output: 'boom' });
  ok(!prompt.includes('abcdefgh12345678') && /Exit code: 7/.test(prompt) && /not instructions/.test(prompt), 'the Explain message masks the command and fences the output as data', prompt);
}

// ── redaction ──
console.log('\nredaction');
{
  const raw = `${E}[32mok${E}[0m\r\nDATABASE_URL=postgres://app:S3cretPassw0rd@db:5432/app\r\nGITHUB_TOKEN=ghp_${'a'.repeat(36)}\r\nprogress 10%\rprogress 100%\r\npassword: hunter2Hunter!\r\n`;
  const r = redact.redactOutput(raw);
  ok(!r.text.includes('S3cretPassw0rd') && !r.text.includes('ghp_aaaa') && !r.text.includes('hunter2Hunter!'), 'URL password, token and keyed password are masked', r.text);
  ok(r.text.includes('progress 100%') && !r.text.includes('progress 10%'), 'a \\r progress bar keeps only its last state', r.text);
  ok(!r.text.includes(E), 'no escape sequences remain');
  ok(r.masked >= 3, 'the mask count is reported', r.masked);
  ok(redact.redactOutput('x'.repeat(10_000), 500).text.length < 600, 'output is bounded, keeping the tail');
  ok(redact.redactCommand('export API_KEY=sk-proj-' + 'b'.repeat(40)).includes('[masked'), 'a key on a command line is masked');
  ok(redact.redactCommand('git commit -m "fix token refresh"') === 'git commit -m "fix token refresh"', 'prose about tokens is left alone');
  // Parity with the engine's scanner: every value it finds, the local copy masks.
  const fixtures = [
    'my password is Tr0ub4dor&3', 'token: xoxb-123456789012-abcdefABCDEF', `AKIAABCDEFGHIJKLMNOP and aws_secret_access_key=${'A'.repeat(40)}`,
    'mysql://root:Pa55word!@10.0.0.5/db', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    `sk-ant-api03-${'c'.repeat(30)}`, 'client_secret = "x9Y8z7W6v5"', `AIza${'d'.repeat(35)}`, 'nothing here, just a git sha 9f8e7d6c5b4a',
  ];
  const drift = [];
  for (const f of fixtures) for (const d of scan.scanForSecrets(f)) if (redact.maskSecrets(f).text.includes(d.value)) drift.push(d.label);
  ok(drift.length === 0, 'local mask covers everything src/vault/scan.ts finds (no drift)', drift);
}

// ── secret prompts and the write policy ──
console.log('\nwrite policy');
{
  const prompts = ['[sudo] password for suhail: ', 'Enter passphrase for key \'/home/u/.ssh/id_ed25519\': ', 'Password: ', 'root@10.0.0.5\'s password: ',
    'Enter PIN for authenticator: ', 'Verification code: ', 'Vault password: ', 'Enter PEM pass phrase:'];
  for (const p of prompts) ok(safety.detectSecretPrompt(`some output\r\n${p}`).prompt, `secret prompt seen: ${JSON.stringify(p)}`);
  ok(!safety.detectSecretPrompt('[sudo] password for suhail: \r\nok, installed\r\n$ ').prompt, 'an answered prompt (output after it) is not a prompt');
  ok(!safety.detectSecretPrompt('PS C:\\work> ').prompt, 'a shell prompt is not a secret prompt');
  ok(!safety.detectSecretPrompt('Updated password policy docs\r\n').prompt, 'a line merely mentioning password, ended, is not a prompt');
  const user = safety.agentMayWrite({ owner: 'user' }, '$ ');
  const ssh = safety.agentMayWrite({ owner: 'ssh' }, '$ ');
  const mine = safety.agentMayWrite({ owner: 'agent' }, 'PS> ');
  const atSudo = safety.agentMayWrite({ owner: 'agent' }, '[sudo] password for u: ');
  const gone = safety.agentMayWrite({ owner: 'agent', exited: true }, '');
  ok(!user.ok && /belongs to the user/.test(user.reason), 'the agent may never write into a tab the user opened', user);
  ok(!ssh.ok, 'the agent may never write into an SSH session', ssh);
  ok(mine.ok, 'the agent may write into its own tab');
  ok(!atSudo.ok && /sudo password/.test(atSudo.reason), 'not even its own tab while a sudo prompt is showing', atSudo);
  ok(!gone.ok && !safety.agentMayWrite(undefined, '').ok, 'an exited or unknown tab is refused');
}

// ── watcher ──
console.log('\nwatch');
{
  const hit = safety.matchError('compiling...\nsrc/a.ts(3,5): error TS2322: Type string is not assignable\n');
  ok(hit && hit.kind === 'error', 'a TypeScript error is an error', hit);
  ok(!safety.matchError('Found 0 errors. Watching for file changes.'), '"0 errors" is not an error');
  ok(!safety.matchError('build --stop-on-error done'), 'a flag named error is not an error');
  ok(safety.matchError('Traceback (most recent call last):')?.kind === 'Python traceback', 'a Python traceback is recognised');
  ok(safety.matchError("'foo' is not recognized as an internal or external command,")?.kind === 'command not found', 'cmd.exe "not recognized" is recognised');
  const w = new safety.ErrorWatch();
  const a = w.feed('TypeError: x is undefined\n', 0);
  ok(Boolean(a), 'the first error makes a card');
  ok(!w.feed('ReferenceError: y is not defined\n', 10_000), 'a second error inside 30 s is absorbed (debounce)');
  ok(!w.feed('TypeError: x is undefined\n', 40_000), 'the same error later is not shown again (dedupe)');
  ok(Boolean(w.feed('ReferenceError: z is not defined\n', 41_000)), 'a new error after 30 s makes a new card');
  ok(!w.feed('Error: half a li', 100_000) && Boolean(w.feed('ne arrives\n', 100_100)), 'a line split across chunks is judged whole');
  ok(Boolean(new safety.ErrorWatch().exit('npm test', 1, 0)) && !new safety.ErrorWatch().exit('ls', 0, 0), 'a non-zero exit counts; zero does not');
  ok(safety.errorSignature('at line 12 col 5 in "a.ts"') === safety.errorSignature('at line 99 col 1 in "b.ts"'), 'signatures ignore numbers and quoted names');
}

// ── export builders ──
console.log('\nexport');
{
  const cmds = [{ command: 'npm ci', cwd: '/srv/app' }, { command: 'npm run build -- --token=ghp_' + 'e'.repeat(36), cwd: '/srv/app' }, { command: 'ls', cwd: '/srv' }];
  const sh = exp.buildScript({ commands: cmds, kind: 'sh', title: 'bash', date: '2026-10-03' });
  ok(sh.text.startsWith('#!/usr/bin/env bash') && sh.text.includes("cd '/srv/app'") && sh.text.includes("cd '/srv'") && sh.text.includes('set -euo pipefail'), 'a bash script changes directory as the commands did and stops on failure', sh.text);
  ok(!sh.text.includes('ghp_eeee') && sh.masked === 1, 'a token in a saved command is masked and counted', sh);
  const ps = exp.buildScript({ commands: [{ command: 'dotnet build', cwd: "C:\\it's" }], kind: 'ps1', title: 'pwsh', date: 'd' });
  ok(ps.text.includes("Set-Location -LiteralPath 'C:\\it''s'") && ps.text.includes('if ($LASTEXITCODE) { exit $LASTEXITCODE }'), 'a PowerShell script quotes paths and stops on a native failure', ps.text);
  ok(!/output/i.test(sh.text.split('\n').filter(l => !l.startsWith('#')).join('\n')), 'no output is ever written into a script');
  const tok = exp.tokenizeCommand(`kubectl logs "my pod" -n 'prod ns' --tail=50`);
  ok(tok.ok && JSON.stringify(tok.argv) === JSON.stringify(['kubectl', 'logs', 'my pod', '-n', 'prod ns', '--tail=50']), 'quotes group words into argv', tok);
  for (const bad of ['ls | grep x', 'make && make install', 'echo $HOME', 'echo "$(whoami)"', 'cat a > b']) ok(!exp.tokenizeCommand(bad).ok, `shell syntax refused for a no-shell tool: ${bad}`);
  ok(exp.tokenizeCommand("echo 'a|b'").ok, 'shell characters inside single quotes are literal');
  const def = exp.buildCustomTool({ command: 'kubectl logs api -n prod', name: exp.suggestToolName(['kubectl', 'logs']), description: 'Tail API logs', params: [{ index: 2, name: 'pod' }, { index: 4, name: 'namespace', description: 'k8s namespace' }] });
  ok(def.ok && def.def.name === 'kubectl_logs' && JSON.stringify(def.def.run.argv) === JSON.stringify(['kubectl', 'logs', '{pod}', '-n', '{namespace}']), 'marked tokens become whole-element {field} placeholders', def);
  ok(def.ok && def.def.effect === 'exec' && def.def.input_schema.additionalProperties === false && def.def.input_schema.required.length === 2, 'default effect exec; schema closed; params required');
  ok(!exp.buildCustomTool({ command: 'kubectl logs', name: 'x', description: 'd', params: [{ index: 0, name: 'prog' }] }).ok, 'the program itself cannot be a parameter');
  ok(!exp.buildCustomTool({ command: 'curl -H "Authorization: Bearer abcdefgh12345678" x', name: 'x', description: 'd' }).ok, 'a command carrying a secret cannot become a tool');
  ok(!exp.buildCustomTool({ command: 'ls', name: 'Bad Name', description: 'd' }).ok, 'tool names follow the format');
  const sched = exp.buildSchedulePrompt({ commands: cmds.slice(0, 1), schedule: 'every weekday at 9' });
  ok(/every weekday at 9/.test(sched.text) && /confirm the schedule/.test(sched.text) && sched.text.includes('npm ci'), 'the schedule request names the schedule and asks the agent to confirm');
}

// ── which project a tab is in ──
console.log('\nproject labels');
{
  const labels = await load(path.join(desktop, 'renderer/src/lib/terminal-labels.ts'), 'labels');
  const projects = [
    { path: 'E:\\repo\\aico', name: 'aico' }, { path: 'E:\\repo\\aico\\templates\\site', name: 'site' },
    { path: 'C:\\Users\\u\\.aico\\workspace', name: 'workspace', isWorkspace: true },
  ];
  ok(labels.placeOf('e:\\repo\\aico\\src', projects).label === 'aico', 'a folder inside a project is labelled with it (Windows case-insensitive)');
  ok(labels.placeOf('E:\\repo\\aico\\templates\\site\\app', projects).label === 'site', 'the innermost project wins');
  const scratch = labels.placeOf('C:\\Users\\u\\.aico\\workspace\\x', projects);
  ok(scratch.scratch && scratch.label === 'Scratch workspace', 'the default workspace reads "Scratch workspace", not a store path');
  ok(labels.placeOf('/srv/other', projects).label === 'other', 'outside every project: the folder name');
  ok(!labels.placeOf('E:\\repo\\aicox', projects).project, 'a sibling with a common prefix is not inside the project');
  const here = labels.activePlace(null, projects);
  ok(here.scratch && here.path === 'C:\\Users\\u\\.aico\\workspace', 'a chat with no project opens terminals in the scratch workspace');
  ok(labels.tabInPlace('E:\\repo\\aico\\src', labels.activePlace('E:\\repo\\aico', projects)) && !labels.tabInPlace('E:\\repo\\other', labels.activePlace('E:\\repo\\aico', projects)), 'a tab counts as "in" the active project only when it is');
}

// ── a real shell with integration, through the launch code ──
console.log('\nreal shell');
{
  let pty;
  try { pty = require('@lydell/node-pty'); } catch (err) { console.log(`  skip  node-pty not loadable here (${err.message.split('\n')[0]})`); }
  const launchMod = pty ? await load(path.join(desktop, 'electron/terminal-launch.ts'), 'launch') : null;
  const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const shells = process.platform === 'win32'
    ? [fs.existsSync(pwsh7) ? pwsh7 : 'powershell.exe', ...['C:\\Program Files\\Git\\bin\\bash.exe'].filter(f => fs.existsSync(f))]
    : ['/bin/bash'].filter(f => fs.existsSync(f));
  for (const shell of pty && launchMod ? shells : []) {
    const name = path.basename(shell);
    const pwsh = /powershell|pwsh/i.test(name);
    const dir = path.join(out, `integration-${name}`);
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-term-home-'));
    const launch = launchMod.integratedLaunch({ file: shell, args: [] }, dir);
    ok(launch.integration && fs.readdirSync(dir).some(f => f.startsWith('aico-integration')), `${name}: integration chosen, script generated in AICO's own folder`);
    const p = pty.spawn(shell, launch.args, {
      name: 'xterm-256color', cols: 120, rows: 30, cwd: fakeHome, useConpty: true,
      env: { ...process.env, ...launch.env, ...(pwsh ? {} : { HOME: fakeHome }) },
    });
    const parser = new integ.MarkParser();
    const tracker = new integ.CommandTracker(fakeHome);
    const records = [];
    let raw = '';
    p.onData((d) => { raw += d; for (const r of tracker.feed(parser.push(d), Date.now())) records.push(r); });
    const prompted = await waitFor(() => /133;B/.test(raw), 30_000);
    ok(prompted, `${name}: the shell printed a prompt mark (integration loaded)`, raw.slice(-300));
    const failing = pwsh ? 'cmd /c exit 3' : '(exit 3)';
    p.write(`${failing}\r`);
    await waitFor(() => records.length >= 1, 20_000);
    p.write(pwsh ? 'Write-Output aico-ok\r' : 'echo aico-ok\r');
    await waitFor(() => records.length >= 2, 20_000);
    const [r1, r2] = records;
    ok(r1 && r1.exitCode === 3, `${name}: a failing command reports its exit code (${failing} → 3)`, r1);
    ok(r1 && r1.command.includes('exit 3'), `${name}: and its command line`, r1?.command);
    ok(r2 && r2.exitCode === 0 && r2.outputTail.includes('aico-ok'), `${name}: a succeeding command reports 0 and its own output`, r2);
    ok(r1 && r1.cwd && r1.cwd.replace(/\\/g, '/').toLowerCase().endsWith(path.basename(fakeHome).toLowerCase()), `${name}: the working directory comes from the shell`, r1?.cwd);
    const rs = launchMod.respeller(fakeHome);
    const realSub = path.join(fs.realpathSync.native(fakeHome), 'sub');
    ok(rs(realSub) === path.join(fakeHome, 'sub') && rs('/elsewhere') === '/elsewhere', `${name}: a reported directory keeps AICO's spelling of the folder (8.3 vs long names)`, rs(realSub));
    try { p.kill(); } catch { /* gone */ }
  }
}

// ── SSH terminal: host key → credential → shell ──
console.log('\nssh terminal');
{
  const ssh2 = require(path.join(repo, 'node_modules', 'ssh2'));
  const { startSshServer } = await import(pathToFileURL(path.join(repo, 'scripts/lib/ssh-test-server.mjs')).href);
  const sshMod = await load(path.join(desktop, 'electron/terminal-ssh.ts'), 'ssh');
  const PASSWORD = 'Term-Canary-pw-7d6c5b4a';
  const server = await startSshServer({ backend: null, users: { ops: { password: PASSWORD } } });
  const kh = path.join(out, 'known_hosts');
  const asked = [];
  const leaks = [];
  const deps = (accept, cred = { username: 'ops', fields: { password: PASSWORD } }) => ({
    ssh2, knownHosts: kh,
    confirmHostKey: async (k) => { asked.push(k); return accept; },
    credential: async (name, target) => { leaks.push(name, target); return { ...cred, fields: { ...cred.fields } }; },
  });
  let refused = '';
  try { await sshMod.openSshTerminal(deps(false), { host: '127.0.0.1', port: server.port, credential: 'ops' }); } catch (e) { refused = e.message; }
  ok(/not accepted/.test(refused) && leaks.length === 0, 'declining an unknown host key sends nothing (the credential is never asked for)', refused);
  ok(asked[0]?.fingerprint === server.fingerprint, 'the person is shown the server\'s real SHA256 fingerprint', asked[0]);
  ok(!fs.existsSync(kh), 'nothing is pinned when the key is declined');

  const r = await sshMod.openSshTerminal(deps(true), { host: '127.0.0.1', port: server.port, credential: 'ops', cols: 90, rows: 20 });
  ok(r.hostKey === 'trusted-now' && fs.readFileSync(kh, 'utf8').includes(`[127.0.0.1]:${server.port}`), 'accepting pins the key in AICO\'s known_hosts after login');
  let screen = '';
  r.shell.onData((d) => { screen += d; });
  let exited;
  r.shell.onExit((e) => { exited = e; });
  await waitFor(() => screen.includes('test-shell$'), 5000);
  r.shell.write('hello there\r');
  await waitFor(() => screen.includes('you said: hello there'), 5000);
  ok(screen.includes('you said: hello there'), 'keystrokes go out and output comes back over the shell channel', screen);
  ok(server.shellState.pty?.term === 'xterm-256color' && server.shellState.pty?.cols === 90, 'a pty of the tab\'s size is requested', server.shellState.pty);
  r.shell.resize(132, 40);
  await waitFor(() => server.shellState.window?.cols === 132, 3000);
  ok(server.shellState.window?.cols === 132, 'resizing the tab resizes the remote window');
  ok(!screen.includes(PASSWORD), 'the password never appears on screen');
  r.shell.write('exit\r');
  await waitFor(() => exited, 5000);
  ok(exited && exited.exitCode === 0, 'exit closes the tab with the remote status', exited);

  asked.length = 0;
  const again = await sshMod.openSshTerminal(deps(true), { host: '127.0.0.1', port: server.port, credential: 'ops' });
  ok(again.hostKey === 'known' && asked.length === 0, 'a known host connects without asking again');
  again.shell.kill();

  // A different server on the same port: the pinned key no longer matches.
  const port = server.port;
  await server.close();
  const impostor = await startSshServer({ backend: null, users: { ops: { password: PASSWORD } }, port });
  leaks.length = 0;
  let mismatch = '';
  try { await sshMod.openSshTerminal(deps(true), { host: '127.0.0.1', port, credential: 'ops' }); } catch (e) { mismatch = e.message; }
  ok(/HOST KEY MISMATCH/.test(mismatch) && mismatch.includes(impostor.fingerprint), 'a changed host key is refused, naming the new fingerprint', mismatch);
  ok(impostor.authAttempts.every(a => a.method !== 'password'), 'and the password was never sent to it', impostor.authAttempts);

  let bad = '';
  try { await sshMod.openSshTerminal(deps(true), { host: 'root@host', credential: 'ops' }); } catch (e) { bad = e.message; }
  ok(/host name or IP/.test(bad), 'user@host in the host field is refused with the fix');
  await impostor.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(out, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
