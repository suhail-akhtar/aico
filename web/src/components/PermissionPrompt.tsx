/**
 * A tool call waiting to be allowed, in the browser client.
 *
 * This had to exist before the approval selector beside it could. The engine
 * blocks the turn on an unanswered permission — the promise is held server-side
 * — so shipping a control that turns asking *on*, in a client with nothing to
 * answer with, would have been shipping a way to hang your own run.
 *
 * The VS Code panel answers with a native modal, which it can because it is
 * inside an editor. A browser tab has no equivalent that is not a `window.confirm`
 * — blocking, unstyleable, and unable to show a diff — so this is a card, placed
 * directly above the composer where the eye already is.
 *
 * ## Deny is what dismissal means
 *
 * There is no way to close this without answering, and that is deliberate. A
 * dismissable prompt on a blocked turn produces a run that is stopped for a
 * reason no longer on screen.
 *
 * @module components/PermissionPrompt
 */

import React from 'react';
import { useStore } from '../store';

/** Tools whose name alone does not say what is about to happen. */
const VERB: Record<string, string> = {
  Terminal: 'run a command',
  Bash: 'run a command',
  Write: 'write a file',
  Edit: 'edit a file',
  MultiEdit: 'edit a file',
  NotebookEdit: 'edit a notebook',
  WebFetch: 'fetch a URL',
  WebSearch: 'search the web',
  Task: 'delegate to a sub-agent',
};

export function PermissionPrompt(): React.ReactElement | null {
  const permission = useStore(s => s.permission);
  const permit = useStore(s => s.permit);

  if (!permission) return null;

  const verb = VERB[permission.tool] ?? `use ${permission.tool}`;
  const diff = permission.fileDiff;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      className="mx-auto mb-3 w-full max-w-column rounded-xl border border-aico-warning/40
                 bg-aico-elevated px-4 py-3"
    >
      <p className="text-[14px] text-aico-primary">
        aico wants to <strong>{verb}</strong>.
      </p>

      {permission.detail && (
        <p className="mt-1 break-words font-mono text-[12px] text-aico-secondary">
          {permission.detail}
        </p>
      )}

      {/*
        The diff the engine already built for the write tools. Allowing an edit
        without seeing it is barely a decision — and it is bounded, because a
        card that grows past the fold puts its own buttons off screen.
      */}
      {diff && (
        <div className="mt-2 overflow-x-auto rounded-lg bg-aico-code px-3 py-2 font-mono text-[12px]">
          {diff.preview && <p className="text-aico-muted">{diff.preview}</p>}
          {(diff.removed ?? []).slice(0, 4).map((line, i) => (
            <div key={`-${i}`} className="text-aico-diff-remove-gutter">- {line}</div>
          ))}
          {(diff.added ?? []).slice(0, 6).map((line, i) => (
            <div key={`+${i}`} className="text-aico-diff-add-gutter">+ {line}</div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void permit(true)}
          className="rounded-lg bg-aico-accent px-3 py-1 text-[13px] text-aico-on-accent
                     transition-colors hover:bg-aico-accent-hover"
        >
          Allow
        </button>
        <button
          onClick={() => void permit(false)}
          className="rounded-lg px-3 py-1 text-[13px] text-aico-secondary
                     transition-colors hover:bg-aico-hover hover:text-aico-primary"
        >
          Deny
        </button>
        <span className="text-[12px] text-aico-muted">
          The turn is waiting on this.
        </span>
      </div>
    </div>
  );
}
