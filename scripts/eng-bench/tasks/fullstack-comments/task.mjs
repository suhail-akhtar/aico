/**
 * Task 5 — a full-stack feature in an existing app: ticket comments, from a
 * migration through the API to the UI, with tests.
 *
 * The app is deliberately framework-free (node:http, node:sqlite, a plain JS
 * page) so the agent has to read and follow the project's own conventions —
 * the migration runner, the error shape, the `el()` DOM helper — rather than
 * reach for a scaffold. The grader starts the app itself on a fresh database,
 * checks the API black-box (shapes, ordering, validation boundaries, 404s,
 * counts on the existing endpoints), then drives the UI in a real browser:
 * add a comment without a reload, see the server's rejection, reload and
 * still see it, and render user text as text (a `<b>` in a comment must not
 * become an element).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  copyDir, gitInit, gitChanged, runNodeTests, listFiles, readText, sha256,
  startProcess, freePort, waitForHttp, http, findBrowser,
} from '../../lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'fullstack-comments',
  title: 'Full-stack feature (DB + API + UI + tests)',
  soft: false,

  setup(project) {
    copyDir(path.join(here, 'fixture'), project);
    gitInit(project);
  },

  prompt: [
    'Feature request from the support team lead: agents need to leave internal comments on a ticket (who said',
    'what, and when), and to see at a glance which tickets have a discussion going.',
    '',
    'Implement it end to end in this app (helpdesk):',
    '- Database: a new migration adding comments linked to tickets. Do not edit migrations that already exist.',
    '- API:',
    '  - GET /api/tickets/:id/comments -> 200 with the ticket\'s comments, oldest first, each',
    '    { id, ticket_id, author, body, created_at }.',
    '  - POST /api/tickets/:id/comments with { author, body } -> 201 with the created comment. author is required,',
    '    1-100 characters after trimming; body is required, 1-2000 characters after trimming. Invalid input -> 400',
    '    validation_error; unknown ticket -> 404 not_found; same error shape as the rest of the API.',
    '  - GET /api/tickets and GET /api/tickets/:id also include comment_count for each ticket.',
    '- UI (public/): in the ticket detail panel, list the ticket\'s comments (container data-testid="comment-list",',
    '  one data-testid="comment-item" per comment showing its author and body) and a form to add one (author input',
    '  data-testid="comment-author", textarea data-testid="comment-body", button data-testid="comment-submit").',
    '  A new comment appears straight away without reloading the page. When the server rejects a comment, show its',
    '  message in an element with data-testid="comment-error". Each ticket row in the list shows the ticket\'s',
    '  comment count in an element with data-testid="comment-count".',
    '- Tests: add API tests for the new endpoints next to the existing ones. npm test must pass.',
  ].join('\n'),

  async grade({ project, check, log }) {
    const testFiles = listFiles(path.join(project, 'test')).filter((f) => /\.m?js$/.test(f)).map((f) => `test/${f}`);
    const suite = runNodeTests(testFiles, { cwd: project });
    check('npm-test-passes', suite.tests.length >= 4 && suite.failed === 0 && suite.code === 0, `${suite.passed}/${suite.tests.length} passed`);
    const testText = testFiles.map((f) => readText(path.join(project, f))).join('\n');
    check('comment-tests-added', /\/comments\b/.test(testText), '');

    const migrations = listFiles(path.join(project, 'migrations'));
    const original = sha256(readText(path.join(here, 'fixture', 'migrations', '001_init.sql')));
    check('new-migration-added', migrations.some((f) => f.endsWith('.sql') && f !== '001_init.sql'), migrations.join(', '));
    check('existing-migration-untouched', sha256(readText(path.join(project, 'migrations', '001_init.sql'))) === original);

    // ── Black-box API ──────────────────────────────────────────────────────
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-bench-helpdesk-'));
    const app = startProcess('node server.js', { cwd: project, env: { PORT: String(port), DB_PATH: path.join(dataDir, 'grade.db') } });
    const base = `http://127.0.0.1:${port}`;
    const up = await waitForHttp(`${base}/api/tickets`, { proc: app });
    check('app-starts-on-fresh-db', up, up ? '' : app.output().slice(-400));
    let t1, t2;
    if (up) {
      t1 = (await http(base, 'POST', '/api/tickets', { body: { title: 'Laptop will not boot' } })).json;
      t2 = (await http(base, 'POST', '/api/tickets', { body: { title: 'Badge reader offline' } })).json;
      const a = await http(base, 'POST', `/api/tickets/${t1.id}/comments`, { body: { author: 'Ana', body: 'Asked for the serial number.' } });
      check('api: create returns 201 with the comment', a.status === 201 && a.json?.ticket_id === t1.id && a.json?.author === 'Ana'
        && a.json?.body === 'Asked for the serial number.' && a.json?.id != null && Boolean(a.json?.created_at), `${a.status} ${a.text.slice(0, 160)}`);
      await http(base, 'POST', `/api/tickets/${t1.id}/comments`, { body: { author: 'Bo', body: 'Replaced the battery.' } });
      const list = await http(base, 'GET', `/api/tickets/${t1.id}/comments`);
      check('api: list is oldest first and scoped to the ticket', list.status === 200 && Array.isArray(list.json)
        && list.json.map((c) => c.author).join(',') === 'Ana,Bo', `${list.status} ${list.text.slice(0, 160)}`);
      const empty = await http(base, 'GET', `/api/tickets/${t2.id}/comments`);
      check('api: a ticket without comments lists []', empty.status === 200 && Array.isArray(empty.json) && empty.json.length === 0, empty.text.slice(0, 100));

      const bad = async (body, raw) => {
        const r = raw ? await http(base, 'POST', `/api/tickets/${t1.id}/comments`, { rawBody: raw }) : await http(base, 'POST', `/api/tickets/${t1.id}/comments`, { body });
        return r.status === 400 && r.json?.error?.code === 'validation_error' ? null : `${r.status} ${r.text.slice(0, 80)}`;
      };
      const failures = [];
      for (const [label, body] of [['empty body', { author: 'Ana', body: '' }], ['whitespace body', { author: 'Ana', body: '   ' }],
        ['2001-char body', { author: 'Ana', body: 'x'.repeat(2001) }], ['missing author', { body: 'hi' }],
        ['101-char author', { author: 'a'.repeat(101), body: 'hi' }], ['non-string body', { author: 'Ana', body: 42 }]]) {
        const why = await bad(body);
        if (why) failures.push(`${label}: ${why}`);
      }
      const malformed = await bad(null, '{"author":');
      if (malformed) failures.push(`malformed JSON: ${malformed}`);
      check('api: invalid comments are 400 validation_error', failures.length === 0, failures.join('; '));
      const edge = await http(base, 'POST', `/api/tickets/${t1.id}/comments`, { body: { author: 'a'.repeat(100), body: 'y'.repeat(2000) } });
      check('api: boundary values (100/2000 chars) are accepted', edge.status === 201, `${edge.status}`);

      const g404 = await http(base, 'GET', '/api/tickets/99999/comments');
      const p404 = await http(base, 'POST', '/api/tickets/99999/comments', { body: { author: 'Ana', body: 'hi' } });
      check('api: unknown ticket is 404 not_found', g404.status === 404 && p404.status === 404 && p404.json?.error?.code === 'not_found', `${g404.status}/${p404.status}`);

      const tickets = (await http(base, 'GET', '/api/tickets')).json ?? [];
      const c1 = tickets.find?.((t) => t.id === t1.id)?.comment_count;
      const c2 = tickets.find?.((t) => t.id === t2.id)?.comment_count;
      const one = (await http(base, 'GET', `/api/tickets/${t1.id}`)).json?.comment_count;
      check('api: comment_count on list and detail', c1 === 3 && c2 === 0 && one === 3, `list ${c1}/${c2}, detail ${one}`);
      const patched = await http(base, 'PATCH', `/api/tickets/${t2.id}`, { body: { status: 'pending' } });
      check('api: existing endpoints unchanged', patched.status === 200 && patched.json?.status === 'pending', `${patched.status}`);
    }

    // ── The UI, in a browser ───────────────────────────────────────────────
    if (up) {
      const ui = await checkUi({ base, ticketId: t2.id, project });
      for (const [id, ok, detail] of ui) check(id, ok, detail);
    } else {
      check('ui: checks could not run', false, 'app did not start');
    }
    await app.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* a locked db file on Windows is harmless here */ }
    return { changedFiles: gitChanged(project) };
  },
};

async function checkUi({ base, ticketId }) {
  const out = [];
  const exe = findBrowser();
  if (!exe) return [['ui: a browser is available', false, 'no Chrome/Edge found']];
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`));
    const row = () => page.locator(`[data-testid="ticket-row"][data-id="${ticketId}"]`);
    await page.goto(base, { waitUntil: 'networkidle' });
    try {
      await row().click({ timeout: 8000 });
      await page.locator('[data-testid="comment-body"]').waitFor({ timeout: 8000 });
      out.push(['ui: comment form shows in the ticket detail', true, '']);
    } catch (e) {
      out.push(['ui: comment form shows in the ticket detail', false, String(e.message).split('\n')[0]]);
      return out;
    }
    await page.evaluate(() => { window.__benchNoReload = true; });
    await page.fill('[data-testid="comment-author"]', 'Cy');
    await page.fill('[data-testid="comment-body"]', 'Rebooted the <b>controller</b>.');
    await page.click('[data-testid="comment-submit"]');
    let appeared = false;
    try {
      await page.locator('[data-testid="comment-item"]', { hasText: 'Rebooted the' }).first().waitFor({ timeout: 6000 });
      appeared = true;
    } catch { /* recorded below */ }
    const noReload = await page.evaluate(() => window.__benchNoReload === true).catch(() => false);
    out.push(['ui: a new comment appears without a page reload', appeared && noReload, appeared ? (noReload ? '' : 'the page reloaded') : 'comment never appeared']);
    const injected = await page.locator('[data-testid="comment-list"] b').count().catch(() => 0);
    const shownLiterally = await page.locator('[data-testid="comment-item"]', { hasText: '<b>controller</b>' }).count().catch(() => 0);
    out.push(['ui: comment text is rendered as text, not HTML', injected === 0 && shownLiterally > 0, `injected <b>: ${injected}`]);

    let countOk = false;
    try {
      await page.waitForFunction((id) => {
        const r = document.querySelector(`[data-testid="ticket-row"][data-id="${id}"] [data-testid="comment-count"]`);
        return r && /\b1\b/.test(r.textContent);
      }, ticketId, { timeout: 5000 });
      countOk = true;
    } catch { /* recorded below */ }
    out.push(['ui: the ticket row shows its comment count', countOk, '']);

    await page.fill('[data-testid="comment-author"]', 'Cy').catch(() => {});
    await page.fill('[data-testid="comment-body"]', '    ').catch(() => {});
    await page.click('[data-testid="comment-submit"]').catch(() => {});
    let errorShown = false;
    try {
      await page.waitForFunction(() => {
        const e = document.querySelector('[data-testid="comment-error"]');
        return e && e.offsetParent !== null && e.textContent.trim().length > 0;
      }, null, { timeout: 5000 });
      errorShown = true;
    } catch { /* recorded below */ }
    out.push(['ui: a rejected comment shows an error message', errorShown, '']);

    await page.reload({ waitUntil: 'networkidle' });
    let persisted = false;
    try {
      await row().click({ timeout: 8000 });
      await page.locator('[data-testid="comment-item"]', { hasText: 'Rebooted the' }).first().waitFor({ timeout: 6000 });
      persisted = true;
    } catch { /* recorded below */ }
    out.push(['ui: comments are still there after a reload', persisted, '']);
    out.push(['ui: no console errors', errors.length === 0, errors.slice(0, 2).join(' | ')]);
  } finally {
    await browser.close();
  }
  return out;
}
