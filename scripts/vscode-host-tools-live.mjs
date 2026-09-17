/**
 * Verify VSCodeReferences/VSCodeRename/VSCodeFormat against a real language
 * server, in a real VS Code, not just tsc.
 *
 * These three call vscode.executeReferenceProvider/executeDocumentRenameProvider/
 * executeFormatDocumentProvider, which only return anything when a real
 * language server is actually attached to a real open document -- no unit test
 * can exercise that. This installs a freshly-packaged VSIX into a throwaway
 * profile, opens a small real TypeScript fixture project (so the built-in TS
 * language server activates), triggers a URI handler over a second
 * `code --open-url` call -- one deterministic call, not simulated keystrokes
 * against a UI this script does not control -- and reads back the JSON
 * result it writes to disk. Uses the same CDP attach this project's
 * vscode-panel-live.mjs already does, just to watch the workbench settle and
 * to read an activation diagnostic, not to drive any UI.
 *
 * ## The extension needs a temporary hook first -- this is not self-contained
 *
 * `extension.ts` does not ship a URI handler for this; add one before running,
 * remove it after (it verified this session's References/Rename/Format work,
 * then was removed -- see the Phase 1 plan / project_vscode_host_tools_phase1
 * memory for the exact block). The shape, if re-adding for a future host tool:
 *
 *   if (process.env.AICO_TEST_HOST_TOOLS === '1') {
 *     context.subscriptions.push(vscode.window.registerUriHandler({
 *       handleUri: (uri) => {
 *         if (uri.path !== '/test-host-tools') return;
 *         void (async () => { ...call runHostCall(...), fs.writeFileSync(
 *           process.env.AICO_TEST_HOST_TOOLS_OUT ?? 'host-tools-test-result.json',
 *           JSON.stringify(results), ) })();
 *       },
 *     }));
 *   }
 *
 * Three real gotchas this discovered, worth not rediscovering:
 * - **A URI handler, not the command palette.** Simulating F1 + typed
 *   characters + Enter over CDP is a real UI your fixture's window layout
 *   and timing have to cooperate with; `--open-url` is one deterministic call.
 * - **Warm up first.** A provider call moments after the window opens, before
 *   the language server has resolved the project's import graph, silently
 *   returns nothing or resolves only within the one file it was invoked from.
 *   Explicitly `openTextDocument`+`showTextDocument` every fixture file
 *   first, then wait several seconds, before calling anything real.
 * - **A cross-file rename invoked from a usage site (not the declaration)
 *   may only rename within that one file**, even once References has
 *   already proven the language server resolves the same symbol across
 *   files. Confirmed reproducible on this machine/TS-server version across
 *   several runs; not chased to a root cause (declaration-anchored rename
 *   hit a separate hang worth its own session). host-tools.ts's own code is
 *   not implicated -- it applies and saves exactly the WorkspaceEdit VS Code
 *   hands back, and References independently proves the resolution works.
 *   Flagged as a known open question, not a shipped defect.
 *
 * Run: node scripts/vscode-host-tools-live.mjs
 * Needs: a packaged VSIX (npm --prefix vscode-extension run package, built
 *        with the temporary hook above back in extension.ts) and `code` on
 *        PATH.
 */
import './lib/test-home.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const PORT = Number(process.env.AICO_CDP_PORT ?? 9334);
const FIXTURE = process.env.AICO_FIXTURE_DIR ?? 'E:/tmp/vscode-host-tools-verify';
const RESULT_FILE = path.join(FIXTURE, 'host-tools-test-result.json');
// Fixed, not env-controlled — see extension.ts's own comment on this same path.
const DIAG_FILE = path.join(fs.realpathSync.native(os.tmpdir()), 'aico-host-tools-diag.json');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}
/*
  Node's spawn(..., {shell: true}) does not auto-quote an array argument for
  the cmd.exe shell it invokes on Windows -- `code` is a .cmd shim, so it
  always goes through cmd.exe here. A path with a space (this machine's own
  username is "Suhail Akhtar") silently splits into two arguments at the
  space, which VS Code then mis-parses as a --user-data-dir one directory
  short and a stray positional after it -- surfacing much later as
  `ENOTDIR: not a directory, mkdir 'c:\Users\Suhail'`, nowhere near the real
  cause. Quoting any arg containing whitespace fixes it.
*/
const q = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, timeoutMs = 60_000, every = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(every);
  }
}

class Cdp {
  #socket; #next = 1; #pending = new Map();
  attached = new Map();
  static async attach(wsUrl) {
    const cdp = new Cdp();
    cdp.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#socket.addEventListener('open', resolve, { once: true });
      cdp.#socket.addEventListener('error', () => reject(new Error(`cannot attach: ${wsUrl}`)), { once: true });
    });
    cdp.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Target.attachedToTarget') {
        cdp.attached.set(message.params.sessionId, message.params.targetInfo);
        return;
      }
      if (message.method === 'Target.detachedFromTarget') { cdp.attached.delete(message.params.sessionId); return; }
      const waiter = cdp.#pending.get(message.id);
      if (!waiter) return;
      cdp.#pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`${method} timed out`)); }, 20_000);
    });
  }
  async discoverChildren(sessionId) {
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return result.result?.value;
  }
}

/**
 * Shut down the editor this probe started, and only that one.
 *
 * Killing the spawned pid is not enough: on Windows `code` is a `.cmd` shim,
 * `shell: true` means the pid belongs to `cmd.exe`, and the real `Code.exe`
 * is launched detached — so a plain `.kill()` leaks an editor apiece, exactly
 * the bug scripts/vscode-panel-live.mjs already found and fixed once (its
 * own header comment: "leaked an editor apiece until twenty-five were
 * running"). Copying that fix rather than rediscovering it: `--user-data-dir`
 * is unique per run and appears in the command line of every process
 * belonging to that instance, which is both a precise handle and a safe one
 * — it cannot match a window the user opened themselves.
 */
async function killEditor() {
  if (process.platform !== 'win32') {
    try { editor?.kill('SIGKILL'); } catch { /* already gone */ }
    return;
  }
  await new Promise((resolve) => {
    const script = `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" `
      + `| Where-Object { $_.CommandLine -like '*${path.basename(userData)}*' } `
      + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    const p = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    p.on('exit', resolve);
    p.on('error', resolve);
  });
}

// Clean fixture result from any previous run.
try { fs.rmSync(RESULT_FILE); } catch {}
try { fs.rmSync(DIAG_FILE); } catch {}

const userData = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-vscode-profile-'));
const extensions = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-vscode-exts-'));

let editor;
try {
  console.log('\nVS CODE HOST TOOLS — References/Rename/Format against a real language server\n');

  const versionOf = (file) => (file.match(/(\d+)\.(\d+)\.(\d+)\.vsix$/) ?? []).slice(1).map(Number);
  const vsix = fs.readdirSync(path.join(repoRoot, 'vscode-extension'))
    .filter(f => f.endsWith('.vsix'))
    .sort((a, b) => {
      const [va, vb] = [versionOf(a), versionOf(b)];
      for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return (va[i] ?? 0) - (vb[i] ?? 0);
      return 0;
    })
    .pop();
  if (!vsix) throw new Error('no .vsix — run `npm --prefix vscode-extension run package` first');

  await new Promise((resolve, reject) => {
    const install = spawn('code', [
      '--user-data-dir', q(userData), '--extensions-dir', q(extensions),
      '--install-extension', q(path.join(repoRoot, 'vscode-extension', vsix)), '--force',
    ], { shell: process.platform === 'win32' });
    let out = '';
    install.stdout?.on('data', d => { out += d; });
    install.stderr?.on('data', d => { out += d; });
    install.on('exit', code => (code === 0 ? resolve() : reject(new Error(`install failed:\n${out}`))));
  });
  check(true, `installed ${vsix} into a throwaway profile`);

  editor = spawn('code', [
    '--user-data-dir', q(userData), '--extensions-dir', q(extensions),
    `--remote-debugging-port=${PORT}`,
    '--disable-workspace-trust',
    '--new-window', q(FIXTURE),
  ], {
    shell: process.platform === 'win32', stdio: 'ignore',
    env: { ...process.env, AICO_TEST_HOST_TOOLS: '1', AICO_TEST_HOST_TOOLS_OUT: RESULT_FILE },
  });

  const wsUrl = await until(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const json = await res.json();
      return json.webSocketDebuggerUrl;
    } catch { return null; }
  }, 30_000);
  check(Boolean(wsUrl), 'the editor exposed a debugger endpoint');
  if (!wsUrl) throw new Error('no debugger endpoint');

  const cdp = await Cdp.attach(wsUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  const workbench = targetInfos.find(t => t.type === 'page' && /workbench/i.test(t.url ?? '')) ?? targetInfos.find(t => t.type === 'page');
  check(Boolean(workbench), 'found the workbench page target');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: workbench.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  // Wait for the workbench (and its extension host) to finish loading, then
  // give the TypeScript language server real time to index this small
  // fixture project — it needs to be genuinely ready for the provider calls
  // to return anything.
  await until(() => cdp.evaluate('document.readyState === "complete"', sessionId), 30_000);
  console.log('  … waiting for the workbench and the TypeScript language server to settle');
  await sleep(12_000);

  // Diagnostic first: did the extension host even see the env var it was
  // launched with? Answers "never activated / env var lost" separately from
  // "activated fine, something downstream broke" before assuming either.
  // A cold, freshly-installed profile can take real time to bootstrap and
  // activate an extension the first time — generous on purpose.
  const diag = await until(() => fs.existsSync(DIAG_FILE) ? JSON.parse(fs.readFileSync(DIAG_FILE, 'utf8')) : null, 45_000);
  check(Boolean(diag), 'the extension activated and wrote its diagnostic marker');
  check(diag?.sawEnvVar === '1', `the extension host saw AICO_TEST_HOST_TOOLS=1 (got ${JSON.stringify(diag?.sawEnvVar)})`);

  // Trigger over a URI handler rather than the command palette — a single
  // deterministic call instead of simulating F1 / typed characters / Enter
  // against UI layout and timing this script does not control.
  await new Promise((resolve, reject) => {
    const open = spawn('code', [
      '--user-data-dir', q(userData), '--extensions-dir', q(extensions),
      '--open-url', 'vscode://suhail-akhtar.aico-vscode/test-host-tools',
    ], { shell: process.platform === 'win32' });
    let out = '';
    open.stdout?.on('data', d => { out += d; });
    open.stderr?.on('data', d => { out += d; });
    open.on('exit', code => (code === 0 ? resolve() : reject(new Error(`--open-url failed:\n${out}`))));
  });

  console.log('  … waiting for the URI handler to run and write its result');
  const found = await until(() => fs.existsSync(RESULT_FILE), 60_000);
  check(Boolean(found), 'the URI handler wrote a result file');

  if (found) {
    const results = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    console.log('\n  raw result:\n', JSON.stringify(results, null, 2), '\n');

    // References: real usage, not a text match — should find both call sites
    // in index.ts (excluding the declaration itself, per the provider's own
    // semantics, or including it — check what actually came back).
    const refs = results.references?.result?.references ?? [];
    check(results.references?.ok !== false, `VSCodeReferences answered ok (${results.references?.error ?? ''})`);
    check(refs.length >= 2, `VSCodeReferences found at least 2 real usages (found ${refs.length})`);
    check(refs.some(r => r.file?.includes('index.ts')), 'VSCodeReferences found a usage in index.ts');

    // Ambiguous rename: must refuse, must NOT mutate anything.
    check(results.renameAmbiguous?.ok === false, 'VSCodeRename refused the ambiguous call (2 "add" on one line, no occurrence)');
    check(/appears 2 times/.test(results.renameAmbiguous?.error ?? ''), 'the refusal names the exact ambiguity');

    // Real rename: must succeed and report every file it touched.
    check(results.rename?.ok !== false, `VSCodeRename answered ok (${results.rename?.error ?? ''})`);
    const changed = results.rename?.result?.filesChanged ?? [];
    check(changed.some(f => f.includes('math.ts')), 'VSCodeRename changed math.ts (the declaration)');
    check(changed.some(f => f.includes('index.ts')), 'VSCodeRename changed index.ts (the call sites)');

    // The rename must actually have landed on disk, not just in a buffer.
    const mathOnDisk = fs.readFileSync(path.join(FIXTURE, 'src', 'math.ts'), 'utf8');
    const indexOnDisk = fs.readFileSync(path.join(FIXTURE, 'src', 'index.ts'), 'utf8');
    check(/export function sum/.test(mathOnDisk), 'math.ts on disk now defines "sum", not "add"');
    check(!/\badd\(/.test(indexOnDisk) && /\bsum\(/.test(indexOnDisk), 'index.ts on disk now calls "sum" everywhere, not "add"');

    // Format: must actually reformat the deliberately messy file.
    check(results.format?.ok !== false, `VSCodeFormat answered ok (${results.format?.error ?? ''})`);
    check(results.format?.result?.changed === true, 'VSCodeFormat reported a real change');
    const messyOnDisk = fs.readFileSync(path.join(FIXTURE, 'src', 'messy.ts'), 'utf8');
    check(!/function   messy/.test(messyOnDisk), 'messy.ts on disk no longer has the original mangled spacing');
  }
} catch (err) {
  check(false, `probe did not crash (${err.message})`);
} finally {
  await killEditor();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(extensions, { recursive: true, force: true }); } catch {}
}

console.log(`\nVS CODE HOST TOOLS: ${passed} passed, ${failed} failed\n`);
for (const f of fails) console.log('  -', f);
process.exit(failed > 0 ? 1 : 0);
