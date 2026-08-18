/**
 * Oversized tool output: keep it, rather than cutting it off.
 *
 * A tool result that does not fit the model's budget used to be sliced at a
 * character count and the remainder discarded, with a note saying how much was
 * gone. That note is the whole problem: the agent can see that it lost
 * something and has no way to get it back, so it reasons from a fragment and
 * cannot tell which fragment it got. Measured across this installation's own
 * logs, that path silently destroyed **11 MB** of tool output — one `Bash`
 * result alone lost 10.2 MB.
 *
 * So the full text is written to the session's workspace and the model is
 * handed a bounded excerpt plus the path. Nothing is lost, the context stays
 * bounded, and reading the rest needs no new tool — `Read` already takes a
 * path, and the workspace is already a writable root.
 *
 * **The excerpt is head *and* tail.** A build log's first lines say what ran
 * and its last lines say why it failed; a plain head would reliably discard
 * the more useful half. `bash.ts` already keeps the tail in memory for exactly
 * this reason.
 *
 * **Spilling never fails a tool call.** If the workspace cannot be resolved or
 * the write fails, this falls back to the old truncation. A result the agent
 * can partly see beats an error it cannot act on.
 *
 * @module tools/spill
 */

import fs from 'fs';
import path from 'path';
import { getWorkspaceInfo } from '../workspace.js';

/** How much of the excerpt is taken from the end rather than the beginning. */
const TAIL_SHARE = 0.35;
/** Below this there is no point splitting an excerpt in two. */
const MIN_SPLIT = 400;

export interface SpillRef {
  /** Absolute path of the file holding the complete output. */
  path: string;
  /** Size of the saved content, in characters. */
  chars: number;
}

/** Set in tests to keep spill files out of the real workspace. */
let overrideDir: string | undefined;

/** Point spill at a specific directory. Pass undefined to restore the default. */
export function setSpillDir(dir: string | undefined): void {
  overrideDir = dir;
}

/**
 * Where spilled output goes.
 *
 * Under the session's own workspace, which already exists for exactly this
 * kind of thing — output the agent produced that is not part of the user's
 * project. Falls back to the workspace root when no session is bound, because
 * a sub-agent's output is still worth keeping.
 */
export function spillDir(): string | undefined {
  if (overrideDir) return overrideDir;
  try {
    const info = getWorkspaceInfo();
    const base = info.sessionDir ?? info.root;
    return base ? path.join(base, 'spill') : undefined;
  } catch {
    return undefined;
  }
}

/** A filename that says where it came from without needing the log. */
function suggestName(toolName: string, callId?: string): string {
  const tool = toolName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'tool';
  const id = (callId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-8) || Math.random().toString(36).slice(2, 10);
  return `${tool}-${id}.txt`;
}

/**
 * Write the whole text somewhere durable.
 *
 * Synchronous on purpose. The tool-result path is already I/O bound, the write
 * happens on well under one percent of results, and making it async would turn
 * every caller — including the two dispatch chokepoints — into an async
 * rewrite for a rare case.
 */
export function saveSpill(toolName: string, content: string, callId?: string): SpillRef | undefined {
  const dir = spillDir();
  if (!dir) return undefined;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, suggestName(toolName, callId));
    fs.writeFileSync(file, content, 'utf8');
    return { path: file, chars: content.length };
  } catch {
    // The workspace may be read-only, full, or on a disconnected drive. None of
    // those are reasons to fail the tool call the user is waiting on.
    return undefined;
  }
}

/** Human-sized description of an amount of text. */
function describe(chars: number): string {
  if (chars < 1024) return `${chars} characters`;
  if (chars < 1024 * 1024) return `${Math.round(chars / 1024)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Build the excerpt the model sees.
 *
 * Sized so the *whole* replacement — excerpt, separator and notice — fits the
 * budget it was given. A notice that pushes the result back over the limit
 * would defeat the point of having one.
 */
export function excerpt(content: string, budget: number, ref?: SpillRef): string {
  const full = ref
    ? `\n\n[… ${describe(content.length)} in total. The complete output is saved at:\n${ref.path}\nRead that file if you need the part not shown here.]`
    : `\n\n[… output truncated, ${describe(Math.max(0, content.length - budget))} discarded and not recoverable.]`;

  // A budget too small for the explanation still has to be honoured — the
  // caller asked for a bound, not a suggestion. Three forms, longest first.
  //
  // The last one carries no path on purpose. Slicing a path to fit produces a
  // locator that looks real and points nowhere, and an agent that tries to read
  // it gets a confusing failure instead of a clear one. "Truncated" is less
  // useful than a path and far better than a wrong path.
  const short = ref ? `\n[…full output: ${ref.path}]` : '\n[…truncated]';
  const minimal = '\n[…truncated]';
  const notice = full.length < budget ? full
    : short.length < budget ? short
    : minimal.length < budget ? minimal
    : minimal.slice(0, budget);

  const room = budget - notice.length;
  if (room <= 0) return notice.slice(0, budget);
  if (content.length <= room) return content;

  // Head and tail, because the beginning says what ran and the end says how it
  // went. A single head reliably throws away the more useful half of a log.
  if (room < MIN_SPLIT) return content.slice(0, room) + notice;

  // The separator is part of the budget. Counting it as one character rather
  // than three overshot by exactly two on every split excerpt — small enough to
  // miss by eye, and a bound that is wrong by any amount is not a bound.
  const separator = '\n⋮\n';
  const tail = Math.floor((room - separator.length) * TAIL_SHARE);
  const head = room - separator.length - tail;
  return `${content.slice(0, head)}${separator}${content.slice(-tail)}${notice}`;
}

/**
 * Bound a tool result, keeping whatever did not fit.
 *
 * Returns the value unchanged when it already fits. Strings are excerpted
 * directly; objects have their oversized string fields excerpted in place, so
 * a `{stdout, stderr, exit_code}` result keeps its shape and its exit code
 * while its streams are bounded independently.
 */
export function spillResult(
  result: unknown,
  maxChars: number,
  toolName: string,
  callId?: string,
): unknown {
  if (typeof result === 'string') {
    if (result.length <= maxChars) return result;
    return excerpt(result, maxChars, saveSpill(toolName, result, callId));
  }

  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const asJson = JSON.stringify(result);
    if (!asJson || asJson.length <= maxChars) return result;

    const copy = { ...(result as Record<string, unknown>) };
    // Each oversized field gets its own share, so a huge stdout cannot crowd
    // out a short stderr that explains the failure.
    const share = Math.max(MIN_SPLIT, Math.floor(maxChars / 2));
    for (const [key, value] of Object.entries(copy)) {
      if (typeof value !== 'string' || value.length <= share) continue;
      copy[key] = excerpt(value, share, saveSpill(`${toolName}-${key}`, value, callId));
    }
    return copy;
  }

  return result;
}
