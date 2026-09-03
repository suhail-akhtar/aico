/**
 * How full the context is, and how much that figure can be trusted.
 *
 * A token count on its own says nothing. 180k is comfortable in a
 * million-token window and nearly fatal in a two-hundred-thousand one, and
 * nobody reading "180k" can tell which they are in — so this always shows
 * occupancy, never a bare number.
 *
 * The provenance is the other half, and it is why the bar is drawn differently
 * when the window was assumed. `contextSource` distinguishes a limit the vendor
 * returned from one nothing stands behind, and presenting those identically is
 * how somebody comes to rely on a fallback. An assumed window is drawn dashed
 * and says so on hover; it is a guess, and it looks like one.
 *
 * Hidden entirely until the server has said what the window is. A meter drawn
 * against an unknown denominator is worse than no meter.
 *
 * @module components/ContextMeter
 */

import React, { useState } from 'react';
import { api } from '@web/api';
import { useStore } from '@web/store';

/** Where the bar stops being reassuring and starts being a warning. */
const WARN_AT = 0.75;
const DANGER_AT = 0.9;

/** What each provenance means, in the words a reader needs. */
const SOURCE_NOTE: Record<string, string> = {
  user: 'you set this limit',
  api: 'reported by the provider',
  learned: 'learned from a provider error',
  observed: 'inferred — it accepted more than was assumed',
  table: "from aico's built-in table",
  assumed: 'assumed — no source knows this model',
};

export function ContextMeter(): React.ReactElement | null {
  const usage = useStore(s => s.usage);
  const model = useStore(s => s.model ?? s.defaultModel);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const window = usage.contextWindow;
  if (!window) return null;

  /*
    Click to set it. A wrong window is the one thing about this meter that
    was reported, and the only remedy was a JSON file. `1m`, `128k` and plain
    digits are all accepted, because that is how model cards write it.
  */
  const parse = (raw: string): number | null => {
    const m = /^\s*([\d,._]+)\s*([km]?)\s*$/i.exec(raw);
    if (!m) return null;
    const n = Number(m[1]!.replace(/[,_]/g, ''));
    if (!Number.isFinite(n)) return null;
    const unit = m[2]!.toLowerCase();
    return Math.round(unit === 'm' ? n * 1_000_000 : unit === 'k' ? n * 1_000 : n);
  };
  const commit = async (): Promise<void> => {
    const tokens = parse(value);
    setEditing(false);
    if (!tokens || !model) return;
    try {
      const result = await api.setContextWindow(model, tokens);
      useStore.setState(s => ({
        usage: { ...s.usage, contextWindow: result.tokens, contextSource: result.source },
      }));
    } catch { /* the meter simply keeps showing what it showed */ }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        placeholder="window: 1m, 128k"
        aria-label="Context window size"
        className="w-[88px] rounded border border-aico-accent bg-aico-elevated px-1 text-[10px]
                   text-aico-primary placeholder:text-aico-muted focus:outline-none"
      />
    );
  }

  // Input plus cache reads: what the model actually had to read this turn.
  // Output is not occupancy — it left the window as it was written.
  const used = usage.input + usage.cached;
  const ratio = Math.min(1, used / window);
  const percent = Math.round(ratio * 100);
  const assumed = usage.contextSource === 'assumed' || usage.contextSource === '';

  const tone = ratio >= DANGER_AT ? 'bg-aico-danger'
    : ratio >= WARN_AT ? 'bg-aico-warning'
      : 'bg-aico-accent';

  const note = SOURCE_NOTE[usage.contextSource] ?? 'source unknown';
  const label = `${compact(used)} of ${compact(window)} tokens — ${percent}% (${note})`;

  return (
    <button
      type="button"
      onClick={() => { setValue(String(window)); setEditing(true); }}
      title={`${label}. Click to set the real window size.`}
      aria-label={label}
      className="flex shrink-0 items-center gap-1 rounded px-0.5 hover:bg-aico-hover"
    >
      <span
        className={[
          'h-[3px] w-8 overflow-hidden rounded-full bg-aico-hover',
          // A dashed outline for a window nothing measured. Colour alone would
          // not survive a colourblind reader or a high-contrast theme.
          assumed ? 'border border-dashed border-aico-muted' : '',
        ].join(' ')}
      >
        <span
          className={`block h-full ${tone}`}
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </span>
      <span className="text-[10px] tabular-nums text-aico-muted">
        {percent}%{assumed ? '?' : ''}
      </span>
    </button>
  );
}

/** 12_400 → "12.4k". Narrow enough for a control strip, precise enough to act on. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}
