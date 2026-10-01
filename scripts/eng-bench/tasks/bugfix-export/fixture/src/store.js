import { encodeCursor, decodeCursor } from './cursor.js';

const MAX_LIMIT = 1000;

function validate(tx) {
  if (!tx || typeof tx !== 'object') throw new TypeError('transaction must be an object');
  if (typeof tx.id !== 'string' || !tx.id) throw new TypeError('transaction.id is required');
  if (typeof tx.accountId !== 'string' || !tx.accountId) throw new TypeError('transaction.accountId is required');
  if (!Number.isInteger(tx.amountCents)) throw new TypeError('transaction.amountCents must be an integer');
  if (!Number.isFinite(tx.createdAt)) throw new TypeError('transaction.createdAt must be epoch milliseconds');
}

/**
 * Transactions for every account. The production deployment backs this with a
 * table; this in-process implementation is what the export job and the tests use.
 */
export class TransactionStore {
  constructor() {
    this.rows = [];
    this.byId = new Map();
  }

  insert(tx) {
    validate(tx);
    if (this.byId.has(tx.id)) throw new Error(`duplicate transaction id ${tx.id}`);
    const row = { currency: 'USD', memo: '', source: 'api', ...tx };
    this.rows.push(row);
    this.byId.set(row.id, row);
    return row;
  }

  insertMany(txs) {
    for (const tx of txs) this.insert(tx);
    return txs.length;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  count(accountId) {
    let n = 0;
    for (const r of this.rows) if (r.accountId === accountId) n++;
    return n;
  }

  /**
   * One page of an account's transactions, oldest first.
   *
   * `after` is the `nextCursor` of the previous page (or null for the first
   * page). `nextCursor` is null on the last page.
   */
  page(accountId, { after = null, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    const rows = this.rows
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => a.createdAt - b.createdAt);

    let remaining = rows;
    if (after) {
      const c = decodeCursor(after);
      remaining = rows.filter((r) => r.createdAt > c.createdAt);
    }

    const items = remaining.slice(0, limit);
    const nextCursor = remaining.length > limit ? encodeCursor(items[items.length - 1]) : null;
    return { items, nextCursor };
  }
}
