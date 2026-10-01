# ledger-export

Transaction storage and the nightly per-account CSV export used by Finance.

## Layout

| File | What |
|---|---|
| `src/store.js` | `TransactionStore` — holds transactions, answers paged queries (`page()`), counts per account |
| `src/cursor.js` | Opaque pagination cursors handed out by `page()` |
| `src/import.js` | `importBatch()` — bulk importer used when onboarding customers from CSV/ERP dumps |
| `src/export.js` | `iterateAccount()` / `exportAccountCsv()` — the nightly export job walks an account page by page |
| `src/csv.js` | CSV row formatting (amounts in cents → decimal strings, RFC 4180 quoting) |
| `src/ids.js` | Transaction id generation |

Amounts are stored as integer cents. `createdAt` is epoch milliseconds.

## Running

```
npm test
```

No dependencies; Node 20+.
