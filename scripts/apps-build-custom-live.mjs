/**
 * The Apps loop for a custom (no-template) app, with a real model, on a
 * scratch store: a bare, genuinely ambiguous brief in, the agent chooses and
 * justifies its own stack, plans, builds story by story, verifies in a
 * browser, and every screen opens without a console error.
 *
 * This exists as the deliberate counterpart to scripts/apps-build-live.mjs's
 * template runs. A template already hands the agent a stack, an AICO.md and
 * a worked feature to copy (docs/EXTENDING.md) -- app-architecture's job
 * there is closer to "follow the pattern" than "invent the pattern". This
 * script starts from `apps/create --custom` (see createCustomApp in
 * src/apps/templates.ts, "stack not yet chosen") specifically to exercise
 * the harder, more ambiguous half of the same skill: naming the data model,
 * choosing the stack, and deciding the architecture from a bare brief with
 * no scaffolding at all.
 *
 * Costs money (a model runs) and minutes (real code, real deps, a real
 * build). Not part of `npm test`. Run when app-plan/app-architecture/
 * app-design change, or to (re-)measure real-world greenfield capability:
 *
 *   node scripts/apps-build-custom-live.mjs --model deepseek-v4-flash --brief team-goals --turns 4
 *
 * Verification here is deliberately stack-agnostic: unlike the template
 * script's Next.js-specific route walk, this only knows the brief and the
 * "Done when" lines the agent itself commits to in .aico/backlog.md -- so it
 * screenshots and console-checks the home page, then walks whatever routes
 * survive a generic same-origin link crawl, rather than assuming a
 * src/app/**\/page.tsx layout.
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
const MODEL = arg('model', process.env.LIVE_MODEL || 'deepseek-v4-flash');
const BRIEF_KEY = arg('brief', 'team-goals');
const TURNS = Number(arg('turns', '4'));
const SOFT_MINUTES = Number(arg('soft-minutes', '40'));
const PORT = Number(arg('port', String(7400 + Math.floor(Math.random() * 90))));
const OUT = path.resolve(arg('out', path.join(repoRoot, 'dist-test', `apps-build-custom-${BRIEF_KEY}-${Date.now()}`)));

// Five genuinely ambiguous, real-world briefs -- deliberately under-specified
// the way an actual stakeholder request is, and in domains distinct from
// this repo's own 9 templates (invoice desk, fleet board, booking API,
// landing page, reading log, todo CLI, support triage, docs site, shopping
// list). Each forces a real architectural decision a template would have
// pre-made: multi-tenant permission boundaries, overlapping-interval
// scheduling, a cascading relational data model, a "feels live" requirement
// with no stack named, and a manager/report workflow with state.
const BRIEFS = {
  'team-goals': { title: 'Goalboard', brief: "A tool for small teams to track shared goals. Multiple teams, each with members who have different permission levels: owners can create goals with a target date and track progress, members can update progress on goals in their team, viewers can only look. People should only ever see their own team's data, never another team's." },
  'venue-scheduling': { title: 'VenueSlot', brief: 'A scheduling tool for a small event venue. Multiple event types -- weddings, corporate events, private parties -- each with its own setup and teardown time that has to be blocked around the event itself. No two bookings can overlap once setup and teardown are included. Staff need a calendar view of the month to see what is booked.' },
  'cafe-inventory': { title: 'StockCup', brief: 'An inventory tool for a small café. Ingredients each have a current quantity and a reorder threshold. Recipes say how much of which ingredients a drink uses. Logging a sale deducts the right ingredients automatically. A dashboard flags anything currently under its threshold.' },
  'note-board': { title: 'Stickyboard', brief: "A shared note board for a small team. Sticky notes have a title, a body and a colour; anyone on the team can add, edit or delete one. Notes are grouped into boards. Changes made by one person should show up for everyone else looking at the same board without them having to manually refresh the page." },
  'timeoff': { title: 'DaysOff', brief: "An internal time-off tool. An employee can request time off and sees their own requests plus a running balance of days left. A manager sees only the pending requests from their direct reports and can approve or deny each with a note. Once decided, the employee's view updates to show the outcome." },
};
const brief = BRIEFS[BRIEF_KEY];
if (!brief) { console.error(`no brief "${BRIEF_KEY}" -- choices: ${Object.keys(BRIEFS).join(', ')}`); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(OUT, 'run.log'), `${line}\n`); };
let passed = 0, failed = 0; const fails = [];
const check = (cond, label) => { if (cond) { passed++; log('  ✓', label); } else { failed++; fails.push(label); log('  ✗', label); } };

// ── Store and server ────────────────────────────────────────────────────────
const workdir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'aico-build-custom-'));
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
log('model', MODEL, 'brief', BRIEF_KEY, 'store', testHome, 'out', OUT);

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

// ── Create the custom app -- no template, no stack chosen yet ──────────────
const created = await api('apps/create', { custom: true, title: brief.title, description: brief.brief.split('.')[0] });
check(Boolean(created.slug), `the app was created custom (${created.slug ?? created.error})`);
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

const firstMessage = `${brief.brief}\n\nThis is a brand-new custom app -- no stack has been chosen yet. Use the app-plan skill: write docs/PRD.md including a justified Stack section (frontend, backend/API, database, and why), then .aico/backlog.md, then build the first story and verify it in the browser.`;
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
  const verify = calls.filter(c => c.name === 'VerifyApp').map(c => { try { return JSON.parse(c.arguments); } catch { return {}; } });
  const stepChecks = verify.reduce((n, v) => n + (v.checks ?? []).filter(c => c.steps).length, 0);
  const end = after.find(e => e.type === 'turn/end')?.data;
  const report = { label, minutes: Math.round((Date.now() - t0) / 600) / 100, steps: after.filter(e => e.type === 'step/start').length, toolCalls: calls.length, counts, verifyCalls: verify.length, stepChecks, end, backlog: backlog(), usage: s.usage };
  turnReports.push(report);
  log(label, JSON.stringify({ minutes: report.minutes, steps: report.steps, toolCalls: report.toolCalls, verifyCalls: report.verifyCalls, stepChecks, backlog: report.backlog, cost: s.usage?.costUsd }));
  return { session: s, after, report };
}

// ── Turn 1: choose the stack, plan, build the first story ──────────────────
const first = await turn('turn1', firstMessage);
check(fs.existsSync(path.join(appDir, 'docs', 'PRD.md')), 'turn1: the agent wrote docs/PRD.md');
const prd = fs.existsSync(path.join(appDir, 'docs', 'PRD.md')) ? fs.readFileSync(path.join(appDir, 'docs', 'PRD.md'), 'utf8') : '';
check(/##?\s*Stack/i.test(prd), 'turn1: the PRD names a Stack section');
check(backlog().done + backlog().open > 2, `turn1: the backlog has stories (${backlog().done} done, ${backlog().open} open)`);
check(first.report.counts.Skill >= 1, 'turn1: a skill was consulted');
check(fs.existsSync(path.join(appDir, '.aico', 'decisions.md')), 'turn1: decisions.md exists (seeded or written)');
check(first.report.verifyCalls >= 1, `turn1: VerifyApp ran (${first.report.verifyCalls} calls, ${first.report.stepChecks} step checks)`);
const endKind = (end) => end?.reason?.kind ?? end?.kind;
check(endKind(first.report.end) === 'completed', `turn1: the turn completed (${JSON.stringify(first.report.end)})`);
if (endKind(first.report.end) === 'error') {
  log('the first turn failed before building anything; nothing further can be measured');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ model: MODEL, brief: BRIEF_KEY, slug, failed, fails, turns: turnReports }, null, 2));
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch {}
  process.exit(1);
}

// ── Following stories ────────────────────────────────────────────────────
for (let i = 2; i <= TURNS; i++) {
  if (backlog().open === 0) { log('backlog complete before turn', i); break; }
  await turn(`turn${i}`, nextStory);
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
const allFiles = [];
const walkFiles = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walkFiles(p); else if (/\.(tsx?|jsx?|html|py|md)$/.test(e.name)) allFiles.push(p); } };
walkFiles(appDir);
const sourceText = allFiles.map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
check(!/Placeholder eyebrow|lorem ipsum/i.test(sourceText), 'no placeholder copy is left in the source');

// ── Reach the app, as a first user, with a browser — stack-agnostic ────────
const view = await api('apps');
const app = view.apps.find(a => a.slug === slug);
let appUrl = app?.kind === 'cli' ? undefined : (view.processes ?? []).find(p => p.slug === slug)?.url;
if (!appUrl && app?.kind && !['page', 'static', 'cli'].includes(app.kind)) {
  await api('apps/run', { slug, action: 'start' });
  for (let i = 0; i < 60; i++) { const v = await api('apps'); appUrl = (v.processes ?? []).find(p => p.slug === slug)?.url; if (appUrl) break; await sleep(3000); }
}
if (!appUrl && view.host && app?.kind !== 'cli') appUrl = `${view.host}/${slug}/`;
if (app?.kind !== 'cli') check(Boolean(appUrl), `the app is served (${appUrl})`);

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
  check(await page.title().then(t => t.length > 0).catch(() => false), 'the home page has a title');

  // Stack-agnostic route discovery: crawl same-origin links from the home
  // page rather than assuming a framework's file-based routing layout.
  const links = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter(Boolean)).catch(() => []);
  const sameOrigin = [...new Set(links.filter((h) => h.startsWith('/') && !/^\/(login|register|api)/.test(h)))].slice(0, 4);
  let i = 1;
  for (const r of sameOrigin) {
    i++;
    try {
      await page.goto(`${origin}${r}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await shot(`${String(i).padStart(2, '0')}-${r.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page'}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(!overflow, `${r} does not scroll sideways at 1280px`);
    } catch (e) { check(false, `${r} opened (${String(e.message).split('\n')[0]})`); }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => undefined);
  const overflowPhone = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => false);
  check(!overflowPhone, 'the home page does not scroll sideways at 390px');
  await shot('99-phone-home');
  check(errors.length === 0, `no console errors across the screens (${errors.length}${errors[0] ? `: ${errors[0].slice(0, 100)}` : ''})`);
  await browser.close();
}

// ── Report ──────────────────────────────────────────────────────────────────
const session = await api(`session?id=${sessionId}`);
const summary = { model: MODEL, brief: BRIEF_KEY, title: brief.title, slug, appDir, testHome, turns: turnReports, backlog: backlog(), usage: session.usage, passed, failed, fails };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
log(`APPS BUILD CUSTOM (${BRIEF_KEY} on ${MODEL}): ${passed} passed, ${failed} failed · cost $${(session.usage?.costUsd ?? 0).toFixed(4)} · backlog ${backlog().done}/${backlog().done + backlog().open}`);
for (const f of fails) log('  -', f);
try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch {}
process.exit(failed > 0 ? 1 : 0);
