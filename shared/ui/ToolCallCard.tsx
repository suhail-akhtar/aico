/**
 * One tool call, as a single line that expands.
 *
 * A turn can make twenty of these, so the resting state is one row: what ran,
 * on what, and how it went. Anything taller turns a transcript into a wall of
 * boxes and buries the prose the calls exist to support.
 *
 * The exception is a file write, whose diff is shown without asking. An edit
 * that completes as an opaque row tells you a file changed but not how, which
 * is the one thing you wanted to know.
 *
 * Emoji icons are deliberately gone: a row of coloured pictograms down the
 * left of a document is louder than the document.
 */

import React, { useState } from 'react';
import { changeFromArgs, FileDiff } from './FileDiff';
import { formatResult } from './tool-result';

/**
 * The one thing about a call worth reading at a glance.
 *
 * Chosen per tool rather than by probing a fixed list of argument names, which
 * is how a web search came out as a bare "Searched the web" with the query — the
 * only part anyone cares about — nowhere on the row.
 */
function describeArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return '';
  };

  const pattern = first('pattern', 'query', 'q', 'search');
  const target = first('path', 'file_path', 'filePath', 'notebook_path', 'directory');
  if (pattern && target) return `${pattern} in ${target}`;

  return first(
    'command', 'query', 'q', 'search', 'pattern', 'url',
    'file_path', 'filePath', 'notebook_path', 'path', 'directory',
    'description', 'prompt', 'question', 'name',
  );
}

/** What each tool is doing, in the present tense, as the row's verb. */
const TOOL_VERBS: Record<string, string> = {
  Bash: 'Ran', Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited',
  Glob: 'Searched', Grep: 'Searched', LS: 'Listed', WebFetch: 'Fetched',
  WebSearch: 'Searched the web', Task: 'Delegated', TodoWrite: 'Updated todos',
  TodoRead: 'Read todos', NotebookEdit: 'Edited notebook', Pwd: 'Checked directory',
  AskUserQuestion: 'Asked', WorkspaceWrite: 'Wrote',
};

export const ToolCallCard = React.memo(function ToolCallCard({
  name,
  args,
  result,
  running,
  progressMs,
}: {
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  running?: boolean;
  /** Elapsed time of a still-running command, when it reports progress. */
  progressMs?: number;
}) {
  // A running command's output opens on its own. Watching a long build is the
  // entire reason its output streams; making the reader click to see it would
  // undo the point.
  const [expanded, setExpanded] = useState(false);
  const live = running === true && hasOutput(result);
  const verb = TOOL_VERBS[name] ?? name;
  // Shown while the write is in flight as well as after: seeing what an edit is
  // about to do is most useful before it has finished doing it.
  const change = changeFromArgs(name, args);

  const argPreview = describeArgs(args);

  const { text: resultText, isError } = result !== undefined ? formatResult(result) : { text: '', isError: false };
  const resultLineCount = resultText.split('\n').length;

  // Attention is spent where it is needed. Twenty successful calls should not
  // shout — they are the normal case and shouting makes the prose unreadable.
  // A call that is *running* needs to be findable in a long transcript, and one
  // that *failed* needs to be impossible to miss. Success stays quiet.
  const tone = running
    ? 'bg-aico-accent-soft'
    : isError
      ? 'bg-aico-danger/8'
      : 'hover:bg-aico-hover';
  const markerTone = running
    ? 'aico-thinking text-aico-accent'
    : isError
      // Previously muted, which made a failed call look like a successful one
      // apart from the glyph — the one state that must never be quiet.
      ? 'text-aico-danger'
      : 'text-aico-success';

  return (
    <div className="my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`group/tool flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left
                    transition-colors ${tone}`}
      >
        <span className={`shrink-0 text-[11px] ${markerTone}`} aria-hidden>
          {running ? '◐' : isError ? '✕' : '✓'}
        </span>

        <span className={`shrink-0 text-[13px] ${
          isError ? 'text-aico-danger' : running ? 'text-aico-primary' : 'text-aico-secondary'
        }`}>
          {verb}
        </span>

        {argPreview && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12px] text-aico-muted"
            title={argPreview}
          >
            {argPreview}
          </span>
        )}
        {!argPreview && <span className="flex-1" />}

        {change && (change.added.length > 0 || change.removed.length > 0) && (
          <span className="shrink-0 text-[11px] tabular-nums">
            {change.added.length > 0 && <span className="text-aico-success">+{change.added.length}</span>}
            {change.removed.length > 0 && <span className="ml-1 text-aico-danger">−{change.removed.length}</span>}
          </span>
        )}
        {running && (
          <span className="shrink-0 tabular-nums text-[11px] text-aico-accent">
            {progressMs !== undefined ? formatElapsed(progressMs) : 'running'}
          </span>
        )}
        {isError && !running && (
          <span className="shrink-0 text-[11px] text-aico-danger">failed</span>
        )}
        {!running && result !== undefined && resultLineCount > 1 && (
          <span className="shrink-0 text-[11px] text-aico-muted">{resultLineCount} lines</span>
        )}
        <span className="shrink-0 text-[10px] text-aico-muted opacity-0 transition-opacity group-hover/tool:opacity-100">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {/* A file write shows its diff without being asked. */}
      {change && <FileDiff change={change} />}

      {(expanded || live) && resultText && (
        <pre
          className={`mt-1 max-h-72 overflow-auto rounded-lg bg-aico-code px-3 py-2 font-mono
                      text-[12px] leading-[20px] selectable ${
                        isError ? 'text-aico-danger' : 'text-aico-secondary'}`}
        >
          {resultText}
        </pre>
      )}
    </div>
  );
});

/** Whether a result has any text yet, without formatting the whole thing. */
function hasOutput(result: unknown): boolean {
  if (typeof result === 'string') return result.length > 0;
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  return Boolean(r.stdout || r.stderr || r.content);
}

/** Elapsed time, at the precision someone watching a build actually wants. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
