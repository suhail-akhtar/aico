/**
 * A tool through which the model can look at, and correct, the context window
 * aico holds for it.
 *
 * ## Why the model gets a say
 *
 * The window is the number compaction works from, and every way of
 * establishing it can be wrong: the built-in table ages, a compatible endpoint
 * reports nothing, and the default is an assumption. When it is wrong the
 * symptoms land on the model — a summary folding its conversation every couple
 * of turns, a meter reading 100% while its requests sail through — and until
 * now the model could see none of that and fix none of it. A user who typed
 * "your window is a million tokens, stop compacting" was asking for something
 * the model had no way to do.
 *
 * ## Why the model does not get the last word
 *
 * Models are reliably wrong about their own limits — the case that prompted
 * this had one insisting it held 4,000 tokens while running on a million. So
 * `set` is for a figure the *user* stated or the provider documents, and the
 * tool says so in its description; a figure below what the model has already
 * been seen to accept, or what the provider itself reported, is refused
 * outright rather than trusted. `get` is always safe and is the right first
 * call: it shows the figure, where it came from, and what would change it.
 *
 * @module tools/context-window
 */

import { currentRunContext } from '../run-context.js';
import {
  clearContextWindow,
  getEffectiveContextBudget,
  resolveWindow,
  setContextWindow,
  type WindowFact,
} from '../context-window.js';

/** Nothing agentic runs in less; a "set" below this is a hallucinated limit. */
const SMALLEST_CREDIBLE_WINDOW = 8_000;
/** Nothing sold today holds more; a "set" above this is a typo. */
const LARGEST_CREDIBLE_WINDOW = 20_000_000;

export const contextWindowToolDefinition = {
  name: 'ContextWindow',
  description:
    'Read or correct the context window aico holds for the model you are running as. '
    + 'The window drives compaction: if conversation summaries appear too often, the context '
    + 'meter reads full while your requests still succeed, or the user says the figure is wrong, '
    + 'call this with action "get" first — it shows the figure, where it came from and what '
    + 'would change it. Use action "set" ONLY with a figure the user stated or the provider '
    + 'documents, never one you guessed and never your own belief about your limits, which is '
    + 'usually wrong. Action "forget" hands the figure back to automatic detection.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'forget'],
        description: '"get" to read, "set" to record a stated figure, "forget" to return to detection.',
      },
      tokens: {
        type: 'number',
        description: 'For "set": the window in tokens, for example 1000000 or 200000.',
      },
      reason: {
        type: 'string',
        description: 'For "set": where the figure came from, in a few words — "the user said so", '
          + '"the provider\'s model page states 1M".',
      },
    },
    required: ['action'],
  },
};

export interface ContextWindowInput {
  action: 'get' | 'set' | 'forget';
  tokens?: number;
  reason?: string;
}

/** A source, in the words the meter uses. */
function describe(fact: WindowFact): string {
  switch (fact.source) {
    case 'user': return 'set by the user';
    case 'api': return 'reported by the provider';
    case 'learned': return 'learned from a provider refusal that stated the limit';
    case 'observed': return 'inferred — a prompt larger than the assumed window was accepted';
    case 'table': return "from aico's built-in table";
    case 'assumed': return 'assumed — nothing knows this model';
    default: return fact.source;
  }
}

export async function executeContextWindow(args: ContextWindowInput): Promise<string> {
  const context = currentRunContext();
  const model = context?.model;
  if (!model) {
    throw new Error('ContextWindow: this run is not bound to a model, so there is nothing to read.');
  }
  const settings = context?.settings;
  const current = resolveWindow(model, settings);

  switch (args.action) {
    case 'get': {
      const budget = getEffectiveContextBudget(model, settings);
      return [
        `Model: ${model}`,
        `Context window: ${current.tokens.toLocaleString()} tokens (${describe(current)})`,
        `Compaction runs when the conversation reaches about 75% of ${budget.toLocaleString()} tokens.`,
        current.source === 'assumed' || current.source === 'table'
          ? 'This figure is not from the provider. If the user knows the real one, record it with '
            + 'action "set"; they can also set it from the context meter in the client.'
          : current.source === 'user'
            ? 'The user set this deliberately. Do not change it unless they ask.'
            : 'This figure came from evidence. Leave it unless the user states a different one.',
      ].join('\n');
    }

    case 'set': {
      const tokens = Number(args.tokens);
      if (!Number.isInteger(tokens)) {
        throw new Error('ContextWindow: "set" needs a whole number of tokens, e.g. 1000000.');
      }
      if (tokens < SMALLEST_CREDIBLE_WINDOW || tokens > LARGEST_CREDIBLE_WINDOW) {
        throw new Error(
          `ContextWindow: ${tokens.toLocaleString()} is not a credible window `
          + `(${SMALLEST_CREDIBLE_WINDOW.toLocaleString()}–${LARGEST_CREDIBLE_WINDOW.toLocaleString()}). `
          + 'If this is your own estimate of your limit, do not set it — models misjudge this.',
        );
      }
      const reason = args.reason?.trim();
      if (!reason) {
        throw new Error('ContextWindow: say where the figure came from in "reason" — the user, or the provider\'s documentation.');
      }
      /*
        Evidence beats assertion. The provider reporting N, or a prompt of N
        having gone through, is proof the window is at least N; a request to
        record something smaller is the hallucinated-limit case this tool is
        built to refuse.
      */
      const evidenced = current.source === 'api' || current.source === 'observed' || current.source === 'learned';
      if (evidenced && tokens < current.tokens) {
        throw new Error(
          `ContextWindow: ${model} is ${describe(current)} at ${current.tokens.toLocaleString()} tokens; `
          + `${tokens.toLocaleString()} is smaller than what is already known to work. Not recorded.`,
        );
      }
      if (current.source === 'user' && tokens !== current.tokens) {
        // Allowed — the user is speaking through the model — but said plainly.
        await setContextWindow(model, tokens, { source: 'user' });
        return `Recorded ${model} at ${tokens.toLocaleString()} tokens (${reason}), replacing the ${current.tokens.toLocaleString()} the user had set before.`;
      }
      await setContextWindow(model, tokens, { source: 'user' });
      return `Recorded ${model} at ${tokens.toLocaleString()} tokens (${reason}). `
        + 'It is held as a user setting: never re-detected, and shown as "set by you" on the context meter, '
        + 'where it can be changed or forgotten.';
    }

    case 'forget': {
      await clearContextWindow(model);
      const after = resolveWindow(model, settings);
      return `Forgot the stored window for ${model}. It now reads ${after.tokens.toLocaleString()} tokens `
        + `(${describe(after)}) until detection or use establishes a better figure.`;
    }

    default:
      throw new Error(`ContextWindow: unknown action "${String((args as { action?: unknown }).action)}" — use get, set or forget.`);
  }
}
