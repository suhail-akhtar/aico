/**
 * The session's standing objective, above the composer.
 *
 * Distinct from the last thing you asked. A goal outlives the turn that set it
 * and is what the work is measured against several turns later — which is
 * exactly when it has scrolled out of view and stops influencing anything.
 * Keeping it pinned is the whole feature.
 *
 * Renders nothing when there is no goal. A permanently visible empty bar
 * costs vertical space on every session that does not use the feature, and
 * "Set a goal" is not a thing anyone needs prompting about mid-conversation.
 *
 * @module components/GoalBar
 */

import React, { useState } from 'react';
import { useStore } from '../store';

export function GoalBar(): React.ReactElement | null {
  const goal = useStore(s => s.goal);
  const setGoal = useStore(s => s.setGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!goal && !editing) return null;

  if (editing) {
    const commit = (): void => {
      const text = draft.trim();
      setEditing(false);
      if (text) void setGoal(text, 'active');
    };
    return (
      <div className="border-t border-aico-hover bg-aico-surface px-4 sm:px-6 py-2">
        <div className="mx-auto w-full max-w-5xl">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
            autoFocus
            placeholder="What is this session trying to achieve?"
            className="w-full rounded-md border border-aico-accent/50 bg-aico-elevated px-3 py-1.5
                       text-xs text-aico-primary placeholder:text-aico-muted focus:outline-none"
          />
        </div>
      </div>
    );
  }

  const paused = goal!.status === 'paused';
  return (
    <div className="border-t border-aico-hover bg-aico-surface px-4 sm:px-6 py-2">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-2">
        <span className={paused ? 'text-aico-muted' : 'text-aico-accent'} title="Session goal">
          ◎
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-xs ${paused ? 'text-aico-muted line-through' : 'text-aico-primary'}`}
          title={goal!.text}
        >
          {goal!.text}
        </span>

        <button
          onClick={() => { setDraft(goal!.text); setEditing(true); }}
          className="rounded px-1.5 py-0.5 text-[10px] text-aico-muted hover:bg-aico-hover hover:text-aico-primary"
        >
          Edit
        </button>
        <button
          onClick={() => void setGoal(goal!.text, paused ? 'active' : 'paused')}
          className="rounded px-1.5 py-0.5 text-[10px] text-aico-muted hover:bg-aico-hover hover:text-aico-primary"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={() => void setGoal('', 'cleared')}
          className="rounded px-1.5 py-0.5 text-[10px] text-aico-muted hover:bg-aico-hover hover:text-aico-danger"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/** The control that creates a goal, offered from the composer toolbar. */
export function SetGoalButton(): React.ReactElement | null {
  const goal = useStore(s => s.goal);
  const setGoal = useStore(s => s.setGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Once a goal exists the bar owns editing it; a second entry point would be
  // two controls for one thing.
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
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        autoFocus
        placeholder="Session goal…"
        className="w-56 rounded-md border border-aico-accent/50 bg-aico-elevated px-2 py-1
                   text-xs text-aico-primary placeholder:text-aico-muted focus:outline-none"
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="Set a goal for this session"
      className="rounded-md px-2 py-1 text-xs text-aico-muted transition-all hover:text-aico-secondary"
    >
      ◎ Goal
    </button>
  );
}
