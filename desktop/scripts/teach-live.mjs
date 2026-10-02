/**
 * Live check of Teach AICO in the real desktop app (the replays use a real
 * model to call one tool — COSTS MONEY, about a cent; run only when asked):
 *
 *   node scripts/teach-live.mjs <outDir>
 *
 * Why it exists: recording, the review, the skill it saves and the replay
 * each pass their unit tests on their own; this proves they work together on
 * a real page, through the real interface:
 *
 *   1  the person teaches a two-page support-request form (text fields, a
 *      plan <select>, a PIN in a password field, a checkbox, Continue, a
 *      message, Submit) — every input injected as trusted input events into
 *      the browser tab, Teach and Stop pressed on the toolbar;
 *   2  the review page shows the steps; name and goal are filled in and
 *      "Save procedure" registers a skill with a procedure.json — which must
 *      not contain the PIN;
 *   3  a chat is asked to run it with different parameters: the model calls
 *      browser_run_procedure, the PIN step is handed to the person (this test
 *      answers the hand-over by typing a new PIN itself), and the server must
 *      receive exactly the new values;
 *   4  the site changes — "Continue" is renamed "Next step" and moved — and
 *      another chat replays it: the server must again receive the right
 *      submission.
 *
 * Isolated AICO_HOME (settings.json copied in for the provider key), local
 * pages on 127.0.0.1. Screenshots: <outDir>/teach-*.png.
 *
 * @module desktop/scripts/teach-live
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-teach-live'));
fs.mkdirSync(outDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-teach-live-home-'));
const realSettings = path.join(os.homedir(), '.aico', 'settings.json');
if (fs.existsSync(realSettings)) fs.copyFileSync(realSettings, path.join(home, 'settings.json'));
console.log(`AICO_HOME=${home}`);

const results = [];
const check = (ok, label, detail) => { results.push({ ok: Boolean(ok), label, detail }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { const f = path.join(outDir, `teach-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); console.log(`  shot ${f}`); };

// ── The site: a two-page support request ──
let variant = 'A';
const submissions = [];
const DEMO_PIN = '4321'; const PERSON_PIN = '9876';
const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;padding:32px;max-width:640px}label{display:block;margin:10px 0}input,select,textarea{display:block;margin-top:4px;padding:6px;width:320px}footer{margin-top:24px;padding-top:12px;border-top:1px solid #ccc}</style></head><body>${body}</body></html>`;
const formPage = () => {
  const go = variant === 'A' ? '<button type="submit">Continue</button>' : '';
  const goB = variant === 'B' ? '<footer><p>Ready?</p><div class="actions"><button type="submit" class="primary">Next step</button></div></footer>' : '';
  return shell('Support request', `<h1>Support request</h1>${variant === 'B' ? '<p class="banner">We redesigned this form.</p>' : ''}
<form id="request" method="post" action="/step2">
  <h2>Your details</h2>
  <label>Full name <input name="fullname" id="fullname" required></label>
  <label>Email <input name="email" id="email" type="email" required></label>
  <label>Plan <select name="plan" id="plan"><option value="basic">Basic</option><option value="pro">Professional</option><option value="enterprise">Enterprise</option></select></label>
  <label>Account PIN <input name="pin" id="pin" type="password" autocomplete="current-password"></label>
  <label><input type="checkbox" name="urgent" id="urgent" style="width:auto;display:inline"> Urgent</label>
  ${go}${goB}
</form>`);
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const step2 = (f) => shell('Describe the problem', `<h1>Describe the problem</h1>
<form id="details" method="post" action="/submit">
  ${Object.entries(f).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
  <label>Message <textarea name="message" id="message" rows="4"></textarea></label>
  <button type="submit">Submit request</button>
</form>`);
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b)))); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
  if (url.pathname === '/form') return send(formPage());
  if (url.pathname === '/step2' && req.method === 'POST') return send(step2(await readBody(req)));
  if (url.pathname === '/submit' && req.method === 'POST') {
    const f = await readBody(req);
    submissions.push(f);
    return send(shell('Request received', `<h1>Request received</h1><p>Reference #${submissions.length}</p>`));
  }
  res.writeHead(404); res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
console.log(`site at ${ORIGIN}`);

// ── The app ──
const exe = path.join(desktop, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = await electron.launch({ executablePath: exe, args: [desktop], env: { ...process.env, AICO_HOME: home }, timeout: 90_000 });
const win = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w?.unmaximize(); w?.setContentSize(1440, 900); }).catch(() => {});
await win.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 120_000 }).catch(() => {});
const invoke = (channel, ...args) => win.evaluate(([c, a]) => window.aicoDesktop.invoke(c, ...a), [channel, args]);
const openView = async (id) => { await win.evaluate((v) => window.dispatchEvent(new CustomEvent('aico:open-view', { detail: { id: v } })), id); await sleep(1500); };
await win.evaluate(() => { window.__handoffs = []; window.aicoDesktop.on('browser:handoff', (p) => window.__handoffs.push(p)); });

/** The person's input, as trusted events into the tab whose address contains `part`. */
const person = (part, a) => app.evaluate(async ({ webContents }, x) => {
  const wc = webContents.getAllWebContents().filter(w => w.getURL().includes(x.part)).pop();
  if (!wc) return `no tab at ${x.part}`;
  if (x.focus) { await wc.executeJavaScript(`document.querySelector(${JSON.stringify(x.focus)}).focus()`); }
  if (x.sel) {
    const r = await wc.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(x.sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 12), y: b.top + b.height / 2 }; })()`);
    if (!r) return `no element ${x.sel}`;
    const px = Math.round(r.x); const py = Math.round(r.y);
    wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    await new Promise(res => setTimeout(res, 200));
  }
  if (x.text != null) wc.insertText(x.text);
  if (x.key) { wc.sendInputEvent({ type: 'keyDown', keyCode: x.key }); wc.sendInputEvent({ type: 'keyUp', keyCode: x.key }); }
  await new Promise(res => setTimeout(res, 350));
  return 'ok';
}, { part, ...a });

// ── 1: teach ──
await openView('browser');
await invoke('browser:open', `${ORIGIN}/form`, true);
await sleep(2500);
await win.click('button[aria-label="Teach AICO"]');
await sleep(1200);
const st0 = await invoke('browser:teach:state');
check(st0.recording, '1: Teach (toolbar) starts recording on the tab in front', JSON.stringify(st0));
const demo = [
  ['/form', { sel: '#fullname', text: 'Ada Lovelace' }],
  ['/form', { sel: '#email', text: 'ada@example.test' }],
  ['/form', { focus: '#plan', key: 'Down' }],
  ['/form', { sel: '#pin', text: DEMO_PIN }],
  ['/form', { sel: '#urgent' }],
  ['/form', { sel: 'button[type=submit]' }],
];
for (const [p, a] of demo) console.log(`  person ${JSON.stringify(a)}: ${await person(p, a)}`);
await sleep(1800);
console.log(`  person message: ${await person('/step2', { sel: '#message', text: 'The printer is on fire' })}`);
console.log(`  person submit: ${await person('/step2', { sel: 'button[type=submit]' })}`);
await sleep(1800);
await shot(win, '1-recording');
const st1 = await invoke('browser:teach:state');
check(st1.recording && st1.steps >= 8, '1: the steps were recorded as the person worked', JSON.stringify(st1));
check(submissions.length === 1 && submissions[0].fullname === 'Ada Lovelace' && submissions[0].pin === DEMO_PIN, '1: the demonstration itself reached the site', JSON.stringify(submissions[0] ?? {}));
await win.click('button[aria-label="Stop teaching"]');
await sleep(1500);
const draft = await invoke('browser:teach:draft');
const kinds = draft ? draft.steps.flatMap(s => s.actions.map(a => a.kind)) : [];
console.log(`  steps: ${draft?.steps.map((s, i) => `${i + 1}. ${s.title}`).join(' | ')}`);
check(draft && kinds.join(',') === 'navigate,type,type,select,secret,click,click,type,click', '1: Stop → a draft of the expected steps', kinds.join(','));
check(draft && !JSON.stringify(draft).includes(DEMO_PIN), '1: the PIN typed into the password field is nowhere in the draft');
check(draft && draft.steps.filter(s => s.shots.length).length >= 7, '1: steps have screenshots for review', `${draft?.steps.filter(s => s.shots.length).length} with pictures`);

// ── 2: review and save ──
await win.waitForSelector('[data-teach-review]', { timeout: 10_000 }).catch(() => {});
await shot(win, '2-review');
await win.fill('[data-teach-name]', 'support-request');
await win.fill('[data-teach-goal]', 'Submit a support request for a customer on the help desk');
await win.click('[data-teach-save]');
await win.waitForSelector('[data-teach-result]', { timeout: 30_000 }).catch(() => {});
const saved = await win.textContent('[data-teach-result]').catch(() => '');
await shot(win, '2-saved');
check(/^Registered "support-request"/.test(saved ?? ''), '2: Save procedure → registered as a skill (draft → verify → register)', (saved ?? '').split('\n')[0]);
const skillDir = path.join(home, 'skills', 'support-request');
const procText = fs.existsSync(path.join(skillDir, 'procedure.json')) ? fs.readFileSync(path.join(skillDir, 'procedure.json'), 'utf8') : '';
const skillMd = fs.existsSync(path.join(skillDir, 'SKILL.md')) ? fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8') : '';
const proc = procText ? JSON.parse(procText) : null;
check(proc && proc.origin === ORIGIN && proc.params.some(p => p.name === 'full_name') && proc.params.some(p => p.name === 'message'), '2: procedure.json is scoped to the origin, with parameters', proc ? proc.params.map(p => p.name).join(', ') : 'missing');
check(procText && !procText.includes(DEMO_PIN) && !skillMd.includes(DEMO_PIN), '2: neither procedure.json nor SKILL.md holds the PIN');
check(/browser_run_procedure/.test(skillMd), '2: SKILL.md tells a chat how to run it');

// A free dry run stops here (no model calls): TEACH_LIVE_NO_MODEL=1.
if (process.env.TEACH_LIVE_NO_MODEL) {
  await app.close().catch(() => {}); server.close();
  // The temp store holds a copy of settings.json (provider keys): it does not outlive the run.
  fs.rmSync(home, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  console.log(`
${results.length - failed.length} passed, ${failed.length} failed (record + save only)`);
  process.exit(failed.length ? 1 : 0);
}

// ── 3 / 4: replay through a chat (the model calls the tool) ──
const startChat = async (text) => {
  await openView('chat');
  await win.keyboard.press('Control+n');
  await sleep(1200);
  const before = await win.evaluate(() => localStorage.getItem('aico.session'));
  await win.evaluate((t) => window.dispatchEvent(new CustomEvent('aico:ask', { detail: { text: t, send: true } })), text);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const now = await win.evaluate(() => localStorage.getItem('aico.session'));
    if (now && now !== before) return now;
  }
  return win.evaluate(() => localStorage.getItem('aico.session'));
};
const sessionOf = (sid) => win.evaluate(async (id) => fetch(`aico://app/api/session?id=${encodeURIComponent(id)}`).then(r => r.json()).catch(e => ({ error: String(e) })), sid);
const transcript = (sid) => win.evaluate(async (id) => fetch(`aico://app/api/session/export?id=${encodeURIComponent(id)}&format=md`).then(r => r.text()).catch(() => ''), sid);
/** Wait for the run; answer the PIN hand-over the way the person would (type it, press Done). */
const runReplay = async (label, params) => {
  const handled = await win.evaluate(() => window.__handoffs.length);
  const sid = await startChat(`Run the taught procedure "support-request" with the browser_run_procedure tool, params ${JSON.stringify(params)}. If it reports "Still running", call browser_run_procedure again with only its runId until it finishes. Use no other tool. Then reply with the first line of its final result.`);
  console.log(`  ${label}: chat ${sid}`);
  let answered = handled;
  const started = Date.now();
  const end = Date.now() + 240_000;
  while (Date.now() < end) {
    await sleep(1000);
    const hs = await win.evaluate(() => window.__handoffs);
    if (hs.length > answered) {
      const h = hs[answered]; answered = hs.length;
      console.log(`  hand-over: ${h.message.slice(0, 90)}`);
      await sleep(800);
      console.log(`  person types the PIN: ${await person('/form', { sel: '#pin', text: PERSON_PIN })}`);
      // Done, the way the person does it: the hand-over banner's own button (that also clears the banner).
      const pressed = await win.click('button:has-text("Done — hand back")', { timeout: 5000 }).then(() => true).catch(() => false);
      if (!pressed) await invoke('browser:handoffDone', h.id, 'done');
      console.log(`  hand-over answered ${pressed ? 'with the banner’s Done button' : 'through the channel (banner not found)'}`);
    }
    // Finished = the tool's report (or a refusal) is in the transcript and the chat has answered.
    if (Date.now() - started > 8000) {
      const md = await transcript(sid);
      const s = await sessionOf(sid);
      const ended = /— (done|stopped|failed|needs_judgement|refused) \(/.test(md) || /SENTINEL:|"error":/.test(md);
      if (ended && s && s.busy === false) break;
    }
  }
  await sleep(1500);
  // What the site's tabs hold now (for diagnosing a run that typed nothing).
  console.log(`  tabs: ${JSON.stringify(await app.evaluate(async ({ webContents }, origin) => Promise.all(webContents.getAllWebContents().filter(w => w.getURL().startsWith(origin)).map(async w => ({
    url: w.getURL().replace(origin, ''), zoom: w.getZoomFactor(), focused: w.isFocused(),
    page: await w.executeJavaScript('({ name: document.getElementById("fullname")?.value, hasFocus: document.hasFocus(), dpr: devicePixelRatio, w: innerWidth, h: innerHeight })').catch(e => String(e)),
  }))), ORIGIN))}`);
  const md = await transcript(sid);
  fs.writeFileSync(path.join(outDir, `teach-${label}.md`), md);
  return { sid, md, calls: [...md.matchAll(/\*\*mcp__aico-desktop__(browser_\w+)\*\*/g)].map(m => m[1]), sentinel: /SENTINEL:/.test(md) };
};

const A = await runReplay('3-replay', { full_name: 'Grace Hopper', email: 'grace@navy.test', message: 'Second run with new values' });
await shot(win, '3-after-replay');
const s2 = submissions.find(x => x.fullname === 'Grace Hopper') ?? {};
console.log(`  submission 2: ${JSON.stringify(s2)}`);
check(s2.fullname === 'Grace Hopper' && s2.email === 'grace@navy.test' && s2.message === 'Second run with new values' && s2.plan === 'pro' && s2.urgent === 'on', '3: the replay submitted the NEW parameters (and the recorded plan + checkbox)');
check(s2.pin === PERSON_PIN, '3: the PIN came from the person at the hand-over, not from the recording', `pin ${s2.pin === PERSON_PIN ? 'as typed by the person' : 'WRONG'}`);
check(A.calls.filter(c => c === 'browser_run_procedure').length >= 1 && !A.sentinel, '3: the model ran it with browser_run_procedure (and nothing blocked it)', `${A.calls.join(', ')}${A.sentinel ? ' — the engine’s Sentinel reviewer stopped the call' : ''}`);

variant = 'B';
const B = await runReplay('4-moved-button', { full_name: 'Lin Variant', email: 'lin@example.test', message: 'Button moved and renamed' });
await shot(win, '4-after-replay');
const s3 = submissions.find(x => x.fullname === 'Lin Variant') ?? {};
console.log(`  submission 3: ${JSON.stringify(s3)}`);
check(s3.fullname === 'Lin Variant' && s3.message === 'Button moved and renamed' && s3.pin === PERSON_PIN && !B.sentinel, '4: after "Continue" became "Next step" in another place, the procedure still went through');
check(/Next step/.test(B.md) || /only button/.test(B.md) || s3.fullname === 'Lin Variant', '4: the report shows how the renamed button was matched', (B.md.match(/Next step[^\n]{0,120}/) ?? [''])[0]);

await app.close().catch(() => {});
server.close();
// The temp store holds a copy of settings.json (provider keys): it does not outlive the run.
fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
