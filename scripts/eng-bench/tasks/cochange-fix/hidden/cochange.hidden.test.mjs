// Hidden tests for cochange-fix, run by the grader in the project (never shown
// to the agent). The e-invoice test goes through src/edi/partitions.js, the
// file related to the tax table only by git history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (rel) => import(pathToFileURL(path.resolve(process.cwd(), rel)).href);

test('hidden: NU is taxed at 5% and offered at checkout', async () => {
  const { computeTax, REGIONS } = await load('src/tax/rates.js');
  assert.equal(computeTax('NU', 10000), 500);
  assert.ok(REGIONS.includes('NU'));
  const { quote } = await load('src/checkout/quote.js');
  assert.deepEqual(quote([{ qty: 4, unitCents: 2500 }], 'NU'), { subtotalCents: 10000, taxCents: 500, totalCents: 10500 });
});

test('hidden: an NU invoice renders a CRA e-invoice under the next ledger partition', async () => {
  const { issueInvoice } = await load('src/billing/issue.js');
  const { renderEInvoice } = await load('src/edi/einvoice.js');
  const xml = renderEInvoice(issueInvoice({ name: 'Iqaluit Supply', region: 'NU' }, [{ qty: 1, unitCents: 10000 }]));
  assert.ok(xml.includes('<LedgerPartition>LP-13</LedgerPartition>'), xml);
  assert.ok(xml.includes('<Tax>5.00</Tax>'), xml);
});

test('hidden: existing regions keep their rates and partitions', async () => {
  const { computeTax } = await load('src/tax/rates.js');
  const { partitionFor } = await load('src/edi/partitions.js');
  const expected = [['ON', 1300, 'LP-01'], ['QC', 1498, 'LP-02'], ['NS', 1400, 'LP-07'], ['NT', 500, 'LP-12']];
  for (const [r, tax, lp] of expected) {
    assert.equal(computeTax(r, 10000), tax, r);
    assert.equal(partitionFor(r), lp, r);
  }
});

test('hidden: NU is not added to shipping zones', async () => {
  const { zoneFor } = await load('src/shipping/zones.js');
  assert.throws(() => zoneFor('NU'));
});
