import { CSV_HEADER, toCsvRow } from './csv.js';

const DEFAULT_PAGE_SIZE = 500;

/** Every transaction of an account, oldest first, fetched page by page. */
export async function* iterateAccount(store, accountId, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
  let after = null;
  do {
    const { items, nextCursor } = store.page(accountId, { after, limit: pageSize });
    for (const tx of items) yield tx;
    after = nextCursor;
  } while (after);
}

/**
 * The nightly export file for one account.
 *
 * TODO(finance-platform): stream rows to the object store instead of building
 * the whole file in memory once the largest accounts pass ~1M rows.
 */
export async function exportAccountCsv(store, accountId, options = {}) {
  const lines = [CSV_HEADER];
  for await (const tx of iterateAccount(store, accountId, options)) lines.push(toCsvRow(tx));
  return `${lines.join('\n')}\n`;
}
