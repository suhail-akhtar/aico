/**
 * The vision fallback: a text-only main model is told what an attached image
 * shows, by the model the person chose for the `vision` role (ADR 0017 §9).
 *
 * Before this, a picture sent to a text-only model became one line — "[shot.png
 * was attached but not sent: this model does not read images]" — and the
 * agent answered a question about a screenshot it had never been shown. When
 * the person has set `models.roles.vision` to a model that can see, that model
 * describes each image once and the description enters the turn as text,
 * marked as a description so neither the model nor the reader mistakes it for
 * the picture.
 *
 * Rules, so callers cannot get them wrong:
 * - **Only an explicit, different, image-reading model.** The role must
 *   resolve (`resolveRole('vision')` checks it accepts images), and be a
 *   different model from the main one. The `balanced` preset sets no vision
 *   model for a text-only main model, so images go to no new provider unless
 *   the person chose one.
 * - **Once per image.** Descriptions are cached by vision model and attachment
 *   id for the life of the process, so a twenty-step turn (and the turns after
 *   it) does not re-send the same screenshot; a failed description is retried
 *   only in a later run.
 * - **Bounded.** Reasoning off, a 400-token answer, a deadline, and the run's
 *   own abort signal. A failure falls back to the old one-line note.
 * - **Costed.** Each call's usage goes to the run's tracker (so spend ceilings
 *   see it) and to the `vision` role's spend.
 *
 * Deliberately not here: describing images for a model that can see them, or
 * sending the user's question along (the vision provider gets the image and
 * its file name, nothing else from the conversation).
 */

import type { AicoSettings } from '../settings.js';
import type { ImagePart, ImageRef, ProviderAPI } from '../providers/types.js';
import { costFor } from '../tokens.js';
import { modelAccepts } from '../model-capabilities.js';
import { recordRoleSpend, resolveRole } from './roles.js';

export interface ImageDescriber {
  /** The vision model, named in the note the main model reads. */
  model: string;
  /** A factual description, or undefined when none could be had. */
  describe(ref: ImageRef, part: ImagePart): Promise<string | undefined>;
}

export const VISION_TIMEOUT_MS = 30_000;
export const VISION_MAX_TOKENS = 400;
/** Longest description kept; a runaway answer must not become the turn. */
const MAX_DESCRIPTION_CHARS = 2_400;
const CACHE_LIMIT = 256;

export const VISION_SYSTEM = [
  'You describe one image for a colleague who cannot see it and must act on it.',
  'Be factual and specific: transcribe any visible text exactly (errors, code, labels, numbers),',
  'then describe layout, UI elements, charts (with their values) and anything that looks wrong.',
  'No guesses about intent, no advice, no preamble. Plain text, at most about 250 words.',
].join(' ');

/** Descriptions by `${model}\0${attachment id}`, oldest first (Map order) for eviction. */
const descriptions = new Map<string, string>();

/** For the tests. */
export function clearVisionCache(): void { descriptions.clear(); }

/**
 * A describer for this run, or undefined when there is nothing to fall back to
 * (main model reads images, no vision role set, or it is the main model).
 */
export function visionDescriber(o: {
  settings: AicoSettings | undefined;
  mainModel: string;
  /** The run's abort signal, read when a call starts. */
  signal?: () => AbortSignal | undefined;
  /** Usage of each call, for the run's token tracker. */
  onUsage?: (input: number, output: number, cached: number, cacheWrite: number) => void;
  /** Test seam: the provider to call instead of selecting one. */
  provider?: ProviderAPI;
}): ImageDescriber | undefined {
  if (modelAccepts(o.mainModel, 'image', o.settings)) return undefined;
  const role = resolveRole('vision', { settings: o.settings, mainModel: o.mainModel });
  if (!role.ok || !role.model || role.model === o.mainModel) return undefined;
  const model = role.model;
  const failed = new Set<string>();
  const inflight = new Map<string, Promise<string | undefined>>();

  const call = async (ref: ImageRef, part: ImagePart): Promise<string | undefined> => {
    const { withoutReasoning } = await import('../session/title-service.js');
    const provider = o.provider
      ?? (await import('../providers/index.js')).selectProvider(model, o.settings ? withoutReasoning(o.settings) : undefined);
    const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS);
    const parent = o.signal?.();
    const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
    const { runInContext, currentRunContext } = await import('../run-context.js');
    const ctx = currentRunContext();
    let text = '';
    await runInContext({ ...(ctx ?? {}), cwd: ctx?.cwd ?? process.cwd(), effort: 'off' }, async () => {
      for await (const ev of provider.chat({
        model,
        systemPrompt: VISION_SYSTEM,
        messages: [{ role: 'user', content: `Describe this image${ref.name ? ` (${ref.name})` : ''}.`, images: [part] }],
        tools: [],
        maxTokens: VISION_MAX_TOKENS,
        signal,
      })) {
        if (ev.type === 'text') text += ev.content;
        else if (ev.type === 'usage') {
          o.onUsage?.(ev.inputTokens, ev.outputTokens, ev.cacheReadTokens ?? 0, ev.cacheWriteTokens ?? 0);
          recordRoleSpend('vision', costFor(model, {
            inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedTokens: ev.cacheReadTokens ?? 0,
          }, o.settings));
        }
      }
    });
    const clean = text.replace(/\s+\n/g, '\n').trim().slice(0, MAX_DESCRIPTION_CHARS);
    return clean || undefined;
  };

  return {
    model,
    async describe(ref, part) {
      const key = `${model}\0${ref.id}`;
      const hit = descriptions.get(key);
      if (hit !== undefined) return hit;
      if (failed.has(key)) return undefined;
      let pending = inflight.get(key);
      if (!pending) {
        pending = call(ref, part).catch((err: unknown) => {
          if (process.env.AICO_DEBUG) console.warn(`  ⚠ vision fallback (${model}) failed: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        });
        inflight.set(key, pending);
      }
      const got = await pending;
      inflight.delete(key);
      if (got === undefined) { failed.add(key); return undefined; }
      descriptions.set(key, got);
      while (descriptions.size > CACHE_LIMIT) descriptions.delete(descriptions.keys().next().value!);
      return got;
    },
  };
}

/**
 * Describe the images in `refs` with `describer`, reading bytes through
 * `resolve` into `cache` first (the same cache the request path uses).
 * Returns descriptions by attachment id; a missing entry means "use the old
 * note". Never throws.
 */
export async function describeImagesWith(
  describer: ImageDescriber,
  refs: readonly ImageRef[],
  resolve: ((refs: ImageRef[]) => Promise<Array<ImagePart | undefined>>) | undefined,
  cache: Map<string, ImagePart>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = refs.filter(ref => !cache.has(ref.id));
  if (wanted.length > 0 && resolve) {
    try {
      const parts = await resolve([...wanted]);
      wanted.forEach((ref, i) => { const part = parts[i]; if (part) cache.set(ref.id, part); });
    } catch { /* best effort: an unreadable attachment keeps the plain note */ }
  }
  await Promise.all(refs.map(async (ref) => {
    const part = cache.get(ref.id);
    if (!part) return;
    try {
      const text = await describer.describe(ref, part);
      if (text) out.set(ref.id, text);
    } catch { /* best effort: describe() already falls back to undefined */ }
  }));
  return out;
}

/** The text a text-only model reads in place of an image it could not be sent. */
export function describedImageNote(ref: ImageRef, visionModel: string, mainModel: string, description: string): string {
  const name = ref.name ? ` "${ref.name}"` : '';
  return `[Image${name} described by ${visionModel} because ${mainModel} cannot see images: ${description}]`;
}
