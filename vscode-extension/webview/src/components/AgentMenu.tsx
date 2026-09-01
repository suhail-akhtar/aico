/**
 * `@` in the composer: who answers.
 *
 * The other half of delegation. `SubAgents` shows work handed off *by* the
 * agent; this addresses a specialist directly, which is a decision made while
 * writing — three words in, when you realise this is a security question.
 *
 * `@` for agents and `#` for files is not a local convention: `@` has meant
 * "agent" in the browser client since it existed, and giving the same key two
 * meanings across two surfaces of one product would be worse than either choice
 * alone. The panel picked `#` for files precisely to leave `@` alone.
 *
 * **Choosing removes the `@name` from the message.** It is a control, not
 * content — leaving the token in would send the agent a message addressed to
 * itself, and the chip beside the composer already says who is listening.
 *
 * @module components/AgentMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { searchAgents, splitAgents } from '@web/agents';
import type { AgentSpec } from '@web/api';

export function AgentMenu({ agents, query, selected, onSelectedChange, onChoose, commit }: {
  agents: AgentSpec[];
  query: string;
  selected: number;
  onSelectedChange: (index: number) => void;
  onChoose: (name: string) => void;
  /** Where to leave a function committing the highlighted row. See FindMenu. */
  commit: React.MutableRefObject<(() => void) | null>;
}): React.ReactElement {
  const matches = searchAgents(agents, query);
  const { mine, builtin } = splitAgents(matches);

  useEffect(() => {
    if (selected >= matches.length) onSelectedChange(Math.max(0, matches.length - 1));
  }, [matches.length, selected, onSelectedChange]);

  // Refreshed every render so the committed row is the highlighted one, not
  // whichever was highlighted when the menu opened.
  useEffect(() => {
    commit.current = () => {
      const pick = matches[selected];
      if (pick) onChoose(pick.name);
    };
    return () => { commit.current = null; };
  });

  if (matches.length === 0) {
    return (
      <Shell>
        <p className="px-2 py-1.5 text-[11px] text-aico-muted">
          No agent matches “{query}”.
        </p>
      </Shell>
    );
  }

  let index = -1;
  const row = (agent: AgentSpec): React.ReactElement => {
    index += 1;
    const at = index;
    return (
      <button
        key={agent.name}
        type="button"
        // `onMouseDown` with the default prevented: a click would blur the
        // textarea first, and the blur handler closes the menu before the click
        // can land.
        onMouseDown={(e) => { e.preventDefault(); onChoose(agent.name); }}
        onMouseEnter={() => onSelectedChange(at)}
        className={[
          'block w-full px-2 py-1 text-left',
          at === selected ? 'bg-aico-accent-soft' : 'hover:bg-aico-hover',
        ].join(' ')}
      >
        <span className="block truncate text-[11px] text-aico-primary">{agent.name}</span>
        <span className="block truncate text-[10px] leading-snug text-aico-muted">
          {agent.description}
        </span>
      </button>
    );
  };

  return (
    <Shell>
      {/*
        Yours above the built-ins. An agent somebody wrote for this project is
        almost always the one they are reaching for, and a list that buries it
        under eight shipped ones makes the feature feel absent.
      */}
      {mine.length > 0 && <Label>Yours</Label>}
      {mine.map(row)}
      {builtin.length > 0 && <Label>Built in</Label>}
      {builtin.map(row)}
    </Shell>
  );
}

function Label({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="px-2 pb-0.5 pt-1 text-[9px] uppercase tracking-wide text-aico-muted">
      {children}
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      onMouseDown={e => e.preventDefault()}
      className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[240px] overflow-y-auto
                 rounded border border-aico-border bg-aico-elevated py-1 shadow-lg"
    >
      {children}
    </div>
  );
}
