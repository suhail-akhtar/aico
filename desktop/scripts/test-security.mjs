/**
 * AICO Desktop — tests for the main-process guards a security review (2026-10)
 * asked for: what the agent may open and navigate to in the built-in browser,
 * which IPC senders the app answers, which paths the interface's file
 * handlers and the agent's uploads may touch, when browser_evaluate is
 * refused, the OS-keychain check autofill shares with the vault, plugin trust
 * tied to a content hash, the `aico://` content-security policies and the
 * human-grant rule, JavaScript dialogs named by their frame, the vault's
 * fill reply, SSH keyboard-interactive answers, and backup scrubbing.
 *
 * The rules are pure (electron/security-core.ts, electron/protocol-policy.ts,
 * electron/backup-core.ts, the exported helper in electron/terminal-ssh.ts);
 * the Electron modules that apply them cannot run in Node, so a few source
 * checks at the end make sure they are still wired in.
 *
 *   node scripts/test-security.mjs
 */

import '../../scripts/lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-sec-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron', 'ssh2'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const sec = await load(path.join(desktop, 'electron/security-core.ts'), 'security');
const pol = await load(path.join(desktop, 'electron/protocol-policy.ts'), 'policy');
const bk = await load(path.join(desktop, 'electron/backup-core.ts'), 'backup');
const ssh = await load(path.join(desktop, 'electron/terminal-ssh.ts'), 'ssh');
const src = (rel) => fs.readFileSync(path.join(desktop, rel), 'utf8');

// ── 1. What the agent may open ──
console.log('\nagent addresses');
{
  const n = sec.normaliseAddress;
  ok(n('example.com') === 'https://example.com' && n('localhost:3000') === 'http://localhost:3000' && n('file:///C:/x.txt') === 'file:///C:/x.txt',
    'the address bar rule is unchanged (a person may still type file:)');
  for (const bad of ['file:///C:/Users/me/.ssh/id_rsa', 'file:///etc/passwd', 'data:text/html,<script>1</script>', 'view-source:https://example.com', 'about:config']) {
    ok(Boolean(sec.agentOpenRefusal(n(bad))), `agent may not open ${bad.slice(0, 40)}`);
  }
  for (const bad of ['chrome://settings', 'devtools://devtools/bundled/inspector.html', 'javascript:alert(1)', 'aico://app/', 'ftp://example.com/x']) {
    ok(Boolean(sec.agentOpenRefusal(bad)) && n(bad).startsWith('https://duckduckgo.com/?q='), `agent never loads ${bad.slice(0, 40)} (refused as such; typed, it is only a search)`);
  }
  for (const good of ['https://example.com/a?b=1', 'http://localhost:5173/', 'about:blank', 'example.com']) {
    ok(sec.agentOpenRefusal(n(good)) === null, `agent may open ${good}`);
  }
  ok(/file: addresses/.test(sec.agentOpenRefusal('file:///x') ?? ''), 'the refusal names the scheme and the fix');
  ok(!sec.agentNavigationAllowed('file:///C:/secrets.txt') && !sec.agentNavigationAllowed('chrome://gpu') && !sec.agentNavigationAllowed('data:text/html,x')
    && sec.agentNavigationAllowed('https://example.com/next') && sec.agentNavigationAllowed('blob:https://example.com/123'),
  'an agent-driven tab follows links/redirects only to web pages (no file:, chrome:, data:)');
}

// ── 2. Plugin frames and human grants ──
console.log('\naico:// policies');
{
  const dir = (csp, name) => csp.split('; ').find(d => d.startsWith(`${name} `)) ?? '';
  ok(dir(pol.APP_CSP, 'form-action') === "form-action 'none'" && dir(pol.PLUGIN_CSP, 'form-action') === "form-action 'none'",
    'app and plugin pages may not submit forms (form-action \'none\')');
  ok(dir(pol.PLUGIN_CSP, 'connect-src') === "connect-src 'none'" && !pol.PLUGIN_CSP.includes('allow-same-origin'), 'plugin frames: no connections, opaque origin');
  const req = (method, headers) => ({ method, headers: new Headers(headers) });
  const APP = 'aico://app';
  ok(pol.humanIntent(req('POST', { 'content-type': 'application/json', 'x-aico-intent': '1', origin: APP }), APP), 'the app transport\'s JSON request with the intent header gets a grant');
  ok(pol.humanIntent(req('POST', { 'content-type': 'application/json; charset=utf-8', 'x-aico-intent': '1' }), APP), 'charset and an absent Origin are fine');
  ok(!pol.humanIntent(req('POST', { 'content-type': 'text/plain', origin: 'null' }), APP), 'a plugin frame\'s text/plain form post gets no grant');
  ok(!pol.humanIntent(req('POST', { 'content-type': 'text/plain', 'x-aico-intent': '1', origin: APP }), APP), 'no grant without JSON');
  ok(!pol.humanIntent(req('POST', { 'content-type': 'application/x-www-form-urlencoded', origin: APP }), APP), 'no grant for a urlencoded form');
  ok(!pol.humanIntent(req('POST', { 'content-type': 'application/json', origin: APP }), APP), 'no grant without the intent header');
  ok(!pol.humanIntent(req('POST', { 'content-type': 'application/json', 'x-aico-intent': '1', origin: 'null' }), APP), 'no grant from an opaque (sandboxed) origin');
  ok(!pol.humanIntent(req('POST', { 'content-type': 'application/json', 'x-aico-intent': '1', origin: 'aico://preview' }), APP), 'no grant from an HTML preview\'s origin');
  ok(!pol.humanIntent(req('GET', { 'content-type': 'application/json', 'x-aico-intent': '1', origin: APP }), APP), 'no grant for a GET');
  const t = src('renderer/src/lib/intent-transport.ts');
  ok(t.includes("'x-aico-intent', '1'") && ['main.tsx', 'browser-main.tsx', 'copilot-main.tsx'].every(f => src(`renderer/src/${f}`).includes("import './lib/intent-transport';")),
    'every app entry sends the intent header');
  ok(/HUMAN_ROUTES\.has\(pathname\) && humanIntent\(request, APP_ORIGIN\)/.test(src('electron/protocol.ts')), 'protocol.ts mints a grant only through humanIntent');
}
console.log('\nplugin trust');
{
  const a = sec.pluginContentHash([{ rel: 'aico-plugin.json', data: '{"id":"x"}' }, { rel: 'view.html', data: '<p>1</p>' }]);
  const b = sec.pluginContentHash([{ rel: 'view.html', data: '<p>1</p>' }, { rel: 'aico-plugin.json', data: '{"id":"x"}' }]);
  const c = sec.pluginContentHash([{ rel: 'aico-plugin.json', data: '{"id":"x"}' }, { rel: 'view.html', data: '<p>2</p>' }]);
  const d = sec.pluginContentHash([{ rel: 'aico-plugin.json', data: '{"id":"x"}' }, { rel: 'view2.html', data: '<p>1</p>' }]);
  ok(a === b && a !== c && a !== d, 'the content hash ignores order and changes with any byte or name');
  const r = sec.reconcilePluginTrust({ trusted: ['x', 'y', 'z', 'gone'], hashes: { x: a, y: 'old' } }, { x: a, y: 'new', z: 'zh' });
  ok(r.trusted.join() === 'x,z,gone' && r.revoked.join() === 'y' && r.hashes.x === a && r.hashes.z === 'zh' && !('y' in r.hashes),
    'a changed plugin loses its trust; a record without a hash takes the current one; an absent plugin keeps its record', r);
  const pl = src('electron/plugins.ts');
  ok(/revokeTrust\(ctx, manifest\.id\)/.test(pl) && /reconcileTrust\(ctx\);\s*const prefs/.test(pl), 'savePlugin (ide_plugin_save) revokes trust; listing reconciles hashes');
}

// ── 3. browser_evaluate ──
console.log('\nbrowser_evaluate');
{
  ok(Boolean(sec.evaluateRefusal({ checkout: true, cardFields: 0, filledPasswords: 0 })), 'refused on a checkout page');
  ok(Boolean(sec.evaluateRefusal({ checkout: false, cardFields: 2, filledPasswords: 0 })), 'refused beside card fields');
  ok(/password/.test(sec.evaluateRefusal({ checkout: false, cardFields: 0, filledPasswords: 1 }) ?? ''), 'refused while a password field holds a value');
  ok(sec.evaluateRefusal({ checkout: false, cardFields: 0, filledPasswords: 0 }) === null, 'elsewhere it goes to the person\'s Allow');
  const b = src('electron/browser.ts');
  const ev = b.slice(b.indexOf('    async evaluate(expression) {'), b.indexOf('    screenshot(opts) {'));
  ok(/evaluateRefusal\(/.test(ev) && /confirm\(\{/.test(ev) && /userGesture: false/.test(ev) && ev.indexOf('confirm({') < ev.indexOf('userGesture: false'),
    'browser_evaluate checks the page, asks the person, then runs without a user gesture');
}

// ── 4. browser_upload ──
console.log('\nbrowser_upload');
{
  const W = { roots: ['C:\\work\\app'], downloads: 'C:\\Users\\me\\Downloads', aicoHome: 'C:\\Users\\me\\.aico', platform: 'win32' };
  const v = (f) => sec.uploadVerdict(f, W);
  ok(v('C:\\work\\app\\docs\\cv.pdf').kind === 'inside' && v('c:\\WORK\\app\\x.png').kind === 'inside', 'a file in a project is expected (case-insensitive on Windows)');
  ok(v('C:\\Users\\me\\Downloads\\invoice.pdf').kind === 'inside', 'a file in Downloads is expected');
  ok(v('D:\\other\\photo.jpg').kind === 'outside', 'a file elsewhere is named to the person');
  ok(v('C:\\work\\app\\..\\..\\Windows\\win.ini').kind === 'outside', '.. does not climb out of a project unnoticed');
  for (const f of ['C:\\Users\\me\\.ssh\\id_ed25519', 'C:\\work\\app\\.env', 'C:\\work\\app\\.npmrc', 'C:\\Users\\me\\.aws\\credentials', 'C:\\work\\app\\certs\\server.pem',
    'C:\\work\\app\\id_rsa', 'C:\\Users\\me\\.aico\\settings.json', 'C:\\Users\\me\\Downloads\\backup.kdbx', 'C:\\work\\app\\deploy.key']) {
    ok(v(f).kind === 'refuse', `refused: ${f}`);
  }
  ok(sec.uploadVerdict('/home/me/.ssh/config', { roots: ['/home/me'], platform: 'linux' }).kind === 'refuse', 'refused on Linux too, even inside a root');
  ok(!sec.insideAny('/home/me/project-evil/x', ['/home/me/project'], 'linux') && sec.insideAny('/home/me/project/x', ['/home/me/project'], 'linux'), 'a sibling folder with the same prefix is not inside');
}

// ── 5. IPC senders and opened folders ──
console.log('\nIPC senders and folders');
{
  const f = sec.appFrameAllowed;
  ok(f({ url: 'aico://app/', isTopFrame: true }) && f({ url: 'aico://app/copilot.html', isTopFrame: true }) && f({ url: 'aico://app/browser.html#x', isTopFrame: true }),
    'the AICO window, the copilot overlay and the browser window are answered');
  ok(!f({ url: 'aico://app/plugins/x/view.html', isTopFrame: false }), 'a plugin frame inside the app is refused');
  ok(!f({ url: 'aico://preview/T/app.html', isTopFrame: true }) && !f({ url: 'https://evil.example/', isTopFrame: true }) && !f({ url: 'file:///C:/x.html', isTopFrame: true }) && !f(null),
    'previews, web pages, file pages and a gone frame are refused');
  ok(/appFrameAllowed\(/.test(src('electron/context.ts')), 'makeHandle checks every sender');
  ok(sec.isExecutablePath('C:\\x\\setup.EXE') && sec.isExecutablePath('/x/run.sh') && sec.isExecutablePath('a.lnk') && !sec.isExecutablePath('notes.md') && !sec.isExecutablePath('photo.png'),
    'programs and scripts are recognised (shell:openPath asks before running one)');
  const files = src('electron/files.ts');
  ok(['fs:read', 'fs:readDataUrl', 'fs:write', 'fs:create', 'fs:rename', 'fs:trash'].every(ch => new RegExp(`'${ch}'[^\\n]*\\n?[^\\n]*roots\\.check`).test(files)),
    'the file handlers that read or change files check the opened folders');
  const core = src('electron/core-ipc.ts');
  ok(/'shell:openPath'[\s\S]{0,200}openedRoots\(ctx\)\.check/.test(core) && /isExecutablePath\(target\)/.test(core), 'shell:openPath is scoped and asks before a program');
}

// ── 7. Autofill and the OS keychain ──
console.log('\nkeychain');
{
  const p = sec.safeStorageProblem;
  ok(p({ ready: true, available: true, platform: 'win32' }) === undefined && p({ ready: true, available: true, platform: 'linux', backend: 'gnome_libsecret' }) === undefined, 'a real keychain protects');
  ok(Boolean(p({ ready: true, available: true, platform: 'linux', backend: 'basic_text' })) && Boolean(p({ ready: true, available: false, platform: 'darwin' })),
    'basic_text (a fixed key) and no keychain do not');
  const af = src('electron/browser-autofill-store.ts');
  ok(/safeStorageProblem\(/.test(af) && !/enc: 'none'/.test(af), 'autofill uses the vault\'s check and never writes a plaintext profile');
  ok(/safeStorageProblem\(/.test(src('electron/vault-host.ts')), 'the vault key uses the same check');
}

// ── 8. JavaScript dialogs ──
console.log('\ndialogs');
{
  const s = sec.dialogSource('https://ads.example.net/frame.html', 'https://bank.example.com/account');
  ok(s.host === 'ads.example.net' && s.embedded, 'a dialog from an embedded frame is named by that frame', s);
  const t = sec.dialogSource('https://bank.example.com/x', 'https://bank.example.com/account');
  ok(t.host === 'bank.example.com' && !t.embedded, 'the page\'s own dialog is the site\'s');
  ok(sec.dialogSource(undefined, 'https://a.example/').host === 'a.example', 'no frame URL: the tab\'s site');
}

// ── 9. The vault's fill reply ──
console.log('\nvault fill reply');
{
  ok(sec.sameFrame({ processId: 4, routingId: 9 }, { processId: 4, routingId: 9 }) && !sec.sameFrame({ processId: 4, routingId: 9 }, { processId: 4, routingId: 10 }) && !sec.sameFrame({ processId: 4, routingId: 9 }, null),
    'only the frame a fill was sent to may answer it');
  ok(/sameFrame\(r\.frame, e\.senderFrame\)/.test(src('electron/browser-vault.ts')), 'the filled reply checks its sender frame');
}

// ── 10. SSH keyboard-interactive ──
console.log('\nssh keyboard-interactive');
{
  const a = ssh.keyboardInteractiveAnswers;
  const pw = 'Canary-pw-1';
  ok(a([{ prompt: 'Password: ' }], pw).answers[0] === pw && a([{ prompt: 'password' }], pw).answers[0] === pw, 'a plain password prompt gets the stored password');
  for (const q of ['Verification code: ', 'Passcode: ', 'One-time password (OATH) for `ops\': ', 'Enter PASSCODE:', 'OTP:', 'Password and OTP: ', 'What is your mother\'s maiden name?']) {
    const r = a([{ prompt: q }], pw);
    ok(r.answers[0] === '' && r.forPerson[0] === q.trim(), `not answered with the password: ${q.trim()}`);
  }
}

// ── Backup scrubbing (privacy review) ──
console.log('\nbackup scrubbing');
{
  const ghp = 'ghp_' + 'a'.repeat(36);
  const settings = {
    mcpServers: {
      gh: { command: 'npx', args: ['-y', 'gh-mcp', '--token', 'plainvalue123', '--api-key=sk-proj-' + 'b'.repeat(40), ghp, '--token', '${GH_TOKEN}'] },
      db: { url: 'postgres://admin:S3cret!pw@db.internal:5432/app', remote: 'https://mcp.example.com/sse?token=abc123def456&team=core' },
    },
    hooks: { PostToolUse: [{ command: `curl -H "Authorization: Bearer ${'x'.repeat(24)}" https://hooks.example.com/${ghp}` }] },
    providers: { openai: { apiKey: 'sk-oa', baseUrl: 'https://api.example.com/v1' } },
    projects: [{ path: 'E:\\repo' }],
    theme: 'dark',
  };
  const s = bk.stripCredentials(settings);
  const json = JSON.stringify(s.value);
  ok(!json.includes(ghp) && !json.includes('plainvalue123') && !json.includes('S3cret!pw') && !json.includes('abc123def456') && !json.includes('x'.repeat(24)) && !json.includes('sk-proj-'),
    'tokens in args, URLs, query strings and hook commands do not survive a "without API keys" backup', json);
  ok(s.value.mcpServers.gh.args[3] === '[masked argument]' && s.value.mcpServers.gh.args.at(-1) === '${GH_TOKEN}' && s.value.mcpServers.gh.args[1] === 'gh-mcp',
    'the value after --token is masked; an env reference and ordinary args are kept', s.value.mcpServers.gh.args);
  ok(s.value.mcpServers.db.url.startsWith('postgres://[masked url-credentials]@db.internal:5432') && /team=core/.test(s.value.mcpServers.db.remote),
    'URL userinfo and sensitive query values are masked; the rest of the URL stays', s.value.mcpServers.db);
  ok(s.value.providers.openai.baseUrl === 'https://api.example.com/v1' && s.value.projects[0].path === 'E:\\repo' && s.value.theme === 'dark', 'ordinary values are untouched');
  const merged = bk.restoreCredentials(s.value, settings);
  ok(merged.value.mcpServers.gh.args[3] === 'plainvalue123' && merged.value.mcpServers.db.url === settings.mcpServers.db.url && merged.value.providers.openai.apiKey === 'sk-oa',
    'restoring on a machine that has the values brings back its own', merged.value.mcpServers);
}

// ── 11. Links handed to the operating system (D6) ──
console.log('\nexternal links');
{
  const a = sec.externalLinkAllowed;
  ok(typeof a === 'function', 'security-core exports externalLinkAllowed');
  if (typeof a === 'function') {
    for (const good of ['https://example.com/a?b=1', 'http://localhost:5173/', 'HTTPS://EXAMPLE.COM', 'mailto:someone@example.com']) ok(a(good), `opens externally: ${good}`);
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'smb://evil.example/share', '\\\\evil.example\\share\\x.exe', 'ms-msdt:/id PCWDiagnostic', 'ms-settings:privacy', 'search-ms:query=x', 'vscode://evil/ext', 'aico://app/', 'data:text/html,<b>x</b>', 'https:', 'http://', '', ' https://example.com', 'not a url']) {
      ok(!a(bad), `refused externally: ${JSON.stringify(bad.slice(0, 40))}`);
    }
  }
  // Every hand-off in main goes through the one helper; nothing else calls shell.openExternal.
  const electronDir = path.join(desktop, 'electron');
  const raw = fs.readdirSync(electronDir).filter(f => f.endsWith('.ts') && f !== 'external-link.ts')
    .filter(f => /shell\.openExternal\(/.test(src(`electron/${f}`)));
  ok(raw.length === 0, 'no main-process module calls shell.openExternal directly (only external-link.ts)', raw);
  const helper = fs.existsSync(path.join(electronDir, 'external-link.ts')) ? src('electron/external-link.ts') : '';
  ok(/externalLinkAllowed\(/.test(helper) && /console\.warn\(/.test(helper), 'external-link.ts checks the scheme and logs a refusal');
  ok(/openExternalLink\(p\.linkURL/.test(src('electron/context-menu.ts')), 'the context menu "Open link" goes through the helper');
  ok(/openExternalLink\(/.test(src('electron/main.ts')) && /openExternalLink\(/.test(src('electron/core-ipc.ts')), 'window-open, will-navigate and the shell:openExternal IPC go through the helper');
}

// ── 12. Imported or page markup is never parsed live (D6) ──
console.log('\nimported markup');
{
  const bm = src('renderer/src/browser/bookmarks.ts');
  ok(!/\.innerHTML\s*=/.test(bm) && !/insertAdjacentHTML|outerHTML\s*=/.test(bm), 'bookmarks never assigns dragged or imported markup to innerHTML');
  ok(/DOMParser/.test(bm), 'bookmark titles from HTML are read through an inert DOMParser document');
}

// ── 13. Attaching a file by path is confined (review 2026-10) ──
console.log('\nattach by path');
{
  const pr = await load(path.join(desktop, '..', 'shared', 'path-refusal.ts'), 'path-refusal');
  for (const bad of ['\\\\evil.example\\share\\a.pdf', '//evil.example/share/a.pdf', '\\\\.\\PhysicalDrive0', 'C:\\work\\NUL.txt', 'C:\\work\\com1']) {
    ok(Boolean(pr.devicePathProblem(bad, 'win32')), `refused as a device or network path: ${bad}`);
  }
  ok(pr.devicePathProblem('C:\\work\\report.pdf', 'win32') === undefined && pr.devicePathProblem('/home/me/a.pdf', 'linux') === undefined, 'an ordinary file is not');
  const ipc = src('electron/core-ipc.ts');
  const handler = ipc.slice(ipc.indexOf("'dialog:readFileBase64'"), ipc.indexOf("'dialog:saveFile'"));
  ok(/devicePathProblem\(/.test(handler) && /openedRoots\(ctx\)\.check\(/.test(handler), 'dialog:readFileBase64 refuses device paths and anything outside the opened folders and picked files');
  ok(handler.indexOf('check(') < handler.indexOf('readFileSync'), 'and checks before it reads');
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  DESKTOP SECURITY: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
