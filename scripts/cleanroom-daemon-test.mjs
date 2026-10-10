/**
 * Daemon and IPC reconstruction (ADR 0041): a real background process, driven
 * over TCP and a local IPC channel, with signals and a watched folder.
 *
 * The target is a Node daemon written for this test: it listens on a TCP port
 * it chooses and on a Unix-domain socket (a named pipe on Windows), answers a
 * few verbs, reloads on SIGHUP, shuts down on SIGTERM, and reacts to files
 * appearing in a folder it watches. Proven: the sandbox waits for readiness
 * from its output, talks on both channels, records replies and closes, delivers
 * signals (and says plainly when the platform cannot), sees file-watcher
 * reactions; the spec describes all of it; and the twin-test passes an identical
 * clone and catches a wrong one. No model, no network beyond loopback.
 */
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../dist-test/test-exports.js';

const C = T.cleanroom;
const WIN = process.platform === 'win32';
let passed = 0, failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log(`  ok    ${m}`); } else { failed++; console.log(`  FAIL  ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 600)); } };
const section = (t) => console.log(`\n── ${t} ──`);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-daemon-'));

const source = (variant) => `
import net from 'node:net';
import fs from 'node:fs';
const watch = process.env.WATCH_DIR;
const ipcPath = process.env.IPC_PATH;
const handle = (sock) => sock.on('data', (d) => {
  const line = String(d).trim();
  const [cmd, ...rest] = line.split(' ');
  if (cmd === 'PING') sock.write('${variant === 'wrong' ? 'pong' : 'PONG'}\\n');
  else if (cmd === 'ECHO') sock.write(rest.join(' ') + '\\n');
  else if (cmd === 'HELP' || cmd === 'help') sock.write('commands: PING ECHO HELP QUIT\\n');
  else if (cmd === 'QUIT') sock.end('bye\\n');
  else if (line === '') { /* a bare newline: no reply */ }
  else sock.write('ERR unknown command\\n');
});
const tcp = net.createServer(handle);
const ipc = net.createServer(handle);
await new Promise(r => tcp.listen(0, '127.0.0.1', r));
await new Promise(r => ipc.listen(ipcPath, r));
if (watch) { let t; fs.watch(watch, () => { clearTimeout(t); t = setTimeout(() => console.log('saw a change in the watched folder'), 150); }); }
process.on('SIGHUP', () => console.log('${variant === 'wrong' ? 'reloading' : 'reloaded config'}'));
process.on('SIGTERM', () => { console.log('shutting down'); process.exit(0); });
console.log('ready on ' + tcp.address().port);
`;
const write = (name, variant) => { const f = path.join(base, name); fs.writeFileSync(f, source(variant)); return f; };
const watchDir = path.join(base, 'watched');
fs.mkdirSync(watchDir);
const ipcPath = WIN ? `\\\\.\\pipe\\cleanroom-test-${process.pid}` : path.join(base, 'daemon.sock');
const launch = (file, extra = {}) => ({ kind: 'daemon', command: process.execPath, args: [file], env: { WATCH_DIR: watchDir, IPC_PATH: ipcPath }, ready: { logMatch: 'ready on (\\d+)' }, ipc: [ipcPath], watchDirs: [watchDir], name: 'echo-daemon', ...extra });
const target = write('target.mjs', 'target');

section('the sandbox: ready, channels, replies');
let sb = new C.DaemonSandbox();
await sb.start(launch(target));
await sb.inject({ type: 'wait', ms: 0 });
let o = await sb.observe();
ok(o.daemon.alive && o.daemon.port > 0 && /ready on \d+/.test(o.daemon.newStdout), 'it waits for the ready line, the port is read from it, and the first observation carries what it said while starting', o.daemon);
await sb.inject({ type: 'send', channel: 'tcp', data: 'PING\\n' });
o = await sb.observe();
ok(o.daemon.reply === 'PONG\n' && !o.daemon.closed, 'a verb sent over TCP gets its reply', o.daemon);
await sb.inject({ type: 'send', channel: `${WIN ? 'pipe' : 'socket'}:${ipcPath}`, data: 'ECHO hello there\\n' });
o = await sb.observe();
ok(o.daemon.reply === 'hello there\n', 'the same daemon answers on its local IPC channel (a Unix socket, or a named pipe on Windows)', o.daemon);
await sb.inject({ type: 'send', channel: 'tcp', data: 'QUIT\\n' });
ok((await sb.observe()).daemon.reply === 'bye\n' && (await sb.observe()).daemon.closed === true, 'a connection the daemon closes is recorded as closed');
await sb.inject({ type: 'send', channel: 'tcp', data: 'nonsense\\n' });
ok((await sb.observe()).daemon.reply === 'ERR unknown command\n', 'an unknown command shows the error contract');
await sb.inject({ type: 'send', channel: 'tcp:127.0.0.1:1', data: 'x' });
ok(!!(await sb.observe()).daemon.connectError, 'a channel that is not there is a recorded connection error, not a crash');
await sb.inject({ type: 'fs-write', path: path.join(watchDir, 'a.txt'), content: 'one' });
o = await sb.observe();
ok(o.daemon.fsChanges.some(c => c.path === 'a.txt' && c.kind === 'added') && /saw a change/.test(o.daemon.newStdout), 'a file written into a watched folder shows on disk and in what the daemon printed', o.daemon);
await sb.inject({ type: 'fs-delete', path: path.join(watchDir, 'a.txt') });
ok((await sb.observe()).daemon.fsChanges.some(c => c.kind === 'removed'), 'a removal is seen');
await sb.inject({ type: 'signal', signal: 'SIGHUP' });
o = await sb.observe();
if (WIN) ok(o.daemon.signalDelivery === 'forced' && !o.daemon.alive, 'on Windows a signal ends the process outright, and the observation says forced', o.daemon);
else ok(o.daemon.alive && /reloaded config/.test(o.daemon.newStdout) && o.daemon.signalDelivery === 'signal', 'SIGHUP is delivered: it reloads and keeps running', o.daemon);
if (!WIN) { await sb.inject({ type: 'signal', signal: 'SIGTERM' }); o = await sb.observe(); ok(!o.daemon.alive && o.daemon.exitCode === 0 && /shutting down/.test(o.daemon.newStdout), 'SIGTERM is a graceful shutdown with its exit code and last words', o.daemon); }
await sb.stop();

let early = '';
try { await new C.DaemonSandbox().start({ kind: 'daemon', command: process.execPath, args: ['-e', "console.error('boom'); process.exit(3)"], ready: { logMatch: 'never' } }); } catch (e) { early = String(e.message); }
ok(/exited before it was ready \(code 3\)/.test(early) && /boom/.test(early), 'a daemon that dies while starting says so, with its last line', early);

section('explore, synthesize');
const j = await C.explore('daemon-target', launch(target), { maxSteps: 60 });
const spec = C.synthesize(j, undefined, C.readExplorerState('daemon-target'));
const D = spec.daemon;
const tcpEx = (s) => D.channels.find(c => c.channel === 'tcp').exchanges.find(x => x.send === s);
ok(j.steps[0].stimulus.type === 'wait' && D.startup.output.includes('ready on') && /matches \/ready on/.test(D.startup.readyBy), 'the spec records how it starts and what it said', D.startup);
ok(D.channels.length === 2 && tcpEx('PING\\n').reply === 'PONG\n' && tcpEx('HELP\\n').reply.includes('commands:') && tcpEx('zzz-unknown-command\\n').reply === 'ERR unknown command\n', 'both channels are described with what each probe got back', D.channels.map(c => c.channel));
ok(D.files.some(f => /write cleanroom-probe/.test(f.action) && /saw a change/.test(f.reaction)), 'a file-watcher reaction is in the spec', D.files);
ok(D.signals.some(s => s.signal === 'SIGTERM') && (WIN ? D.signals.every(s => s.delivery === 'forced') : D.signals.some(s => s.signal === 'SIGHUP' && !s.exited && /reloaded/.test(s.output)) && D.signals.some(s => s.signal === 'SIGTERM' && s.exited && s.exitCode === 0)), 'signals and their effects are in the spec', D.signals);
ok(spec.unknowns.some(u => /D-Bus/.test(u)) && spec.unknowns.some(u => /only the channels named/.test(u)) && (!WIN || spec.unknowns.some(u => /Windows/.test(u))), 'the spec says what it did not cover');
const ws = path.join(base, 'ws');
C.prepareWorkspace(spec, ws);
ok(C.assertSpecOnly(ws, C.corpusDir('daemon-target')).ok && /## Daemon/.test(fs.readFileSync(path.join(ws, 'spec', 'SPEC.md'), 'utf8')) && !fs.readFileSync(path.join(ws, 'spec', 'SPEC.md'), 'utf8').includes(target), 'the workspace is spec-only and the spec never names where the target lives');

section('twin-test a daemon clone');
const same = write('same.mjs', 'target');
const wrong = write('wrong.mjs', 'wrong');
const tSame = await C.twinTest({ journey: j, clone: launch(same) });
ok(tSame.parity === 1, 'an identical daemon matches on replies, closes, output, files and signals (ports scrubbed)', C.renderTwinReport(tSame));
const tWrong = await C.twinTest({ journey: j, clone: launch(wrong) });
ok(tWrong.parity < 1 && tWrong.differences.some(x => x.field === 'reply' && x.stimulus.data === 'PING\\n'), 'a daemon answering pong instead of PONG is caught on the reply', C.renderTwinReport(tWrong));
if (!WIN) ok(tWrong.differences.some(x => x.field === 'stdout' && x.stimulus.signal === 'SIGHUP'), 'and a different reload message is caught on the signal step');

try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
console.log(`\ncleanroom daemon: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
