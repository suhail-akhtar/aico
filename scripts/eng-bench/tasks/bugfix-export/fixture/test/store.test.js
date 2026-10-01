import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionStore } from '../src/store.js';

function tx(id, createdAt, accountId = 'acct_1', amountCents = 100) {
  return { id, accountId, amountCents, createdAt };
}

test('insert and get', () => {
  const s = new TransactionStore();
  s.insert(tx('a', 1000));
  assert.equal(s.get('a').amountCents, 100);
  assert.equal(s.get('missing'), null);
});

test('rejects duplicate ids', () => {
  const s = new TransactionStore();
  s.insert(tx('a', 1000));
  assert.throws(() => s.insert(tx('a', 2000)), /duplicate/);
});

test('count is per account', () => {
  const s = new TransactionStore();
  s.insertMany([tx('a', 1), tx('b', 2), tx('c', 3, 'acct_2')]);
  assert.equal(s.count('acct_1'), 2);
  assert.equal(s.count('acct_2'), 1);
});

test('page returns oldest first and a cursor for the next page', () => {
  const s = new TransactionStore();
  s.insertMany([tx('c', 3000), tx('a', 1000), tx('b', 2000)]);
  const first = s.page('acct_1', { limit: 2 });
  assert.deepEqual(first.items.map((r) => r.id), ['a', 'b']);
  assert.ok(first.nextCursor);
  const second = s.page('acct_1', { after: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map((r) => r.id), ['c']);
  assert.equal(second.nextCursor, null);
});

test('page validates limit', () => {
  const s = new TransactionStore();
  assert.throws(() => s.page('acct_1', { limit: 0 }), RangeError);
  assert.throws(() => s.page('acct_1', { limit: 1001 }), RangeError);
});

test('page rejects a malformed cursor', () => {
  const s = new TransactionStore();
  s.insert(tx('a', 1000));
  assert.throws(() => s.page('acct_1', { after: 'not-a-cursor' }), TypeError);
});
