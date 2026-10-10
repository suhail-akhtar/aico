/**
 * A model to steer the explorer, and a budget it cannot exceed.
 *
 * The default explorer tries everything it can see in a fixed order. On a
 * target with hundreds of controls that spends the step budget on footer links
 * while the checkout flow goes untried. A guide fixes the *order*: at each
 * state it is shown what is on offer and what has been tried, and names the
 * options most likely to reveal new behaviour.
 *
 * It can only reorder. An option the target did not offer is dropped by the
 * explorer (`ordered` in explorer.ts), so a model that hallucinates a button
 * costs nothing and invents no stimulus; a model that fails, or says nothing
 * usable, leaves the default order. The model never sees the target's
 * scripts, only the same labels a person would read on screen.
 *
 * Cost control, enforced here and not requested of the model: a hard ceiling
 * in USD on everything the guide spends, a cap on the number of calls, and a
 * cache so the same view is never asked twice. `createModelCompleter` is the
 * one place a real provider is called; tests pass their own `Completer`.
 *
 * @module cleanroom/guide
 */

import { createHash } from 'node:crypto';
import type { AicoSettings } from '../settings.js';
import type { Guide, GuideView } from './explorer.js';

export type Completer = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

const SYSTEM = [
  'You steer an automated black-box explorer that is learning how a piece of software behaves by using it.',
  'You are shown where it is, the options on offer, and what it already tried. Choose up to 6 options that are most likely to reveal NEW behaviour:',
  'different screens, forms and their validation, error paths, settings, the core task the software exists for. Prefer what has not been tried and skip near-duplicates (many similar links, footer or legal pages).',
  'Answer with ONLY a JSON array of option strings copied exactly from the list. No explanation.',
].join(' ');

export function createGuide(complete: Completer, opts: { maxCalls?: number; signal?: AbortSignal } = {}): Guide & { calls: () => number } {
  const cache = new Map<string, string[] | undefined>();
  let calls = 0;
  const guide = (async (view: GuideView): Promise<string[] | undefined> => {
    if (!view.options.length) return undefined;
    const options = view.options.slice(0, 80);
    const key = createHash('sha1').update(view.state + '\n' + options.join('\n') + '\n' + view.history.join('\n')).digest('hex');
    if (cache.has(key)) return cache.get(key);
    if (calls >= (opts.maxCalls ?? 20)) return undefined;
    calls++;
    const user = [`Target kind: ${view.kind}`, `Now: ${view.state.slice(0, 600)}`, 'Options:', ...options.map((o, i) => `${i + 1}. ${o}`), 'Already tried (latest last):', ...(view.history.length ? view.history.map(h => `- ${h}`) : ['- nothing yet'])].join('\n');
    let answer: string[] | undefined;
    try { answer = parsePicks(await complete(SYSTEM, user, opts.signal), options); } catch { answer = undefined; }
    cache.set(key, answer);
    return answer;
  }) as Guide & { calls: () => number };
  guide.calls = () => calls;
  return guide;
}

/** The picks that are really options, in the order given, from a reply that may wrap the array in prose or fences. */
export function parsePicks(text: string, options: string[]): string[] | undefined {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return undefined;
  let arr: unknown;
  try { arr = JSON.parse(m[0]); } catch { return undefined; }
  if (!Array.isArray(arr)) return undefined;
  const set = new Set(options);
  const picks = arr.filter((x): x is string => typeof x === 'string' && set.has(x));
  return picks.length ? picks : undefined;
}

/**
 * The completer that calls a configured model. Stops (returns an empty answer,
 * so the explorer falls back to its own order) once `budgetUsd` is spent.
 */
export function createModelCompleter(o: { settings: AicoSettings; model: string; budgetUsd: number; provider?: import('../providers/types.js').ProviderAPI }): Completer & { spent: () => number } {
  let spent = 0;
  const f = (async (system: string, user: string, signal?: AbortSignal): Promise<string> => {
    if (spent >= o.budgetUsd) return '';
    const { selectProvider } = await import('../providers/index.js');
    const { costFor } = await import('../tokens.js');
    const provider = o.provider ?? selectProvider(o.model, o.settings);
    let text = '';
    for await (const ev of provider.chat({ model: o.model, systemPrompt: system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 400, ...(signal ? { signal } : {}) })) {
      if (ev.type === 'text') text += ev.content;
      else if (ev.type === 'usage') spent += costFor(o.model, { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedTokens: ev.cacheReadTokens ?? 0 }, o.settings);
    }
    return text;
  }) as Completer & { spent: () => number };
  f.spent = () => spent;
  return f;
}
