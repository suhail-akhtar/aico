/**
 * `CurrencyRates` — exchange rates, ready for a ```currency converter card.
 *
 * Two keyless sources, used in a fixed order and always named:
 *
 *   1. Frankfurter — the European Central Bank's daily reference rates. The
 *      authoritative one, and the only one with history, but the ECB publishes
 *      about thirty currencies: no PKR, no AED, no NGN.
 *   2. open.er-api.com — a free daily feed covering ~160 currencies, used only
 *      for what Frankfurter does not carry.
 *
 * Every rate in the result says which of the two it came from, because "the
 * rate" for a currency the ECB does not publish is a different kind of number
 * from one it does, and a reader converting real money is entitled to know.
 *
 * @module tools/currency
 */

import { requestJson, TtlCache, fencedBlock } from './net.js';

export interface CurrencyInput {
  base: string;
  symbols?: string[] | string;
  amount?: number;
  date?: string;
}

const FRANKFURTER = 'https://api.frankfurter.app';
const ER_API = 'https://open.er-api.com/v6/latest';

const cache = new TtlCache<unknown>(30 * 60 * 1000);

export function resetCurrencyForTests(): void {
  cache.clear();
}

async function cachedJson<T>(url: string, what: string): Promise<T> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit as T;
  const value = await requestJson<T>(url, { what });
  cache.set(url, value);
  return value;
}

interface Rate { rate: number; source: 'Frankfurter (ECB)' | 'open.er-api.com'; date?: string }

/** Six significant figures: enough for 0.00361 and for 278.412, noise for neither. */
function sig(value: number): number {
  return Number(value.toPrecision(6));
}

function codeList(input: CurrencyInput['symbols']): string[] {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  return [...new Set(raw.map(s => String(s).trim().toUpperCase()).filter(Boolean))];
}

export async function currencyRates(input: CurrencyInput): Promise<string> {
  const base = String(input.base ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) throw new Error(`"${input.base}" is not a currency code — use three letters, like USD or PKR.`);
  const symbols = codeList(input.symbols).filter(s => s !== base);
  const bad = symbols.filter(s => !/^[A-Z]{3}$/.test(s));
  if (bad.length) throw new Error(`Not currency codes: ${bad.join(', ')}. Use three-letter ISO codes like EUR, GBP, PKR.`);
  const amount = typeof input.amount === 'number' && Number.isFinite(input.amount) && input.amount > 0 ? input.amount : undefined;
  const date = input.date?.trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD.');
  if (date && date > new Date().toISOString().slice(0, 10)) throw new Error('date is in the future — rates are only published for past days.');

  const rates = new Map<string, Rate>();
  const notes: string[] = [];

  // Which currencies the ECB set covers. Asked rather than hard-coded, because
  // the set changes (it dropped RUB in 2022) — and if the list cannot be had,
  // Frankfurter is simply asked and its answer trusted.
  let ecb: Set<string> | undefined;
  try {
    ecb = new Set(Object.keys(await cachedJson<Record<string, string>>(`${FRANKFURTER}/currencies`, 'Frankfurter currency list')));
  } catch { /* unknown; ask anyway */ }

  if (!ecb || ecb.has(base)) {
    const wanted = symbols.length ? symbols.filter(s => !ecb || ecb.has(s)) : [];
    if (symbols.length === 0 || wanted.length > 0) {
      const qs = new URLSearchParams({ from: base, ...(wanted.length ? { to: wanted.join(',') } : {}) });
      try {
        const r = await cachedJson<{ date?: string; rates?: Record<string, number> }>(
          `${FRANKFURTER}/${date ?? 'latest'}?${qs}`, 'Frankfurter (ECB rates)');
        for (const [code, rate] of Object.entries(r.rates ?? {})) {
          if (typeof rate === 'number') rates.set(code, { rate: sig(rate), source: 'Frankfurter (ECB)', ...(r.date ? { date: r.date } : {}) });
        }
      } catch (err) {
        notes.push(`Frankfurter did not answer (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
  }

  // Whatever the ECB does not publish — or everything, if the base itself is
  // not one of its currencies or Frankfurter was unreachable.
  const missing = symbols.length ? symbols.filter(s => !rates.has(s)) : (rates.size === 0 ? ['*'] : []);
  if (missing.length > 0) {
    if (date) {
      notes.push(`Historical rates come only from the ECB set, which does not include ${missing[0] === '*' ? base : missing.join(', ')}.`);
    } else {
      try {
        const r = await cachedJson<{ result?: string; 'error-type'?: string; time_last_update_utc?: string; rates?: Record<string, number> }>(
          `${ER_API}/${base}`, 'open.er-api.com rates');
        if (r.result !== 'success') {
          notes.push(`open.er-api.com could not price ${base}${r['error-type'] ? ` (${r['error-type']})` : ''}.`);
        } else {
          const updated = r.time_last_update_utc ? new Date(r.time_last_update_utc) : undefined;
          const day = updated && !Number.isNaN(updated.getTime()) ? updated.toISOString().slice(0, 10) : undefined;
          const take = missing[0] === '*' ? Object.keys(r.rates ?? {}).filter(c => c !== base) : missing;
          for (const code of take) {
            const rate = r.rates?.[code];
            if (typeof rate === 'number') rates.set(code, { rate: sig(rate), source: 'open.er-api.com', ...(day ? { date: day } : {}) });
          }
        }
      } catch (err) {
        notes.push(`open.er-api.com did not answer (${err instanceof Error ? err.message : String(err)}).`);
      }
    }
  }

  const unpriced = symbols.filter(s => !rates.has(s));
  if (rates.size === 0) {
    throw new Error([`No exchange rates could be found for ${base}${symbols.length ? ` → ${symbols.join(', ')}` : ''}.`, ...notes].join(' '));
  }

  const order = symbols.length ? symbols.filter(s => rates.has(s)) : [...rates.keys()].sort();
  const bySource = new Map<string, string[]>();
  for (const code of order) {
    const src = rates.get(code)!.source;
    bySource.set(src, [...(bySource.get(src) ?? []), code]);
  }
  const sourceText = [...bySource].map(([src, codes]) => `${src}: ${codes.length > 8 ? `${codes.length} currencies` : codes.join(', ')}`).join('; ');
  const dates = [...new Set(order.map(c => rates.get(c)!.date).filter(Boolean))] as string[];

  const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 6 });
  const lines = order.map(code => {
    const r = rates.get(code)!;
    return `1 ${base} = ${fmt(r.rate)} ${code}`
      + `${amount ? ` → ${fmt(amount)} ${base} = ${fmt(sig(amount * r.rate))} ${code}` : ''}`
      + ` (${r.source}${r.date ? `, ${r.date}` : ''})`;
  });

  const block = {
    base,
    ...(amount ? { amount } : {}),
    rates: Object.fromEntries(order.map(c => [c, rates.get(c)!.rate])),
    ...(dates.length ? { date: dates.sort().at(-1) } : {}),
    source: sourceText,
  };

  return [
    `Exchange rates for ${base}${date ? ` on ${date}` : ''} (rates are per 1 ${base}):`,
    ...lines,
    ...(unpriced.length ? [`No rate found for: ${unpriced.join(', ')}.`] : []),
    ...notes,
    'These are reference/market mid rates, not what a bank or exchange will charge.',
    'Show a converter by pasting this block as it is:',
    fencedBlock('currency', block),
  ].join('\n');
}

export const currencyRatesDefinition = {
  name: 'CurrencyRates',
  description:
    'Exchange rates between currencies — no key needed. ECB reference rates via Frankfurter (with history by `date`), '
    + 'falling back to open.er-api.com for currencies the ECB does not publish (e.g. PKR, AED); each rate names its source. '
    + 'Optionally converts an `amount`. Returns a summary and a ready-to-paste ```currency block that draws a converter card.',
  inputSchema: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Currency to convert from, ISO code ("USD").' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'Currencies to convert to (["PKR","EUR"]). Omit for all.' },
      amount: { type: 'number', description: 'Amount of the base currency to convert (optional).' },
      date: { type: 'string', description: 'YYYY-MM-DD for a historical rate (ECB currencies only). Omit for the latest.' },
    },
    required: ['base'],
  },
};
