/**
 * Build one of each kind of Mini App, for real, and judge the result.
 *
 * Not a unit test and not a throwaway: these land in the workspace the portal
 * actually reads, so they can be opened, used, and looked at afterwards. The
 * point is to see how the two kinds perform on briefs that are more than a
 * table — one with a visual element the design system does not hand you, one
 * with routes and server actions.
 *
 *   node scripts/showcase-build.mjs [page|next|both]
 *
 * Costs money. Uses deepseek-v4-flash through OpenRouter.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const {
  runAgent, runInContext, loadSettings, createMiniApp, getMiniApp, miniAppDir,
  authoringContract, nextAuthoringContract, startApp, stopApp, appState,
  resolveWorkspaceRoot,
} = await import('../dist-test/test-exports.js');
const { startMiniAppServer } = await import('../dist-test/miniapps/server.js');

const MODEL = 'deepseek/deepseek-v4-flash';
const which = process.argv[2] ?? 'both';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); return; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.log('OPENROUTER_API_KEY not set — nothing to build with.');
  process.exit(1);
}

const cwd = process.cwd();
const settings = await loadSettings();
const workspace = resolveWorkspaceRoot(settings, cwd);
console.log(`\n  workspace: ${workspace}\n`);

/** Create the app if it is not already there, so a re-run resumes. */
async function ensureApp(title, description, kind) {
  const existing = (await getMiniApp(
    title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), settings, cwd));
  if (existing) return existing;
  return createMiniApp({ title, description, kind }, settings, cwd);
}

async function build(app, brief, contract) {
  const dir = miniAppDir(app.slug, settings, cwd);
  console.log(`\n── ${app.title} (${app.kind ?? 'page'}) ──`);
  console.log(`  ${dir}\n`);
  const started = Date.now();
  const answer = await runInContext(
    { cwd, sessionId: `showcase-${app.slug}`, settings },
    () => runAgent({
      task: brief,
      model: MODEL,
      cwd,
      sessionId: `showcase-${app.slug}`,
      settings: { ...settings, maxIterations: 70 },
      projectInstructions: contract,
      autoApprove: true,
      verbose: false,
      silent: true,
      conversationHistory: [],
    }).catch(err => `[the turn ended: ${err instanceof Error ? err.message : String(err)}]`),
  );
  console.log(`  built in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  ${String(answer).split(/\r?\n/).slice(0, 4).join(' ').slice(0, 200)}\n`);
  return dir;
}

// ── The single-page one ─────────────────────────────────────────────

if (which === 'page' || which === 'both') {
  const app = await ensureApp(
    'Habit Tracker',
    'Daily habits and how long each streak is',
    'page',
  );
  const appDir = miniAppDir(app.slug, settings, cwd);
  await build(app, [
    'Build this habit tracker.',
    'Habits have a name, a colour, and a target number of days per week.',
    'I tick a habit off for a given day; the same habit can be ticked for many days.',
    'The main screen shows, for each habit, the current streak and the last four weeks',
    'as a small grid of days so I can see the pattern at a glance.',
    'I can add a habit, tick today off, and untick it if I got it wrong.',
    'Do not ask questions — decide sensibly and build it.',
    'Seed a few weeks of realistic history so the grid is not empty.',
  ].join(' '), authoringContract(app.slug, appDir,
    `http://127.0.0.1:${settings.miniApps?.port ?? 7331}/${app.slug}/`));

  const page = path.join(miniAppDir(app.slug, settings, cwd), 'public', 'index.html');
  check('the page app has a page', fs.existsSync(page));
  if (fs.existsSync(page)) {
    const html = fs.readFileSync(page, 'utf8');
    check('it wires the runtime before Alpine',
      html.indexOf('_aico/aico.js') > 0 && html.indexOf('_aico/aico.js') < html.indexOf('_aico/alpine.js'));
    check('it uses the data client', /aico\.db\./.test(html));
    check('and no CDN', !/https?:\/\/(cdn|unpkg|jsdelivr|fonts\.googleapis)/i.test(html));
  }
}

// ── The full-stack one ──────────────────────────────────────────────

if (which === 'next' || which === 'both') {
  const app = await ensureApp(
    'Expense Tracker',
    'What I spent, by category, per month',
    'nextjs',
  );
  const dir = miniAppDir(app.slug, settings, cwd);
  await build(app, [
    'Build this expense tracker as a Next.js app.',
    'An expense has an amount, a category, a note and a date.',
    'The first screen shows this month total, the biggest category, and a list of',
    'recent expenses. There is a second route at /categories showing the breakdown',
    'per category with a total for each.',
    'I can add an expense and delete one.',
    'Do not ask questions — decide sensibly and build it.',
    'Seed two months of realistic expenses so the screens are not empty.',
    'Write the files and stop; do not run npm or start a server yourself.',
  ].join(' '), nextAuthoringContract(app.slug, dir));

  check('the next app has a package.json', fs.existsSync(path.join(dir, 'package.json')));

  console.log('  starting it (first run installs Next)\n');
  await startApp(app.slug, dir);
  const deadline = Date.now() + 900_000;
  let last = '';
  while (Date.now() < deadline) {
    const now = appState(app.slug);
    if (now && now.state !== last) { last = now.state; console.log(`  state: ${now.state}`); }
    if (!now || now.state === 'running' || now.state === 'failed') break;
    await new Promise(r => setTimeout(r, 2000));
  }
  const ready = appState(app.slug);
  check('the next app starts', ready?.state === 'running',
    `${ready?.state}: ${ready?.error ?? ''}\n`
    + (ready?.output ?? []).slice(-12).map(l => `        ${l}`).join('\n'));

  if (ready?.state === 'running' && ready.url) {
    for (const route of ['/', '/categories']) {
      let res = { status: 0, html: '' };
      for (let i = 0; i < 5; i++) {
        res = await fetch(ready.url + route)
          .then(async r => ({ status: r.status, html: await r.text() }))
          .catch(e => ({ status: 0, html: e.message }));
        if (res.status === 200) break;
        await new Promise(r => setTimeout(r, 4000));
      }
      check(`${route} answers 200`, res.status === 200,
        `HTTP ${res.status}\n` + (appState(app.slug)?.output ?? []).slice(-10)
          .map(l => `        ${l}`).join('\n'));
    }
    console.log(`\n  running at ${ready.url} — left up for inspection`);
  }
}

// ── Serve the page apps so they can be looked at ────────────────────

if (which === 'page' || which === 'both') {
  const host = await startMiniAppServer({ settings, cwd, sisterPort: 0 });
  console.log(`\n  page apps served at ${host.url} — left up for inspection`);
}

console.log(`\n  showcase: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL ${f}`);
// Deliberately does not exit: the servers stay up so the apps can be opened.
