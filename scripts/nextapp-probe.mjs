/**
 * Does a Next.js Mini App actually install, start, serve and stop?
 *
 * The unit tests cover the environment scrubbing, which is the security claim.
 * This covers the mechanical one: that aico can take a directory with a
 * package.json in it, install its dependencies, run a dev server on a port it
 * chose, notice when it is ready, serve the page over HTTP, and then kill the
 * whole tree — which on Windows is a shim, npm and node, not one process.
 *
 * The app is written here rather than by a model on purpose. What is under test
 * is the runner, and a model-authored app would put its bugs in the way of the
 * runner's.
 *
 *   node scripts/nextapp-probe.mjs
 *
 * Slow — a real `npm install` of Next, several minutes the first time. Costs no
 * API tokens.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { startApp, stopApp, appState, subscribeToApps } =
  await import('../dist-test/test-exports.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); return; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-nextapp-'));
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

// The smallest thing that is genuinely a Next.js app: a real dependency set, a
// layout, a page, and a database read on the server so the SQLite path is
// exercised rather than described.
write('package.json', JSON.stringify({
  name: 'probe-app',
  private: true,
  scripts: { dev: 'next dev' },
  dependencies: { next: '^15', react: '^19', 'react-dom': '^19' },
}, null, 2));

write('next.config.mjs', 'export default {};\n');

write('lib/db.mjs', `import { DatabaseSync } from 'node:sqlite';
let handle;
export function db() {
  // Opened once per process. A module that connects per request exhausts file
  // handles under any real use, and the failure arrives long after the cause.
  if (!handle) {
    handle = new DatabaseSync('data.sqlite');
    handle.exec(\`CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)\`);
    handle.exec("INSERT OR IGNORE INTO notes (id, body) VALUES (1, 'from sqlite')");
  }
  return handle;
}
`);

write('app/layout.jsx', `export const metadata = { title: 'Probe App' };
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
`);

write('app/page.jsx', `import { db } from '../lib/db.mjs';
export const dynamic = 'force-dynamic';
export default function Page() {
  const rows = db().prepare('SELECT body FROM notes ORDER BY id').all();
  return (
    <main>
      <h1>Probe App</h1>
      <ul>{rows.map((r, i) => <li key={i}>{r.body}</li>)}</ul>
    </main>
  );
}
`);

console.log(`\n  app: ${dir}\n`);

const seen = new Set();
const detach = subscribeToApps((apps) => {
  for (const app of apps) {
    if (app.slug !== 'probe' || seen.has(app.state)) continue;
    seen.add(app.state);
    console.log(`  state: ${app.state}`);
  }
});

const started = await startApp('probe', dir);
check('starting returns immediately rather than blocking on npm install',
  ['starting', 'installing'].includes(started.state), `state was ${started.state}`);

/** Wait for the app to be running, or for it to give up. */
async function settle(limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const now = appState('probe');
    if (!now || now.state === 'running' || now.state === 'failed') return now;
    await new Promise(r => setTimeout(r, 1000));
  }
  return appState('probe');
}

const ready = await settle(600_000);
check('it reaches running', ready?.state === 'running',
  `${ready?.state}${ready?.error ? `: ${ready.error}` : ''}\n`
  + (ready?.output ?? []).slice(-12).map(l => `        ${l}`).join('\n'));

if (ready?.state === 'running') {
  check('it reports a port it chose', Boolean(ready.port), String(ready.port));
  check('and a URL', Boolean(ready.url), String(ready.url));
  // Reported as "installing" first, which is the state a first run spends
  // minutes in and the one a panel most needs to show.
  check('it passed through installing', seen.has('installing'),
    `states seen: ${[...seen].join(', ')}`);

  // The page renders server-side and reads SQLite. If the database line makes
  // it into the HTML, the whole path worked.
  const html = await fetch(ready.url).then(r => r.text()).catch(e => `fetch failed: ${e.message}`);
  check('it serves the rendered page', /Probe App/.test(html), html.slice(0, 160));
  check('and the page read its own database', /from sqlite/.test(html),
    'the SQLite row did not reach the HTML');
}

await stopApp('probe');
// The whole tree, not just the parent: on Windows the dev server is a shim,
// npm and node, and killing only the first leaves the port held.
const afterStop = ready?.url
  ? await fetch(ready.url).then(() => 'still answering').catch(() => 'gone')
  : 'gone';
check('stopping frees the port', afterStop === 'gone', afterStop);
check('and the app is no longer tracked', appState('probe') === undefined);

detach();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n  next.js mini app: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`    FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
