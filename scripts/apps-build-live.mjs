/**
 * The whole Apps loop, with a real model, on a scratch store.
 *
 * What it proves: a brief becomes an app through the same path the portal
 * takes — create from a template, install, plan, build story by story, verify
 * in a browser, deploy — and every screen of the result opens without a
 * console error. Along the way it rates a reply, checks the proposal that
 * rating produces, keeps it, and steers a turn, so the learning loop is
 * exercised on a real session rather than a synthetic one.
 *
 * Costs money (a model runs) and minutes (an install, a build). Not part of
 * `npm test`. Run before a release, or when a template or a skill changed:
 *
 *   node scripts/apps-build-live.mjs --model z-ai/glm-5.3-flash --template web-saas-next --turns 4 --deploy
 *
 * A turn is never cut short. A probe that killed a busy turn at a deadline
 * once lost the result it was there to measure; this one polls until the
 * server says the turn ended, and steers if a turn passes the soft limit.
 */
process.env.AICO_KEEP_TEST_HOME = '1';
const { testHome } = await import('./lib/test-home.mjs');
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const MODEL = arg('model', process.env.LIVE_MODEL || 'z-ai/glm-5.3-flash');
const TEMPLATE = arg('template', 'web-saas-next');
const TURNS = Number(arg('turns', '3'));
const SOFT_MINUTES = Number(arg('soft-minutes', '40'));
const PORT = Number(arg('port', String(7400 + Math.floor(Math.random() * 90))));
const OUT = path.resolve(arg('out', path.join(repoRoot, 'dist-test', `apps-build-${TEMPLATE}-${Date.now()}`)));
const DEPLOY = flag('deploy');
const BRIEFS = {
  'web-saas-next': { title: 'Invoice Desk', brief: 'An invoice desk for a small design studio. Customers with contact details; invoices with line items (description, quantity, unit price, tax rate), automatic totals, and statuses draft, sent and paid; a dashboard showing outstanding and overdue totals and the five most recent invoices. Users sign in, and each user only ever sees their own studio\'s data. It must look like a product a studio would pay for, not an admin panel.' },
  'dashboard-next': { title: 'Fleet Board', brief: 'A metrics dashboard for a small delivery fleet: vans report fuel, distance and deliveries through an ingest route; the board shows today against yesterday for each, a line chart of the last 14 days, and a table of the vans ranked by deliveries per litre. It must read like a product an operations lead opens every morning.' },
  'api-service-hono': { title: 'Booking API', brief: 'A JSON API for a small venue: rooms, bookings with start and end times that must not overlap for the same room, and a daily availability endpoint. Field-level validation errors, an OpenAPI document that matches, and tests that run the app in memory.' },
  'landing-static': { title: 'Ledgerly', brief: 'A landing page for Ledgerly, bookkeeping software for freelancers: hero, three benefits, pricing with two tiers, an FAQ, and a contact form. Copy in the product\'s voice, no placeholder text anywhere.' },
  'page-records': { title: 'Reading Log', brief: 'A reading log: books with title, author, status (want, reading, finished), rating and notes; a summary strip of counts; filter by status. Simple and quick.' },
};
const brief = BRIEFS[TEMPLATE] ?? BRIEFS['web-saas-next'];

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(OUT, 'run.log'), `${line}\n`); };
let passed = 0, failed = 0; const fails = [];
const check = (cond, label) => { if (cond) { passed++; log('  ✓', label); } else { failed++; fails.push(label); log('  ✗', label); } };

// ── Store and server ────────────────────────────────────────────────────────
const workdir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-build-'));
const workspace = path.join(workdir, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const settingsFile = path.join(testHome, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
settings.model = MODEL;
settings.autoApprove = true;
settings.workspace = { ...(settings.workspace ?? {}), path: workspace };
settings.miniApps = { ...(settings.miniApps ?? {}), enabled: true, port: PORT };
delete settings.projects;
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
log('model', MODEL, 'template', TEMPLATE, 'store', testHome, 'out', OUT);

const server = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js'), 'serve', '--no-open'], { cwd: workdir, env: { ...process.env, FORCE_COLOR: '0' } });
server.stderr.on('data', d => fs.appendFileSync(path.join(OUT, 'server.log'), d));
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
  server.stdout.on('data', d => { fs.appendFileSync(path.join(OUT, 'server.log'), d); const m = d.toString().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const token = url.split('token=')[1];
const base = url.split('/?')[0];
const api = async (route, body, method) => {
  const res = await fetch(`${base}/api/${route}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { 'x-aico-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Create the app the way the wizard does ──────────────────────────────────
const created = await api('apps/create', { template: TEMPLATE, title: brief.title, description: brief.brief.split('.')[0], install: true });
check(Boolean(created.slug), `the app was created from ${TEMPLATE} (${created.slug ?? created.error})`);
const slug = created.slug;
const sessionId = created.sessionId ?? `miniapp-${slug}`;
const appDir = path.join(workspace, 'miniapps', slug);
const events = () => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === `${sessionId}.events.jsonl`) found.push(p); } };
  try { walk(path.join(testHome, 'projects')); } catch {}
  if (!found[0]) return [];
  return fs.readFileSync(found[0], 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

const firstMessage = `${brief.brief}\n\nStart from this app's AICO.md and docs/EXTENDING.md, use the app-plan skill to turn this into docs/PRD.md and the first iteration of .aico/backlog.md, then build the first story and verify it in the browser.`;
const nextStory = 'Build the next unticked story in .aico/backlog.md. Run the checks, start the app if it is not running, verify the Done-when line in the browser with VerifyApp steps, then tick it.';

async function waitTurn(label) {
  const started = Date.now();
  let lastCount = -1;
  let steered = false;
  let polls = 0;
  while (true) {
    const s = await api(`session?id=${sessionId}`);
    polls++;
    if (s.messages && s.messages.length !== lastCount) { lastCount = s.messages.length; log(label, 'messages', lastCount); }
    // Idle after the run has had time to start is the end of the turn — a turn
    // that failed on its first request ends with one message, not two.
    if (s.busy === false && (lastCount > 1 || polls > 4)) {
      const end = [...events()].reverse().find(e => e.type === 'turn/end');
      if (end?.data?.reason?.kind === 'error') log(label, 'ended in error:', JSON.stringify(end.data.reason).slice(0, 300));
      return s;
    }
    const minutes = (Date.now() - started) / 60_000;
    if (!steered && minutes > SOFT_MINUTES) {
      steered = true;
      log(label, `past ${SOFT_MINUTES} minutes — steering to finish`);
      await api('steer', { sessionId, content: 'Steer from the person: finish this story now. Run RunChecks once, verify what is built with one VerifyApp call, tick what was observed, and end the turn with the report. Leave anything else for the next story.' });
    }
    await sleep(5000);
  }
}

const backlog = () => {
  try { const md = fs.readFileSync(path.join(appDir, '.aico', 'backlog.md'), 'utf8'); return { done: (md.match(/^- \[x\]/gm) ?? []).length, open: (md.match(/^- \[ \]/gm) ?? []).length }; }
  catch { return { done: 0, open: 0 }; }
};

const turnReports = [];
async function turn(label, task) {
  const before = events().length;
  const t0 = Date.now();
  const sent = await api('submit', { sessionId, task });
  check(sent.ok !== false && !sent.error, `${label}: submitted (${sent.error ?? 'ok'})`);
  const s = await waitTurn(label);
  const after = events().slice(before);
  const calls = after.filter(e => e.type === 'tool/call').map(e => e.data);
  const counts = {}; for (const c of calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  const reads = calls.filter(c => c.name === 'Read').map(c => { try { return JSON.parse(c.arguments).file_path; } catch { return ''; } });
  const rereads = reads.length - new Set(reads).size;
  const verify = calls.filter(c => c.name === 'VerifyApp').map(c => { try { return JSON.parse(c.arguments); } catch { return {}; } });
  const stepChecks = verify.reduce((n, v) => n + (v.checks ?? []).filter(c => c.steps).length, 0);
  const shots = verify.filter(v => v.screenshot).length;
  const gate = after.filter(e => e.type === 'user/message' && e.data?.source?.plugin).map(e => e.data.source.plugin);
  const end = after.find(e => e.type === 'turn/end')?.data;
  const report = { label, minutes: Math.round((Date.now() - t0) / 600) / 100, steps: after.filter(e => e.type === 'step/start').length, toolCalls: calls.length, counts, rereads, verifyCalls: verify.length, stepChecks, screenshotCalls: shots, gates: gate, end, backlog: backlog(), usage: s.usage };
  turnReports.push(report);
  log(label, JSON.stringify({ minutes: report.minutes, steps: report.steps, toolCalls: report.toolCalls, rereads, verifyCalls: report.verifyCalls, stepChecks, gates: gate.length, backlog: report.backlog, cost: s.usage?.costUsd }));
  return { session: s, after, report };
}

// ── Turn 1: plan and the first story ────────────────────────────────────────
const first = await turn('turn1', firstMessage);
check(fs.existsSync(path.join(appDir, 'docs', 'PRD.md')), 'turn1: the agent wrote docs/PRD.md');
check(backlog().done + backlog().open > 4, `turn1: the backlog has stories (${backlog().done} done, ${backlog().open} open)`);
check(first.report.counts.Skill >= 1, 'turn1: a skill was consulted');
check(first.report.counts.McpAddServer === undefined, 'turn1: no MCP server was installed to work around the verifier');
check(first.report.verifyCalls >= 1, `turn1: VerifyApp ran (${first.report.verifyCalls} calls, ${first.report.stepChecks} step checks)`);
const endKind = (end) => end?.reason?.kind ?? end?.kind;
check(endKind(first.report.end) === 'completed', `turn1: the turn completed (${JSON.stringify(first.report.end)})`);
if (endKind(first.report.end) === 'error') {
  log('the first turn failed before building anything; nothing further can be measured');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ model: MODEL, template: TEMPLATE, slug, failed, fails, turns: turnReports }, null, 2));
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch {}
  process.exit(1);
}

// ── Learning: rate the reply, expect a proposal, keep it ────────────────────
{
  const assistant = [...events()].reverse().find(e => e.type === 'assistant/message');
  const seq = assistant?.seq ?? assistant?.data?.seq;
  if (typeof seq === 'number') {
    const rated = await api('feedback', { sessionId, targetSeq: seq, rating: 'down', note: 'Money columns should use tabular-nums and be right-aligned, and the primary action belongs in the page header, not below the list.' });
    check(rated.ok === true, 'feedback: a 👎 with a note was recorded');
  } else {
    check(false, 'feedback: found the last assistant message to rate');
  }
}

// ── Following stories, with a steer during the first of them ────────────────
let steerLanded = false;
const reviewTask = 'Review this app as it stands: open it in the browser with VerifyApp, check every ticked story still holds, note anything a paying user would notice, fix what is small, and report.';
for (let i = 2; i <= TURNS; i++) {
  // The rating's proposal is extracted when the *next* turn ends, so one more
  // turn always runs; with nothing left to build it is a review.
  if (backlog().open === 0 && i > 2) { log('backlog complete before turn', i); break; }
  const beforeEvents = events().length;
  const submitted = api('submit', { sessionId, task: backlog().open === 0 ? reviewTask : nextStory });
  if (i === 2) {
    await sleep(20_000);
    const steer = await api('steer', { sessionId, content: 'Steer from the person: while you are in there, make sure every money value is right-aligned with tabular-nums. Carry on with the story.' });
    check(steer.ok === true, 'steer: a mid-turn message was accepted');
  }
  await submitted;
  const s = await waitTurn(`turn${i}`);
  const after = events().slice(beforeEvents);
  const calls = after.filter(e => e.type === 'tool/call').map(e => e.data);
  const counts = {}; for (const c of calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  const reads = calls.filter(c => c.name === 'Read').map(c => { try { return JSON.parse(c.arguments).file_path; } catch { return ''; } });
  const report = { label: `turn${i}`, steps: after.filter(e => e.type === 'step/start').length, toolCalls: calls.length, counts, rereads: reads.length - new Set(reads).size, backlog: backlog(), usage: s.usage, end: after.find(e => e.type === 'turn/end')?.data };
  turnReports.push(report);
  log(`turn${i}`, JSON.stringify({ steps: report.steps, toolCalls: report.toolCalls, rereads: report.rereads, backlog: report.backlog, cost: s.usage?.costUsd }));
  if (i === 2) {
    steerLanded = after.some(e => e.type === 'user/message' && /tabular-nums/.test(JSON.stringify(e.data)));
    check(steerLanded, 'steer: the steered message reached the turn');
    const proposals = await api(`learning/list?cwd=${encodeURIComponent(appDir)}`);
    const all = [...(proposals.project ?? []), ...(proposals.global ?? [])];
    const fromFeedback = all.find(p => /tabular-nums|page header/i.test(JSON.stringify(p)));
    check(Boolean(fromFeedback), `learning: the rating became a proposal (${all.length} open)`);
    if (fromFeedback) {
      const kept = await api('learning/adopt', { id: fromFeedback.id, cwd: appDir });
      check(kept.ok !== false && !kept.error, `learning: the proposal was kept (${kept.error ?? 'ok'})`);
      const knowledge = path.join(appDir, '.aico', 'knowledge.json');
      const anywhere = fs.existsSync(knowledge) ? fs.readFileSync(knowledge, 'utf8') : JSON.stringify(await api(`learning/list?cwd=${encodeURIComponent(appDir)}&status=adopted`));
      check(/tabular-nums|page header/i.test(anywhere), 'learning: the kept lesson is on record');
    }
  }
}

// ── The app's own checks, run here, not trusted from the report ─────────────
const run = (cmd) => spawnSync(cmd, { cwd: appDir, shell: true, encoding: 'utf8', timeout: 600_000 });
if (fs.existsSync(path.join(appDir, 'package.json'))) {
  for (const script of ['typecheck', 'lint', 'test']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.[script]) continue;
    const r = run(`npm run ${script} --silent`);
    check(r.status === 0, `the app's own ${script} passes (${(r.stdout + r.stderr).trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''})`);
  }
}
check(!/Placeholder eyebrow|lorem ipsum/i.test(fs.readdirSync(path.join(appDir, 'src'), { recursive: true }).filter(f => /\.(tsx|html|astro|md)$/.test(String(f))).map(f => { try { return fs.readFileSync(path.join(appDir, 'src', String(f)), 'utf8'); } catch { return ''; } }).join('\n')), 'no placeholder copy is left in the source');

// ── Deploy from the files it ships ──────────────────────────────────────────
if (DEPLOY) {
  const started = await api('apps/deploy', { slug, target: 'docker' });
  if (started.error && /docker|requires|not installed/i.test(started.error)) {
    log('deploy skipped:', started.error);
  } else {
    check(!started.error, `deploy: started (${started.error ?? 'ok'})`);
    let state;
    for (let i = 0; i < 240; i++) { state = (await api(`apps/deploy?slug=${slug}`)).deploy; if (state && ['deployed', 'failed', 'stopped', 'done'].includes(state.state)) break; await sleep(5000); }
    check(state?.state === 'deployed' || state?.state === 'done', `deploy: finished as ${state?.state} (${(state?.output ?? []).slice(-2).join(' | ').slice(0, 160)})`);
  }
}

// ── Every screen, as a first user, with a browser ───────────────────────────
const view = await api('apps');
const app = view.apps.find(a => a.slug === slug);
let appUrl = (view.processes ?? []).find(p => p.slug === slug)?.url;
if (!appUrl && app?.kind && !['page', 'static'].includes(app.kind)) {
  await api('apps/run', { slug, action: 'start' });
  for (let i = 0; i < 60; i++) { const v = await api('apps'); appUrl = (v.processes ?? []).find(p => p.slug === slug)?.url; if (appUrl) break; await sleep(3000); }
}
if (!appUrl && view.host) appUrl = `${view.host}/${slug}/`;
check(Boolean(appUrl), `the app is served (${appUrl})`);

if (appUrl) {
  const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  const exe = BROWSERS.find(p => fs.existsSync(p));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(`uncaught: ${e.message}`));
  const shot = async (n) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: true }); };
  const origin = appUrl.replace(/\/$/, '');
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => undefined);
  await shot('01-home');
  // Sign up when the app has accounts, so the signed-in screens are reachable.
  if (await page.$('a[href="/register"], a[href$="/register"]')) {
    await page.goto(`${origin}/register`, { waitUntil: 'networkidle' });
    await page.fill('#email', 'owner@studio.example').catch(() => undefined);
    await page.fill('#password', 'correct-horse-battery').catch(() => undefined);
    await page.click('button[type=submit]').catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await shot('02-after-signup');
  }
  const routes = [];
  const appRoot = path.join(appDir, 'src', 'app');
  const walk = (d, prefix) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) { if (e.name.startsWith('[') || e.name.startsWith('_') || e.name === 'api') continue; walk(path.join(d, e.name), e.name.startsWith('(') ? prefix : `${prefix}/${e.name}`); } else if (/^page\.(tsx|jsx)$/.test(e.name)) routes.push(prefix || '/'); } };
  walk(appRoot, '');
  let i = 2;
  for (const r of routes.filter(r => !/register|login/.test(r))) {
    i++;
    try {
      await page.goto(`${origin}${r}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await shot(`${String(i).padStart(2, '0')}-${r.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(!overflow, `${r} does not scroll sideways at 1280px`);
    } catch (e) { check(false, `${r} opened (${String(e.message).split('\n')[0]})`); }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const r of routes.filter(r => !/register|login/.test(r)).slice(0, 4)) {
    i++;
    try {
      await page.goto(`${origin}${r}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await shot(`${String(i).padStart(2, '0')}-phone-${r.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(!overflow, `${r} does not scroll sideways at 390px`);
    } catch (e) { check(false, `${r} opened on a phone (${String(e.message).split('\n')[0]})`); }
  }
  check(errors.length === 0, `no console errors across the screens (${errors.length}${errors[0] ? `: ${errors[0].slice(0, 100)}` : ''})`);
  await browser.close();
}

// ── Report ──────────────────────────────────────────────────────────────────
const session = await api(`session?id=${sessionId}`);
const summary = { model: MODEL, template: TEMPLATE, slug, appDir, testHome, turns: turnReports, backlog: backlog(), usage: session.usage, passed, failed, fails };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
log(`APPS BUILD (${TEMPLATE} on ${MODEL}): ${passed} passed, ${failed} failed · cost $${(session.usage?.costUsd ?? 0).toFixed(4)} · backlog ${backlog().done}/${backlog().done + backlog().open}`);
for (const f of fails) log('  -', f);
try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch {}
process.exit(failed > 0 ? 1 : 0);
