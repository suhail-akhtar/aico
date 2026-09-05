/**
 * How hard to think, for models that can be asked.
 *
 * The control exists because of a real complaint: small tasks were taking a
 * long time to think about. DeepSeek's platform default is `high` with no
 * adaptive option, and aico sent it on every request — including the step that
 * reads one line of `git status`. There was no way to say otherwise.
 *
 * ## It offers what the model has, and nothing when it has none
 *
 * The levels come from `reasoning.ts`, per model, because they genuinely differ:
 * GLM is a switch, Gemini's sets vary between models in one family, and OpenAI's
 * own guide declines to enumerate them. A model nothing is known about shows no
 * control at all — offering five settings that might each 400 would be worse
 * than offering none.
 *
 * ## `auto` is not a level
 *
 * It means "send nothing". For Claude that is genuinely the best answer, because
 * 4.6 and later decide per request; pinning a middle value would replace a
 * decision made with the request in view by one made once, without it. For
 * DeepSeek it means `high`, which is why the menu says so rather than leaving
 * the reader to wonder where the time is going.
 *
 * @module components/EffortMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { effortDisplay, reasoningFor, type EffortChoice, type EffortLevel } from '@aico/reasoning';

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

export function EffortMenu({ value, onChange }: {
  value: EffortChoice;
  onChange: (next: EffortChoice) => void;
}): React.ReactElement | null {
  const pinned = useStore(s => s.model);
  const fallbackModel = useStore(s => s.defaultModel);
  const model = pinned ?? fallbackModel ?? '';

  const choice = value;
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

  /*
    Nothing to offer, so nothing is shown.

    Also the right behaviour when the model changes under a choice: the composer
    reads `effort` back out of this component, and a hidden menu reports `auto`,
    which sends no parameter at all.
  */
  if (fact.levels.length === 0) return null;

  // What will be sent on this model, which is not always what was picked —
  // a choice outlives a model switch and is stepped to the nearest rung.
  const display = effortDisplay(model, choice);
  const shown = display.shown;
  const label = shown === 'auto' ? autoLabel(fact.fallback) : shown;
  const stepped = display.stepped && display.from
    ? ` (this model has no "${display.from}"; ${shown} is sent)`
    : '';

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title={`Reasoning effort: ${shown === 'auto' ? `auto — ${autoMeaning(fact.fallback)}` : shown}${stepped}`}
        data-effort={shown}
        className={[
          'rounded px-1.5 py-0.5 text-[11px]',
          shown === 'auto'
            ? 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'
            : 'bg-aico-accent-soft text-aico-accent',
        ].join(' ')}
      >
        {label}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-[240px] rounded border border-aico-border bg-aico-elevated py-1 shadow-lg">
          <Row
            active={choice === 'auto'}
            label="Auto"
            blurb={autoMeaning(fact.fallback)}
            onPick={() => { onChange('auto'); setOpen(false); }}
          />
          {fact.levels.map(level => (
            <Row
              key={level}
              active={shown === level}
              label={level}
              blurb={BLURB[level]}
              onPick={() => { onChange(level); setOpen(false); }}
            />
          ))}
          {/*
            Where the answer came from. The same honesty the context meter
            applies to a window: a set nothing has verified should not look
            identical to one a provider confirmed by refusing a value.
          */}
          <p className="border-t border-aico-border-subtle px-2 pt-1 text-[10px] text-aico-muted">
            {fact.source === 'learned'
              ? 'Levels confirmed by this provider.'
              : 'Levels from the built-in table.'}
          </p>
        </div>
      )}
    </div>
  );
}

/** What `auto` actually does on this model, said rather than implied. */
function autoMeaning(fallback: ReturnType<typeof reasoningFor>['fallback']): string {
  if (fallback === 'adaptive') return 'The model decides per request. Usually the best choice.';
  if (fallback === 'unknown') return 'Send nothing and take the provider default.';
  return `Send nothing — this provider then uses ${fallback}.`;
}

/**
 * The button's text when nothing is pinned.
 *
 * A provider whose silent default is `high` says so on the button. "Auto" alone
 * would hide the single most useful fact about why a small task took a while.
 */
function autoLabel(fallback: ReturnType<typeof reasoningFor>['fallback']): string {
  if (fallback === 'adaptive' || fallback === 'unknown') return 'Auto';
  return `Auto (${fallback})`;
}

function Row({ active, label, blurb, onPick }: {
  active: boolean; label: string; blurb: string; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onPick}
      className={[
        'block w-full px-2 py-1 text-left hover:bg-aico-hover',
        active ? 'text-aico-accent' : 'text-aico-primary',
      ].join(' ')}
    >
      <span className="block text-[11px] capitalize">{label}</span>
      <span className="block text-[10px] leading-snug text-aico-muted">{blurb}</span>
    </button>
  );
}
