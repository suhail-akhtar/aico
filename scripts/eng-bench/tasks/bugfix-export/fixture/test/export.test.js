import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionStore } from '../src/store.js';
import { exportAccountCsv, iterateAccount } from '../src/export.js';
import { formatAmount } from '../src/csv.js';

test('exports every row of a small account in order', async () => {
  const s = new TransactionStore();
  for (let i = 0; i < 12; i++) s.insert({ id: `t${i}`, accountId: 'acct_9', amountCents: i * 10, createdAt: 1_700_000_000_000 + i * 1000 });
  const ids = [];
  for await (const t of iterateAccount(s, 'acct_9', { pageSize: 5 })) ids.push(t.id);
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => `t${i}`));
});

test('csv has a header and quotes memos', async () => {
  const s = new TransactionStore();
  s.insert({ id: 't1', accountId: 'a', amountCents: -1205, memo: 'refund, "partial"', createdAt: Date.UTC(2024, 0, 2) });
  const csv = await exportAccountCsv(s, 'a');
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'id,created_at,amount,currency,memo');
  assert.equal(lines[1], 't1,2024-01-02T00:00:00.000Z,-12.05,USD,"refund, ""partial"""');
});

test('formatAmount', () => {
  assert.equal(formatAmount(0), '0.00');
  assert.equal(formatAmount(7), '0.07');
  assert.equal(formatAmount(123456), '1234.56');
});
