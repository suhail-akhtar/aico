/**
 * The clean-room wall (ADR 0041): the implementer cannot reach the corpus.
 *
 * Proven here, against real files, a real child process and the real agent
 * loop with a scripted model: only the file tools and CloneRun are offered; a
 * path outside the workspace is refused for reads and a path outside clone/ for
 * writes (symlinks included); the clone's own code runs under Node's permission
 * model, so a script that tries to read the corpus or spawn a process is
 * denied by the runtime; the full `implement` flow ends with a clone that the
 * twin-test finds identical to the recorded behaviour. No model, no network,
 * no spend.
 */
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../dist-test/test-exports.js';

const C = T.cleanroom;
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log(`  ok    ${m}`); } else { fail++; console.log(`  FAIL  ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 500)); } };
const section = (t) => console.log(`\n── ${t} ──`);
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `cleanroom-${n}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left behind */ } };

const spec = {
  version: 1, id: 'wall', kind: 'cli', createdAt: '2026-10-10T00:00:00Z', unknowns: [],
  coverage: { steps: 1, states: 1, transitions: 1, note: 'test' },
  cli: { name: 'greeter', commands: [{ path: [], usage: 'Usage: greeter <command>', summary: 'Greets people.', flags: [] }], cases: [{ args: ['greet', 'Ana'], stdout: 'Hello, Ana!\n', stderr: '', exitCode: 0 }] },
};

section('who is a workspace');
const base = tmp('wall');
const ws = path.join(base, 'ws');
C.prepareWorkspace(spec, ws);
const outside = path.join(base, 'corpus');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'observer-only');
ok(C.isWorkspace(ws) && !C.isWorkspace(base), 'a prepared folder carries the marker, its parent does not');
ok(C.assertSpecOnly(ws).ok, 'the marker is part of the spec-only layout');

section('the guard: tools and paths');
const r = (name, args) => C.wallRefusal(ws, name, args, ws);
ok(/not available here/.test(r('Bash', { command: 'ls' })) && /not available/.test(r('WebFetch', { url: 'http://x' })) && /not available/.test(r('Task', {})), 'a shell, the web and delegation are refused by name');
ok(r('Read', { file_path: path.join(ws, 'spec', 'SPEC.md') }) === undefined && r('Glob', { pattern: '**/*' }) === undefined && r('LS', {}) === undefined, 'reading the workspace is allowed');
ok(/outside/.test(r('Read', { file_path: path.join(outside, 'secret.txt') })) && /outside/.test(r('Read', { file_path: '../corpus/secret.txt' })), 'reading outside the workspace is refused, absolute or relative');
ok(/outside/.test(r('Grep', { pattern: 'x', path: outside })) && /outside/.test(r('LS', { path: base })), 'searching and listing outside is refused');
ok(/stays inside/.test(r('Glob', { pattern: '../**/*' })) && /stays inside/.test(r('Glob', { pattern: path.join(outside, '*') })), 'a Glob pattern cannot climb out');
ok(r('Write', { file_path: path.join(ws, 'clone', 'a.mjs'), content: 'x' }) === undefined && r('Edit', { file_path: 'clone/b.mjs' }) === undefined, 'writing inside clone/ is allowed');
ok(/clone\//.test(r('Write', { file_path: path.join(ws, 'spec', 'SPEC.md'), content: 'x' })) && /clone\//.test(r('Edit', { file_path: path.join(ws, 'BRIEF.md') })), 'spec/ and the brief are read-only');
ok(/clone\//.test(r('Write', { file_path: path.join(outside, 'x.txt'), content: 'x' })) && /needs "file_path"/.test(r('Write', {})), 'writing outside, or without a path, is refused');
const link = path.join(ws, 'clone', 'out');
let linked = false;
try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* no symlink right on this machine */ }
if (linked) ok(/outside/.test(r('Read', { file_path: path.join(link, 'secret.txt') })) && /clone\//.test(r('Write', { file_path: path.join(link, 'x.txt'), content: 'x' })), 'a link inside the workspace that leads out is not a way out');
else console.log('  SKIP  could not create a symlink here');
if (linked) fs.rmSync(link, { recursive: true, force: true });
ok(C.permissionFlags(ws, '22.21.0')[0] === '--permission' && C.permissionFlags(ws, '20.11.0')[0] === '--experimental-permission' && C.permissionFlags(ws, '18.0.0') === undefined, 'the permission flag follows the Node version, and an old Node is refused');

section('CloneRun: the clone runs confined');
const inWs = (fn) => T.runInContext({ cwd: ws, sessionId: 'wall' }, fn);
fs.writeFileSync(path.join(ws, 'clone', 'hello.mjs'), "console.log('hello ' + process.argv.slice(2).join(',') + ' ' + (process.env.SECRET ?? 'no-secret')); process.stdin.on('data', d => console.log('in:' + d));");
fs.writeFileSync(path.join(ws, 'clone', 'peek.mjs'), `import fs from 'node:fs'; try { console.log(fs.readFileSync(${JSON.stringify(path.join(outside, 'secret.txt'))}, 'utf8')); } catch (e) { console.log('denied:' + e.code); }`);
fs.writeFileSync(path.join(ws, 'clone', 'spawn.mjs'), "import cp from 'node:child_process'; try { cp.execSync('echo hi'); console.log('spawned'); } catch (e) { console.log('denied:' + e.code); }");
fs.writeFileSync(path.join(ws, 'clone', 'server.mjs'), "import http from 'node:http'; http.createServer((q, s) => { if (q.url === '/api') { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ ok: true })); } else s.end('page'); }).listen(Number(process.env.PORT), '127.0.0.1');");
fs.writeFileSync(path.join(ws, 'clone', 'hang.mjs'), 'setInterval(() => {}, 1000);');
process.env.SECRET = 'parent-secret';
let out = await inWs(() => T.executeTool('CloneRun', { file: 'hello.mjs', args: ['a', 'b'], stdin: 'x' }));
ok(/exit 0/.test(out) && /hello a,b no-secret/.test(out) && /in:x/.test(out), 'a command clone runs with its args and stdin, and the parent environment is not inherited', out);
out = await inWs(() => T.executeTool('CloneRun', { file: 'peek.mjs' }));
ok(/denied:ERR_ACCESS_DENIED/.test(out) && !/observer-only/.test(out), 'clone code that reads outside clone/ is denied by the runtime', out);
out = await inWs(() => T.executeTool('CloneRun', { file: 'spawn.mjs' }));
ok(/denied:ERR_ACCESS_DENIED/.test(out) && !/spawned/.test(out), 'clone code cannot start a process', out);
out = await inWs(() => T.executeTool('CloneRun', { file: 'server.mjs', requests: [{ path: '/' }, { path: '/api' }, { method: 'POST', path: '/nope' }] }));
ok(/GET \/ -> 200/.test(out) && /GET \/api -> 200 \(content-type: application\/json\)/.test(out) && /"ok":true/.test(out) && /POST \/nope -> 200/.test(out), 'a server clone is started, exercised over HTTP and stopped', out);
out = await inWs(() => T.executeTool('CloneRun', { file: 'hang.mjs', timeoutSec: 1 }));
ok(/stopped: no exit within 1s/.test(out), 'a clone that never exits is stopped at the timeout', out);
out = await inWs(() => T.executeTool('CloneRun', { file: '../spec/spec.json' }));
ok(/not inside clone\//.test(out), 'only scripts in clone/ can be run', out);
out = await inWs(() => T.executeTool('CloneRun', { file: 'missing.mjs' }));
ok(/does not exist yet/.test(out), 'a missing script says so', out);
out = await T.runInContext({ cwd: base, sessionId: 'x' }, () => T.executeTool('CloneRun', { file: 'hello.mjs' }));
ok(/only inside a clean-room workspace/.test(out), 'outside a workspace CloneRun refuses', out);
delete process.env.SECRET;

section('the whole implement flow, with a scripted model');
// A model that tries to cheat first (a shell, a read of the corpus), then does the job.
const cliSource = `
const [,, ...args] = process.argv;
if (args[0] === 'greet') { if (!args[1]) { console.error('error: missing <name>'); process.exit(2); } console.log('Hello, ' + args[1] + '!'); process.exit(0); }
console.log('Usage: greeter <command>'); process.exit(0);
`;
function scripted(steps) {
  let i = 0;
  return {
    id: 'mock', displayName: 'Mock', toolNames: [], requests: [],
    async *chat(opts) {
      this.toolNames.push((opts.tools ?? []).map(t => t.name));
      this.requests.push(JSON.stringify(opts.messages));
      const step = steps[Math.min(i++, steps.length - 1)];
      for (const ev of step) yield ev;
    },
  };
}
const usage = { inputTokens: 100, outputTokens: 10 };
const call = (id, name, input) => [{ type: 'tool_call', id, name, input }, { type: 'usage', ...usage }, { type: 'finish', reason: 'tool_calls' }];
const say = (text) => [{ type: 'text', content: text }, { type: 'usage', ...usage }, { type: 'finish', reason: 'stop' }];
const ws2 = path.join(tmp('impl'), 'w');
const provider = scripted([
  call('c1', 'Bash', { command: `cat ${path.join(outside, 'secret.txt')}` }),
  call('c2', 'Read', { file_path: path.join(outside, 'secret.txt') }),
  call('c3', 'Write', { file_path: path.join(ws2, 'clone', 'cli.mjs'), content: cliSource }),
  call('c5', 'CloneRun', { mode: 'run', file: 'cli.mjs', args: ['greet', 'Ana'] }),
  say('Built clone/cli.mjs and ran it: greet works, usage prints. Not verified: error cases beyond a missing name.'),
]);
const res = await C.implementClone(spec, ws2, { model: 'mock', budgetUsd: 1, maxMinutes: 2, settings: { completionGate: { enabled: false, security: false }, cron: { enabled: false } }, provider });
const offered = provider.toolNames[0];
ok(!offered.includes('Bash') && !offered.includes('WebFetch') && !offered.includes('Task') && offered.includes('Read') && offered.includes('Write'), 'the model is offered the file tools and nothing that reaches out', offered);
ok(res.check.ok && /Built clone\/cli.mjs/.test(res.text), 'the run completes and says what it verified', res.text);
ok(fs.existsSync(path.join(ws2, 'clone', 'cli.mjs')), 'the clone was written inside clone/');
ok(!/observer-only/.test(fs.readFileSync(path.join(ws2, 'clone', 'cli.mjs'), 'utf8')), 'nothing from the corpus ended up in the clone');
// What the model was told after trying to cheat: the shell does not exist, and the read outside was refused by the wall.
const afterCheat = provider.requests[2] ?? '';
ok(/outside it|outside this workspace|may only look inside/.test(afterCheat) && !/observer-only/.test(afterCheat), 'the read of the corpus was refused with a reason, and its content never reached the model', afterCheat.slice(-300));
const twin = await C.twinTest({
  journey: { id: 'wall', target: { kind: 'cli', command: process.execPath, args: [path.join(ws2, 'clone', 'cli.mjs')] }, steps: [
    { seq: 1, from: 'start', to: 'a', stimulus: { type: 'run', args: ['greet', 'Ana'] }, observation: { at: 'x', kind: 'cli', stdout: 'Hello, Ana!\n', stderr: '', exitCode: 0 } },
    { seq: 2, from: 'a', to: 'b', stimulus: { type: 'run', args: ['greet'] }, observation: { at: 'x', kind: 'cli', stdout: '', stderr: 'error: missing <name>\n', exitCode: 2 } },
  ] },
  clone: { kind: 'cli', command: process.execPath, args: [path.join(ws2, 'clone', 'cli.mjs')] },
});
ok(twin.parity === 1, 'the clone the scripted model built matches the recorded behaviour', C.renderTwinReport(twin));
rm(base);

console.log(`\ncleanroom wall: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
