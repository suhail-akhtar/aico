/**
 * Task 1 — an enterprise-style API from an empty folder: multi-tenant orders
 * with JWT auth, role-based access, validation, structured errors,
 * pagination, versioned migrations and tests.
 *
 * The stack is the agent's choice (Node or Python, SQLite) but the contract is
 * fixed, the way a real platform team hands one over: endpoints, claim names,
 * error codes, and a `bench.json` naming the install/test/start commands. That
 * is what lets the grader be black-box and stack-agnostic. It mints its own
 * JWTs (so it can also mint expired, wrongly signed and `alg: none` ones),
 * starts the server on a fresh database, and checks the behaviours that
 * actually separate a working multi-tenant API from a demo: cross-tenant
 * reads/writes/deletes are 404 rather than leaks, every role is denied what it
 * should be, validation rejects the edges, pagination is exact, and data and
 * migrations survive a restart.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  sh, startProcess, freePort, waitForHttp, http, mintJwt, listFiles, readText,
} from '../../lib/util.mjs';

const SECRET = 'eng-bench-grader-signing-key';

export default {
  id: 'enterprise-api',
  title: 'Enterprise API (multi-tenant orders, JWT, RBAC)',
  soft: false,

  setup(project) {
    fs.mkdirSync(project, { recursive: true });
  },

  prompt: [
    'Build a multi-tenant REST API for orders, from scratch, in this empty project folder.',
    '',
    'Stack: your choice of Node.js (22+) or Python (3.11+), with SQLite for storage. If you choose Python, install',
    'dependencies into a virtualenv at .venv inside the project, never into the global interpreter.',
    '',
    'Create bench.json at the project root naming three shell commands, run from the project root by the',
    'platform\'s default shell (cmd.exe on Windows): {"install": "...", "test": "...", "start": "..."}. "start" runs',
    'the server in the foreground, listening on the port in the PORT environment variable, storing data in the',
    'SQLite file named by DATABASE_PATH (created if missing), and verifying tokens with the secret in JWT_SECRET.',
    '',
    'Authentication: every endpoint except GET /health requires "Authorization: Bearer <token>". Tokens are HS256',
    'JWTs issued by our identity service (not by this API), signed with JWT_SECRET, with claims sub (user id),',
    'tenant_id (string), role ("admin" | "manager" | "viewer") and exp. A missing, malformed, wrongly signed or',
    'expired token -> 401.',
    '',
    'Authorization: viewer may read; manager may read, create and update; admin may also delete. Anything else -> 403,',
    'including a role outside those three.',
    '',
    'Multi-tenancy: every order belongs to the tenant_id of the token that created it. A tenant can never see, change',
    'or delete another tenant\'s orders; to them those orders do not exist (404).',
    '',
    'Endpoints (JSON in and out; a single resource is returned as the object itself, without an envelope):',
    '- GET /health -> 200 {"status": "ok"}, no auth.',
    '- POST /orders with {customer: string 1-200 chars, items: array of 1-100 {sku: string 1-64 chars, quantity:',
    '  integer >= 1, unit_price: number >= 0}, notes?: string up to 1000 chars} -> 201 with the order.',
    '- GET /orders?page=1&page_size=20 -> 200 {data: [orders], page, page_size, total}, oldest first (creation order).',
    '  page is an integer >= 1 (default 1); page_size an integer 1-100 (default 20); any other value -> 400.',
    '- GET /orders/{id} -> 200 with the order.',
    '- PATCH /orders/{id} with {status} where status is one of pending, paid, shipped, cancelled -> 200 with the order.',
    '- DELETE /orders/{id} -> 204.',
    'An order is {id, tenant_id, customer, items, total, status, notes, created_at, updated_at}; status starts as',
    '"pending"; total is the sum of quantity * unit_price rounded to 2 decimals.',
    '',
    'Errors: always {"error": {"code": "...", "message": "...", "details"?: ...}} with code validation_error (400,',
    'including malformed JSON), unauthorized (401), forbidden (403), not_found (404) or internal (500). Never return',
    'a stack trace.',
    '',
    'Database: the schema is managed by versioned migrations in a migrations/ directory, applied automatically at',
    'startup, recorded in the database, and safe to run on every start.',
    '',
    'Tests: an automated suite, run by bench.json\'s "test" command, covering auth, roles, tenant isolation,',
    'validation and pagination.',
    '',
    'When you finish, the API must work exactly as specified when installed and started with bench.json\'s commands',
    'against a fresh, empty database.',
  ].join('\n'),

  async grade({ project, check, log }) {
    let bench = null;
    try { bench = JSON.parse(readText(path.join(project, 'bench.json'))); } catch { /* recorded below */ }
    const ok = bench && ['install', 'test', 'start'].every((k) => typeof bench[k] === 'string' && bench[k].trim());
    check('bench.json names install/test/start', ok, ok ? JSON.stringify(bench) : 'missing or incomplete');
    const files = listFiles(project);
    const stack = files.includes('package.json') ? 'node' : files.some((f) => /\.py$/.test(f)) ? 'python' : 'unknown';
    if (!ok) return { stack, files: files.length };

    const install = sh(bench.install, { cwd: project, timeoutMs: 600_000 });
    check('install succeeds', install.code === 0, install.code === 0 ? '' : (install.err || install.out).slice(-300));
    const tests = sh(bench.test, { cwd: project, timeoutMs: 300_000, env: { JWT_SECRET: SECRET } });
    check('its own test suite passes', tests.code === 0, (tests.out + tests.err).trim().split('\n').slice(-3).join(' | ').slice(0, 300));
    const testFiles = files.filter((f) => /(^|\/)(tests?|__tests__)\/|[._-]test\.|test_.*\.py$|_test\.py$|\.spec\./i.test(f));
    check('has test files', testFiles.length > 0, testFiles.slice(0, 6).join(', '));
    const migrationFiles = files.filter((f) => /(^|\/)migrations?\//i.test(f) && !/__init__|__pycache__/.test(f));
    check('versioned migration files exist', migrationFiles.length > 0, migrationFiles.slice(0, 5).join(', '));

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-bench-orders-'));
    const dbFile = path.join(dataDir, 'orders.db');
    const port = await freePort();
    const env = { PORT: String(port), DATABASE_PATH: dbFile, JWT_SECRET: SECRET };
    const base = `http://127.0.0.1:${port}`;
    let srv = startProcess(bench.start, { cwd: project, env });
    const up = await waitForHttp(`${base}/health`, { proc: srv, timeoutMs: 60_000 });
    check('server starts on a fresh database', up, up ? '' : srv.output().slice(-400));
    const extra = { stack, port, dbFile };
    if (!up) { await srv.stop(); return extra; }

    const now = Math.floor(Date.now() / 1000);
    const tok = (tenant, role, over = {}) => mintJwt({ sub: `u-${tenant}-${role}`, tenant_id: tenant, role, iat: now, exp: now + 3600, ...over }, SECRET);
    const A = { admin: tok('acme', 'admin'), manager: tok('acme', 'manager'), viewer: tok('acme', 'viewer') };
    const B = { admin: tok('globex', 'admin'), manager: tok('globex', 'manager'), viewer: tok('globex', 'viewer') };
    const code = (r) => r.json?.error?.code;
    const is = (r, status, c) => r.status === status && code(r) === c;
    const show = (r) => `${r.status} ${r.text.slice(0, 120)}`;

    const health = await http(base, 'GET', '/health');
    check('GET /health is 200 {status:"ok"}', health.status === 200 && health.json?.status === 'ok', show(health));

    // ── Authentication ─────────────────────────────────────────────────────
    const authCases = [
      ['no token', {}],
      ['malformed token', { headers: { authorization: 'Bearer not.a.jwt' } }],
      ['wrong signature', { token: mintJwt({ sub: 'x', tenant_id: 'acme', role: 'admin', exp: now + 3600 }, 'some-other-secret') }],
      ['expired token', { token: tok('acme', 'admin', { exp: now - 60 }) }],
      ['alg none', { token: mintJwt({ sub: 'x', tenant_id: 'acme', role: 'admin', exp: now + 3600 }, SECRET, { alg: 'none' }) }],
    ];
    const authFails = [];
    for (const [label, opts] of authCases) {
      const r = await http(base, 'GET', '/orders', opts);
      if (!is(r, 401, 'unauthorized')) authFails.push(`${label}: ${show(r)}`);
    }
    check('401 unauthorized for missing/malformed/forged/expired/alg-none tokens', authFails.length === 0, authFails.join('; '));

    // ── Create, totals, roles ──────────────────────────────────────────────
    const order = { customer: 'Wayne Enterprises', items: [{ sku: 'BOLT-9', quantity: 3, unit_price: 19.99 }, { sku: 'NUT-2', quantity: 10, unit_price: 0.35 }], notes: 'dock 4' };
    const created = await http(base, 'POST', '/orders', { token: A.manager, body: order });
    const o = created.json ?? {};
    check('manager creates an order (201, tenant, pending, total)', created.status === 201 && o.id != null && o.tenant_id === 'acme'
      && o.status === 'pending' && Math.abs(Number(o.total) - 63.47) < 0.005 && o.customer === order.customer && Array.isArray(o.items), show(created));
    const id = o.id;
    const viewerPost = await http(base, 'POST', '/orders', { token: A.viewer, body: order });
    check('viewer cannot create (403 forbidden)', is(viewerPost, 403, 'forbidden'), show(viewerPost));
    const oddRole = await http(base, 'GET', '/orders', { token: tok('acme', 'superuser') });
    check('unknown role is 403 forbidden', is(oddRole, 403, 'forbidden'), show(oddRole));
    const viewerRead = await http(base, 'GET', `/orders/${id}`, { token: A.viewer });
    check('viewer can read', viewerRead.status === 200 && String(viewerRead.json?.id) === String(id), show(viewerRead));
    const viewerPatch = await http(base, 'PATCH', `/orders/${id}`, { token: A.viewer, body: { status: 'paid' } });
    const managerDelete = await http(base, 'DELETE', `/orders/${id}`, { token: A.manager });
    const viewerDelete = await http(base, 'DELETE', `/orders/${id}`, { token: A.viewer });
    check('viewer cannot update, manager/viewer cannot delete (403)', is(viewerPatch, 403, 'forbidden') && is(managerDelete, 403, 'forbidden') && is(viewerDelete, 403, 'forbidden'),
      `${show(viewerPatch)} / ${show(managerDelete)} / ${show(viewerDelete)}`);

    // ── Validation ─────────────────────────────────────────────────────────
    const invalid = [
      ['missing customer', { items: order.items }],
      ['blank customer', { customer: '', items: order.items }],
      ['201-char customer', { customer: 'x'.repeat(201), items: order.items }],
      ['empty items', { customer: 'c', items: [] }],
      ['quantity 0', { customer: 'c', items: [{ sku: 'a', quantity: 0, unit_price: 1 }] }],
      ['fractional quantity', { customer: 'c', items: [{ sku: 'a', quantity: 1.5, unit_price: 1 }] }],
      ['negative price', { customer: 'c', items: [{ sku: 'a', quantity: 1, unit_price: -1 }] }],
      ['string price', { customer: 'c', items: [{ sku: 'a', quantity: 1, unit_price: '1' }] }],
      ['missing sku', { customer: 'c', items: [{ quantity: 1, unit_price: 1 }] }],
      ['1001-char notes', { customer: 'c', items: order.items, notes: 'n'.repeat(1001) }],
    ];
    const valFails = [];
    for (const [label, body] of invalid) {
      const r = await http(base, 'POST', '/orders', { token: A.admin, body });
      if (!is(r, 400, 'validation_error')) valFails.push(`${label}: ${show(r)}`);
    }
    check('invalid orders are 400 validation_error (10 cases)', valFails.length === 0, valFails.join('; '));
    const malformed = await http(base, 'POST', '/orders', { token: A.admin, rawBody: '{"customer": "c", ' });
    check('malformed JSON is 400 validation_error', is(malformed, 400, 'validation_error'), show(malformed));
    const edge = await http(base, 'POST', '/orders', { token: A.admin, body: { customer: 'x'.repeat(200), items: [{ sku: 's'.repeat(64), quantity: 1, unit_price: 0 }] } });
    check('boundary values are accepted (200-char customer, 64-char sku, price 0)', edge.status === 201, show(edge));
    const badStatus = await http(base, 'PATCH', `/orders/${id}`, { token: A.manager, body: { status: 'teleported' } });
    check('invalid status update is 400 validation_error', is(badStatus, 400, 'validation_error'), show(badStatus));

    // ── Tenant isolation ───────────────────────────────────────────────────
    const bGet = await http(base, 'GET', `/orders/${id}`, { token: B.admin });
    const bPatch = await http(base, 'PATCH', `/orders/${id}`, { token: B.admin, body: { status: 'cancelled' } });
    const bDelete = await http(base, 'DELETE', `/orders/${id}`, { token: B.admin });
    check('another tenant gets 404 not_found on read/update/delete', is(bGet, 404, 'not_found') && is(bPatch, 404, 'not_found') && is(bDelete, 404, 'not_found'),
      `${show(bGet)} / ${show(bPatch)} / ${show(bDelete)}`);
    const stillThere = await http(base, 'GET', `/orders/${id}`, { token: A.viewer });
    check('the order survives the other tenant\'s attempts unchanged', stillThere.status === 200 && stillThere.json?.status === 'pending', show(stillThere));
    await http(base, 'POST', '/orders', { token: B.manager, body: { customer: 'Globex only', items: [{ sku: 'g', quantity: 1, unit_price: 5 }] } });
    const bList = await http(base, 'GET', '/orders', { token: B.viewer });
    check('list shows only the caller\'s tenant', bList.status === 200 && bList.json?.total === 1 && bList.json?.data?.length === 1
      && bList.json.data[0].customer === 'Globex only', show(bList));

    // ── Pagination, on a tenant of its own so earlier failures cannot cascade ──
    const C = { manager: tok('initech', 'manager'), viewer: tok('initech', 'viewer'), admin: tok('initech', 'admin') };
    for (let i = 0; i < 25; i++) await http(base, 'POST', '/orders', { token: C.manager, body: { customer: `Page ${String(i).padStart(2, '0')}`, items: [{ sku: 'p', quantity: 1, unit_price: i }] } });
    const def = await http(base, 'GET', '/orders', { token: C.viewer });
    check('default page is 20 of total 25', def.status === 200 && def.json?.data?.length === 20 && def.json?.total === 25 && def.json?.page === 1 && def.json?.page_size === 20, `${def.status} len=${def.json?.data?.length} total=${def.json?.total}`);
    const pages = [];
    for (const p of [1, 2, 3]) pages.push(await http(base, 'GET', `/orders?page=${p}&page_size=10`, { token: C.viewer }));
    const ids = pages.flatMap((r) => r.json?.data ?? []).map((x) => String(x.id));
    const customers = pages.flatMap((r) => r.json?.data ?? []).map((x) => x.customer);
    check('page_size=10 pages are exact, disjoint and complete', pages[2].json?.data?.length === 5 && new Set(ids).size === 25 && pages[1].json?.page === 2,
      `sizes ${pages.map((r) => r.json?.data?.length).join('/')}, unique ${new Set(ids).size}`);
    check('oldest first', customers.length === 25 && customers.every((c, i) => c === `Page ${String(i).padStart(2, '0')}`), customers.slice(0, 3).join(', '));
    const beyond = await http(base, 'GET', '/orders?page=9&page_size=10', { token: C.viewer });
    check('a page past the end is 200 with no data', beyond.status === 200 && beyond.json?.data?.length === 0 && beyond.json?.total === 25, show(beyond));
    const pageFails = [];
    for (const q of ['page_size=0', 'page_size=101', 'page=0', 'page=-1', 'page=abc', 'page_size=2.5']) {
      const r = await http(base, 'GET', `/orders?${q}`, { token: C.viewer });
      if (!is(r, 400, 'validation_error')) pageFails.push(`${q}: ${show(r)}`);
    }
    check('bad page/page_size are 400 validation_error', pageFails.length === 0, pageFails.join('; '));

    // ── Update, delete ─────────────────────────────────────────────────────
    const paid = await http(base, 'PATCH', `/orders/${id}`, { token: A.manager, body: { status: 'paid' } });
    check('manager updates status', paid.status === 200 && paid.json?.status === 'paid', show(paid));
    const victim = def.json?.data?.[5]?.id;
    const del = await http(base, 'DELETE', `/orders/${victim}`, { token: C.admin });
    const gone = await http(base, 'GET', `/orders/${victim}`, { token: C.admin });
    check('admin deletes (204), then it is 404', del.status === 204 && is(gone, 404, 'not_found'), `${show(del)} / ${show(gone)}`);
    const unknown = await http(base, 'GET', '/orders/does-not-exist-123', { token: A.admin });
    check('unknown id is 404 with the error shape', is(unknown, 404, 'not_found') && typeof unknown.json?.error?.message === 'string', show(unknown));
    const leak = [malformed, unknown, badStatus].some((r) => /\bat\s+\S+\s+\(|Traceback \(most recent call last\)/.test(r.text));
    check('no stack traces in error responses', !leak, '');

    // ── Restart: data and migrations survive ───────────────────────────────
    await srv.stop();
    srv = startProcess(bench.start, { cwd: project, env });
    const again = await waitForHttp(`${base}/health`, { proc: srv, timeoutMs: 60_000 });
    const after = again ? await http(base, 'GET', `/orders/${id}`, { token: A.viewer }) : { status: 0, text: srv.output().slice(-300) };
    check('restart on the same database keeps data (migrations re-run safely)', again && after.status === 200 && after.json?.status === 'paid', show(after));
    await srv.stop();

    let tables = [];
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      db.close();
    } catch (e) { tables = [`(could not open: ${e.message})`]; }
    check('applied migrations are recorded in the database', tables.some((t) => /migrat|alembic_version|schema_version/i.test(t)), tables.join(', '));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* a locked db file on Windows is harmless here */ }
    return { ...extra, tables };
  },
};
