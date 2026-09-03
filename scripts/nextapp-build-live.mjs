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

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
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

// Source the agent wrote, not build output. `.next` holds Next's own compiled
// bundles — webpack runtime, polyfills, framework chunks — and judging the
// agent's SQL habits by reading those is judging the wrong author.
const GENERATED = new Set(['.next', 'node_modules', 'dist', 'build']);
const sources = list
  // Filtered on the RELATIVE path, before joining. Matching a directory name
  // inside an absolute path means caring about separators and about whatever
  // the temp directory happens to be called; the first segment of the relative
  // path says the same thing and cannot be argued with.
  .map(f => String(f))
  .filter(rel => !rel.split(/[\\/]/).some(seg => GENERATED.has(seg)))
  .map(rel => path.join(dir, rel))
  .filter(f => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && fs.statSync(f).isFile())
  .map(f => ({ f, text: fs.readFileSync(f, 'utf8') }));

check('it uses node:sqlite rather than adding a driver',
  sources.some(s => /node:sqlite/.test(s.text)) || deps.some(d => /sqlite|pg|mysql/.test(d)),
  'no database access found at all');

/*
  The contract's sharpest rule, and the one a page kind never had to worry
  about because it could not write a query at all.

  Interpolation is not injection, and the first version of this check could not
  tell the difference. It flagged

    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

  which is the correct way to build a partial UPDATE: the fragments are
  literals the function itself wrote ("title = ?"), and every value still goes
  through a placeholder. Condemning that alongside `${id}` teaches a reader to
  ignore the check, which is worse than not having one.

  So an interpolation is suspect unless it is a joined list of fragments. That
  is a heuristic, not a proof — `${values.join(',')}` would slip past it — and
  saying so here matters, because a check whose limits are unwritten gets
  trusted past them.
*/
/*
  Look at SQL sites, not at English.

  The version before this searched for the words SELECT/UPDATE/DELETE anywhere
  in a file and then for an interpolation within two hundred characters. In a
  React component that matches `updateTitle`, `onDelete` and
  `fetch('/api/tasks/update')` — so it condemned a client component containing
  no SQL whatsoever. Twice in a row it failed for a reason that had nothing to
  do with what it was checking.

  SQL reaches the database through `prepare(...)` or `exec(...)` and nowhere
  else, so that is what is read: the literal handed to one of those calls.
*/
const SQL_SITE = /\b(?:prepare|exec)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
const concatenated = sources.filter(({ text }) => {
  for (const [, literal] of text.matchAll(SQL_SITE)) {
    for (const [, expression] of literal.matchAll(/\$\{([^}]*)\}/g)) {
      // A joined list of fragments is how a partial UPDATE is built correctly;
      // the values still travel as placeholders. Anything else is a value.
      if (!/\.join\s*\(/.test(expression)) return true;
    }
  }
  // The other shape: a value glued on with + rather than interpolated.
  return /\b(?:prepare|exec)\s*\(\s*['"][^'"]*['"]\s*\+\s*[a-z_$]/i.test(text);
});
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
  /*
    Fetch the status, not just the body.

    A Next.js page that throws still answers with HTML — the dev error shell —
    so "it rendered something" passed while the app was returning 500 on every
    request. The status is the thing that cannot be argued with. Retried a few
    times because the dev server compiles a route on first request.
  */
  let res = { status: 0, html: '' };
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(ready.url)
      .then(async r => ({ status: r.status, html: await r.text() }))
      .catch(e => ({ status: 0, html: `fetch failed: ${e.message}` }));
    if (res.status === 200) break;
    await new Promise(r => setTimeout(r, 4000));
  }

  check('it answers 200 rather than an error page', res.status === 200,
    `HTTP ${res.status} — a page that throws still returns HTML, so the status is the check\n`
    + (ready.output ?? []).slice(-12).map(l => `        ${l}`).join('\n'));
  check('and serves a page', /<html|<body|<main|<div/i.test(res.html), res.html.slice(0, 160));
  check('with the board on it', /todo|doing|done/i.test(res.html), res.html.slice(0, 240));
}

await stopApp(app.slug);
check('and stops cleanly', appState(app.slug) === undefined);

console.log(`\n  next.js build (live): ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL ${f}`);
console.log(`\n  left for inspection: ${dir}\n`);
process.exit(failures.length === 0 ? 0 : 1);
