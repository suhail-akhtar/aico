/**
 * The standing objective, pinned above the composer.
 *
 * A goal is not the last thing you asked. It outlives the turn that set it and
 * is what the work is measured against several turns later — which is precisely
 * when it has scrolled out of view and stopped influencing anything. Keeping it
 * on screen is the entire feature, and a side bar is where it costs least: one
 * line, always in the same place.
 *
 * Renders nothing when there is no goal. An empty bar would spend vertical space
 * on every session that does not use this, in the surface that has the least of
 * it to spend. The way to create one is the composer's ◎ button.
 *
 * @module components/GoalBar
 */

import React, { useState } from 'react';
import { useStore } from '@web/store';

export function GoalBar(): React.ReactElement | null {
  const goal = useStore(s => s.goal);
  const setGoal = useStore(s => s.setGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!goal) return null;

  if (editing) {
    const commit = (): void => {
      const text = draft.trim();
      setEditing(false);
      if (text) void setGoal(text, goal.status === 'paused' ? 'paused' : 'active');
    };
    return (
      <div className="shrink-0 border-t border-aico-border-subtle px-3 py-1">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          autoFocus
          aria-label="Session goal"
          className="w-full rounded border border-aico-accent bg-transparent px-1 py-0.5
                     text-[11px] text-aico-primary focus:outline-none"
        />
      </div>
    );
  }

  const paused = goal.status === 'paused';

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-aico-border-subtle px-3 py-1">
      <span
        aria-hidden
        className={`text-[10px] ${paused ? 'text-aico-muted' : 'text-aico-accent'}`}
      >
        ◎
      </span>
      {/*
        Double-click to edit, matching the header's title. One click would fire
        while somebody is only trying to read a truncated goal, which at this
        width is most of the time — the full text lives in the tooltip.
      */}
      <button
        type="button"
        title={goal.text}
        onDoubleClick={() => { setDraft(goal.text); setEditing(true); }}
        className={`min-w-0 flex-1 truncate text-left text-[11px] ${
          paused ? 'text-aico-muted line-through' : 'text-aico-secondary'
        }`}
      >
        {goal.text}
      </button>

      <Small
        label={paused ? 'Resume' : 'Pause'}
        title={paused
          ? 'Put this goal back in front of the agent'
          : 'Keep the goal but stop steering by it'}
        onPick={() => void setGoal(goal.text, paused ? 'active' : 'paused')}
      />
      <Small label="Clear" title="Drop this goal" onPick={() => void setGoal('', 'cleared')} />
    </div>
  );
}

/**
 * Create a goal, from the composer's toolbar.
 *
 * Disappears once one exists: from then on the bar owns editing it, and a
 * second entry point would be two controls for the same single value.
 */
export function SetGoalButton(): React.ReactElement | null {
  const goal = useStore(s => s.goal);
  const setGoal = useStore(s => s.setGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (goal) return null;

  if (editing) {
    const commit = (): void => {
      const text = draft.trim();
      setEditing(false);
      if (text) void setGoal(text, 'active');
    };
    return (
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        autoFocus
        placeholder="What is this session for?"
        aria-label="Session goal"
        className="min-w-0 flex-1 rounded border border-aico-accent bg-transparent px-1 py-0.5
                   text-[11px] text-aico-primary placeholder:text-aico-muted focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      title="Set a standing objective the agent keeps in view"
      aria-label="Set session goal"
      onClick={() => setEditing(true)}
      className="flex size-[20px] shrink-0 items-center justify-center rounded text-[11px]
                 text-aico-muted hover:bg-aico-hover hover:text-aico-primary"
    >
      ◎
    </button>
  );
}

function Small({ label, title, onPick }: {
  label: string; title: string; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onPick}
      className="shrink-0 rounded px-1 py-0.5 text-[10px] text-aico-muted
                 hover:bg-aico-hover hover:text-aico-primary"
    >
      {label}
    </button>
  );
}
