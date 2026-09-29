/**
 * ```currency — a converter over the rates the block carries.
 *
 * Both amounts are editable and each drives the other; the swap button flips
 * the pair; any currency in `rates` can be chosen on either side, converted
 * through the base. The rates are the model's (usually from a lookup), so the
 * date and source are always shown with them.
 *
 * @module shared/ui/rich/Currency
 */

import React, { useMemo, useState } from 'react';
import { Arriving, Icon, useParsed } from './common';
import { convertCurrency, formatAmount, formatRate, parseCurrency, type CurrencySpec } from './specs';

export function Currency({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseCurrency);
  if (waiting || !spec) return <Arriving what="Converter" />;
  return <Converter key={source} spec={spec} />;
}

let names: Intl.DisplayNames | null | undefined;
function currencyName(code: string): string | undefined {
  if (names === undefined) {
    try { names = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch { names = null; }
  }
  try { const n = names?.of(code); return n && n !== code ? n : undefined; } catch { return undefined; }
}

function parseInput(s: string): number {
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function plain(n: number): string {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const digits = abs >= 1 || abs === 0 ? 2 : Math.min(8, 2 - Math.floor(Math.log10(abs)) + 1);
  return String(Number(n.toFixed(digits)));
}

function Converter({ spec }: { spec: CurrencySpec }): React.ReactElement {
  const codes = useMemo(() => Object.keys(spec.rates), [spec.rates]);
  const [from, setFrom] = useState(spec.base);
  const [to, setTo] = useState(spec.target);
  const [fromText, setFromText] = useState(plain(spec.amount));
  const [toText, setToText] = useState(plain(convertCurrency(spec.amount, spec.base, spec.target, spec.rates)));
  const [driver, setDriver] = useState<'from' | 'to'>('from');

  const fromAmount = driver === 'from' ? parseInput(fromText) : convertCurrency(parseInput(toText), to, from, spec.rates);
  const toAmount = driver === 'to' ? parseInput(toText) : convertCurrency(parseInput(fromText), from, to, spec.rates);
  const rate = convertCurrency(1, from, to, spec.rates);
  const inverse = convertCurrency(1, to, from, spec.rates);

  const editFrom = (v: string): void => { setDriver('from'); setFromText(v); setToText(plain(convertCurrency(parseInput(v), from, to, spec.rates))); };
  const editTo = (v: string): void => { setDriver('to'); setToText(v); setFromText(plain(convertCurrency(parseInput(v), to, from, spec.rates))); };
  const pickFrom = (c: string): void => { setFrom(c); setDriver('from'); setToText(plain(convertCurrency(fromAmount, c, to, spec.rates))); setFromText(plain(fromAmount)); };
  const pickTo = (c: string): void => { setTo(c); setDriver('from'); setFromText(plain(fromAmount)); setToText(plain(convertCurrency(fromAmount, from, c, spec.rates))); };
  const swap = (): void => {
    setFrom(to); setTo(from);
    setFromText(plain(toAmount)); setToText(plain(fromAmount)); setDriver('from');
  };

  const others = codes.filter(c => c !== from && c !== to);

  return (
    <div className="aw aw-fx">
      <div className="aw-fx-headline">
        <span className="aw-muted">{Number.isFinite(fromAmount) ? formatAmount(fromAmount) : '—'} {currencyName(from) ?? from} equals</span>
        <b>{Number.isFinite(toAmount) ? formatAmount(toAmount) : '—'} {currencyName(to) ?? to}</b>
      </div>
      <div className="aw-fx-pair">
        <Side label="From" code={from} codes={codes} text={fromText} onText={editFrom} onCode={pickFrom} />
        <button type="button" className="aw-fx-swap" onClick={swap} aria-label="Swap currencies" title="Swap">
          <Icon name="swap" size={16} />
        </button>
        <Side label="To" code={to} codes={codes} text={toText} onText={editTo} onCode={pickTo} />
      </div>
      <div className="aw-fx-rate">
        <span>1 {from} = <b>{formatRate(rate)}</b> {to}</span>
        <span className="aw-muted">1 {to} = {formatRate(inverse)} {from}</span>
      </div>
      {others.length > 0 && (
        <div className="aw-fx-others" role="list" aria-label="Other currencies">
          {others.map(c => (
            <button key={c} type="button" role="listitem" className="aw-fx-other" onClick={() => pickTo(c)} title={`Convert to ${currencyName(c) ?? c}`}>
              <span className="aw-fx-code">{c}</span>
              <b>{formatAmount(convertCurrency(fromAmount, from, c, spec.rates))}</b>
            </button>
          ))}
        </div>
      )}
      <div className="aw-source">
        {[spec.date && `Rates as of ${spec.date}`, spec.source && `Source: ${spec.source}`].filter(Boolean).join(' · ') || 'Rates as given — not live'}
      </div>
    </div>
  );
}

function Side({ label, code, codes, text, onText, onCode }: {
  label: string; code: string; codes: string[]; text: string; onText: (v: string) => void; onCode: (c: string) => void;
}): React.ReactElement {
  return (
    <label className="aw-fx-side">
      <span className="aw-fx-label">{label}</span>
      <span className="aw-fx-field">
        <input
          className="aw-fx-input"
          inputMode="decimal"
          value={text}
          onChange={e => onText(e.target.value)}
          aria-label={`${label} amount`}
        />
        {/* The native select stays (keyboard, mobile pickers) but is drawn over
            by the code alone, so a long currency name never clips the field. */}
        <span className="aw-fx-select-wrap" title={currencyName(code) ?? code}>
          <span className="aw-fx-code">{code}</span>
          <Icon name="chevron-right" size={11} className="aw-fx-caret" />
          <select className="aw-fx-select" value={code} onChange={e => onCode(e.target.value)} aria-label={`${label} currency`}>
            {codes.map(c => <option key={c} value={c}>{c}{currencyName(c) ? ` — ${currencyName(c)}` : ''}</option>)}
          </select>
        </span>
      </span>
    </label>
  );
}
