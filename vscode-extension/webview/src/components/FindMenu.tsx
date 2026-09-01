/**
 * The `#` menu: point at a file or a symbol without leaving the keyboard.
 *
 * `#` rather than `@`, and the choice is not arbitrary. `@` already addresses a
 * *specialist* in aico's web client, and selecting one removes the token from
 * the message because it is a control rather than content. Giving the same key a
 * second meaning in a second surface of one product would be worse than either
 * convention alone. `#` is free, and VS Code users already type it in Copilot
 * Chat to mean "this thing".
 *
 * Selecting removes the `#query` from the text, for the same reason `@` does: a
 * chip appears beside the composer saying what is attached, and leaving the
 * token behind would send the agent a search string it has no use for.
 *
 * @module components/FindMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { findInWorkspace, type FindResult } from '../context';

export function FindMenu({
  query, selected, onSelectedChange, onChoose, onDismiss, commit,
}: {
  query: string;
  selected: number;
  onSelectedChange: (index: number) => void;
  onChoose: (result: FindResult) => void;
  onDismiss: () => void;
  /**
   * Where to leave a function that commits the highlighted row.
   *
   * The composer owns the keyboard — the textarea has focus, so enter arrives
   * there — but this component owns the results. Rather than lift the list up to
   * satisfy one keypress, the commit comes down.
   */
  commit: React.MutableRefObject<(() => void) | null>;
}): React.ReactElement {
  const [results, setResults] = useState<FindResult[] | null>(null);
  /** Which search these results are for, so a slow one cannot overwrite a fast one. */
  const generation = useRef(0);

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;

    /*
      A symbol provider can take a second on a cold index, so results arrive out
      of order as the query grows. Without this guard, typing `#conf` then `#config`
      can leave the menu showing matches for `conf` — results for a query the
      user has already finished typing past.
    */
    void findInWorkspace(query).then(found => {
      if (generation.current === mine) setResults(found);
    });
  }, [query]);

  useEffect(() => {
    if (results && selected >= results.length) {
      onSelectedChange(Math.max(0, results.length - 1));
    }
  }, [results, selected, onSelectedChange]);

  // Refreshed on every render so the committed row is the highlighted one, not
  // whichever was highlighted when the menu first opened.
  useEffect(() => {
    commit.current = () => {
      const pick = results?.[selected];
      if (pick) onChoose(pick);
    };
    return () => { commit.current = null; };
  });

  if (results !== null && results.length === 0) {
    return (
      <Shell>
        <p className="px-2 py-1.5 text-[11px] text-aico-muted">
          {query.trim()
            ? <>Nothing matches “{query}”. <button onClick={onDismiss} className="underline">Dismiss</button></>
            : 'No files open to suggest.'}
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      {results === null && (
        <p className="px-2 py-1.5 text-[11px] text-aico-muted">Searching…</p>
      )}
      {results?.map((result, index) => (
        <button
          key={`${result.uri}:${result.line ?? ''}:${result.label}`}
          type="button"
          // `onMouseDown` with the default prevented, not `onClick`: a click on
          // this menu would blur the textarea first, and the blur handler closes
          // the menu before the click can land.
          onMouseDown={(e) => { e.preventDefault(); onChoose(result); }}
          onMouseEnter={() => onSelectedChange(index)}
          className={[
            'flex w-full items-baseline gap-1.5 px-2 py-1 text-left',
            index === selected ? 'bg-aico-accent-soft' : 'hover:bg-aico-hover',
          ].join(' ')}
        >
          <span className="shrink-0 text-[9px] uppercase text-aico-muted">
            {result.kind === 'symbol' ? (result.symbolKind ?? 'sym') : 'file'}
          </span>
          <span className="min-w-0 truncate text-[11px] text-aico-primary">
            {result.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-right text-[10px] text-aico-muted">
            {result.detail}{result.line ? `:${result.line}` : ''}
          </span>
        </button>
      ))}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div
      onMouseDown={e => e.preventDefault()}
      className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-[240px] overflow-y-auto rounded border border-aico-border bg-aico-elevated py-1 shadow-lg"
    >
      {children}
    </div>
  );
}
