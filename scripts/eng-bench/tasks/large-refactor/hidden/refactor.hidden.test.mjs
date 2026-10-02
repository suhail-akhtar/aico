// Hidden behaviour checks for the large-refactor task. Copied into the
// project at grading time and run against the grader's own compiled output
// (.bench-build), never shown to the agent. BENCH_META lists every feature
// module, whether it is an EU one, and its exported names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const build = path.resolve('.bench-build');
const load = (rel) => import(pathToFileURL(path.join(build, rel.replace(/\.ts$/, '.js'))).href);
const meta = JSON.parse(process.env.BENCH_META ?? '[]');

test('hidden: formatMoney formats USD by default, EUR, GBP and other codes', async () => {
  const { formatMoney } = await load('src/core/money.ts');
  assert.equal(typeof formatMoney, 'function');
  assert.equal(formatMoney(12.5), '$12.50');
  assert.equal(formatMoney(12.5, 'USD'), '$12.50');
  assert.equal(formatMoney(12.5, 'EUR'), '€12.50');
  assert.equal(formatMoney(3, 'GBP'), '£3.00');
  assert.equal(formatMoney(7, 'JPY'), 'JPY 7.00');
  assert.equal(formatMoney.length, 1, 'the currency parameter has a default');
});

test('hidden: the barrel exports formatMoney and not formatPrice', async () => {
  const barrel = await load('src/core/index.ts');
  assert.equal(typeof barrel.formatMoney, 'function');
  assert.equal(barrel.formatPrice, undefined);
  const money = await load('src/core/money.ts');
  assert.equal(money.formatPrice, undefined);
});

test('hidden: EU features price in euros, the others in dollars', async () => {
  assert.ok(meta.length >= 150, `meta lists ${meta.length} features`);
  for (const m of meta) {
    const mod = await load(m.file);
    const sym = m.eu ? '€' : '$';
    assert.equal(mod[`describe${m.id}`]({ qty: 3, unit: 2.5 }), `${m.id}: 3 x ${sym}2.50 = ${sym}7.50`, m.file);
    assert.equal(mod[`total${m.id}`]([{ qty: 2, unit: 1.25 }, { qty: 1, unit: 4 }]), `${sym}6.50`, m.file);
    if (m.usesRange) assert.equal(mod[`range${m.id}`](5, 9), '$5.00–$9.00', m.file);
  }
});

test('hidden: formatPriceRange is unchanged', async () => {
  const { formatPriceRange } = await load('src/core/index.ts');
  assert.equal(formatPriceRange(5, 9), '$5.00–$9.00');
  assert.equal(formatPriceRange(0.5, 10), '$0.50–$10.00');
});
