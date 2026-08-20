/**
 * `@` in the composer, to engage a specialist without leaving the keyboard.
 *
 * The picker beside the model does the same job, and this exists because the
 * two are used at different moments. The picker is a decision made before you
 * start writing; the mention is one made *while* writing, when you get three
 * words in and realise this is a security question.
 *
 * **Selecting removes the `@name` from the message.** It is a control, not
 * content — leaving the token in the text would send the agent a message
 * addressed to itself, and the chip beside the model already says who is
 * listening. The rest of what you typed is untouched.
 *
 * @module components/MentionMenu
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { AgentSpec } from '../api';
import { searchAgents, splitAgents } from '../agents';

interface MentionMenuProps {
  agents: AgentSpec[];
  query: string;
  onChoose: (name: string) => void;
  onDismiss: () => void;
  /** Set by the composer so arrow keys move the selection from the textarea. */
  selected: number;
  onSelectedChange: (index: number) => void;
}

export function MentionMenu({
  agents, query, onChoose, onDismiss, selected, onSelectedChange,
}: MentionMenuProps): React.ReactElement | null {
  const matches = useMemo(() => searchAgents(agents, query), [agents, query]);
  const { mine, builtin } = splitAgents(matches);
  const [hovered, setHovered] = useState<number | null>(null);

  // A narrowing search can leave the selection past the end of the list.
  useEffect(() => {
    if (selected >= matches.length) onSelectedChange(Math.max(0, matches.length - 1));
  }, [matches.length, selected, onSelectedChange]);

  if (matches.length === 0) {
    return (
      <div
        onMouseDown={e => e.preventDefault()}
        className="absolute bottom-full left-4 z-20 mb-1.5 w-72 rounded-xl border border-aico-border
                   bg-aico-bg px-3 py-2 text-[12px] text-aico-muted shadow-lg"
      >
        No agent matches “{query}”. <button onClick={onDismiss} className="underline">Dismiss</button>
      </div>
    );
  }

  const row = (agent: AgentSpec): React.ReactElement => {
    const index = matches.indexOf(agent);
    const active = index === (hovered ?? selected);
    return (
      <button
        key={agent.name}
        onMouseEnter={() => setHovered(index)}
        onMouseLeave={() => setHovered(null)}
        onClick={() => onChoose(agent.name)}
        className={`block w-full px-3 py-1.5 text-left transition-colors ${
          active ? 'bg-aico-accent-soft' : 'hover:bg-aico-hover'
        }`}
      >
        <span className={`font-mono text-[12px] ${active ? 'text-aico-accent' : 'text-aico-primary'}`}>
          @{agent.name}
        </span>
        <span className="mt-0.5 block text-[11px] leading-[15px] text-aico-muted">
          {agent.description}
        </span>
      </button>
    );
  };

  return (
    <div
      // mousedown, not click, is what steals focus — and the composer closes
      // the menu on blur. Without this, clicking a row dismisses the menu and
      // selects nothing, which looks exactly like a broken button.
      onMouseDown={e => e.preventDefault()}
      className="absolute bottom-full left-4 z-20 mb-1.5 max-h-72 w-80 overflow-y-auto
                 rounded-xl border border-aico-border bg-aico-bg py-1 shadow-lg"
    >
      {mine.length > 0 && (
        <>
          <p className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-aico-muted">Yours</p>
          {mine.map(row)}
        </>
      )}
      {builtin.length > 0 && (
        <>
          <p className="mt-1 px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-aico-muted">
            Built in
          </p>
          {builtin.map(row)}
        </>
      )}
      <p className="mt-1 border-t border-aico-border px-3 pt-1.5 text-[10px] text-aico-muted">
        ↑↓ to choose · Enter to engage · Esc to dismiss
      </p>
    </div>
  );
}
