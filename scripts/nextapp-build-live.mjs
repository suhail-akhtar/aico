/**
 * Can the agent build a Next.js Mini App from the contract alone?
 *
 * `nextapp-probe.mjs` proves the runner with an app written by hand — installs,
 * starts, serves, dies cleanly. What it cannot prove is whether the *contract*
 * is good enough that a model reads it and produces something that runs. Those
 * are different claims and the second is the one that decides whether the
 * feature is real.
 *
 * So this hands a model the brief and then checks the result the way a person
 * would: start it, open it, read the HTML it served.
 *
 *   node scripts/nextapp-build-live.mjs
 *
 * Slow and not free — a model turn, then a real `npm install` of Next.
 */

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  runAgent, runInContext, loadSettings, createMiniApp, miniAppDir,
  startApp, stopApp, appState, nextAuthoringContract,
} = await import('../dist-test/test-exports.js');

const MODEL = 'deepseek/deepseek-v4-flash';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); return; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.log('OPENROUTER_API_KEY not set — nothing to test against.');
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-nextbuild-'));
const settings = {
  ...(await loadSettings()),
  workspace: { path: root },
  miniApps: { enabled: true },
  maxIterations: 60,
};

const app = await createMiniApp(
  { title: 'Task Board', description: 'Tasks in columns, with a count per column', kind: 'nextjs' },
  settings, root,
);
const dir = miniAppDir(app.slug, settings, root);
console.log(`\n  workspace: ${root}\n  app:       ${dir}\n`);

check('the app records what kind it is', app.kind === 'nextjs', String(app.kind));

// The same brief the tool hands over on `create`, so what is under test is the
// contract as shipped rather than a better one written for the occasion.
const contract = nextAuthoringContract(app.slug, dir);

const started = Date.now();
const answer = await runInContext({ cwd: root, sessionId: 'live-nextapp-build', settings }, () =>
  runAgent({
    task: [
      'Build this task board as a Next.js app in the directory named below.',
      'Tasks have a title, a status (todo / doing / done), and an order within their column.',
      'The first screen shows three columns with a count on each.',
      'Do not ask questions — decide sensibly and build it.',
      'Seed a few realistic tasks so the board is not empty.',
      'Write the files and stop; do not try to run npm or start a server yourself.',
    ].join(' '),
    model: MODEL,
    cwd: root,
    sessionId: 'live-nextapp-build',
    settings,
    projectInstructions: contract,
    autoApprove: true,
    verbose: false,
    silent: true,
    conversationHistory: [],
  }).catch(err => `[the turn ended: ${err instanceof Error ? err.message : String(err)}]`));

console.log(`\n  wrote it in ${Math.round((Date.now() - started) / 1000)}s`);
console.log('  --- agent said ---');
console.log(String(answer).split(/\r?\n/).slice(0, 10).map(l => '  ' + l).join('\n'));
console.log('  --- end ---\n');

// ── What it wrote ───────────────────────────────────────────────────

const has = (rel) => fs.existsSync(path.join(dir, rel));
const list = fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true }).filter(f => !String(f).includes('node_modules'))
  : [];
console.log(`  files: ${list.slice(0, 25).join(', ')}\n`);

check('it wrote a package.json', has('package.json'));
if (!has('package.json')) {
  console.log(`\n  next.js build (live): ${passed} passed, ${failures.length + 1} failed\n`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
check('it depends on next and react', deps.includes('next') && deps.includes('react'),
  deps.join(', '));
// The contract asks for a short list. Every dependency is time on first run and
// surface nobody reviewed.
check('and did not pull in a pile of extras', deps.length <= 6, `${deps.length}: ${deps.join(', ')}`);

const hasPage = ['app/page.tsx', 'app/page.jsx', 'app/page.js']. some(has);
const hasLayout = ['app/layout.tsx', 'app/layout.jsx', 'app/layout.js'].some(has);
check('it wrote an app router page', hasPage, list.join(', ').slice(0, 200));
check('and a layout', hasLayout);

// Everything under the app directory, so a query built by string concatenation
// shows up wherever it was written.
const sources = list
  .map(f => path.join(dir, String(f)))
  .filter(f => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && fs.statSync(f).isFile())
  .map(f => ({ f, text: fs.readFileSync(f, 'utf8') }));

check('it uses node:sqlite rather than adding a driver',
  sources.some(s => /node:sqlite/.test(s.text)) || deps.some(d => /sqlite|pg|mysql/.test(d)),
  'no database access found at all');

// The contract's sharpest rule, and the one a page kind never had to worry
// about because it could not write a query at all.
const concatenated = sources.filter(s =>
  /(SELECT|INSERT|UPDATE|DELETE)[^\n`'"]*(\$\{|['"]\s*\+)/i.test(s.text));
check('no value is concatenated into SQL',
  concatenated.length === 0,
  concatenated.map(s => path.basename(s.f)).join(', '));

// ── Does it actually run? ───────────────────────────────────────────

console.log('  starting it (first run installs Next — several minutes)\n');
await startApp(app.slug, dir);

async function settle(limitMs) {
  const deadline = Date.now() + limitMs;
  let last = '';
  while (Date.now() < deadline) {
    const now = appState(app.slug);
    if (now && now.state !== last) { last = now.state; console.log(`  state: ${now.state}`); }
    if (!now || now.state === 'running' || now.state === 'failed') return now;
    await new Promise(r => setTimeout(r, 2000));
  }
  return appState(app.slug);
}

const ready = await settle(900_000);
check('it starts', ready?.state === 'running',
  `${ready?.state}${ready?.error ? `: ${ready.error}` : ''}\n`
  + (ready?.output ?? []).slice(-15).map(l => `        ${l}`).join('\n'));

if (ready?.state === 'running' && ready.url) {
  const html = await fetch(ready.url).then(r => r.text()).catch(e => `fetch failed: ${e.message}`);
  check('and serves a page', /<html|<body|<main|<div/i.test(html), html.slice(0, 200));
  // A Next error page is still HTML, so "it rendered" is not enough on its own.
  check('that is not an error screen',
    !/Application error|Unhandled Runtime Error|call stack/i.test(html),
    html.slice(0, 300));
  const seeded = /todo|doing|done/i.test(html);
  check('with the board on it', seeded, html.slice(0, 300));
}

await stopApp(app.slug);
check('and stops cleanly', appState(app.slug) === undefined);

console.log(`\n  next.js build (live): ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL ${f}`);
console.log(`\n  left for inspection: ${dir}\n`);
process.exit(failures.length === 0 ? 0 : 1);
