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

const MODES: Array<{ mode: ApprovalMode; label: string; blurb: string }> = [
  {
    mode: 'auto',
    label: 'Auto',
    blurb: 'Never ask. What this client has always done.',
  },
  {
    mode: 'edits',
    label: 'Ask, not for edits',
    blurb: 'File writes go through; commands, fetches and delegation are put to you.',
  },
  {
    mode: 'ask',
    label: 'Ask every time',
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
        className={`rounded-lg px-2.5 py-1 text-[13px] transition-colors disabled:opacity-40 ${
          value === 'auto'
            // Anything other than auto changes what happens when the agent
            // reaches for a tool, which is worth seeing without hovering.
            ? 'text-aico-muted hover:bg-aico-hover hover:text-aico-secondary'
            : 'bg-aico-accent-soft text-aico-accent'
        }`}
      >
        {value === 'auto' ? 'Approve: auto' : current.label}
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
