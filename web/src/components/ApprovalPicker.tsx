/**
 * How much this run asks before it acts, in the browser client.
 *
 * Three settings rather than a switch, for the reason the panel's version gives:
 * writing a file inside a project you opened is the work, and running a shell
 * command is the thing worth being asked about. One on/off control for both
 * means people turn it off after the fourth dialog about a file they expected
 * to change — and then it is off for the command too.
 *
 * `auto` is the default and is exactly what every browser session has always
 * done. This is an addition, not a new demand on anyone who was happy.
 *
 * @module components/ApprovalPicker
 */

import React, { useEffect, useRef, useState } from 'react';

export type ApprovalMode = 'auto' | 'edits' | 'ask';
import { TOOLBAR_CAPTION, TOOLBAR_CONTROL, toolbarTone } from './toolbar';

/**
 * `label` names the mode in the menu; `short` is what fits on the button.
 *
 * They differ because the two are read in different circumstances. Choosing
 * happens once, with three options side by side and room to explain each.
 * Afterwards the button is glanced at, next to five other controls, and
 * "Ask, not for edits" was long enough to push the whole row into wrapping.
 */
const MODES: Array<{ mode: ApprovalMode; label: string; short: string; blurb: string }> = [
  {
    mode: 'auto',
    label: 'Auto',
    short: 'auto',
    blurb: 'Never ask. What this client has always done.',
  },
  {
    mode: 'edits',
    label: 'Ask, not for edits',
    short: 'not edits',
    blurb: 'File writes go through; commands, fetches and delegation are put to you.',
  },
  {
    mode: 'ask',
    label: 'Ask every time',
    short: 'always',
    blurb: 'Every tool call waits for a decision. Thorough, and slow by design.',
  },
];

export function ApprovalPicker({ value, onChange, disabled }: {
  value: ApprovalMode;
  onChange: (next: ApprovalMode) => void;
  disabled?: boolean;
}): React.ReactElement {
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

  const current = MODES.find(m => m.mode === value) ?? MODES[0];

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        disabled={disabled}
        title={`Approval: ${current.label} — ${current.blurb}`}
        // Anything other than auto changes what happens when the agent reaches
        // for a tool, which is worth seeing without hovering.
        className={`${TOOLBAR_CONTROL} ${toolbarTone(value !== 'auto')}`}
      >
        <span className={value === 'auto' ? TOOLBAR_CAPTION : ''}>Approve</span>
        {current.short}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-aico-border
                        bg-aico-bg py-1 shadow-lg">
          {MODES.map(entry => (
            <button
              key={entry.mode}
              onClick={() => { onChange(entry.mode); setOpen(false); }}
              className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-aico-hover ${
                entry.mode === value ? 'text-aico-accent' : 'text-aico-primary'
              }`}
            >
              <span className="block text-[13px]">{entry.label}</span>
              <span className="block text-[12px] leading-snug text-aico-muted">{entry.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
