/**
 * What you can do to the conversation you are in.
 *
 * Rename, fork, archive. Small operations, and their absence was felt out of
 * proportion to their size: a panel where every conversation is called
 * "Untitled" until the model names it, and where a wrong turn means starting
 * over rather than branching, is a panel people stop keeping history in.
 *
 * ## Renaming happens in place
 *
 * Not a modal, and not VS Code's `showInputBox`. The title is already on screen
 * and already the right shape; turning it into a field is one less context
 * switch than a dialog that covers the thing being renamed. Escape reverts,
 * Enter commits — the two keys anyone tries.
 *
 * ## Archive asks, fork does not
 *
 * Forking is additive and instantly visible: the copy opens, and the original
 * is untouched. Archiving removes something from the list, which reads as
 * deletion whether or not it is, so it says what it actually does.
 *
 * @module components/SessionMenu
 */

import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { host } from '../host';

export function SessionMenu({ title, onRenaming }: {
  title: string;
  /** Lets the header swap the title for a field without owning the state. */
  onRenaming: (on: boolean) => void;
}): React.ReactElement {
  const sessionId = useStore(s => s.sessionId);
  const archiveSession = useStore(s => s.archiveSession);
  const forkSession = useStore(s => s.forkSession);
  const busy = useStore(s => s.busy);

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) { setOpen(false); setConfirming(false); }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setOpen(false); setConfirming(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        title="This conversation"
        aria-label="This conversation"
        onClick={() => setOpen(v => !v)}
        className={[
          'flex size-[22px] shrink-0 items-center justify-center rounded',
          'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary',
          open ? 'bg-aico-hover text-aico-primary' : '',
        ].join(' ')}
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
          <circle cx="8" cy="3.5" r="1.15" />
          <circle cx="8" cy="8" r="1.15" />
          <circle cx="8" cy="12.5" r="1.15" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-[210px] rounded border
                        border-aico-border bg-aico-elevated py-1 shadow-lg">
          <Item
            label="Rename"
            onPick={() => { setOpen(false); onRenaming(true); }}
          />
          <Item
            label="Fork this conversation"
            hint="A copy you can take somewhere else. This one is untouched."
            /*
              Refused while a turn runs. Forking mid-turn would copy a
              conversation whose last message is still being written, and the
              copy would look complete while missing its own ending.
            */
            disabled={busy}
            onPick={() => { setOpen(false); void forkSession(sessionId); }}
          />

          <div className="my-1 border-t border-aico-border-subtle" />

          {/*
            The wide surface, named for what it is good at rather than by an
            icon nobody has learned. A 300px column is the wrong shape for Mini
            Apps, the trajectory view and the settings screens, and this is
            where somebody deciding where to work will look.
          */}
          <Item
            label="Open the full workspace"
            hint="Mini Apps, trajectory and changes, with room to read them."
            onPick={() => { setOpen(false); host.openWorkspace(); }}
          />
          <Item
            label="Settings"
            hint="Providers, models, MCP, skills and memory."
            onPick={() => { setOpen(false); host.openSettings(); }}
          />
          <Item
            label="Measure skills"
            hint="Score a skill against tasks with known answers, or improve it."
            onPick={() => { setOpen(false); host.openSettings('skills'); }}
          />

          <div className="my-1 border-t border-aico-border-subtle" />

          {confirming ? (
            <div className="px-2 py-1">
              <p className="text-[10px] leading-snug text-aico-muted">
                Archived conversations leave the list. Nothing is deleted.
              </p>
              <div className="mt-1 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false); setConfirming(false);
                    void archiveSession(sessionId, true);
                  }}
                  className="rounded bg-aico-accent px-2 py-0.5 text-[11px] text-aico-on-accent
                             hover:bg-aico-accent-hover"
                >
                  Archive
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded px-2 py-0.5 text-[11px] text-aico-secondary hover:bg-aico-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <Item label="Archive" onPick={() => setConfirming(true)} />
          )}
        </div>
      )}
    </div>
  );
}

function Item({ label, hint, disabled, onPick }: {
  label: string; hint?: string; disabled?: boolean; onPick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className="block w-full px-2 py-1 text-left text-aico-primary hover:bg-aico-hover
                 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="block text-[11px]">{label}</span>
      {hint && <span className="block text-[10px] leading-snug text-aico-muted">{hint}</span>}
    </button>
  );
}

/**
 * The title, editable in place.
 *
 * Kept here beside the menu that opens it so the two cannot disagree about what
 * a rename does — and so the header stays a layout component rather than
 * growing a form.
 */
export function TitleField({ initial, onDone }: {
  initial: string;
  onDone: () => void;
}): React.ReactElement {
  const rename = useStore(s => s.rename);
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => { field.current?.select(); }, []);

  const commit = (): void => {
    const next = value.trim();
    // An empty title is not a rename, it is a mistake. The existing name stays
    // rather than leaving a row nobody can identify.
    if (next && next !== initial) void rename(next);
    onDone();
  };

  return (
    <input
      ref={field}
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); onDone(); }
      }}
      aria-label="Conversation name"
      className="min-w-0 flex-1 rounded border border-aico-accent bg-transparent px-1
                 text-[12px] text-aico-primary focus:outline-none"
    />
  );
}
