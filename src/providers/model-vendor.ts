/**
 * What a model id says about who serves it.
 *
 * Its own module, and the reason is structural rather than aesthetic: both
 * provider *selection* (`providers/index`) and instance *resolution*
 * (`providers/instances`) need these answers, and those two already import each
 * other in one direction. Putting the predicates in either one would close the
 * cycle.
 *
 * Nothing here asks whether a key is configured. That is a separate question,
 * and conflating "this id belongs to Anthropic" with "we can call Anthropic" is
 * what made routing hard to reason about in the first place.
 *
 * @module providers/model-vendor
 */

import type { ProviderType } from './instances.js';

/**
 * A DeepSeek Platform model id.
 *
 * Deliberately excludes the `deepseek/…` form: that slash-prefixed id is
 * OpenRouter's namespacing, and routing it to api.deepseek.com would 404 on a
 * model name the platform has never heard of. Bare ids (`deepseek-v4-flash`)
 * are the platform's own.
 */
export function isDeepSeekPlatformModel(model: string): boolean {
  return /^deepseek-/i.test(model);
}

export function isOpenAIModel(model: string): boolean {
  return (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  );
}

/**
 * Detect Z.AI GLM models. Supports both bare names (glm-4.6, glm-5.2) and
 * prefixed names (zai/glm-5.2, z-ai/glm-5). The prefix form is stripped
 * before sending to the API — Z.AI expects bare model IDs.
 */
export function isZAIModel(model: string): boolean {
  return /^z-?ai\//i.test(model) || /^glm-/i.test(model);
}

/**
 * The vendor a model id names outright, or null when it does not name one.
 *
 * Only the unambiguous cases. `claude-sonnet-5` is Anthropic's and nobody
 * else's; `llama-3` is served by half the industry and returns null. The
 * slash-prefixed forms (`anthropic/claude-…`) are a *router's* namespacing
 * rather than a vendor claim, so they are excluded too — sending one to
 * api.anthropic.com would 404 just as surely.
 */
export function vendorForModel(model: string): ProviderType | null {
  if (model.startsWith('claude-')) return 'anthropic';
  if (isOpenAIModel(model)) return 'openai';
  if (model.startsWith('gemini-')) return 'gemini';
  if (/^glm-/i.test(model)) return 'zai';
  if (isDeepSeekPlatformModel(model)) return 'deepseek';
  return null;
}

/**
 * Whether a provider type speaks for exactly one vendor.
 *
 * Gateways front many vendors and are *expected* to receive model ids that are
 * not "theirs", so a mismatch against one means nothing. A direct vendor
 * receiving another vendor's model id is a 404 waiting to happen.
 */
export function isDirectVendor(type: ProviderType): boolean {
  return type !== 'openrouter' && type !== 'openai-compatible';
}
