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
import type { Field as FieldSpec } from '../../settings-schema';
import { Icon } from '../Icon';

export interface FieldProps {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Set when the stored value differs from the engine's unset behaviour. */
  changed: boolean;
  /** Shown above the label when the row is a search hit from another pane. */
  breadcrumb?: string;
}

export function Field({ spec, value, onChange, changed, breadcrumb }: FieldProps): React.ReactElement {
  const stacked = spec.kind === 'segmented';

  return (
    <div className="group/field border-b border-aico-border-subtle py-4 last:border-b-0">
      <div className={stacked ? '' : 'flex items-start gap-6'}>
        <div className="min-w-0 flex-1">
          {breadcrumb && (
            <div className="mb-0.5 text-[11px] uppercase tracking-wider text-aico-muted">{breadcrumb}</div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-aico-primary">{spec.label}</span>
            {changed && (
              <>
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-aico-accent"
                  title="Changed from the default"
                />
                <button
                  onClick={() => onChange(undefined)}
                  title="Put this back to the default"
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-aico-muted
                             opacity-0 transition-opacity hover:text-aico-primary
                             focus:opacity-100 group-hover/field:opacity-100"
                >
                  <Icon name="undo" size={12} /> Reset
                </button>
              </>
            )}
          </div>
          {spec.hint && (
            <p className="mt-0.5 max-w-lg text-[13px] leading-relaxed text-aico-secondary">{spec.hint}</p>
          )}
        </div>

        {!stacked && <div className="shrink-0 pt-0.5"><Control spec={spec} value={value} onChange={onChange} /></div>}
      </div>

      {stacked && <div className="mt-3"><Control spec={spec} value={value} onChange={onChange} /></div>}
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
  }
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
              {option.icon && <Icon name={option.icon} size={15} />}
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
function NumberInput(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  const shown = value === undefined || value === null ? '' : String(value);
  const placeholder = spec.placeholder ?? (spec.fallback !== undefined ? String(spec.fallback) : '');
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-aico-border-subtle bg-aico-surface
                    pl-3 pr-3 transition-colors focus-within:border-aico-accent/60">
      <input
        type="number"
        value={shown}
        placeholder={placeholder}
        {...(spec.min !== undefined ? { min: spec.min } : {})}
        {...(spec.max !== undefined ? { max: spec.max } : {})}
        {...(spec.step !== undefined ? { step: spec.step } : {})}
        onChange={e => {
          const raw = e.target.value.trim();
          onChange(raw === '' ? undefined : Number(raw));
        }}
        aria-label={spec.label}
        className="w-[5.5rem] bg-transparent py-1.5 text-right text-[13px] tabular-nums
                   text-aico-primary placeholder:text-aico-muted focus:outline-none"
      />
      {spec.unit && <span className="text-[12px] text-aico-muted">{spec.unit}</span>}
    </div>
  );
}

function TextInput(
  { spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void },
): React.ReactElement {
  return (
    <input
      type="text"
      value={value === undefined || value === null ? '' : String(value)}
      placeholder={spec.placeholder ?? ''}
      onChange={e => {
        const raw = e.target.value;
        onChange(raw.trim() === '' ? undefined : raw);
      }}
      aria-label={spec.label}
      className="w-[15rem] rounded-full border border-aico-border-subtle bg-aico-surface px-3.5 py-1.5
                 text-[13px] text-aico-primary placeholder:text-aico-muted
                 transition-colors focus:border-aico-accent/60 focus:outline-none"
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
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-aico-muted"
      />
    </div>
  );
}
