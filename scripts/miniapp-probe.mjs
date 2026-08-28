/**
 * Does a Mini App actually serve, persist, and refuse?
 *
 * This exercises the host the way a page and an attacker each would: real HTTP
 * against a real listening port, a real SQLite file on disk, and a restart in
 * the middle — because "the data is still there" is the one claim a single
 * process cannot make about itself.
 *
 *   node scripts/miniapp-probe.mjs
 *
 * Build first: npm run test:miniapps (or the tsup line inside it)
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { startMiniAppServer } = await import('../dist-test/miniapps/server.js');

const root = mkdtempSync(path.join(tmpdir(), 'aico-miniapp-'));
const settings = { workspace: { path: root } };
const dir = path.join(root, 'miniapps', 'invoices');
mkdirSync(path.join(dir, 'public'), { recursive: true });

writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
  slug: 'invoices', title: 'Invoices', createdAt: 1, updatedAt: 1, built: true,
}));

writeFileSync(path.join(dir, 'schema.sql'), `
CREATE TABLE IF NOT EXISTS invoices (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT    NOT NULL,
  total    REAL    NOT NULL DEFAULT 0,
  status   TEXT    NOT NULL DEFAULT 'draft'
);
`);

writeFileSync(path.join(dir, 'public', 'index.html'),
  '<!doctype html><title>Invoices</title><h1>Invoices</h1>');
// A file that must never be reachable from the public root.
writeFileSync(path.join(root, 'miniapps', 'secret.txt'), 'do not serve me');

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(detail ? `${name} — ${detail}` : name);
}

let server = await startMiniAppServer({ settings, cwd: root, sisterPort: 0 });
const base = server.url;

async function get(pathname, init) {
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json, headers: res.headers };
}

// ── the shape the page sees ─────────────────────────────────────────

const tables = await get('/invoices/api/tables');
check('describe returns the table', tables.json?.[0]?.name === 'invoices',
  JSON.stringify(tables.json));
check('describe finds the primary key',
  tables.json?.[0]?.columns?.find(c => c.name === 'id')?.primaryKey === true);
check('describe reports NOT NULL',
  tables.json?.[0]?.columns?.find(c => c.name === 'customer')?.notNull === true);

// ── CRUD ────────────────────────────────────────────────────────────

const created = await get('/invoices/api/invoices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer: 'Acme', total: 1200.5 }),
});
check('insert returns 201', created.status === 201, `got ${created.status}`);
check('insert echoes the stored row', created.json?.customer === 'Acme');
check('insert applies column defaults', created.json?.status === 'draft',
  `status was ${created.json?.status}`);
const id = created.json?.id;

await get('/invoices/api/invoices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer: 'Globex', total: 400 }),
});

const listed = await get('/invoices/api/invoices?orderBy=total&direction=desc');
check('list orders by the named column', listed.json?.[0]?.customer === 'Acme',
  JSON.stringify(listed.json));
check('list returns everything', listed.json?.length === 2);

const filtered = await get('/invoices/api/invoices?where.customer=Globex');
check('list filters on a column', filtered.json?.length === 1
  && filtered.json[0].customer === 'Globex', JSON.stringify(filtered.json));

const updated = await get(`/invoices/api/invoices/${id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'sent' }),
});
check('update returns the new row', updated.json?.status === 'sent',
  JSON.stringify(updated.json));
check('update leaves other columns alone', updated.json?.customer === 'Acme');

// ── the checks that matter ──────────────────────────────────────────

const badColumn = await get('/invoices/api/invoices?orderBy=total;DROP TABLE invoices');
check('an unknown orderBy is refused', badColumn.status === 400,
  `got ${badColumn.status}`);
const stillThere = await get('/invoices/api/invoices');
check('the table survived it', stillThere.json?.length === 2);

const badFilter = await get('/invoices/api/invoices?where.nope=1');
check('an unknown filter column is refused', badFilter.status === 400);

const badTable = await get('/invoices/api/sqlite_master');
check('a table outside the schema is refused', badTable.status === 400,
  `got ${badTable.status}`);

// A value that would end the string if it were ever concatenated.
const quoted = await get('/invoices/api/invoices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer: "O'Brien'); DROP TABLE invoices;--", total: 1 }),
});
check('a quote in a value is stored, not executed',
  quoted.json?.customer === "O'Brien'); DROP TABLE invoices;--",
  JSON.stringify(quoted.json));
const afterQuote = await get('/invoices/api/invoices');
check('the table survived the quote', afterQuote.json?.length === 3);

// Constraint violations belong to the caller, not the server.
const violating = await get('/invoices/api/invoices', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ total: 5 }),
});
check('a NOT NULL violation is a 400 with a message',
  violating.status === 400 && typeof violating.json?.error === 'string',
  `${violating.status} ${violating.text}`);

// ── serving ─────────────────────────────────────────────────────────

const page = await get('/invoices/');
check('the page is served', page.text.includes('<h1>Invoices</h1>'));
check('the page carries a CSP',
  (page.headers.get('content-security-policy') ?? '').includes("connect-src 'self'"),
  page.headers.get('content-security-policy'));

const bare = await fetch(`${base}/invoices`, { redirect: 'manual' });
check('a bare slug redirects to the canonical form',
  bare.status === 302 && bare.headers.get('location') === '/invoices/',
  `${bare.status} → ${bare.headers.get('location')}`);

const traversal = await get('/invoices/../secret.txt');
check('path traversal does not escape public/',
  traversal.status >= 400 && !traversal.text.includes('do not serve me'),
  `${traversal.status} ${traversal.text.slice(0, 40)}`);
const encodedTraversal = await get('/invoices/%2e%2e/%2e%2e/secret.txt');
check('encoded path traversal does not escape either',
  encodedTraversal.status >= 400 && !encodedTraversal.text.includes('do not serve me'),
  `${encodedTraversal.status} ${encodedTraversal.text.slice(0, 40)}`);

const runtime = await get('/_aico/aico.js');
check('the runtime client is served', runtime.text.includes('window.aico'));
const css = await get('/_aico/aico.css');
check('the stylesheet is served', css.text.includes('--accent'));
const alpine = await get('/_aico/alpine.js');
check('Alpine is served from node_modules',
  alpine.status === 200 && alpine.text.length > 10000,
  `${alpine.status}, ${alpine.text.length} bytes`);

const foreign = await get('/invoices/api/invoices', {
  headers: { Origin: 'http://127.0.0.1:1' },
});
check('a foreign origin is refused', foreign.status === 403, `got ${foreign.status}`);

const missing = await get('/nope/');
check('an unknown app is a 404', missing.status === 404);

const index = await get('/');
check('the index lists the app', index.text.includes('Invoices'));

// ── the claim a single process cannot make ──────────────────────────

await server.close();
server = await startMiniAppServer({ settings, cwd: root, sisterPort: 0 });
const afterRestart = await fetch(`${server.url}/invoices/api/invoices`).then(r => r.json());
check('data survives a restart', afterRestart.length === 3,
  `${afterRestart.length} rows after restart`);
check('the update survived too',
  afterRestart.find(r => r.customer === 'Acme')?.status === 'sent');

await server.close();
rmSync(root, { recursive: true, force: true });

for (const failure of failures) console.log(`  FAIL  ${failure}`);
console.log(`\nmini apps: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
