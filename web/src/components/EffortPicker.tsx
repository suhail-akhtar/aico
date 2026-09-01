/**
 * How hard to think, in the browser client.
 *
 * The same control the VS Code panel has, and the same rule: it offers what the
 * *model* accepts and nothing when the model is unknown. Both read
 * `shared/reasoning`, so there is one answer about what a model can be asked and
 * two places that render it — a second table would drift within a release.
 *
 * Shipping this only in the panel would have been the worse kind of gap: the
 * browser workspace is where most sessions still run, and it is where "why is
 * a one-line change taking so long" is asked. The answer for DeepSeek — that
 * its platform default is `high` on every request — was equally invisible here.
 *
 * @module components/EffortPicker
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  reasoningFor, type EffortChoice, type EffortLevel,
} from '../../../shared/reasoning';
import { useStore } from '../store';
import { TOOLBAR_CAPTION, TOOLBAR_CONTROL, toolbarTone } from './toolbar';

/** What each rung means, in the words someone choosing would use. */
const BLURB: Record<EffortLevel, string> = {
  off: 'Do not think first. Fastest, and wrong for anything subtle.',
  minimal: 'Barely think. For lookups and mechanical edits.',
  low: 'A little thought. Good for small, well-defined changes.',
  medium: 'Balanced.',
  high: 'Think hard. For design, debugging and anything unfamiliar.',
  xhigh: 'Think harder still. Slow, and occasionally worth it.',
  max: 'Everything it has. Expect to wait.',
};

export function EffortPicker({ value, onChange, disabled }: {
  value: EffortChoice;
  onChange: (next: EffortChoice) => void;
  disabled?: boolean;
}): React.ReactElement | null {
  const pinned = useStore(s => s.model);
  const fallbackModel = useStore(s => s.defaultModel);
  const model = pinned ?? fallbackModel ?? '';

  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const fact = reasoningFor(model);

  // Nothing known about this model, so nothing offered. Five settings that
  // might each be refused would be worse than none.
  if (fact.levels.length === 0) return null;

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        disabled={disabled}
        title={`Reasoning effort — ${value === 'auto' ? autoMeaning(fact.fallback) : BLURB[value]}`}
        className={`${TOOLBAR_CONTROL} ${toolbarTone(value !== 'auto')}`}
      >
        <span className={value === 'auto' ? TOOLBAR_CAPTION : ''}>Think</span>
        {value === 'auto' ? autoLabel(fact.fallback) : value}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-aico-border
                        bg-aico-bg py-1 shadow-lg">
          <Row
            active={value === 'auto'}
            label="Auto"
            blurb={autoMeaning(fact.fallback)}
            onPick={() => { onChange('auto'); setOpen(false); }}
          />
          {fact.levels.map(level => (
            <Row
              key={level}
              active={value === level}
              label={level}
              blurb={BLURB[level]}
              onPick={() => { onChange(level); setOpen(false); }}
            />
          ))}
          {/*
            Where the answer came from, for the same reason the context meter
            distinguishes a measured window from an assumed one: a set nothing
            has confirmed should not look identical to one a provider confirmed
            by refusing a value.
          */}
          <p className="border-t border-aico-border-subtle px-3 pt-1.5 text-[11px] text-aico-muted">
            {fact.source === 'learned'
              ? 'Levels confirmed by this provider.'
              : 'Levels from the built-in table.'}
          </p>
        </div>
      )}
    </div>
  );
}

/** What `auto` actually does here, said rather than implied. */
function autoMeaning(fallback: ReturnType<typeof reasoningFor>['fallback']): string {
  if (fallback === 'adaptive') return 'The model decides per request. Usually the best choice.';
  if (fallback === 'unknown') return 'Send nothing and take the provider default.';
  return `Send nothing — this provider then uses ${fallback}.`;
}

/**
 * A provider whose silent default is `high` says so on the button.
 *
 * "Auto" alone would hide the single most useful fact about why a small task
 * took a while, which is the complaint that produced this control.
 */
function autoLabel(fallback: ReturnType<typeof reasoningFor>['fallback']): string {
  if (fallback === 'adaptive' || fallback === 'unknown') return 'auto';
  /*
    `auto·high`, not `auto (high)`.

    The parenthetical read as an aside about something optional, and at
    eighteen characters it was the label that pushed this row into wrapping.
    The middot says the two are one value — what you chose, and what that
    turns into here — in six fewer characters.
  */
  return `auto·${fallback}`;
}

function Row({ active, label, blurb, onPick }: {
  active: boolean; label: string; blurb: string; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onPick}
      className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-aico-hover ${
        active ? 'text-aico-accent' : 'text-aico-primary'
      }`}
    >
      <span className="block text-[13px] capitalize">{label}</span>
      <span className="block text-[12px] leading-snug text-aico-muted">{blurb}</span>
    </button>
  );
}
