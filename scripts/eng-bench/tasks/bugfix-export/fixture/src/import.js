import { newTransactionId } from './ids.js';

function toCents(amount) {
  const n = typeof amount === 'string' ? Number(amount.replace(/,/g, '')) : amount;
  if (!Number.isFinite(n)) throw new TypeError(`invalid amount: ${amount}`);
  return Math.round(n * 100);
}

/**
 * Bulk-load transactions for one account (customer onboarding, ERP dumps).
 *
 * Every row in a batch is stamped with the import time, truncated to the
 * second, so that auditors can tie a row back to the import run that created
 * it. Returns the number of rows inserted.
 */
export function importBatch(store, accountId, records, { clock = Date.now, idGen = newTransactionId } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const stampedAt = Math.floor(clock() / 1000) * 1000;
  const rows = records.map((r) => ({
    id: idGen(),
    accountId,
    amountCents: toCents(r.amount),
    currency: r.currency ?? 'USD',
    memo: r.memo ?? '',
    createdAt: stampedAt,
    source: 'import',
  }));
  return store.insertMany(rows);
}
