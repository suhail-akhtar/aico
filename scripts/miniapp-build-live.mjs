/**
 * Can the agent actually build a working Mini App, unaided?
 *
 * Everything else about Mini Apps is tested against fixtures I wrote by hand,
 * which proves the server and says nothing about the part that matters: whether
 * the contract is good enough that a model reads it and produces a working app.
 * A contract can be beautifully argued and still leave out the one sentence
 * that would have stopped a blank page.
 *
 * So this hands a real model a real brief and then checks the result the way a
 * person would — over HTTP, against the running host, looking at what the page
 * and the database actually contain.
 *
 *   node scripts/miniapp-build-live.mjs
 *
 * Costs money. Uses deepseek-v4-flash through OpenRouter.
 *
 * Do NOT run `npm test` while this is in flight: that rebuilds dist-test with
 * --clean, and this script imports from it. A run killed that way looks exactly
 * like a run that hung — the host stops answering and the verdict never
 * prints. Learned the expensive way.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  runAgent, runInContext, loadSettings, createMiniApp, miniAppDir, miniAppContext,
} = await import('../dist-test/test-exports.js');
const { startMiniAppServer } = await import('../dist-test/miniapps/server.js');

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-miniapp-build-'));
const settings = { ...(await loadSettings()), workspace: { path: root }, miniApps: { enabled: true } };

const app = await createMiniApp(
  { title: 'Reading Log', description: 'Books I am reading and what I thought of them' },
  settings, root,
);
const dir = miniAppDir(app.slug, settings, root);
console.log(`\n  workspace: ${root}\n  app: ${dir}\n`);

/*
  The app's context, exactly as a bound session gets it.

  The first version of this test skipped the binding and let the agent find the
  app itself. It went looking — a filesystem-wide listing of the home directory,
  280KB of paths — and burned through the 100-step cap without finishing, having
  written the files in the first ninety seconds. That is the cost of a missing
  fact, and it is the whole argument for putting the app's directory, schema and
  file list in the system prompt rather than making the model hunt for them.
*/
// The host runs for the whole test, so the agent can open the page it is
// building — exactly as a real Mini App session does. The first version passed
// a port that nothing was listening on, and the agent spent its entire budget
// hunting the filesystem for the missing server.
const host = await startMiniAppServer({ settings, cwd: root, sisterPort: 0 });
const appUrl = `${host.url}/${app.slug}/`;
const appContext = await miniAppContext(app, dir, appUrl, true);
console.log(`  served at: ${appUrl}
`);

const started = Date.now();
const answer = await runInContext({ cwd: root, sessionId: 'live-miniapp-build', settings }, () =>
  runAgent({
    task: [
      'Build this reading log.',
      'Track books with a title, author, status (want to read / reading / finished),',
      'a rating out of five once finished, and a short note.',
      'The main screen should tell me at a glance how many I have finished and what I am reading now.',
      'Do not ask me any questions — decide sensibly and build it.',
      'Seed a few realistic rows so the first screen is not empty.',
    ].join(' '),
    model: MODEL,
    cwd: root,
    sessionId: 'live-miniapp-build',
    settings: { ...settings, maxIterations: 45 },
    projectInstructions: appContext,
    autoApprove: true,
    verbose: false,
    silent: true,
    conversationHistory: [],
  }));

console.log(`\n  built in ${Math.round((Date.now() - started) / 1000)}s`);
console.log('  --- agent said ---');
console.log(answer.split(/\r?\n/).slice(0, 12).map(l => '  ' + l).join('\n'));
console.log('  --- end ---\n');

// ── What is on disk ─────────────────────────────────────────────────

const schemaPath = path.join(dir, 'schema.sql');
const pagePath = path.join(dir, 'public', 'index.html');
check('it wrote a schema', fs.existsSync(schemaPath));
check('it wrote a page', fs.existsSync(pagePath));

if (!fs.existsSync(pagePath)) {
  console.log(`\n  miniapp build (live): ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`    FAIL ${f}`);
  process.exit(1);
}

const page = fs.readFileSync(pagePath, 'utf8');

// The three lines the contract insists on. Each has a specific failure mode:
// no runtime means no data client, no Alpine means a dead page, and the wrong
// order means Alpine starts before the components are registered.
check('the page loads the shipped stylesheet', /_aico\/aico\.css/.test(page));
check('and the runtime before Alpine',
  page.indexOf('_aico/aico.js') > 0
  && page.indexOf('_aico/aico.js') < page.indexOf('_aico/alpine.js'),
  'aico.js must be registered before Alpine auto-starts');

// A CDN link would have been silently killed by the CSP, which is exactly the
// failure the contract exists to prevent.
check('it did not reach for a CDN',
  !/https?:\/\/(cdn|unpkg|jsdelivr|fonts\.googleapis)/i.test(page),
  'the CSP would have blocked it, and the page would render unstyled');

check('it uses the data client rather than hand-rolled fetch',
  /aico\.db\./.test(page), 'no aico.db call found');

// ── What the server says ────────────────────────────────────────────

const base = `${host.url}/${app.slug}`;

const tables = await fetch(`${base}/api/tables`).then(r => r.json());
check('the schema applied', Array.isArray(tables) && tables.length > 0,
  JSON.stringify(tables).slice(0, 120));

const table = Array.isArray(tables) ? tables[0] : undefined;
check('and its table has a primary key',
  Boolean(table?.columns?.some(c => c.primaryKey)),
  'update and delete address rows by primary key and refuse a table without one');

if (table) {
  const rows = await fetch(`${base}/api/${encodeURIComponent(table.name)}`).then(r => r.json());
  check('it seeded real rows', Array.isArray(rows) && rows.length > 0,
    `${Array.isArray(rows) ? rows.length : 0} row(s) in ${table.name}`);
  console.log(`\n  ${table.name}: ${table.columns.map(c => c.name).join(', ')}`);
  if (Array.isArray(rows)) {
    for (const row of rows.slice(0, 3)) console.log(`    ${JSON.stringify(row).slice(0, 110)}`);
  }
  console.log('');
}

const served = await fetch(`${base}/`).then(r => r.text());
check('the page is served by the host', served.includes('<'), served.slice(0, 80));

await host.close();

console.log(`\n  miniapp build (live): ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL ${f}`);
console.log(`\n  left in place for inspection: ${dir}\n`);
process.exit(failures.length === 0 ? 0 : 1);
