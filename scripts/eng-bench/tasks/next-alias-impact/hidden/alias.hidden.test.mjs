// Hidden tests for next-alias-impact, run by the grader against its own
// compiled copy of the project (.bench-build), never shown to the agent.
// BENCH_META is the generator's list of real callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd(), '.bench-build');
const load = (rel) => import(pathToFileURL(path.join(root, rel.replace(/\.ts$/, '.js'))).href);
const meta = JSON.parse(process.env.BENCH_META);

test('hidden: formatAmount takes a required currency and formats USD, EUR and GBP', async () => {
  const { formatAmount } = await load('src/lib/format/currency.ts');
  assert.equal(formatAmount.length, 2, 'currency must be a required second parameter (no default)');
  assert.equal(formatAmount(1234, 'USD'), '$12.34');
  assert.equal(formatAmount(1234, 'EUR'), '€12.34');
  assert.equal(formatAmount(5, 'GBP'), '£0.05');
});

test('hidden: every component prices in its own currency', async () => {
  const wrong = [];
  for (const c of meta.callers.filter((x) => x.kind === 'component')) {
    try {
      const fn = (await load(c.file))[c.name];
      for (const [cur, sym] of [['EUR', '€'], ['GBP', '£'], ['USD', '$']]) {
        const out = fn({ title: 'T', cents: 1234, discountCents: 234, currency: cur });
        if (out !== `T: ${sym}10.00 (you save ${sym}2.34)`) { wrong.push(`${c.file}: ${out}`); break; }
      }
    } catch (e) { wrong.push(`${c.file}: ${e.message}`); }
  }
  assert.equal(wrong.length, 0, wrong.slice(0, 5).join(' | '));
});

test('hidden: every route module prices in its own currency', async () => {
  const wrong = [];
  for (const c of meta.callers.filter((x) => x.kind === 'page')) {
    try {
      const out = (await load(c.file)).default({ title: 'T', cents: 1234, discountCents: 234, currency: 'GBP' });
      if (!out.startsWith('# T — £12.34') || out.includes('$') || out.includes('€')) wrong.push(`${c.file}: ${out.split('\n')[0]}`);
    } catch (e) { wrong.push(`${c.file}: ${e.message}`); }
  }
  assert.equal(wrong.length, 0, wrong.slice(0, 5).join(' | '));
});

test('hidden: the same-named formatAmount in legacy POS and in reports is unchanged', async () => {
  const pos = await load('src/legacy/pos/formatAmount.ts');
  const reports = await load('src/features/reports/lib/formatAmount.ts');
  assert.equal(pos.formatAmount(1234), 'USD 12.34');
  assert.equal(reports.formatAmount(1234567), '1,234,567');
  const r = await load('src/features/reports/report07.ts');
  assert.equal(r.reportRow07({ label: 'Q', total: 1000, currency: 'EUR' }), 'Q | 1,000 | EUR');
  const p = await load('src/legacy/pos/receipts/receipt07.ts');
  assert.equal(p.receiptLine07({ sku: 'X', cents: 50, currency: 'GBP' }), 'X           USD 0.50');
});
