/**
 * "Open in editor" and the web file viewer (src/server/editor, ADR 0030),
 * offline.
 *
 * What each block proves:
 *   - command lines: quoting, placeholders, each well-known editor's line
 *     syntax, a command with no {file} still gets the file;
 *   - finding the program: PATH (+ PATHEXT on Windows), an absolute path, a
 *     missing one says so — and with no editor the answer is "use the viewer";
 *   - the gate: launching needs a person — the token alone (a real
 *     DecisionGate with no UI key) is refused before anything else;
 *   - confinement: only files of registered projects, by real path —
 *     `..`, an absolute path elsewhere, a symlink out of the project, a
 *     directory, an unregistered project are all refused;
 *   - the launch itself, for real: a fake editor on a private PATH writes the
 *     arguments it received; on Windows through the `.cmd` launcher path
 *     (cmd.exe, every argument quoted), elsewhere with no shell; a path with a
 *     character cmd would interpret is refused, never passed;
 *   - the viewer: text of a project file; credentials-looking files, binary,
 *     oversized and outside files refused.
 *
 * Part of `npm test`. No model, no network, nothing outside temp folders.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(process.env.AICO_TEST_EXPORTS ?? path.join(here, '..', 'dist-test', 'test-exports.js')).href);
const E = T.editorServer;

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 800)}` : ''}`); }
}
async function block(name, fn) {
  console.log(`\n${name}`);
  try { await fn(); } catch (err) { failed++; failures.push(`${name}: threw`); console.log(`  FAIL  threw: ${err.stack ?? err}`); }
}
const WIN = process.platform === 'win32';
const world = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aico editor ')));   // a space on purpose
process.on('exit', () => { try { fs.rmSync(world, { recursive: true, force: true }); } catch { /* best effort */ } });
const project = path.join(world, 'my project');
const other = path.join(world, 'other');
fs.mkdirSync(path.join(project, 'src'), { recursive: true });
fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
fs.writeFileSync(path.join(project, '.env'), 'TOKEN=not-a-real-secret\n');
fs.writeFileSync(path.join(project, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
fs.writeFileSync(path.join(project, 'big.txt'), 'x'.repeat(E.VIEWER_MAX_BYTES + 10));
fs.writeFileSync(path.join(other, 'outside.ts'), 'OUTSIDE\n');
let linked = false;
try { fs.symlinkSync(path.join(other, 'outside.ts'), path.join(project, 'link.ts'), 'file'); linked = true; } catch { /* no symlink privilege (Windows without developer mode) */ }

// A fake editor that records its arguments, on a PATH of its own.
const bin = path.join(world, 'bin');
fs.mkdirSync(bin);
const record = path.join(world, 'args.txt');
if (WIN) {
  fs.writeFileSync(path.join(bin, 'code.cmd'), `@echo off\r\necho %*> "${record}"\r\n`);
} else {
  fs.writeFileSync(path.join(bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`, { mode: 0o755 });
}
const envWith = { ...process.env, PATH: bin, Path: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const envWithout = { ...process.env, PATH: path.join(world, 'empty'), Path: path.join(world, 'empty') };

const yes = async () => ({ ok: true });
const deps = (over = {}) => ({
  human: yes,
  isKnownProject: async (d) => path.resolve(d).toLowerCase() === project.toLowerCase(),
  projects: async () => [project],
  editorCommand: () => undefined,
  env: envWith,
  ...over,
});
const waitFor = async (file, ms = 8_000) => { const until = Date.now() + ms; while (Date.now() < until) { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return fs.readFileSync(file, 'utf8'); await new Promise(r => setTimeout(r, 50)); } return ''; };

await block('Command lines and placeholders', () => {
  assert(JSON.stringify(E.splitCommand('code -g {file}:{line}')) === JSON.stringify(['code', '-g', '{file}:{line}']), 'words');
  assert(JSON.stringify(E.splitCommand('"C:\\Program Files\\Ed\\ed.exe" --line {line} \'{file}\'')) === JSON.stringify(['C:\\Program Files\\Ed\\ed.exe', '--line', '{line}', '{file}']), 'quoted words keep their spaces');
  assert(E.defaultArgs('code').join(' ') === '-g {file}:{line}:{col}' && E.defaultArgs('cursor.cmd').join(' ') === '-g {file}:{line}:{col}', 'VS Code family: -g file:line:col');
  assert(E.defaultArgs('idea64.exe').join(' ') === '--line {line} {file}' && E.defaultArgs('subl').join(' ') === '{file}:{line}', 'JetBrains and Sublime syntax');
  const plan = E.planEditor(undefined, path.join(project, 'src', 'app.ts'), 2, 1, project, envWith);
  assert(!('error' in plan) && plan.label === 'VS Code' && plan.args.join(' ').endsWith(`app.ts:2:1`), 'no setting: VS Code from the PATH at file:line:col', plan);
  const custom = E.planEditor(`"${path.join(bin, WIN ? 'code.cmd' : 'code')}" --goto {file}#{line}`, '/p/f.ts', 7, 1, '/p', envWithout);
  assert(!('error' in custom) && custom.args.join(' ') === '--goto /p/f.ts#7', 'editor.command placeholders are filled', custom);
  const noFile = E.planEditor(`"${path.join(bin, WIN ? 'code.cmd' : 'code')}" --new-window`, '/p/f.ts', 1, 1, '/p', envWithout);
  assert(!('error' in noFile) && noFile.args.at(-1) === '/p/f.ts', 'a command with no {file} still gets the file');
  const none = E.planEditor(undefined, '/p/f.ts', 1, 1, '/p', envWithout);
  assert('error' in none && /not on the PATH/.test(none.error), 'no editor anywhere: an error the client turns into the viewer', none);
  const missing = E.planEditor('nonexistent-editor-xyz {file}', '/p/f.ts', 1, 1, '/p', envWith);
  assert('error' in missing && /not found/.test(missing.error), 'a configured editor that is not installed says so');
});

await block('Launching needs a person: the token alone is refused first', async () => {
  const gate = new T.DecisionGate();
  const human = () => gate.checkHuman({});
  let spawned = 0;
  const r = await E.handleEditorRoute('editor/open', 'POST', { path: project, file: 'src/app.ts' }, new URLSearchParams(), deps({ human, spawn: () => { spawned++; throw new Error('must not spawn'); } }));
  assert(r.status === 403 && r.body.code === 'human-required' && spawned === 0, 'no person: 403 human-required, nothing started', r);
  const get = await E.handleEditorRoute('editor/open', 'GET', {}, new URLSearchParams(), deps());
  assert(get.status === 405, 'GET is not a way to launch');
});

await block('Only files of registered projects, by real path', async () => {
  const open = (body, over) => E.handleEditorRoute('editor/open', 'POST', body, new URLSearchParams(), deps({ spawn: () => { throw new Error('must not spawn'); }, ...over }));
  assert((await open({ path: other, file: 'outside.ts' })).status === 403, 'an unregistered project is refused');
  assert((await open({ path: project, file: '../other/outside.ts' })).status === 403, '`..` out of the project is refused');
  assert((await open({ file: path.join(other, 'outside.ts') })).status === 403, 'an absolute path in no registered project is refused');
  assert((await open({ path: project, file: 'src' })).status === 400, 'a directory is not a file');
  assert((await open({ path: project, file: 'src/nope.ts' })).status === 404, 'a missing file is a 404');
  if (linked) assert((await open({ path: project, file: 'link.ts' })).status === 403, 'a symlink pointing out of the project is refused (real path)');
  else assert(true, 'symlinks unavailable here (Windows without symlink privilege): the real-path rule is exercised by `..` and absolute paths above');
});

await block('The launch, for real: a fake editor receives the file and line', async () => {
  fs.rmSync(record, { force: true });
  const r = await E.handleEditorRoute('editor/open', 'POST', { path: project, file: 'src/app.ts', line: 2 }, new URLSearchParams(), deps());
  assert(r.status === 200 && r.body.opened === true && r.body.editor === 'VS Code' && r.body.rel === 'src/app.ts', 'opened, by the fake `code` on the PATH', r.body);
  const got = await waitFor(record);
  assert(got.includes('-g') && got.includes(`${path.join(project, 'src', 'app.ts')}:2:1`), `the editor got -g <file>:2:1 (a path with a space survived ${WIN ? 'cmd quoting' : 'no shell'})`, got);
  const abs = await E.handleEditorRoute('editor/open', 'POST', { file: path.join(project, 'src', 'app.ts') }, new URLSearchParams(), deps());
  assert(abs.body.opened === true && abs.body.rel === 'src/app.ts', 'an absolute path finds its registered project');
  const noEditor = await E.handleEditorRoute('editor/open', 'POST', { path: project, file: 'src/app.ts', line: 2 }, new URLSearchParams(), deps({ env: envWithout }));
  assert(noEditor.body.opened === false && noEditor.body.fallback === 'viewer' && /not on the PATH/.test(noEditor.body.reason), 'no editor: the answer says so and points to the viewer', noEditor.body);
  // What reaches spawn: never a shell outside the Windows batch case; unsafe characters refused there.
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); const ee = new EventEmitter(); setImmediate(() => ee.emit('spawn')); ee.unref = () => {}; return ee; };
  await E.launch({ exe: '/usr/bin/subl', args: ['/p/a b.ts:3'], label: 'subl' }, { spawn: fakeSpawn, platform: 'linux' });
  assert(calls[0].cmd === '/usr/bin/subl' && calls[0].args[0] === '/p/a b.ts:3' && calls[0].opts.shell === false, 'POSIX: the program and an argument array, shell off');
  const bad = await E.launch({ exe: 'C:\\VS Code\\bin\\code.cmd', args: ['-g', 'C:\\p\\100%done.ts:1'], label: 'VS Code' }, { spawn: fakeSpawn, platform: 'win32' });
  assert(bad.ok === false && calls.length === 1, 'Windows launcher: a path with % is refused, never passed to cmd', bad);
  await E.launch({ exe: 'C:\\VS Code\\bin\\code.cmd', args: ['-g', 'C:\\p\\a & b.ts:1'], label: 'VS Code' }, { spawn: fakeSpawn, platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } });
  const last = calls.at(-1);
  assert(last.cmd === 'C:\\Windows\\cmd.exe' && last.args.slice(0, 3).join(' ') === '/d /s /c' && last.args[3] === '""C:\\VS Code\\bin\\code.cmd" "-g" "C:\\p\\a & b.ts:1""' && last.opts.windowsVerbatimArguments === true, 'Windows launcher: every word quoted (an & stays inside quotes)', last);
});

await block('The viewer: project text only', async () => {
  const view = (q) => E.handleEditorRoute('editor/file', 'GET', {}, new URLSearchParams(q), deps());
  const ok = await view({ path: project, file: 'src/app.ts' });
  assert(ok.status === 200 && ok.body.text.startsWith('export const a') && ok.body.path === 'src/app.ts', 'a source file is returned');
  assert((await view({ path: project, file: '.env' })).status === 403, 'a credentials-looking file is refused');
  assert((await view({ path: project, file: 'blob.bin' })).status === 415, 'binary is refused');
  assert((await view({ path: project, file: 'big.txt' })).status === 413, 'over 2 MB is refused');
  assert((await view({ path: project, file: '../other/outside.ts' })).status === 403, 'outside the project is refused');
  assert((await view({ path: other, file: 'outside.ts' })).status === 403, 'an unregistered project is refused');
  if (linked) assert((await view({ path: project, file: 'link.ts' })).status === 403, 'a symlink out of the project is refused');
});

console.log(`\neditor: ${passed} passed, ${failed} failed`);
if (failed) { console.log(`Failures:\n  ${failures.join('\n  ')}`); process.exit(1); }
process.exit(0);
