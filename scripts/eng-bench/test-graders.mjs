/**
 * Proves the eng-bench graders before a model is ever graded by them: free,
 * offline, no model calls.
 *
 * A grader that passes broken work, or fails correct work, makes every number
 * the bench produces meaningless — and nobody would notice, because the
 * numbers would still look plausible. So for every task this runs the grader
 * twice: on the untouched fixture (the work not done: it must FAIL, and fail
 * the specific checks that detect the seeded problem) and on a reference
 * solution (the work done right: it must score 100%). The design-doc rubric
 * is run on a strong and a thin sample document; its LLM judge is not called
 * here.
 *
 *   node scripts/eng-bench/test-graders.mjs            # all
 *   node scripts/eng-bench/test-graders.mjs refactor-shipping
 */
import '../lib/test-home.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createChecks, readText } from './lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
let failures = 0;
const expect = (cond, label) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) failures++; };
const quiet = () => {};

async function load(id) {
  return (await import(pathToFileURL(path.join(here, 'tasks', id, 'task.mjs')).href)).default;
}

async function grade(task, overlayDir) {
  const project = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `eng-bench-grader-${task.id}-`));
  task.setup(project);
  if (overlayDir) fs.cpSync(overlayDir, project, { recursive: true });
  const checks = createChecks(quiet);
  const extra = await task.grade({ project, check: checks.check, log: quiet, askModel: undefined });
  const s = checks.summary();
  try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* Windows file locks; temp dir */ }
  return { ...s, extra, failed: s.checks.filter((c) => !c.ok).map((c) => `${c.id}${c.detail ? ` (${c.detail.slice(0, 120)})` : ''}`) };
}

const CODE_TASKS = {
  'bugfix-export': ['hidden: ties across page boundaries are exported exactly once (several page sizes)', 'hidden: a bulk-imported account exports every row (1,203 rows)'],
  'refactor-shipping': ['hidden: registerCarrier adds a carrier without editing calculateShipping', 'hidden: calculateShipping is a thin dispatcher with no carrier logic'],
  'delegation-security': ['fixed: safe-path', 'fixed: user-query', 'fixed: session-token', 'fixed: redirect-guard', 'fixed: html-render'],
  'fullstack-comments': ['new-migration-added', 'api: create returns 201 with the comment', 'ui: comment form shows in the ticket detail'],
  'enterprise-api': ['bench.json names install/test/start'],
};

for (const [id, mustFail] of Object.entries(CODE_TASKS)) {
  if (only && only !== id) continue;
  console.log(`\n${id}`);
  const task = await load(id);
  const before = await grade(task, null);
  expect(before.passed < before.total, `fixture alone fails (${before.passed}/${before.total})`);
  for (const c of mustFail) expect(before.failed.some((f) => f.startsWith(c)), `fixture alone fails "${c}"`);
  const after = await grade(task, path.join(here, 'tasks', id, 'reference'));
  expect(after.passed === after.total, `reference solution scores 100% (${after.passed}/${after.total})`);
  for (const f of after.failed) console.log(`        reference failed: ${f}`);
}

// The large refactor's repository and reference are generated, not checked
// in, so its reference is applied by the task itself; its mutants are the
// three mistakes a rename at scale actually makes.
if (!only || only === 'large-refactor') {
  console.log('\nlarge-refactor');
  const task = await load('large-refactor');
  const run = async (mutate) => {
    const project = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'eng-bench-grader-large-refactor-'));
    task.setup(project);
    if (mutate) mutate(project);
    const checks = createChecks(quiet);
    await task.grade({ project, check: checks.check, log: quiet });
    const s = checks.summary();
    try { fs.rmSync(project, { recursive: true, force: true }); } catch { /* Windows file locks; temp dir */ }
    return { ...s, failed: s.checks.filter((c) => !c.ok).map((c) => c.id) };
  };
  const edit = (project, rel, from, to) => {
    const file = path.join(project, rel);
    const text = readText(file);
    expect(text.includes(from), `mutation applies to ${rel}`);
    fs.writeFileSync(file, text.replace(from, to));
  };
  const before = await run(null);
  expect(before.passed < before.total, `fixture alone fails (${before.passed}/${before.total})`);
  for (const c of ['hidden: formatMoney formats USD by default, EUR, GBP and other codes', 'no formatPrice identifier remains']) {
    expect(before.failed.some((f) => f.startsWith(c)), `fixture alone fails "${c}"`);
  }
  const after = await run((p) => task.applyReference(p));
  expect(after.passed === after.total, `reference solution scores 100% (${after.passed}/${after.total})`);
  for (const f of after.failed) console.log(`        reference failed: ${f}`);
  const sed = await run((p) => {
    task.applyReference(p);
    edit(p, 'src/util/u005.ts', 'formatPriceRange', 'formatMoneyRange');
  });
  expect(sed.failed.some((f) => f.startsWith('files that never used formatPrice are byte-identical')), 'mutant (text replace hit formatPriceRange) loses "byte-identical"');
  const alias = await run((p) => {
    task.applyReference(p);
    edit(p, 'src/core/index.ts', 'export { formatMoney,', 'export { formatMoney, formatMoney as formatPrice,');
  });
  expect(alias.failed.some((f) => f.startsWith('hidden: the barrel exports formatMoney and not formatPrice')), 'mutant (old name kept as an alias) loses the barrel check');
  const missedEu = await run((p) => {
    task.applyReference(p);
    edit(p, 'src/features/eu/e01.ts', "(line.unit, 'EUR')", '(line.unit)');
  });
  expect(missedEu.failed.some((f) => f.startsWith('hidden: EU features price in euros')), 'mutant (one EU call site missed) loses the EU check');
  const addedTest = await run((p) => {
    task.applyReference(p);
    edit(p, 'test/money.test.ts', "test('formats a price band'", "test('formats euros', () => {\n  assert.equal(formatMoney(1, 'EUR'), '€1.00');\n});\n\ntest('formats a price band'");
  });
  expect(addedTest.passed === addedTest.total, `acceptable: a test added for the new parameter still scores 100% (${addedTest.passed}/${addedTest.total})${addedTest.failed.length ? `: ${addedTest.failed.join('; ')}` : ''}`);
}

// Plausible-but-wrong solutions: the tempting fix, a missed scope, an early
// rounding. Each must lose the named check — proof that the hidden tests
// test the property, not just "something changed".
const MUTANTS = [
  { task: 'bugfix-export', label: 'naive `>=` cursor fix', base: 'fixture', file: 'src/store.js', from: 'r.createdAt > c.createdAt', to: 'r.createdAt >= c.createdAt',
    mustFail: ['hidden: ties across page boundaries are exported exactly once (several page sizes)', 'hidden: a tie group larger than one page terminates and is complete'] },
  { task: 'refactor-shipping', label: 'FedEx base rounded too early', base: 'reference', file: 'src/carriers/fedex.js', from: 'let base = 9 + 1.25 * weight', to: 'let base = Math.round((9 + 1.25 * weight) * 100) / 100',
    mustFail: ['hidden: behaviour is identical to the original for 800 generated orders'] },
  { task: 'refactor-shipping', label: 'carrier dispatched before weight validation', base: 'reference', file: 'src/shipping.js',
    from: "  const ctx = normalise(order);\n  const strategy = registry.get(ctx.carrier);\n  if (!strategy) throw new Error('Unsupported carrier: ' + order.carrier);",
    to: "  const strategy = registry.get(String(order?.carrier || '').toLowerCase());\n  if (!strategy) throw new Error('Unsupported carrier: ' + order?.carrier);\n  const ctx = normalise(order);",
    mustFail: ['hidden: behaviour is identical to the original for 800 generated orders'] },
  { task: 'refactor-shipping', label: 'insurance formula copied into a carrier', base: 'reference', file: 'src/carriers/usps.js',
    from: 'surcharges += insurance(order.declaredValue);', to: 'surcharges += Math.round((order.declaredValue - 1000) * 0.005 * 100) / 100;',
    mustFail: ['hidden: shared insurance rule is not copied per carrier'] },
  { task: 'delegation-security', label: 'timingSafeEqual without a length check', base: 'reference', file: 'packages/session-token/index.js', from: 'given.length !== expected.length || ', to: '',
    mustFail: ['fixed: session-token'] },
  { task: 'delegation-security', label: 'startsWith(root) containment check', base: 'reference', file: 'packages/safe-path/index.js',
    from: "  const rel = path.relative(base, full);\n  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;", to: '  if (!full.startsWith(base)) return null;',
    mustFail: ['fixed: safe-path'] },
  { task: 'enterprise-api', label: 'single-order lookup not scoped to the tenant', base: 'reference', file: 'server.js',
    from: "db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').get(m[1], tenant)", to: "db.prepare('SELECT * FROM orders WHERE id = ?').get(m[1])",
    mustFail: ['another tenant gets 404 not_found on read/update/delete'] },
  { task: 'enterprise-api', label: 'expiry not checked', base: 'reference', file: 'server.js',
    from: "  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) fail(401, 'unauthorized', 'token expired');\n", to: '',
    mustFail: ['401 unauthorized for missing/malformed/forged/expired/alg-none tokens'] },
  { task: 'fullstack-comments', label: 'comments rendered with innerHTML', base: 'reference', file: 'public/app.js',
    from: "el('strong', {}, c.author), ' ', el('span', {}, c.body)))),", to: "Object.assign(el('span'), { innerHTML: `<strong>${c.author}</strong> ${c.body}` })))),",
    mustFail: ['ui: comment text is rendered as text, not HTML'] },
  // Acceptable variations: a correct solution written differently must not
  // lose points. This one is the shape the 2026-10-01 baseline agent chose
  // (one shared helper, each carrier passing its own rate), which the first
  // version of the duplication check wrongly failed.
  { task: 'refactor-shipping', label: 'shared helper with the rate passed per carrier (acceptable)', base: 'reference',
    edits: ['ups', 'fedex', 'usps'].map((c) => ({ file: `src/carriers/${c}.js`, from: 'insurance(order.declaredValue)', to: 'insurance(order.declaredValue, { over: 1000, rate: 0.005 })' })),
    mustPass: true },
];

for (const m of MUTANTS) {
  if (only && only !== m.task) continue;
  console.log(`\n${m.task} mutant: ${m.label}`);
  const task = await load(m.task);
  const staging = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'eng-bench-mutant-'));
  if (m.base === 'reference') fs.cpSync(path.join(here, 'tasks', m.task, 'reference'), staging, { recursive: true });
  for (const e of m.edits ?? [{ file: m.file, from: m.from, to: m.to }]) {
    const current = path.join(staging, e.file);
    const text = readText(fs.existsSync(current) ? current : path.join(here, 'tasks', m.task, 'fixture', e.file));
    expect(text.includes(e.from), `mutation applies to ${e.file}`);
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.writeFileSync(current, text.replace(e.from, e.to));
  }
  const r = await grade(task, staging);
  if (m.mustPass) expect(r.passed === r.total, `still scores 100% (${r.passed}/${r.total})${r.failed.length ? `: ${r.failed.join('; ')}` : ''}`);
  for (const c of m.mustFail ?? []) expect(r.failed.some((f) => f.startsWith(c)), `loses "${c}"`);
  fs.rmSync(staging, { recursive: true, force: true });
}

if (!only || only === 'architecture-doc') {
  console.log('\narchitecture-doc (rubric only; the judge is not called offline)');
  const { rubric } = await import(pathToFileURL(path.join(here, 'tasks', 'architecture-doc', 'task.mjs')).href);
  const run = (file) => { const c = createChecks(quiet); rubric(readText(path.join(here, 'tasks', 'architecture-doc', 'samples', file)), c.check); return c.summary(); };
  const good = run('good.md');
  expect(good.passed === good.total, `strong sample passes the rubric (${good.passed}/${good.total})`);
  for (const c of good.checks.filter((x) => !x.ok)) console.log(`        strong sample failed: ${c.id} ${c.detail}`);
  const thin = run('thin.md');
  expect(thin.passed <= thin.total / 3, `thin sample fails most of the rubric (${thin.passed}/${thin.total})`);
  const task = await load('architecture-doc');
  const empty = await grade(task, null);
  expect(empty.passed <= 1, `no document scores ~0 (${empty.passed}/${empty.total})`);
}

console.log(failures ? `\n${failures} grader self-test failure(s)` : '\nall grader self-tests passed');
process.exit(failures ? 1 : 0);
