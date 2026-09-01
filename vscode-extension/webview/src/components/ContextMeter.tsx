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

import React from 'react';
import { useStore } from '@web/store';

/** Where the bar stops being reassuring and starts being a warning. */
const WARN_AT = 0.75;
const DANGER_AT = 0.9;

/** What each provenance means, in the words a reader needs. */
const SOURCE_NOTE: Record<string, string> = {
  user: 'you set this limit',
  api: 'reported by the provider',
  learned: 'learned from a provider error',
  table: "from aico's built-in table",
  assumed: 'assumed — no source knows this model',
};

export function ContextMeter(): React.ReactElement | null {
  const usage = useStore(s => s.usage);

  const window = usage.contextWindow;
  if (!window) return null;

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
    <span
      title={label}
      aria-label={label}
      className="flex shrink-0 items-center gap-1"
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
    </span>
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
