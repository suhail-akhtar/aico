/**
 * The VS Code extension's logic, against a real aico server.
 *
 * Installing the extension proves the manifest is valid and that `activate()`
 * runs — the extension host log confirms both. It proves nothing about whether
 * the server actually starts, whether the token is captured, or whether the
 * panel points the iframe somewhere real. Those are the parts that break.
 *
 * So the `vscode` module is stubbed and the compiled extension is driven
 * directly: a real `aico serve` child, a real token parsed out of its stdout, a
 * real HTTP call to its API. Only the editor is fake.
 *
 * Run: cd vscode-extension && npx tsc -p ./   (then)   node scripts/vscode-ext-live.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(root, 'vscode-extension', 'out');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

if (!fs.existsSync(path.join(out, 'server.js'))) {
  console.error('\nNo build. Run: cd vscode-extension && npx tsc -p ./\n');
  process.exit(1);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-vsc-'));
fs.writeFileSync(path.join(workdir, 'note.txt'), 'scratch project for the probe\n');

// ── the fake editor ────────────────────────────────────────────────────
// Only the surface the extension actually touches. Anything it reaches for that
// is not here will throw, which is the point: a stub that silently returns
// undefined for everything hides exactly the mistakes this is looking for.
const panels = [];
const statusItems = [];
const serverLog = [];

const vscodeStub = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workdir } }],
    getConfiguration: () => ({
      get: (key, fallback) => fallback,
    }),
    asRelativePath: (uri) => path.basename(uri.fsPath ?? String(uri)),
  },
  window: {
    // Captured, not discarded. The first version threw this away, so when the
    // server failed to start the probe reported "exited with code 1" and hid
    // the message explaining why — the same mistake the extension's own code is
    // commented against.
    createOutputChannel: () => ({
      appendLine: (line) => { serverLog.push(String(line)); },
      append: (text) => { serverLog.push(String(text)); },
      show: () => {}, dispose: () => {},
    }),
    createStatusBarItem: () => {
      const item = { text: '', tooltip: undefined, backgroundColor: undefined,
        command: undefined, shown: false,
        show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
      statusItems.push(item);
      return item;
    },
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panel = {
        viewType, title, showOptions, options,
        webview: { html: '' },
        reveal() { this.revealed = true; },
        dispose() { this.onDispose?.(); },
        onDidDispose(fn) { this.onDispose = fn; },
      };
      panels.push(panel);
      return panel;
    },
    activeTextEditor: undefined,
    showErrorMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    withProgress: (_opts, task) => task(),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1 },
  ProgressLocation: { Window: 10 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(v) { this.value = v; } },
  Uri: { parse: (s) => ({ toString: () => s }) },
  env: { openExternal: () => Promise.resolve(true) },
};

/*
  Hand the compiled extension a fake `vscode`.

  There is no such module on disk — it is injected by the editor at runtime — so
  the resolver is taught to answer for it and the cache is pre-filled with the
  stub. The resolver patch has to come first: calling `require.resolve('vscode')`
  before it is in place throws, which is exactly what the first version did.
*/
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub };

const { ServerManager } = require(path.join(out, 'server.js'));
const { WorkspacePanel } = require(path.join(out, 'panel.js'));

let manager;

try {
  console.log('\n-- the server starts and its token is captured --');
  manager = new ServerManager(vscodeStub.window.createOutputChannel());

  // Two at once: the guard exists because clicking the status bar while the
  // panel opens would otherwise race two servers onto the same port.
  const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
  check(Boolean(a?.token), `a token was parsed out of stdout (${a?.token?.slice(0, 8)}…)`);
  check(a.port > 0, `on a real port (${a.port})`);
  check(a === b, 'and two concurrent starts produced one server, not two');
  check(manager.current()?.port === a.port, 'which is the one it reports as current');

  console.log('\n-- it can actually talk to that server --');
  const system = await manager.api('system');
  check(Array.isArray(system.work), 'the work ledger comes back through the API');
  check(Array.isArray(system.cron), 'and so does the rest of the system snapshot');

  console.log('\n-- the panel points at something real --');
  {
    WorkspacePanel.show(a, 'web-probe-session');
    const panel = panels[panels.length - 1];
    check(Boolean(panel), 'a webview panel was created');
    check(panel.options.enableScripts === true, 'with scripts enabled');
    check(panel.options.retainContextWhenHidden === true,
      'and context retained — otherwise a long turn is torn down whenever the tab loses focus');

    // Port mapping is what makes this work over Remote SSH, where localhost
    // inside a webview means the user's machine rather than the server's.
    const mapping = panel.options.portMapping?.[0];
    check(mapping?.webviewPort === a.port && mapping?.extensionHostPort === a.port,
      `the port is mapped to itself (${mapping?.webviewPort} → ${mapping?.extensionHostPort})`);

    const html = panel.webview.html;
    check(html.includes(`http://localhost:${a.port}/`), 'the iframe points at the running server');
    check(html.includes(`token=${a.token}`), 'carrying the token');
    check(html.includes('session=web-probe-session'),
      'and the session, which is the whole reason the client learned to read one from the URL');
    check(new RegExp(`frame-src http://localhost:${a.port} http://127\\.0\\.0\\.1:${a.port}`).test(html),
      'with a CSP that allows only that one loopback port');
    check(/default-src 'none'/.test(html), 'and nothing else by default');
  }

  console.log('\n-- the embedded page is really served --');
  {
    // The iframe URL is only useful if it answers. This is the check that would
    // have caught a wrong port or a mangled token.
    const res = await fetch(`http://localhost:${a.port}/?token=${a.token}`);
    check(res.status === 200, `the workspace responds (HTTP ${res.status})`);
    const body = await res.text();
    check(/<div id="root"|<script/.test(body), 'with the web client, not an error page');
  }

  console.log('\n-- the Origin guard is not in the way --');
  {
    // The reason embedding needed no change to the server. A request whose
    // Origin is the loopback port is same-origin as far as the guard cares.
    const ok = await fetch(`http://localhost:${a.port}/api/system`, {
      headers: { 'x-aico-token': a.token, Origin: `http://localhost:${a.port}` },
    });
    check(ok.status === 200, `a same-origin request from the iframe is accepted (${ok.status})`);

    const foreign = await fetch(`http://localhost:${a.port}/api/system`, {
      headers: { 'x-aico-token': a.token, Origin: 'https://evil.example' },
    });
    check(foreign.status === 403,
      `while a foreign origin is still refused (${foreign.status}) — embedding did not weaken it`);
  }

  console.log('\n-- stopping it really stops it --');
  {
    manager.stop();
    check(manager.current() === undefined, 'the manager forgets the server');
    const gone = await (async () => {
      for (let i = 0; i < 40; i++) {
        try {
          await fetch(`http://localhost:${a.port}/api/system`, {
            headers: { 'x-aico-token': a.token },
            signal: AbortSignal.timeout(500),
          });
        } catch {
          return true;
        }
        await new Promise(r => setTimeout(r, 250));
      }
      return false;
    })();
    check(gone, 'and the port stops answering — no orphaned agent left running');
  }
} catch (err) {
  failed++;
  fails.push(`threw: ${err.message}`);
  console.log(`\n  ✗ threw: ${err.message}`);
  console.log(err.stack?.split('\n').slice(1, 4).join('\n'));
} finally {
  console.log(`\nvscode extension (live): ${passed} passed, ${failed} failed`);
  for (const f of fails) console.log(`  - ${f}`);

  try { manager?.dispose(); } catch { /* already stopped */ }
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* locked */ }
  process.exit(failed ? 1 : 0);
}
