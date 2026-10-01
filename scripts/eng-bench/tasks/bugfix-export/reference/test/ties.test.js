// Reference regression test (grader self-test only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionStore } from '../src/store.js';
import { iterateAccount } from '../src/export.js';

test('rows sharing a timestamp across a page boundary are exported once', async () => {
  const s = new TransactionStore();
  for (let i = 0; i < 7; i++) s.insert({ id: `t${i}`, accountId: 'a', amountCents: 1, createdAt: 1000 });
  const ids = [];
  for await (const t of iterateAccount(s, 'a', { pageSize: 3 })) ids.push(t.id);
  assert.equal(new Set(ids).size, 7);
  assert.equal(ids.length, 7);
});
