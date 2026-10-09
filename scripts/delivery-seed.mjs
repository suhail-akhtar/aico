/**
 * A Delivery board to look at: a real git repository and a journal seeded with a task in
 * every state, so the screens can be run, photographed and judged without a model.
 *
 *   npm run build && npx tsup src/test-exports.ts --format esm --outDir dist-test --target node18 --silent
 *   node scripts/delivery-seed.mjs <outDir>
 *   AICO_HOME=<outDir>/.aico node dist/index.js serve --port 7340      # the web portal
 *   AICO_HOME=<outDir>/.aico node desktop/scripts/shot.mjs <shots> [steps.json]   # the desktop
 *
 * WHY A SEED AND NOT A RUN. Looking at the board needs tasks in review with diffs, a
 * question a run is waiting on, a release with merged tasks since its tag. Producing those
 * by running agents costs money and is not repeatable; the journal is the board (ADR 0038),
 * so writing its events and making the matching git state is the same thing a run leaves
 * behind. Nothing here starts a run: the dispatcher stays paused and no provider is
 * configured in the store it writes (no key is copied from the real settings).
 *
 * The store is `<outDir>/.aico`, never `~/.aico`. `test-home.mjs` is imported first because
 * the rule for every probe is that nothing can reach the real store; its throwaway home is
 * then replaced by `<outDir>/.aico`, which is kept so a server can be pointed at it.
 *
 * @module scripts/delivery-seed
 */

import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const requested = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'aico-delivery-live'));
fs.rmSync(requested, { recursive: true, force: true });
fs.mkdirSync(requested, { recursive: true });
// The long spelling of the path (Windows may hand out C:\Users\NAME~1): git, the engine and the clients must agree on one.
const outDir = fs.realpathSync.native(requested);
const home = path.join(outDir, '.aico');
const project = path.join(outDir, 'shop');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });
process.env.AICO_HOME = home;
// No provider keys, no real settings: which projects exist, and the person's own deploy command (so Deploy is available).
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ projects: [{ path: project, name: 'shop', addedAt: Date.now() }], delivery: { deployCommand: 'node deploy.mjs' } }, null, 2));

const { DeliveryStore: S, DeliveryGit: G } = await import('../dist-test/test-exports.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
};
const commit = (dir, message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD'); };
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// ── the repository ───────────────────────────────────────────────────────
git(project, 'init', '-q', '-b', 'main');
git(project, 'config', 'user.name', 'Sam Rivera'); git(project, 'config', 'user.email', 'sam@shop.example');
git(project, 'config', 'commit.gpgsign', 'false'); git(project, 'config', 'core.autocrlf', 'false');
write(project, {
  'package.json': JSON.stringify({ name: 'shop', version: '1.2.0', scripts: { test: 'node check.js' } }, null, 2) + '\n',
  'check.js': "console.log('checks ok');\n",
  'deploy.mjs': "console.log('deploying', process.argv.slice(2).join(' '));\n",
  '.gitignore': 'node_modules/\n.aico/\n',
  'README.md': '# Shop\n\nA small storefront.\n',
  'CHANGELOG.md': '# Changelog\n\n## 1.2.0 - 2026-09-30\n\n### Added\n\n- Product catalogue\n',
  'src/cart.js': 'exports.total = (items) => items.reduce((n, i) => n + i.price * i.qty, 0);\n',
  'src/pricing.js': 'exports.round = (n) => Math.round(n * 100) / 100;\n',
  'src/search.js': 'exports.find = (q, products) => products.filter(p => p.name.includes(q));\n',
  'src/checkout.js': 'exports.checkout = (cart) => ({ ok: cart.length > 0 });\n',
  'src/orders.js': 'exports.list = (orders) => orders;\n',
  'src/auth/session.js': "exports.mint = (user) => `s_${user}_${Date.now()}`;\n",
  'test/cart.test.js': "require('node:test')('cart', () => {});\n",
});
fs.mkdirSync(path.join(project, '.aico'), { recursive: true });
fs.writeFileSync(path.join(project, '.aico', 'profile.json'), JSON.stringify({ version: 1, commands: { test: { command: 'node check.js', source: 'user', at: '2026-01-01T00:00:00.000Z' } } }));
fs.mkdirSync(path.join(project, 'node_modules', '.bin'), { recursive: true });
commit(project, 'feat: product catalogue');
git(project, 'tag', '-a', 'v1.2.0', '-m', 'v1.2.0');
const trunkAtRelease = git(project, 'rev-parse', 'HEAD');

S.ensureInit(project, 'main');

/** A task record with the defaults every task has. */
function task(over) {
  const id = S.newTaskId();
  const t = {
    id, project, title: 'Untitled', body: '', acceptance: [], status: 'backlog', priority: 3, dependsOn: [], labels: [],
    createdAt: iso(600), updatedAt: iso(30), ...over,
  };
  S.putTask(project, t);
  return t;
}
const comment = (t, by, text) => S.addComment(project, t.id, by, text);

/** Land a change on the trunk the way the board does (a branch, fast-forwarded), and record where it landed. */
function landed(over, files, message, kind, summary, minutesAgo) {
  const t = task({ ...over, status: 'review', createdAt: iso(minutesAgo + 200) });
  const from = git(project, 'rev-parse', 'main');
  const branch = `aico/task-${t.id}`;
  git(project, 'checkout', '-q', '-b', branch);
  write(project, files);
  const to = commit(project, message);
  git(project, 'checkout', '-q', 'main');
  git(project, 'merge', '-q', '--ff-only', branch);
  git(project, 'branch', '-q', '-d', branch);
  S.patchTask(project, t.id, {
    status: 'merged', updatedAt: iso(minutesAgo), evidence: { md: `## ${t.title}\n\n${summary}\n`, summary },
    landed: { from, to, at: iso(minutesAgo), kind, breaking: false, by: 'person' },
    costUsd: 0.4 + Math.random() * 0.5,
  });
  comment(t, 'person', 'Approved and landed.');
  return t;
}

// ── merged since v1.2.0 (the release train) ─────────────────────────────
landed({ title: 'Add a wishlist page', body: 'Let signed-in customers keep a list of products.', acceptance: ['A wishlist page lists saved products'], priority: 2 },
  { 'src/wishlist.js': 'exports.add = (list, p) => [...list, p];\n', 'test/wishlist.test.js': "require('node:test')('wishlist', () => {});\n" },
  'feat: add a wishlist page', 'feat', 'Checks passed: test. 2 files, +4 -0.', 2800);
landed({ title: 'Fix a double charge when a payment is retried', acceptance: ['A retried payment is charged once'], priority: 1 },
  { 'src/checkout.js': 'exports.checkout = (cart, key) => ({ ok: cart.length > 0, key });\n', 'test/retry.test.js': "require('node:test')('retry', () => {});\n" },
  'fix: do not charge twice when a payment is retried', 'fix', 'Checks passed: test. 2 files, +3 -1.', 1900);
landed({ title: 'Speed up product search', body: 'Index product names once instead of scanning on every query.', priority: 3 },
  { 'src/search.js': 'const idx = new Map();\nexports.find = (q, products) => products.filter(p => (idx.get(p) ?? p.name).includes(q));\n' },
  'perf: index product names for search', 'perf', 'Checks passed: test. 1 file, +2 -1.', 900);

// ── the working set: a worktree with real commits per task ───────────────
function withWorktree(over, files, message, extra = {}) {
  const t = task(over);
  const wt = path.join(home, 'worktrees', 'delivery', S.boardDir(project).split(path.sep).pop(), t.id);
  const branch = `aico/task-${t.id}`;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(project, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  write(wt, files);
  commit(wt, message);
  const changed = git(wt, 'diff', '--name-only', 'main', 'HEAD').split('\n').filter(Boolean);
  S.patchTask(project, t.id, { branch, worktree: wt, touches: { files: changed, symbols: [], predicted: false }, ...extra });
  return { t, wt };
}

async function review(over, files, message, risk, summary, green = true) {
  const { t, wt } = withWorktree({ ...over, status: 'review', updatedAt: iso(over.minutesAgo ?? 20) }, files, message, { risk, evidence: { md: `## ${over.title}\n\n${summary}\n\n### Checks\n\n- test: passed\n`, summary }, costUsd: 0.5 + Math.random() });
  const tree = await G.treeOf(wt);
  const trunkSha = await G.revParse(project, 'main');
  S.recordBase(project, t.id, trunkSha, tree);
  S.recordChecks(project, tree, green, [{ name: 'test', command: 'node check.js', outcome: green ? 'passed' : 'failed', exitCode: green ? 0 : 1, ms: 1400, tests: { runner: 'node', passed: 14, failed: green ? 0 : 2, skipped: 0, failures: [] } }]);
  S.queuePush(project, t.id);
  return t;
}

await review({ title: 'Fix rounding in order totals', body: 'Totals showed 19.989999 for some carts.', acceptance: ['Totals are rounded to cents'], priority: 1, labels: ['src/pricing.js'], minutesAgo: 12 },
  { 'src/pricing.js': 'exports.round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;\n', 'test/pricing.test.js': "require('node:test')('pricing', () => {});\n" },
  'fix: round order totals to cents', { score: 8, level: 'low', reasons: ['2 files, 4 lines changed', 'a test was added'] }, 'Checks passed: test (14). 2 files, +4 -1.');
await review({ title: 'Trim whitespace from search queries', acceptance: ['" shoe " finds shoes'], priority: 3, labels: ['src/search.js'], minutesAgo: 25 },
  { 'src/search.js': 'exports.find = (q, products) => products.filter(p => p.name.includes(q.trim()));\n', 'test/search.test.js': "require('node:test')('search', () => {});\n" },
  'fix: trim search queries', { score: 6, level: 'low', reasons: ['2 files, 3 lines changed', 'a test was added'] }, 'Checks passed: test (14). 2 files, +3 -1.');
await review({ title: 'Paginate the order history', body: 'The page loads every order at once.', acceptance: ['25 orders per page', 'Next and previous links'], priority: 2, labels: ['src/orders.js'], minutesAgo: 40 },
  { 'src/orders.js': 'exports.list = (orders, page = 1, size = 25) => orders.slice((page - 1) * size, page * size);\nexports.pages = (orders, size = 25) => Math.ceil(orders.length / size);\n',
    'src/orders-view.js': 'exports.links = (page, pages) => ({ prev: page > 1 ? page - 1 : null, next: page < pages ? page + 1 : null });\n',
    'test/orders.test.js': "require('node:test')('orders', () => {});\n" },
  'feat: paginate the order history', { score: 34, level: 'medium', reasons: ['3 files, 18 lines changed', 'reaches 6 files that depend on orders.js'] }, 'Checks passed: test (14). 3 files, +18 -2.');
await review({ title: 'Rotate the session token format', body: 'Tokens must not embed the user name.', acceptance: ['Tokens are opaque', 'Old tokens still validate for a day'], priority: 1, labels: ['src/auth'], minutesAgo: 55 },
  { 'src/auth/session.js': "const crypto = require('node:crypto');\nexports.mint = () => `s_${crypto.randomBytes(16).toString('hex')}`;\n" },
  'feat!: opaque session tokens', { score: 71, level: 'high', reasons: ['touches authentication or session code', 'no test was added for changed source', 'reaches 11 files that depend on session.js'] }, 'Checks passed: test (14). 1 file, +2 -1. No test covers the change.');

// Changes requested
const changes = withWorktree({ title: 'Handle an empty cart at checkout', body: 'Checkout throws when the cart is empty.', priority: 2, status: 'changes', updatedAt: iso(70) },
  { 'src/checkout.js': "exports.checkout = (cart) => { if (!cart.length) throw new Error('empty'); return { ok: true }; };\n" }, 'fix: reject an empty cart');
comment(changes.t, 'agent', 'Submitted: an empty cart now throws.');
comment(changes.t, 'person', 'Return a result object with ok: false instead of throwing, so the page can show a message; add a test for it.');

// Running: one working, one waiting for a person
const run1 = withWorktree({ title: 'Persist the cart across sessions', body: 'Save the cart server-side for signed-in customers.', priority: 2, status: 'running', labels: ['src/cart.js'], updatedAt: iso(2) },
  { 'src/cart-store.js': 'exports.save = (user, cart) => ({ user, cart });\n' }, 'feat: save the cart for signed-in customers',
  { claim: { runId: 'seed-run-1', sessionId: 'seed-session-1', leaseUntil: new Date(Date.now() + 86_400_000).toISOString() }, sessionId: 'seed-session-1', costUsd: 0.84 });
S.markStart(project, run1.t.id, 'seed-run-1');
const run2 = withWorktree({ title: 'Validate discount codes', body: 'Reject unknown, expired and already-used codes.', priority: 2, status: 'running', labels: ['src/pricing.js'], updatedAt: iso(1) },
  { 'src/discounts.js': 'exports.valid = (code) => /^[A-Z0-9]{6,12}$/.test(code);\n' }, 'feat: validate discount code format',
  {
    claim: { runId: 'seed-run-2', sessionId: 'seed-session-2', leaseUntil: new Date(Date.now() + 86_400_000).toISOString() }, sessionId: 'seed-session-2', costUsd: 0.31,
    needs: { kind: 'question', prompt: 'Should a discount code stack with the sale price, or replace it?', since: iso(4) },
  });
S.markStart(project, run2.t.id, 'seed-run-2');
comment(run2.t, 'agent', 'Waiting for you: Should a discount code stack with the sale price, or replace it?');

// Ready, backlog, blocked, cancelled
task({ title: 'Show stock level on product cards', body: 'Say "Only 3 left" when stock is low.', status: 'ready', priority: 2, labels: ['src/catalogue'], updatedAt: iso(15) });
task({ title: 'Rate-limit the login endpoint', body: 'Five failed attempts a minute per address.', status: 'ready', priority: 1, labels: ['src/auth'], updatedAt: iso(10) });
task({ title: 'Add a gift-card payment method', body: 'Customers can pay with a gift card code.', status: 'backlog', priority: 3, acceptance: ['A gift card covers part or all of an order'] });
task({ title: 'Localise the checkout copy', status: 'backlog', priority: 4, labels: ['i18n'] });
const blocked = task({ title: 'Move to the new payments SDK', body: 'Replace the legacy client.', status: 'blocked', priority: 2, updatedAt: iso(300) });
comment(blocked, 'agent', 'The run ended without finishing: spend ceiling reached ($3.02 of $3.00). Its branch and commits are kept. Set the task to ready to run it again.');
task({ title: 'Support legacy IE11', status: 'cancelled', priority: 4, updatedAt: iso(900) });

// ── an earlier release the board made ────────────────────────────────────
S.putRelease(project, {
  version: '1.2.0', tag: 'v1.2.0', commit: trunkAtRelease, at: iso(4300), bump: 'minor',
  notes: '### Added\n\n- Product catalogue (Checks passed: test. 6 files, +64 -0.)', tasks: [{ id: 'a1b2c3d4', title: 'Product catalogue', kind: 'feat', breaking: false, summary: 'Checks passed: test. 6 files, +64 -0.' }],
  files: ['package.json', 'CHANGELOG.md'],
  deploy: { state: 'ok', at: iso(4290), command: 'node deploy.mjs', source: 'setting', tail: 'Deployed v1.2.0' },
});
S.setSettings(project, { maxParallel: 2 });
S.setDispatcher(project, 'paused');

console.log(`Seeded ${S.boardState(project).tasks.length} tasks.`);
console.log(`  project : ${project}`);
console.log(`  AICO_HOME: ${home}`);
console.log(`  serve   : AICO_HOME="${home}" node dist/index.js serve --port 7340`);
process.exit(0);
