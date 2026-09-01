/**
 * The panel, in a real VS Code, looked at rather than assumed.
 *
 * Everything else about this feature can pass while the panel renders nothing.
 * The transport probe proves the wire; the typechecker proves the types; neither
 * says whether the content-security policy admits the bundle, whether the view
 * container appears at all, or whether the theme variables resolve to colours.
 * Those only fail at run time, inside a webview, and only in an editor.
 *
 * So this launches VS Code against a throwaway profile with the extension
 * installed, drives its command palette over the Chrome DevTools Protocol, and
 * reads the panel's DOM out of the webview.
 *
 * The CDP route is what makes this possible without a human. VS Code is
 * Electron, `--remote-debugging-port` gives its renderer a debugger, and a
 * webview is a frame inside it — so the same protocol that drives a browser
 * drives the editor.
 *
 * Run: node scripts/vscode-panel-live.mjs
 * Needs: a packaged VSIX (npm --prefix vscode-extension run package) and `code`
 *        on PATH.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const PORT = Number(process.env.AICO_CDP_PORT ?? 9333);

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, timeoutMs = 30_000, every = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(every);
  }
}

/**
 * A CDP session, with flat auto-attach.
 *
 * The auto-attach part is not optional here, and it is what the first version of
 * this probe got wrong. A VS Code webview is an out-of-process iframe: it does
 * not appear in `/json`, and the workbench page cannot `Runtime.evaluate` into
 * it because it is cross-origin. The only way in is to ask the browser to attach
 * to child targets and address them by session id — which `flatten: true`
 * multiplexes down the one socket already open.
 */
class Cdp {
  #socket; #next = 1; #pending = new Map();
  /** Child targets discovered by auto-attach, keyed by session id. */
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
      if (message.method === 'Target.detachedFromTarget') {
        cdp.attached.delete(message.params.sessionId);
        return;
      }

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
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000);
    });
  }

  /** Follow every child frame, however deeply nested, down this one socket. */
  async discoverChildren(sessionId) {
    await this.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    }, sessionId);
  }

  /** Evaluate in a target — or, with `contextId`, in one frame inside it. */
  async evaluate(expression, sessionId, contextId) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
      ...(contextId ? { contextId } : {}),
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result.result?.value;
  }

  /**
   * Every frame in a target, as an evaluable execution context.
   *
   * A VS Code webview nests our document one frame deeper than the shell, and
   * that inner frame is same-process — so it is not a target of its own and
   * auto-attach never surfaces it. `Runtime.evaluate` on the shell reaches the
   * shell's own context and reports our root as missing, which is exactly what
   * "the panel is not there" looked like while it was plainly on screen.
   *
   * An isolated world per frame is the way in: same DOM, separate globals, which
   * is all that reading markup and computed styles needs.
   */
  async frameContexts(sessionId) {
    await this.send('Page.enable', {}, sessionId);
    const { frameTree } = await this.send('Page.getFrameTree', {}, sessionId);

    const ids = [];
    const walk = (node) => {
      ids.push(node.frame.id);
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(frameTree);

    const contexts = [];
    for (const frameId of ids) {
      try {
        const { executionContextId } = await this.send('Page.createIsolatedWorld', {
          frameId, worldName: 'aico-probe', grantUniveralAccess: true,
        }, sessionId);
        contexts.push(executionContextId);
      } catch { /* a frame that has gone away between listing and asking */ }
    }
    return contexts;
  }

  close() { try { this.#socket.close(); } catch { /* already gone */ } }
}

const targets = () => fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json()).catch(() => []);

/**
 * Shut down the editor this probe started, and only that one.
 *
 * Killing the spawned pid is not enough, and the reason is the same one that
 * already bit the extension's own `stop()`: on Windows `code` is a `.cmd` shim,
 * `shell: true` means the pid belongs to `cmd.exe`, and the real `Code.exe` is
 * launched detached — so `taskkill /T` walks a tree the editor is not in. Runs
 * leaked an editor apiece until twenty-five were running.
 *
 * The `--user-data-dir` is unique per run and appears in the command line of
 * every process belonging to that instance, which makes it both a precise handle
 * and a safe one: it cannot match a window the user opened themselves. Killing
 * by image name would have been simpler and would close their editor.
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

/**
 * Open a file in the running window and select a line.
 *
 * `code --goto` rather than driving the command palette. The palette needs
 * keystrokes to land in a quick-input that may not have focus yet, and a
 * mis-timed one silently types into the editor instead — which looks exactly
 * like the feature under test not working. `--goto` is a supported entry point
 * that either opens the file or fails loudly.
 *
 * The selection itself still needs keys: `--goto` places a caret, and a caret is
 * not a selection. Shift+Down against the focused editor is the smallest thing
 * that produces one.
 */
async function openFile(file, line) {
  await new Promise((resolve) => {
    const p = spawn('code', [
      '--user-data-dir', userData, '--extensions-dir', extensions,
      '--reuse-window', '--goto', `${file}:${line}:1`,
    ], { shell: process.platform === 'win32', stdio: 'ignore' });
    p.on('exit', resolve);
    p.on('error', resolve);
  });
  await sleep(3000);
}

/** Extend the selection by a line. `--goto` leaves a caret, and a caret is not a selection. */
async function selectDown(cdp) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40,
      modifiers: 8, // Shift
    }).catch(() => { /* the window may be busy; the retry loop covers it */ });
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-vsc-live-'));
const userData = path.join(root, 'data');
const extensions = path.join(root, 'ext');
const workspace = path.join(root, 'ws');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# probe workspace\n');
/*
  A real source file, so the editor context has something to report.

  TypeScript rather than plain text: VS Code's built-in language features give
  it a symbol provider and diagnostics, which is what the `#` search and the
  Problems chip are actually reading. A workspace of markdown would exercise
  neither and pass anyway.
*/
fs.writeFileSync(path.join(workspace, 'sample.ts'), [
  'export function greet(name: string): string {',
  '  return `hello ${name}`;',
  '}',
  '',
  'export const answer = 42;',
  '',
].join('\n'));

let editor;
let workbench;
let panel;

try {
  console.log('\nVS CODE PANEL — in a real editor\n');

  const vsix = fs.readdirSync(path.join(repoRoot, 'vscode-extension'))
    .filter(f => f.endsWith('.vsix'))
    .sort()
    .pop();
  if (!vsix) throw new Error('no .vsix — run `npm --prefix vscode-extension run package` first');

  // ── install into a profile of its own ───────────────────────────────
  await new Promise((resolve, reject) => {
    const install = spawn('code', [
      '--user-data-dir', userData, '--extensions-dir', extensions,
      '--install-extension', path.join(repoRoot, 'vscode-extension', vsix), '--force',
    ], { shell: process.platform === 'win32' });
    let out = '';
    install.stdout?.on('data', d => { out += d; });
    install.stderr?.on('data', d => { out += d; });
    install.on('exit', code => (code === 0 ? resolve() : reject(new Error(`install failed:\n${out}`))));
  });
  check(true, `installed ${vsix} into a throwaway profile`);

  // ── launch with a debugger attached ─────────────────────────────────
  editor = spawn('code', [
    '--user-data-dir', userData, '--extensions-dir', extensions,
    `--remote-debugging-port=${PORT}`,
    /*
      A throwaway folder is an untrusted one, and VS Code disables every
      extension in Restricted Mode — including this one, deliberately. Without
      this flag the probe tests a window where nothing of ours is running and
      reports it as "the view container never registered".
    */
    '--disable-workspace-trust',
    '--new-window', workspace,
  ], { shell: process.platform === 'win32', stdio: 'ignore' });

  const workbenchTarget = await until(async () => {
    const list = await targets();
    return list.find(t => t.type === 'page' && t.url.includes('workbench'));
  }, 60_000);
  check(Boolean(workbenchTarget), 'VS Code came up with a debugger attached');
  if (!workbenchTarget) throw new Error('no workbench target');

  workbench = await Cdp.attach(workbenchTarget.webSocketDebuggerUrl);
  await workbench.send('Runtime.enable');

  /*
    ── the tab, beside Chat ──────────────────────────────────────────────

    Waited for rather than slept past. `onStartupFinished` lands whenever the
    window is ready, which on a cold profile is well past the six seconds an
    earlier version of this probe allowed — and the failure looked exactly like
    a view container that had never registered. Two rounds of debugging a bug
    that did not exist is what the wait is for.
  */
  const tabs = await until(async () => {
    const found = await workbench.evaluate(`
      [...document.querySelectorAll('.auxiliarybar .composite-bar .action-label')]
        .map(e => e.getAttribute('aria-label') || '')
        .join('||')
    `).catch(() => '');
    // Case-insensitive: VS Code title-cases a view container's name, so a
    // container titled "aico" is announced as "Aico".
    return /(^|\|)aico($|\|)/i.test(found) ? found : null;
  }, 90_000, 1000);

  check(Boolean(tabs), `aico is a tab in the Secondary Side Bar (${tabs ?? 'never appeared'})`);

  /*
    The activity-bar container must NOT be there at the same time. Both are
    declared and gated on one context key; if both rendered, the extension
    would be occupying two places at once and — worse — the manifest gate that
    keeps older VS Code from having its other extensions displaced would be
    proven not to work.
  */
  const activityBar = await workbench.evaluate(`
    [...document.querySelectorAll('.activitybar .action-label')]
      .map(e => e.getAttribute('aria-label') || '').join('||')
  `).catch(() => '');
  check(
    !/(^|\|)aico($|\|)/i.test(activityBar),
    'the activity-bar fallback stays hidden on a VS Code that has a Secondary Side Bar',
  );

  // ── open it ─────────────────────────────────────────────────────────
  const clicked = await workbench.evaluate(`
    (() => {
      const tab = [...document.querySelectorAll('.auxiliarybar .composite-bar .action-label')]
        .find(e => /^aico$/i.test(e.getAttribute('aria-label') || ''));
      if (!tab) return false;
      tab.click();
      return true;
    })()
  `).catch(() => false);
  check(clicked === true, 'the tab can be opened');
  await sleep(3000);

  // ── find the webview and read it ────────────────────────────────────
  /*
    A webview is two frames deep: an outer `vscode-webview://` shell and the
    document inside it. Rather than model that nesting, every attached frame is
    asked whether it contains our root — the one that answers is the panel.
  */
  await workbench.discoverChildren();

  const panelSession = await until(async () => {
    for (const [sessionId, info] of workbench.attached) {
      if (!(info.url ?? '').includes('vscode-webview')) continue;
      try {
        await workbench.send('Runtime.enable', {}, sessionId);
        await workbench.discoverChildren(sessionId);

        /*
          Every frame in the shell, tried in turn.

          Identified by our own root element rather than by title or by frame
          position. A webview is two frames deep and only the inner one carries
          the document we wrote — and that inner frame is same-process, so it is
          never a target of its own. Asking the shell directly reports our root
          as missing while the panel is plainly on screen, which is exactly how
          this probe spent two rounds hunting a bug that did not exist.
        */
        for (const contextId of await workbench.frameContexts(sessionId)) {
          const mine = await workbench
            .evaluate("Boolean(document.getElementById('root'))", sessionId, contextId)
            .catch(() => false);
          if (mine === true) return { sessionId, contextId };
        }
      } catch { /* a frame that is gone, or not scriptable */ }
    }
    return null;
  }, 60_000, 1000);

  if (!panelSession) {
    console.log('\n  — frames seen, for diagnosis:');
    for (const [sessionId, info] of workbench.attached) {
      let title = '?';
      try { title = await workbench.evaluate('document.title', sessionId); } catch { /* not scriptable */ }
      console.log(`      ${info.type} title=${JSON.stringify(title)} url=${(info.url ?? '').slice(0, 90)}`);
    }
    const iframes = await workbench.evaluate(`
      [...document.querySelectorAll('iframe')].map(f => f.src.slice(0, 90)).join(' | ')
    `).catch(() => '');
    console.log(`      workbench iframes: ${iframes || '(none)'}`);
    const sideBar = await workbench.evaluate(`
      document.querySelector('.auxiliarybar')?.innerText?.replace(/\\s+/g, ' ').slice(0, 120) ?? '(no auxiliary bar)'
    `).catch(() => '?');
    console.log(`      secondary side bar: ${sideBar}\n`);
  }

  check(
    Boolean(panelSession),
    `the panel webview is attachable (${workbench.attached.size} child frames seen)`,
  );

  if (panelSession) {
    const evaluate = (expression) =>
      workbench.evaluate(expression, panelSession.sessionId, panelSession.contextId);

    /*
      An empty #root is the failure this whole probe exists for. A blocked
      script has no other symptom: the panel is simply blank, and the CSP
      violation is visible only in devtools nobody opens.
    */
    const mounted = await until(
      async () => {
        const count = await evaluate("document.querySelectorAll('#root *').length").catch(() => 0);
        return count > 0 ? count : null;
      },
      30_000,
      500,
    );
    check(Boolean(mounted), `React mounted inside the webview (${mounted ?? 0} nodes)`);

    const text = (await evaluate('document.body.innerText').catch(() => '')) ?? '';
    check(
      /ask aico|no folder open|could not reach aico|conversations in this folder|untitled/i.test(text),
      `the panel rendered its own UI (${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 70))})`,
    );

    /*
      The way through to the wide surface, offered where it is useful.

      A 300px column is the wrong shape for Mini Apps, the trajectory view and
      the settings screens, and a toolbar icon nobody has learned does not tell
      a new reader that a second surface exists at all.
    */
    check(
      /open the full workspace/i.test(text),
      'an empty conversation offers the full workspace',
    );

    const themed = await evaluate(`
      (() => {
        const s = getComputedStyle(document.documentElement);
        return JSON.stringify({
          fg: s.getPropertyValue('--aico-text-primary').trim(),
          bg: s.getPropertyValue('--aico-bg').trim(),
          // Proof the mapping resolved rather than merely being declared: a
          // variable pointing at an undefined --vscode-* would compute to ''.
          resolved: getComputedStyle(document.body).color,
        });
      })()
    `).catch(() => '{}');
    const tokens = JSON.parse(themed ?? '{}');
    check(
      Boolean(tokens.fg) && Boolean(tokens.resolved),
      `aico's tokens resolve against the VS Code theme (body colour ${tokens.resolved || 'unset'})`,
    );

    const composer = await evaluate("Boolean(document.querySelector('textarea'))")
      .catch(() => false);
    check(composer === true, 'the composer is present');

    /*
      ── the folder the panel is actually working in ─────────────────────

      The assertion that would have caught the bug a person found by using the
      panel: it had quietly registered a second project for the open folder and
      was running there instead. Nothing on screen said so, and nothing in the
      test suite asked.

      Read from the header's own tooltip rather than from any internal state,
      because the tooltip is what a person would check.
    */
    const shownFolder = await evaluate(`
      (() => {
        const el = [...document.querySelectorAll('[title]')]
          .find(e => /[\\\\/]/.test(e.getAttribute('title') || ''));
        return el ? el.getAttribute('title') : '';
      })()
    `).catch(() => '');

    /*
      The window's own idea of where it is, for comparison.

      Without this the check can only say the panel is wrong, not whether the
      panel misread the window or the window opened somewhere unexpected — and
      those have completely different fixes.
    */
    const windowTitle = await workbench.evaluate('document.title').catch(() => '');

    const norm = (p) => p.toLowerCase().replace(/[\\/]+/g, '/');
    check(
      norm(shownFolder) === norm(workspace),
      `the panel works in the folder the window has open`
      + ` (panel says ${JSON.stringify(shownFolder)}; window title ${JSON.stringify(windowTitle)})`,
    );

    // ── editor context reaches the panel ──────────────────────────────
    /*
      Opened and selected through VS Code's own commands rather than by faking a
      message. The whole feature is a chain — an editor event, a debounce, a
      postMessage, a React render — and every link but the last would pass a test
      that started halfway along.
    */
    await openFile(path.join(workspace, 'sample.ts'), 2);

    const chips = await until(async () => {
      const text = await evaluate('document.body.innerText').catch(() => '');
      return /sample\.ts/.test(text) ? text : null;
    }, 20_000, 750);

    check(
      Boolean(chips),
      `the open file appears as a context chip (${JSON.stringify((chips ?? '').replace(/\s+/g, ' ').slice(0, 80))})`,
    );

    /*
      The selection keystroke is re-sent until the range shows up.

      Sending it once and waiting was flaky in exactly the way that teaches you
      nothing: `--goto` returns before the editor has focus, so the first
      Shift+Down sometimes lands nowhere. Re-pressing is what a person would do,
      and it turns a coin-flip into a check that means something when it fails.
    */
    const ranged = await until(async () => {
      await selectDown(workbench);
      await sleep(1200);
      const text = await evaluate('document.body.innerText').catch(() => '');
      return /sample\.ts:2(-\d+)?/.test(text) ? text : null;
    }, 25_000, 0);

    check(
      Boolean(ranged),
      'the chip carries the selected line range, not just the filename',
    );
  }
} catch (err) {
  failed += 1;
  fails.push(`threw: ${err?.message ?? err}`);
  console.log(`\n  ✗ ${err?.stack ?? err}`);
} finally {
  panel?.close();
  workbench?.close();
  await killEditor();
  await sleep(2000);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows holds handles */ }
}

console.log(`\nVS CODE PANEL: ${passed} passed, ${failed} failed`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
