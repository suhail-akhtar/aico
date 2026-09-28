/**
 * Observation masking: old tool output replaced by a short placeholder.
 *
 * In a long agentic turn most of the context is tool *output* — file bodies,
 * command logs, search hits — and most of it is only useful for the step that
 * read it. Measured on SWE-agent trajectories, observations are about 84% of
 * each turn's tokens, and replacing the ones older than a recent window with a
 * placeholder solved as many tasks as an LLM-written summary at roughly half
 * the cost of keeping everything ("The Complexity Trap", arXiv 2508.21433).
 * The model's own reasoning and actions stay; only what it was shown goes.
 *
 * ## Deterministic, so it does not cost the cache
 *
 * A mask is a `context/masked` event in the log naming a seq. Derivation hides
 * every eligible tool result at or before it, the same way on every request.
 * Masking therefore breaks the cached prefix once, when the event is written,
 * and the shortened prefix is cached from then on — rather than a sliding
 * window that would change the prefix on every step.
 *
 * ## What is never masked
 *
 * Errors, which the model needs in order not to repeat them. Short results,
 * where a placeholder saves nothing. And the tools whose output is state rather
 * than observation — a sub-agent's report or the todo list cannot be fetched
 * again by re-running a cheap call.
 *
 * @module session/mask
 */

import type { ToolCall } from '../providers/types.js';

/** Results at or under this many characters are left alone. */
export const MASK_MIN_CHARS = 800;

/** Tool-call argument strings longer than this are abbreviated once masked. */
export const MASK_INPUT_MIN_CHARS = 2_000;

/**
 * Tools whose output is state, not a re-fetchable observation.
 *
 * `Task` and `Investigate` are whole sub-agent runs — re-running one to see
 * its report again is the most expensive call available. The plan and todo
 * tools carry what the work is *for*. `Skill` bodies are instructions the
 * model is meant to keep following.
 */
export const MASK_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'Task', 'Investigate', 'TodoWrite', 'TodoRead', 'ProposePlan', 'Skill', 'AskUserQuestion',
]);

/** Whether a tool result may be replaced by a placeholder. */
export function isMaskable(name: string, content: string, isError?: boolean): boolean {
  if (isError) return false;
  if (MASK_EXEMPT_TOOLS.has(name)) return false;
  return content.length > MASK_MIN_CHARS;
}

/** A spill path a result already names, so the placeholder can keep it. */
export function spillPathIn(content: string): string | undefined {
  const full = /complete output is saved at:\n(\S[^\n]*)/.exec(content);
  if (full) return full[1]!.trim();
  const short = /\[…full output: ([^\]\n]+)\]/.exec(content);
  return short ? short[1]!.trim() : undefined;
}

/**
 * What the model sees in place of a masked result.
 *
 * Says what was there and how to get it back, because a bare "[cleared]"
 * reads as an empty result and invites the model to conclude the call found
 * nothing. The first line is kept: for most tools it says what ran and on
 * what, which is often all a later step needs.
 */
export function maskedResult(name: string, content: string, savedAt?: string): string {
  const firstLine = content.split('\n', 1)[0]!.trim().slice(0, 160);
  const where = savedAt ?? spillPathIn(content);
  return `[Earlier ${name} output (${content.length.toLocaleString('en-US')} chars) cleared to keep `
    + 'the context focused.'
    + (firstLine ? ` It began: "${firstLine}${firstLine.length === 160 ? '…' : ''}".` : '')
    + (where ? ` The full text is saved at ${where}.` : '')
    // Not "call the tool again": said that way, a model re-read everything it
    // had already dealt with — 55 reads for 10 files, watched live.
    + ' Work from what you already concluded or wrote down; re-read only if you need a detail you did not keep.]';
}

/**
 * A tool call with its oversized string arguments abbreviated.
 *
 * A `Write` carries the whole file it wrote as an argument, so an old write is
 * often the single largest thing in the context — and the file itself is on
 * disk. Returns the same object when nothing needed shortening, so unmasked
 * calls are shared rather than copied.
 */
export function maskedCall(call: ToolCall): ToolCall {
  const input = call.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return call;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MASK_INPUT_MIN_CHARS) {
      next[key] = `[${value.length.toLocaleString('en-US')} chars cleared from context — `
        + 'the result is on disk if this call wrote a file]';
      changed = true;
    } else {
      next[key] = value;
    }
  }
  return changed ? { ...call, input: next } : call;
}
