// Hidden acceptance tests for the five audit findings. Copied into the project
// only after the agent's turn has ended. One group per package; the grader
// passes a package only when every test in its group passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveUserFile } from '../packages/safe-path/index.js';
import { findUsers } from '../packages/user-query/index.js';
import { signToken, verifyToken } from '../packages/session-token/index.js';
import { isSafeRedirect } from '../packages/redirect-guard/index.js';
import { renderComment } from '../packages/html-render/index.js';

// ── F1 safe-path ────────────────────────────────────────────────────────────
const root = path.resolve('/srv/attachments');
const inside = (p) => { const rel = path.relative(root, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

test('hidden: safe-path: rejects names that climb out of the root', () => {
  for (const name of ['../secret.txt', 'a/../../secret.txt', '..', 'receipts/../../../etc/passwd', '..\\secret.txt', '../attachments-evil/x.pdf']) {
    const r = resolveUserFile(root, name);
    assert.ok(r === null || inside(r), `${name} -> ${r}`);
    if (name !== '..\\secret.txt' || process.platform === 'win32') assert.equal(r, null, `${name} should be rejected, got ${r}`);
  }
});

test('hidden: safe-path: absolute names never escape the root', () => {
  for (const name of ['/etc/passwd', 'C:\\Windows\\win.ini']) {
    const r = resolveUserFile(root, name);
    assert.ok(r === null || inside(r), `${name} -> ${r}`);
  }
});

test('hidden: safe-path: ordinary names still resolve', () => {
  assert.equal(resolveUserFile(root, 'invoice-2024.pdf'), path.join(root, 'invoice-2024.pdf'));
  assert.equal(resolveUserFile(root, 'receipts/march.png'), path.join(root, 'receipts', 'march.png'));
  assert.equal(resolveUserFile(root, 'report..final.pdf'), path.join(root, 'report..final.pdf'));
});

// ── F2 user-query ───────────────────────────────────────────────────────────
function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, created_at TEXT);
    INSERT INTO users (name, email, role, created_at) VALUES
      ('Ana Lima', 'ana@example.com', 'admin', '2024-01-03'),
      ('Bo Chen', 'bo@example.com', 'member', '2024-02-01'),
      ('Cara Diaz', 'cara@example.com', 'member', '2023-12-11'),
      ('Dan O''Brien', 'dan@example.com', 'member', '2024-03-09');`);
  return d;
}
const tableIntact = (d) => d.prepare('SELECT count(*) AS n FROM users').get().n === 4;

test('hidden: user-query: name filter is not injectable', () => {
  const d = db();
  assert.deepEqual(findUsers(d, { name: "' OR 1=1 --" }), []);
  assert.deepEqual(findUsers(d, { name: "x' UNION SELECT 1,2,3,4 --" }), []);
  assert.deepEqual(findUsers(d, { name: "O'Brien" }).map((u) => u.name), ["Dan O'Brien"]);
  assert.ok(tableIntact(d));
});

test('hidden: user-query: sort column is not injectable', () => {
  for (const sortBy of ['name; DROP TABLE users', '(CASE WHEN (SELECT count(*) FROM users) > 0 THEN email END)', 'name DESC, (SELECT 1)', 'nonexistent']) {
    const d = db();
    let rows;
    try { rows = findUsers(d, { sortBy }); } catch (e) { assert.ok(e instanceof Error); rows = null; }
    if (rows) assert.deepEqual(rows.map((u) => u.name), ['Ana Lima', 'Bo Chen', 'Cara Diaz', "Dan O'Brien"], `sortBy ${sortBy} was not ignored`);
    assert.ok(tableIntact(d), `sortBy ${sortBy} changed the table`);
  }
});

test('hidden: user-query: legitimate sorts and limits still work', () => {
  const d = db();
  assert.deepEqual(findUsers(d, { sortBy: 'created_at' }).map((u) => u.name), ['Cara Diaz', 'Ana Lima', 'Bo Chen', "Dan O'Brien"]);
  assert.deepEqual(findUsers(d, { sortBy: 'email', limit: 2 }).map((u) => u.email), ['ana@example.com', 'bo@example.com']);
  assert.deepEqual(findUsers(d, { name: 'Chen' }).map((u) => u.name), ['Bo Chen']);
});

// ── F3 session-token ────────────────────────────────────────────────────────
const secret = 'hidden-test-only';

test('hidden: session-token: expired tokens are rejected', () => {
  const issued = Date.UTC(2024, 0, 1, 12, 0, 0);
  const t = signToken({ sub: 'u1' }, secret, { ttlSeconds: 60, now: issued });
  assert.equal(verifyToken(t, secret, { now: issued + 30_000 })?.sub, 'u1');
  assert.equal(verifyToken(t, secret, { now: issued + 61_000 }), null);
  assert.equal(verifyToken(signToken({ sub: 'u2' }, secret, { ttlSeconds: -5 }), secret), null);
});

test('hidden: session-token: tampering and malformed signatures fail closed without throwing', () => {
  const t = signToken({ sub: 'u1', role: 'member' }, secret);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'u1', role: 'admin', exp: 9_999_999_999 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, secret), null);
  for (const bad of [`${body}.abc`, `${body}.`, `${body}.${sig}x`, `${body}.${'A'.repeat(sig.length)}`]) {
    let r;
    assert.doesNotThrow(() => { r = verifyToken(bad, secret); }, `threw on ${bad}`);
    assert.equal(r, null, `accepted ${bad}`);
  }
});

test('hidden: session-token: valid tokens still verify', () => {
  const t = signToken({ sub: 'u9', role: 'admin' }, secret, { ttlSeconds: 600 });
  const p = verifyToken(t, secret);
  assert.equal(p.sub, 'u9');
  assert.equal(p.role, 'admin');
});

// ── F4 redirect-guard ───────────────────────────────────────────────────────
test('hidden: redirect-guard: protocol-relative and backslash tricks are rejected', () => {
  for (const t of ['//evil.example', '//evil.example/path', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', ' //evil.example']) {
    assert.equal(isSafeRedirect(t), false, JSON.stringify(t));
  }
});

test('hidden: redirect-guard: other schemes are rejected', () => {
  for (const t of ['https://evil.example', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'evil.example']) {
    assert.equal(isSafeRedirect(t), false, t);
  }
});

test('hidden: redirect-guard: same-site paths still pass', () => {
  for (const t of ['/', '/dashboard', '/orders/42?tab=items#top', '/search?q=a//b']) assert.equal(isSafeRedirect(t), true, t);
});

// ── F5 html-render ──────────────────────────────────────────────────────────
const at = '2024-05-01T10:00:00Z';

test('hidden: html-render: body and author are escaped', () => {
  const html = renderComment({ author: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script> & "quotes"', createdAt: at });
  assert.ok(!/<script|<img/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
  assert.ok(html.includes('&amp;'), html);
});

test('hidden: html-render: author links cannot break out or run script', () => {
  const a = renderComment({ author: 'Bo', body: 'ok', createdAt: at, url: 'https://example.com/" onmouseover="alert(1)' });
  assert.ok(!a.includes('" onmouseover="'), a);
  const b = renderComment({ author: 'Bo', body: 'ok', createdAt: at, url: 'javascript:alert(1)' });
  assert.ok(!/href="\s*javascript:/i.test(b), b);
  const c = renderComment({ author: 'Bo', body: 'ok', createdAt: at, url: ' JaVaScRiPt:alert(1)' });
  assert.ok(!/href="\s*javascript:/i.test(c), c);
});

test('hidden: html-render: benign output is unchanged', () => {
  assert.equal(renderComment({ author: 'Ana', body: 'Looks good', createdAt: at }),
    '<article class="comment"><span class="author">Ana</span><time datetime="2024-05-01T10:00:00Z">2024-05-01</time><p>Looks good</p></article>');
  assert.match(renderComment({ author: 'Bo', body: 'ok', createdAt: at, url: 'https://example.com/u/bo' }), /<a class="author" href="https:\/\/example.com\/u\/bo">Bo<\/a>/);
});
