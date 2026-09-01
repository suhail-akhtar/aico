/**
 * How much this run asks before it acts.
 *
 * Three settings rather than a switch, because the two risks are genuinely
 * different. Writing a file inside a project you deliberately opened is the work
 * you asked for; running a shell command is the thing worth being asked about.
 * A single on/off means people turn it off after the fourth dialog about a file
 * they expected to change — and then it is off for the shell command too.
 *
 * `auto` is the default and is what the browser workspace has always done. That
 * matters: this is an addition, not a new demand on anyone who was happy.
 *
 * @module components/ApprovalMenu
 */

import React, { useEffect, useRef, useState } from 'react';

export type ApprovalMode = 'auto' | 'edits' | 'ask';

const MODES: Array<{ mode: ApprovalMode; label: string; blurb: string }> = [
  {
    mode: 'auto',
    label: 'Auto',
    blurb: 'Never ask. What the terminal and the browser workspace have always done.',
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

export function ApprovalMenu({ mode, onChange }: {
  mode: ApprovalMode;
  onChange: (next: ApprovalMode) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = MODES.find(m => m.mode === mode) ?? MODES[0];

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title={`Approval: ${current.label} — ${current.blurb}`}
        className={[
          'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]',
          mode === 'auto'
            ? 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'
            // Not "auto" is the state worth seeing without hovering: it changes
            // what happens when the agent reaches for a tool.
            : 'bg-aico-accent-soft text-aico-accent',
        ].join(' ')}
      >
        <svg
          viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor"
          strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
        >
          {/* A shield: the same idea VS Code uses for workspace trust. */}
          <path d="M8 1.75 3.25 3.5v4c0 3 2 5.4 4.75 6.75C10.75 12.9 12.75 10.5 12.75 7.5v-4z" />
        </svg>
        {mode === 'auto' ? 'Auto' : current.label}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-[230px] rounded border border-aico-border bg-aico-elevated py-1 shadow-lg">
          {MODES.map(entry => (
            <button
              key={entry.mode}
              type="button"
              onClick={() => { onChange(entry.mode); setOpen(false); }}
              className={[
                'block w-full px-2 py-1 text-left hover:bg-aico-hover',
                entry.mode === mode ? 'text-aico-accent' : 'text-aico-primary',
              ].join(' ')}
            >
              <span className="block text-[11px]">{entry.label}</span>
              <span className="block text-[10px] leading-snug text-aico-muted">
                {entry.blurb}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
