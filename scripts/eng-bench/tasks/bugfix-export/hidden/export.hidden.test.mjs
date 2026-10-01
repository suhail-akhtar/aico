// Hidden acceptance tests for the ledger-export bug. Copied into the project
// only after the agent's turn has ended; it never sees them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactionStore } from '../src/store.js';
import { iterateAccount, exportAccountCsv } from '../src/export.js';
import { importBatch } from '../src/import.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

// A store whose page() refuses to be called more often than any correct
// iteration could need — so a fix that loops forever fails instead of hanging.
function guarded(store, maxCalls) {
  const page = store.page.bind(store);
  let calls = 0;
  store.page = (...args) => {
    if (++calls > maxCalls) throw new Error(`page() called ${calls} times — iteration does not terminate`);
    return page(...args);
  };
  return store;
}

function build({ n, account = 'acct_4471', seed = 1, tieEvery = 4 }) {
  const r = rng(seed);
  const s = new TransactionStore();
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    if (i % tieEvery !== 0) t += 1 + Math.floor(r() * 3) * 1000; // most rows share a timestamp with a neighbour
    s.insert({ id: `tx_${Math.floor(r() * 1e12).toString(36)}_${i}`, accountId: account, amountCents: Math.floor(r() * 10000), createdAt: t });
  }
  return s;
}

async function collect(store, account, pageSize) {
  const out = [];
  for await (const tx of iterateAccount(store, account, { pageSize })) out.push(tx);
  return out;
}

test('hidden: ties across page boundaries are exported exactly once (several page sizes)', async () => {
  for (const pageSize of [1, 2, 3, 7, 10, 50]) {
    const store = guarded(build({ n: 120, seed: pageSize, tieEvery: 3 }), 400);
    const got = await collect(store, 'acct_4471', pageSize);
    const ids = got.map((t) => t.id);
    assert.equal(ids.length, 120, `pageSize ${pageSize}: exported ${ids.length} of 120`);
    assert.equal(new Set(ids).size, 120, `pageSize ${pageSize}: duplicates exported`);
  }
});

test('hidden: a tie group larger than one page terminates and is complete', async () => {
  const s = new TransactionStore();
  for (let i = 0; i < 25; i++) s.insert({ id: `same_${String(i).padStart(2, '0')}`, accountId: 'a', amountCents: i, createdAt: 1_700_000_000_000 });
  s.insert({ id: 'later', accountId: 'a', amountCents: 1, createdAt: 1_700_000_001_000 });
  guarded(s, 20);
  const got = await collect(s, 'a', 10);
  assert.equal(got.length, 26);
  assert.equal(new Set(got.map((t) => t.id)).size, 26);
  assert.equal(got[25].id, 'later');
});

test('hidden: export order is chronological', async () => {
  const store = guarded(build({ n: 200, seed: 9 }), 200);
  const got = await collect(store, 'acct_4471', 7);
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].createdAt <= got[i].createdAt, `row ${i} out of order`);
});

test('hidden: a bulk-imported account exports every row (1,203 rows)', async () => {
  const s = new TransactionStore();
  let now = 1_700_000_000_250;
  const clock = () => now;
  // Three import runs within a few seconds of each other plus live API traffic.
  importBatch(s, 'acct_4471', Array.from({ length: 700 }, (_, i) => ({ amount: (i % 50) + 0.25 })), { clock });
  for (let i = 0; i < 3; i++) s.insert({ id: `api_${i}`, accountId: 'acct_4471', amountCents: 100, createdAt: now + 400 + i });
  now += 1500;
  importBatch(s, 'acct_4471', Array.from({ length: 450 }, () => ({ amount: '1,000.10' })), { clock });
  now += 900;
  importBatch(s, 'acct_4471', Array.from({ length: 50 }, () => ({ amount: 3 })), { clock });
  assert.equal(s.count('acct_4471'), 1203);
  guarded(s, 50);
  const csv = await exportAccountCsv(s, 'acct_4471', { pageSize: 500 });
  const rows = csv.trimEnd().split('\n').slice(1);
  assert.equal(rows.length, 1203);
  assert.equal(new Set(rows.map((r) => r.split(',')[0])).size, 1203);
});

test('hidden: rows inserted out of order still export once, in order', async () => {
  const s = new TransactionStore();
  const times = [5, 1, 3, 3, 3, 2, 5, 5, 4, 1, 1, 3];
  times.forEach((t, i) => s.insert({ id: `r${String(i).padStart(2, '0')}`, accountId: 'z', amountCents: i, createdAt: t * 1000 }));
  guarded(s, 30);
  const got = await collect(s, 'z', 2);
  assert.equal(got.length, times.length);
  assert.equal(new Set(got.map((t) => t.id)).size, times.length);
  assert.deepEqual(got.map((t) => t.createdAt), [...times].sort((a, b) => a - b).map((t) => t * 1000));
});

test('hidden: page() contract is unchanged (cursor string, null at the end)', () => {
  const s = new TransactionStore();
  for (let i = 0; i < 5; i++) s.insert({ id: `p${i}`, accountId: 'q', amountCents: 1, createdAt: 1000 });
  const a = s.page('q', { limit: 3 });
  assert.equal(a.items.length, 3);
  assert.equal(typeof a.nextCursor, 'string');
  const b = s.page('q', { after: a.nextCursor, limit: 3 });
  assert.equal(b.items.length, 2);
  assert.equal(b.nextCursor, null);
  assert.equal(new Set([...a.items, ...b.items].map((t) => t.id)).size, 5);
  assert.throws(() => s.page('q', { after: 'garbage!!' }), TypeError);
});

test('hidden: distinct timestamps still paginate exactly (regression)', async () => {
  const s = new TransactionStore();
  for (let i = 0; i < 31; i++) s.insert({ id: `d${i}`, accountId: 'd', amountCents: i, createdAt: 1000 + i });
  guarded(s, 40);
  const got = await collect(s, 'd', 4);
  assert.deepEqual(got.map((t) => t.id), Array.from({ length: 31 }, (_, i) => `d${i}`));
});
