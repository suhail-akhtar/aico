export const CSV_HEADER = 'id,created_at,amount,currency,memo';

function quote(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function toCsvRow(tx) {
  return [
    quote(tx.id),
    new Date(tx.createdAt).toISOString(),
    formatAmount(tx.amountCents),
    quote(tx.currency),
    quote(tx.memo),
  ].join(',');
}
