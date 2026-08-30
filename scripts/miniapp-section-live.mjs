/**
 * Can you change a Mini App by talking to its section?
 *
 * This is the headline claim of dedicated sections and the one thing about them
 * that had never been run. Everything else was verified around it: the binding
 * survives a reload, the scope bar names the app, the context assembles. None of
 * that proves the part people actually do — open the app's conversation, ask for
 * a change, and get it.
 *
 * Driven entirely through the running server's HTTP API, deliberately. Calling
 * `runAgent` directly would skip the binding route, the context injection and
 * the model resolution, which is most of what is under test.
 *
 *   node scripts/miniapp-section-live.mjs
 *
 * Costs money — one turn on deepseek-v4-flash via OpenRouter. Needs a built
 * `dist/` (npm run build) and OPENROUTER_API_KEY.
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MODEL = 'deepseek/deepseek-v4-flash';
const PORT = 7461;

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

// ── A workspace with one app already in it ──────────────────────────

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-section-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-section-ws-'));
fs.mkdirSync(path.join(home, '.aico'), { recursive: true });
fs.writeFileSync(path.join(home, '.aico', 'settings.json'), JSON.stringify({
  workspace: { path: ws },
  miniApps: { enabled: true, port: PORT + 1 },
  model: MODEL,
}, null, 2));

const slug = 'reading-log';
const dir = path.join(ws, 'miniapps', slug);
fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
  slug, title: 'Reading Log', description: 'Books and what I thought of them',
  createdAt: Date.now(), updatedAt: Date.now(), built: true,
}, null, 2));
fs.writeFileSync(path.join(dir, 'schema.sql'), `CREATE TABLE IF NOT EXISTS books (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  title  TEXT    NOT NULL,
  author TEXT    NOT NULL,
  status TEXT    NOT NULL DEFAULT 'reading'
);
INSERT OR IGNORE INTO books (id, title, author, status)
VALUES (1, 'Dune', 'Frank Herbert', 'finished');
`);
fs.writeFileSync(path.join(dir, 'public', 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reading Log</title>
<link rel="stylesheet" href="/_aico/aico.css">
<script src="/_aico/aico.js"></script>
<script defer src="/_aico/alpine.js"></script>
</head><body class="app-main" x-data="resource('books', { blank: { title: '', author: '', status: 'reading' } })" x-cloak>
<header class="app-header"><h1>Reading Log</h1></header>
<div class="card"><div class="table-wrap"><table class="table">
<thead><tr><th>Title</th><th>Author</th><th>Status</th></tr></thead>
<tbody><template x-for="b in rows" :key="b.id"><tr>
  <td x-text="b.title"></td><td x-text="b.author"></td><td x-text="b.status"></td>
</tr></template></tbody>
</table></div></div>
</body></html>
`);

console.log(`\n  home:      ${home}\n  workspace: ${ws}\n`);

// ── The server, as a real process ───────────────────────────────────

const server = spawn(process.execPath, [path.join(REPO, 'dist', 'index.js'), 'serve', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, USERPROFILE: home, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', c => { serverOut += c.toString(); });
server.stderr.on('data', c => { serverOut += c.toString(); });

const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); return true; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

if (!await waitForServer()) {
  console.log('server never came up:\n' + serverOut.slice(0, 800));
  stop();
  process.exit(1);
}
const token = (serverOut.match(/token=([A-Za-z0-9_-]+)/) || [])[1];
const H = { 'x-aico-token': token, 'Content-Type': 'application/json' };
const api = (p, init) => fetch(`http://127.0.0.1:${PORT}/api/${p}`, { headers: H, ...init })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ── Open the app's section, exactly as the panel does ───────────────

const bound = await api('miniapps/session', { method: 'POST', body: JSON.stringify({ slug }) });
check('the panel can open the app’s section', bound.status === 200 && bound.body.sessionId === `miniapp-${slug}`,
  JSON.stringify(bound.body));
const sessionId = bound.body.sessionId;

const before = fs.readFileSync(path.join(dir, 'public', 'index.html'), 'utf8');

// ── Ask for a change, the way a person would ────────────────────────
//
// Deliberately phrased without naming the app, the directory or the files. If
// the injected context is doing its job the agent already knows all three; if
// it is not, this is exactly the request that fails.

const ASK = 'Add a rating out of five. Books that are finished should be able to '
  + 'have one, and it should show in the table. Update the schema and the page.';

console.log(`  asking: "${ASK}"\n`);
const started = Date.now();
const submitted = await api('submit', {
  method: 'POST',
  body: JSON.stringify({ sessionId, task: ASK, model: MODEL, project: ws }),
});
check('the turn is accepted', submitted.status === 202, JSON.stringify(submitted.body));

/** Poll until the run reports it is no longer busy. */
async function waitForTurn(limitMs) {
  const deadline = Date.now() + limitMs;
  let sawBusy = false;
  while (Date.now() < deadline) {
    const s = await api(`session?id=${encodeURIComponent(sessionId)}`);
    const busy = s.body?.busy === true;
    if (busy) sawBusy = true;
    if (sawBusy && !busy) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

const finished = await waitForTurn(600_000);
check('the turn finishes', finished, `still running after ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`\n  turn took ${Math.round((Date.now() - started) / 1000)}s\n`);

// ── What actually changed ───────────────────────────────────────────

const after = fs.readFileSync(path.join(dir, 'public', 'index.html'), 'utf8');
const schema = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');

check('it changed the page', after !== before,
  'index.html is byte-identical — nothing was edited');
check('and the schema', /rating/i.test(schema), schema.slice(0, 160));
check('the page shows the rating', /rating/i.test(after),
  'no mention of rating in the page');

// The context names the directory. An agent that had to go looking would leave
// its search in the transcript, and that search is the cost this whole feature
// exists to remove.
const traj = await api(`trajectory?id=${encodeURIComponent(sessionId)}&limit=200`);
const calls = (traj.body?.events ?? traj.body?.rows ?? [])
  .filter(e => e.type === 'tool/call')
  .map(e => String(e.data?.name ?? ''));
console.log(`  tool calls: ${calls.length ? calls.join(', ') : '(none recorded)'}\n`);
check('it did not go hunting the filesystem',
  calls.filter(n => n === 'Glob' || n === 'LS').length <= 2,
  `${calls.filter(n => n === 'Glob' || n === 'LS').length} Glob/LS calls`);

// ── Does the app still work? ────────────────────────────────────────

const host = `http://127.0.0.1:${PORT + 1}/${slug}`;
const tables = await fetch(`${host}/api/tables`).then(r => r.json()).catch(e => ({ err: e.message }));
const books = Array.isArray(tables) ? tables.find(t => t.name === 'books') : undefined;
check('the schema still applies', Boolean(books), JSON.stringify(tables).slice(0, 160));
check('and the new column is really there',
  Boolean(books?.columns?.some(c => /rating/i.test(c.name))),
  books ? books.columns.map(c => c.name).join(', ') : 'no books table');

const rows = await fetch(`${host}/api/books`).then(r => r.json()).catch(() => null);
check('the existing row survived the change', Array.isArray(rows) && rows.length > 0,
  `${Array.isArray(rows) ? rows.length : 0} rows — a migration that dropped data would be worse than one that failed`);

const page = await fetch(`${host}/`).then(r => r.text()).catch(e => `failed: ${e.message}`);
check('the page still serves', /Reading Log/.test(page), page.slice(0, 120));

stop();

/*
  Report first, tidy up afterwards, and never let tidying up decide the outcome.

  The first version deleted the temp directories before printing, and on Windows
  the mini-app host still held `data.sqlite` — so `rmSync` threw, the process
  died, and a run whose checks had all completed reported nothing at all. A
  cleanup step that can hide a result is worse than no cleanup step.
*/
console.log(`\n  mini app section (live): ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL ${f}`);

for (const dead of [home, ws]) {
  try {
    fs.rmSync(dead, { recursive: true, force: true });
  } catch (err) {
    console.log(`  (left behind ${dead}: ${err instanceof Error ? err.message : String(err)})`);
  }
}
process.exit(failures.length === 0 ? 0 : 1);
