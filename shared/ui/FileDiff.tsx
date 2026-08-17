/**
 * A minimal added/removed view for file-writing tool calls.
 *
 * Built from the tool's own arguments rather than from the engine's permission
 * payload. The engine only assembles a diff when it is about to ask for
 * approval, so on auto-approve — the usual mode — there is none, and the edit
 * would complete as an opaque row. The arguments are always present.
 *
 * Deliberately not a real diff algorithm: `Edit` already tells us exactly which
 * text is being replaced by which, so line-matching would add a dependency and
 * a class of bugs to re-derive something the tool call states outright.
 */

import React from 'react';

export interface FileChange {
  path?: string;
  removed: string[];
  added: string[];
  /** Set when the body was clipped, so the UI never implies it showed it all. */
  truncated: boolean;
  note?: string;
}

/** Lines shown per side before clipping. Enough to see the shape of a change. */
const MAX_LINES = 12;

function clip(text: string): { lines: string[]; truncated: boolean } {
  const all = text.split('\n');
  return { lines: all.slice(0, MAX_LINES), truncated: all.length > MAX_LINES };
}

/**
 * Derive a change summary from a tool call, or undefined when the tool does not
 * write files. Returning undefined rather than an empty shell keeps the caller
 * from rendering a diff header over nothing.
 */
export function changeFromArgs(
  name: string,
  args: Record<string, unknown> | undefined,
): FileChange | undefined {
  if (!args) return undefined;
  const path = typeof args.file_path === 'string' ? args.file_path : undefined;

  if (name === 'Edit' && typeof args.new_string === 'string') {
    const add = clip(args.new_string);
    const rem = typeof args.old_string === 'string'
      ? clip(args.old_string)
      : { lines: [], truncated: false };
    return {
      path,
      removed: rem.lines,
      added: add.lines,
      truncated: add.truncated || rem.truncated,
      ...(args.replace_all === true ? { note: 'all occurrences' } : {}),
    };
  }

  if (name === 'Write' && typeof args.content === 'string') {
    const add = clip(args.content);
    return {
      path,
      removed: [],
      added: add.lines,
      truncated: add.truncated,
      note: 'full file write',
    };
  }

  return undefined;
}

export function FileDiff({ change }: { change: FileChange }): React.ReactElement {
  return (
    <div className="mt-1 overflow-hidden rounded-lg border border-aico-border-subtle">
      {(change.path || change.note) && (
        <div className="flex items-center gap-2 border-b border-aico-border-subtle bg-aico-code px-3 py-1.5
                        text-[11px] text-aico-muted">
          {change.path && <span className="truncate font-mono">{change.path}</span>}
          <div className="flex-1" />
          {change.removed.length > 0 && (
            <span style={{ color: 'var(--aico-diff-remove-gutter)' }}>−{change.removed.length}</span>
          )}
          {change.added.length > 0 && (
            <span style={{ color: 'var(--aico-diff-add-gutter)' }}>+{change.added.length}</span>
          )}
          {change.note && <span className="shrink-0 opacity-70">{change.note}</span>}
        </div>
      )}

      <div className="max-h-72 overflow-auto">
        {change.removed.map((line, i) => (
          <div key={`r${i}`} className="diff-row diff-remove">
            <span className="diff-gutter" aria-hidden>−</span>
            <span className="diff-code">{line || ' '}</span>
          </div>
        ))}
        {change.added.map((line, i) => (
          <div key={`a${i}`} className="diff-row diff-add">
            <span className="diff-gutter" aria-hidden>+</span>
            <span className="diff-code">{line || ' '}</span>
          </div>
        ))}
        {change.truncated && (
          <div className="px-3 py-1.5 text-[11px] text-aico-muted">
            … clipped. Expand the tool result for the whole change.
          </div>
        )}
      </div>
    </div>
  );
}

