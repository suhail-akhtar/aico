/**
 * One settings row, rendered from its schema record.
 *
 * The layout rule is the same for every kind: what the setting *is* on the
 * left, what it is *set to* on the right, one hairline between rows and no
 * boxes. A settings screen that boxes every row turns eight options into eight
 * panels, and the panels end up louder than the words in them.
 *
 * Segmented fields break the rule deliberately. A three-way choice where each
 * option needs a sentence of explanation does not fit in a control on the right
 * — squeezing it into a dropdown hides exactly the information someone opened
 * the screen to read.
 *
 * Every row knows whether it differs from what the engine does unset, and says
 * so with a single accent dot and an undo control that appears on hover. That
 * is the answer to "what did I change in here?", which is otherwise a question
 * only the settings file can answer.
 *
 * @module components/settings/Field
 */

import React from 'react';
import type { Field as FieldSpec, LockedSetting } from '../../settings-schema';
import { Icon } from '../Icon';

export interface FieldProps {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Set when the stored value differs from the engine's unset behaviour. */
  changed: boolean;
  /** Shown above the label when the row is a search hit from another pane. */
  breadcrumb?: string;
  /**
   * Set when the organisation's managed policy governs this setting (ADR 0035).
   * A `fixed` lock disables the control; the others stay editable inside the
   * policy's bounds, and the row says why it is managed. The engine enforces
   * either way — this is the screen telling the truth, not the lock.
   */
  lock?: LockedSetting | undefined;
}

export function Field({ spec, value, onChange, changed, breadcrumb, lock }: FieldProps): React.ReactElement {
  const fixed = lock?.kind === 'fixed';
  const stacked = spec.kind === 'segmented';
  /*
    Only the wide controls drop below their label.

    A text field or a select is 15rem and is what squeezes the prose beside it.
    A toggle is 38px and a number is not much more — both fit alongside the
    label at any width this client is usable at, and moving them down would
    strand a small control on an empty line for no gain.
  */
  const wide = spec.kind === 'text' || spec.kind === 'select' || spec.kind === 'list';

  return (
    <div className="group/field border-b border-aico-border-subtle py-4 last:border-b-0">
      {/*
        Side by side when there is room, stacked when there is not.

        The control is a fixed 15rem. In a modal on a 700px window that leaves
        about 165px for the label, so "Defaults to the cheapest model in the
        same family as your provider" came out as four lines beside a control
        with empty space around it — squeezing the half that is prose to
        protect the half that is a fixed-width box.

        768px rather than a container query because the modal is sized from the
        viewport, so the two track each other closely enough and this needs no
        new machinery.
      */}
      <div className={stacked ? ''
        : `flex items-start gap-6 ${wide ? 'max-md:flex-col max-md:gap-2' : ''}`}>
        <div className="min-w-0 flex-1">
          {breadcrumb && (
            <div className="mb-0.5 text-[11px] uppercase tracking-wider text-aico-muted">{breadcrumb}</div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-aico-primary">{spec.label}</span>
            {lock && (
              <span
                title={lock.reason}
                className="flex items-center gap-1 rounded-full border border-aico-border-subtle px-1.5 py-0.5 text-[11px] text-aico-muted"
                data-testid="managed-lock"
              >
                <Icon name="lock" size={12} /> Managed
              </span>
            )}
            {changed && !fixed && (
              <>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-aico-accent"
                  title="Changed from the default"
                />
                <button
                  onClick={() => onChange(undefined)}
                  title="Put this back to the default"
                  // Always visible on a changed row: hover-only hid it from touch.
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-aico-muted
                             transition-colors hover:text-aico-primary"
                >
                  <Icon name="undo" size={16} /> Reset
                </button>
              </>
            )}
          </div>
          {spec.hint && (
            <p className="mt-0.5 max-w-lg text-[13px] leading-relaxed text-aico-secondary">{spec.hint}</p>
          )}
          {lock && <p className="mt-0.5 max-w-lg text-[12px] leading-relaxed text-aico-muted">{lock.reason}</p>}
        </div>

        {!stacked && (
          <div className={`shrink-0 pt-0.5 ${wide ? 'max-md:w-full max-md:pt-0' : ''}`}>
            <fieldset disabled={fixed} className="m-0 min-w-0 border-0 p-0 disabled:opacity-60">
              <Control spec={spec} value={value} onChange={onChange} />
            </fieldset>
          </div>
        )}
      </div>

      {stacked && (
        <fieldset disabled={fixed} className="m-0 mt-3 min-w-0 border-0 p-0 disabled:opacity-60">
          <Control spec={spec} value={value} onChange={onChange} />
        </fieldset>
      )}
    </div>
  );
}

function Control(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  switch (spec.kind) {
    case 'segmented': return <Segmented spec={spec} value={value} onChange={onChange} />;
    case 'toggle': return <Toggle spec={spec} value={value} onChange={onChange} />;
    case 'number': return <NumberInput spec={spec} value={value} onChange={onChange} />;
    case 'select': return <Select spec={spec} value={value} onChange={onChange} />;
    case 'text': return <TextInput spec={spec} value={value} onChange={onChange} />;
    case 'list': return <ListInput spec={spec} value={value} onChange={onChange} />;
  }
}

/**
 * A short list, typed as comma-separated items.
 *
 * Tool names, folders, thresholds — lists of a few words each, where a
 * repeater with add and remove buttons would be more machinery than the data.
 * Saved as an array; blank means unset.
 */
function ListInput(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  const [draft, setDraft, done] = useDraft(Array.isArray(value) ? value.join(', ') : value);
  const [error, setError] = React.useState<string | null>(null);
  const placeholder = spec.placeholder
    ?? (Array.isArray(spec.fallbackList) ? spec.fallbackList.join(', ') : '');
  const commit = (): void => {
    done();
    const items = draft.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    if (items.length === 0) { setError(null); if (value !== undefined) onChange(undefined); return; }
    const next: unknown[] = spec.numeric ? items.map(Number) : items;
    if (spec.numeric && next.some(n => !Number.isFinite(n as number))) { setError('Numbers only'); return; }
    setError(null);
    if (JSON.stringify(next) !== JSON.stringify(value)) onChange(next);
  };
  return (
    <div className="flex flex-col items-end gap-1 max-md:w-full">
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={e => { setDraft(e.target.value); setError(null); }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { e.stopPropagation(); setError(null); done(); }
        }}
        aria-label={spec.label}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-full border bg-aico-surface px-3.5 py-1.5 text-[13px] text-aico-primary
                   placeholder:text-aico-muted transition-colors focus:border-aico-accent/60 focus:outline-none
                   md:w-[15rem] ${error ? 'border-red-500/70' : 'border-aico-border-subtle'}`}
      />
      {error && <span role="alert" className="text-[11px] text-red-500">{error} — not saved</span>}
    </div>
  );
}

/**
 * A choice where each option needs explaining.
 *
 * Cards rather than a dropdown, side by side, so the trade-off between them is
 * readable without opening anything. Wraps to one per line on a narrow screen
 * rather than shrinking each card until the explanation is unreadable.
 */
function Segmented(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  const current = (value ?? spec.fallback) as string | undefined;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {(spec.options ?? []).map(option => {
        const active = current === option.value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={`rounded-xl border px-3 py-3 text-left transition-colors ${
              active
                ? 'border-aico-accent bg-aico-accent-soft'
                : 'border-aico-border-subtle hover:border-aico-border hover:bg-aico-hover'
            }`}
          >
            <span className={`flex items-center gap-2 text-[13px] font-medium ${
              active ? 'text-aico-accent' : 'text-aico-primary'
            }`}>
              {option.icon && <Icon name={option.icon} size={17} />}
              {option.label}
            </span>
            {option.hint && (
              <span className="mt-1 block text-[12px] leading-snug text-aico-secondary">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * On or off.
 *
 * A switch rather than a checkbox: the label is already on the left, and a
 * checkbox needs its own label to say what checked means. The knob's travel is
 * the whole affordance — it reads as a state, not as a form field.
 */
function Toggle(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  const on = value === undefined ? spec.fallback === true : value === true;
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={spec.label}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] rounded-full transition-colors ${
        on ? 'bg-aico-accent' : 'bg-aico-border'
      }`}
    >
      <span
        // `left-0` is load-bearing: without an inset the knob's static position
        // is the end of the button's line box, which put it outside the track.
        className={`absolute left-0 top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          on ? 'translate-x-[19px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

/**
 * A number with its unit attached.
 *
 * The unit sits inside the field rather than in the label, because "120" and
 * "120s" are different amounts of information and only one of them survives
 * being read at a glance. Blank means unset, which is not the same as zero —
 * zero is a real value for the timeouts, and it means "no limit".
 */
/**
 * A draft that is only committed when the person is done with it.
 *
 * These fields used to save on every keystroke, and showed the stored value
 * back while the save and the re-read were in flight — so fast typing lost
 * characters, and every intermediate number was written: typing 8080 into a
 * port moved a server through ports 8, 80 and 808 on the way. The draft is
 * the person's; it is committed on Enter or on leaving the field, and Escape
 * puts back what is saved.
 */
function useDraft(value: unknown): [string, (s: string) => void, () => void] {
  const stored = value === undefined || value === null ? '' : String(value);
  const [draft, setDraft] = React.useState(stored);
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => { if (!editing) setDraft(stored); }, [stored, editing]);
  const set = (s: string): void => { setEditing(true); setDraft(s); };
  const done = (): void => setEditing(false);
  return [draft, set, done];
}

function NumberInput(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  const scale = spec.scale ?? 1;
  const [draft, setDraft, done] = useDraft(typeof value === 'number' ? value / scale : value);
  const [error, setError] = React.useState<string | null>(null);
  const placeholder = spec.placeholder
    ?? (typeof spec.fallback === 'number' ? String(spec.fallback / scale) : '');
  const commit = (): void => {
    done();
    const raw = draft.trim();
    if (raw === '') { setError(null); if (value !== undefined) onChange(undefined); return; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { setError('Not a number'); return; }
    if (spec.min !== undefined && n < spec.min) { setError(`At least ${spec.min}`); return; }
    if (spec.max !== undefined && n > spec.max) { setError(`At most ${spec.max}`); return; }
    setError(null);
    if (n * scale !== value) onChange(n * scale);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={`flex items-center gap-1.5 rounded-full border bg-aico-surface pl-3 pr-3 transition-colors
                      focus-within:border-aico-accent/60 ${error ? 'border-red-500/70' : 'border-aico-border-subtle'}`}>
        <input
          type="number"
          value={draft}
          placeholder={placeholder}
          {...(spec.min !== undefined ? { min: spec.min } : {})}
          {...(spec.max !== undefined ? { max: spec.max } : {})}
          {...(spec.step !== undefined ? { step: spec.step } : {})}
          onChange={e => { setDraft(e.target.value); setError(null); }}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { e.stopPropagation(); setError(null); done(); }
          }}
          aria-label={spec.label}
          aria-invalid={error ? true : undefined}
          className="w-[5.5rem] bg-transparent py-1.5 text-right text-[13px] tabular-nums
                     text-aico-primary placeholder:text-aico-muted focus:outline-none"
        />
        {spec.unit && <span className="text-[12px] text-aico-muted">{spec.unit}</span>}
      </div>
      {error && <span role="alert" className="text-[11px] text-red-500">{error} — not saved</span>}
    </div>
  );
}

function TextInput(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  const [draft, setDraft, done] = useDraft(value);
  const commit = (): void => {
    done();
    const next = draft.trim() === '' ? undefined : draft;
    if (next !== value) onChange(next);
  };
  return (
    <input
      type="text"
      value={draft}
      placeholder={spec.placeholder ?? ''}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { e.stopPropagation(); done(); }
      }}
      aria-label={spec.label}
      className="w-full rounded-full border border-aico-border-subtle bg-aico-surface px-3.5 py-1.5
                 text-[13px] text-aico-primary placeholder:text-aico-muted transition-colors
                 focus:border-aico-accent/60 focus:outline-none md:w-[15rem]"
    />
  );
}

function Select(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  return (
    <div className="relative">
      <select
        value={String(value ?? spec.fallback ?? '')}
        onChange={e => onChange(e.target.value)}
        aria-label={spec.label}
        className="appearance-none rounded-full border border-aico-border-subtle bg-aico-surface
                   py-1.5 pl-3.5 pr-9 text-[13px] text-aico-primary
                   transition-colors focus:border-aico-accent/60 focus:outline-none"
      >
        {(spec.options ?? []).map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-aico-muted"
      />
    </div>
  );
}
