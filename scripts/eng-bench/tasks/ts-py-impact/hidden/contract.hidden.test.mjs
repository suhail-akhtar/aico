// Hidden tests for ts-py-impact (web side), run by the grader against its own
// compiled copy (.bench-build) of web/. BENCH_META lists the components.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.cwd(), '.bench-build');
const load = (rel) => import(pathToFileURL(path.join(root, rel.replace(/^web\//, '').replace(/\.ts$/, '.js'))).href);
const meta = JSON.parse(process.env.BENCH_META);
const order = { id: 'o1', full_name: 'Ada Lovelace', email: 'ada@example.com', total_cents: 1200, status: 'open' };
const invoice = { id: 'i1', order_id: 'o1', customer_name: 'Grace Hopper', amount_cents: 900 };

test('hidden: the create-order request sends full_name', async () => {
  const { buildCreateOrderRequest } = await load('web/src/api/orders.ts');
  const body = buildCreateOrderRequest({ name: ' Ada ', email: 'a@x', totalCents: 5 });
  assert.equal(body.full_name, 'Ada');
  assert.equal('customer_name' in body, false);
});

test('hidden: every order component reads full_name', async () => {
  const wrong = [];
  for (const c of [...meta.webOrder, ...meta.webLegacyOrder]) {
    try {
      const out = (await load(c.file))[c.name](order);
      if (!out.includes('Ada Lovelace')) wrong.push(`${c.file}: ${out}`);
    } catch (e) { wrong.push(`${c.file}: ${e.message}`); }
  }
  assert.equal(wrong.length, 0, wrong.slice(0, 5).join(' | '));
});

test('hidden: invoice components keep customer_name', async () => {
  const wrong = [];
  for (const c of meta.webInvoice) {
    const out = (await load(c.file))[c.name](invoice);
    if (!out.includes('Grace Hopper')) wrong.push(`${c.file}: ${out}`);
  }
  const cell = await load('web/src/legacy/grid/invoiceCell03.ts');
  if (!cell.invoiceCell03(invoice).includes('Grace Hopper')) wrong.push('invoiceCell03');
  assert.equal(wrong.length, 0, wrong.slice(0, 5).join(' | '));
});
