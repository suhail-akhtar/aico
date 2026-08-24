/**
 * What a model can actually be sent, and what it can produce.
 *
 * The platform had one shape of request for every model: text in, text out.
 * That is true of most of them and wrong about a growing number, and being
 * wrong in either direction costs something different. Send an image to a
 * model that cannot read one and the provider rejects the whole request —
 * including, on a durable transcript, every later turn that replays it, so a
 * single bad attachment breaks the conversation permanently rather than once.
 * Refuse an image a model could have read and the reader is simply told no for
 * no reason.
 *
 * So capability is resolved before the request is built, and the answer is
 * *conservative when unknown*: a model nobody has described is treated as
 * text-only. That asymmetry is deliberate. Under-declaring produces a clear
 * refusal the reader can override; over-declaring produces a request the
 * endpoint rejects, and the rejection arrives with the offending bytes already
 * written into the session log.
 *
 * Resolution follows {@link module:context-window} exactly — runtime cache,
 * then a settings override, then a built-in table matched longest-prefix-first.
 * That is not incidental: context window and modality are the same kind of
 * fact, learned the same ways, and a second mechanism for the second fact
 * would be one more thing to keep in step.
 *
 * @module model-capabilities
 */

import type { AicoSettings } from './settings.js';

/**
 * A kind of content a model can take in or give back.
 *
 * Deliberately not an enum of everything imaginable. Each member here is one
 * the platform can actually carry end to end; adding one without the plumbing
 * would let a capability check pass and the request fail a layer later, which
 * is exactly the failure this module exists to prevent.
 */
export type Modality = 'text' | 'image' | 'audio' | 'video';

export const MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'video'];

export interface ModelCapabilities {
  /** What may be put in a request to this model. */
  input: readonly Modality[];
  /** What it can emit. */
  output: readonly Modality[];
  /**
   * Whether this model can be the one the agent runs on.
   *
   * A provider catalogue is not a list of chat models. Asking OpenAI what it
   * serves returns embeddings, speech synthesis, transcription, moderation,
   * image generation and video generation alongside the models that can hold a
   * conversation — and picking one of those in a model picker produces a run
   * that fails on its first request, with an error from the vendor about a
   * wrong endpoint rather than anything about the choice just made.
   *
   * The agent needs text in and text out at minimum: text in to be prompted,
   * text out to reason and to name tool calls. Anything short of that cannot
   * drive it however capable it is otherwise.
   */
  chat: boolean;
  /**
   * Whether anything actually described this model, or whether these are the
   * safe defaults.
   *
   * The behaviour is the same either way — text only — but the reason is not,
   * and a surface that says "this model does not accept images" when the truth
   * is "nobody has told us" trains the reader to distrust it. One is a fact;
   * the other is an invitation to set an override.
   */
  known: boolean;
}

/** Text in, text out: what every model can do, and all an unknown one is assumed to. */
const CONSERVATIVE: ModelCapabilities = Object.freeze({
  input: Object.freeze(['text'] as Modality[]),
  output: Object.freeze(['text'] as Modality[]),
  // Assumed usable. The opposite default would refuse every model released
  // after this table, which is a worse failure than letting an unusable one be
  // chosen: one is a wrong answer the reader can see and correct, the other
  // silently removes the right answer.
  chat: true,
  known: false,
});

interface CapabilityEntry {
  /** Matched against the start of the model id, lowercased. Longest wins. */
  match: string;
  input: readonly Modality[];
  /** Defaults to text, which is what a chat route returns. */
  output?: readonly Modality[];
  /** Set false for a catalogue entry that is not a chat model at all. */
  chat?: false;
}

/**
 * What each family is known to accept, as published by its vendor.
 *
 * Entries are prefixes rather than exact ids because ids acquire suffixes —
 * dates, sizes, `-latest`, a gateway's vendor prefix — and an exact table goes
 * stale the day a model is re-released under a longer name. A family that
 * gains a capability mid-generation is the case this gets wrong, and the
 * settings override is the answer to that.
 *
 * Chat routes all return text. The entries that do not are the ones marked
 * `chat: false` — embeddings, speech, transcription, moderation, and the image
 * and video generators. They are here precisely because the provider lists
 * them: a picker that showed them unlabelled beside the usable models would be
 * offering a choice that cannot work.
 */
const BUILTIN_CAPABILITIES: CapabilityEntry[] = [
  // ── Anthropic Claude — vision across the current generations ──
  { match: 'claude-opus', input: ['text', 'image'] },
  { match: 'claude-sonnet', input: ['text', 'image'] },
  { match: 'claude-haiku', input: ['text', 'image'] },
  { match: 'claude-fable', input: ['text', 'image'] },
  { match: 'claude-3', input: ['text', 'image'] },
  { match: 'claude-', input: ['text', 'image'] },

  // ── OpenAI ──
  { match: 'gpt-5', input: ['text', 'image'] },
  { match: 'gpt-4.1', input: ['text', 'image'] },
  { match: 'gpt-4o', input: ['text', 'image'] },
  // The reasoning line is split: o3 and o4 read images, o1 did not.
  { match: 'o1', input: ['text'] },
  { match: 'o3', input: ['text', 'image'] },
  { match: 'o4', input: ['text', 'image'] },
  { match: 'gpt-4-turbo', input: ['text', 'image'] },
  // The original GPT-4 and 3.5 predate vision. Both are still served, and
  // without these they would show as undescribed rather than as text-only.
  { match: 'gpt-4', input: ['text'] },
  { match: 'gpt-3.5', input: ['text'] },
  { match: 'davinci-', input: ['text'] },
  { match: 'babbage-', input: ['text'] },

  // ── Google Gemini — the widest input surface of the set ──
  { match: 'gemini-', input: ['text', 'image', 'audio', 'video'] },

  // ── DeepSeek ──
  // V4 reads images; the V3-era chat and reasoning endpoints do not. Left
  // narrow on purpose: the bare `deepseek-` fallback claiming vision would
  // extend it to every future id including text-only ones.
  { match: 'deepseek/deepseek-v4', input: ['text', 'image'] },
  { match: 'deepseek-v4', input: ['text', 'image'] },
  { match: 'deepseek/deepseek-chat', input: ['text'] },
  { match: 'deepseek/deepseek-r1', input: ['text'] },
  { match: 'deepseek-reasoner', input: ['text'] },
  { match: 'deepseek-chat', input: ['text'] },

  // ── Others in common use through gateways ──
  { match: 'glm-4.6v', input: ['text', 'image'] },
  { match: 'glm-4v', input: ['text', 'image'] },
  { match: 'glm-', input: ['text'] },
  { match: 'llama-4', input: ['text', 'image'] },
  { match: 'llama-3.2-vision', input: ['text', 'image'] },
  { match: 'llama-3', input: ['text'] },
  { match: 'qwen-vl', input: ['text', 'image'] },
  { match: 'qwen2-vl', input: ['text', 'image'] },
  { match: 'qwen3-vl', input: ['text', 'image'] },
  { match: 'qwen', input: ['text'] },
  { match: 'mistral-small-3', input: ['text', 'image'] },
  { match: 'pixtral', input: ['text', 'image'] },
  { match: 'mistral-', input: ['text'] },
  { match: 'grok-4', input: ['text', 'image'] },
  { match: 'grok-2-vision', input: ['text', 'image'] },
  { match: 'grok-', input: ['text'] },

  // ── Listed by their providers, but not models an agent can run on ──
  // Every one of these appears in a plain catalogue listing beside the chat
  // models. Naming them is the only way the picker can say so before the
  // choice is made rather than after the first request fails.
  { match: 'gpt-image', input: ['text', 'image'], output: ['image'], chat: false },
  { match: 'chatgpt-image', input: ['text', 'image'], output: ['image'], chat: false },
  { match: 'dall-e', input: ['text'], output: ['image'], chat: false },
  { match: 'sora', input: ['text', 'image'], output: ['video'], chat: false },
  { match: 'tts-', input: ['text'], output: ['audio'], chat: false },
  { match: 'gpt-4o-mini-tts', input: ['text'], output: ['audio'], chat: false },
  { match: 'whisper', input: ['audio'], output: ['text'], chat: false },
  { match: 'gpt-transcribe', input: ['audio'], output: ['text'], chat: false },
  { match: 'gpt-live-transcribe', input: ['audio'], output: ['text'], chat: false },
  { match: 'gpt-4o-transcribe', input: ['audio'], output: ['text'], chat: false },
  // Spelled out rather than left to `gpt-4o-transcribe`, which it does not
  // start with — without this it matches the plain `gpt-4o` vision entry and
  // a speech-to-text endpoint is offered as an image-reading chat model.
  { match: 'gpt-4o-mini-transcribe', input: ['audio'], output: ['text'], chat: false },
  // The realtime and audio lines speak a socket protocol, not chat completion.
  { match: 'gpt-realtime', input: ['text', 'audio'], output: ['text', 'audio'], chat: false },
  { match: 'gpt-audio', input: ['text', 'audio'], output: ['text', 'audio'], chat: false },
  { match: 'text-embedding', input: ['text'], output: ['text'], chat: false },
  { match: 'omni-moderation', input: ['text', 'image'], output: ['text'], chat: false },
  { match: 'text-moderation', input: ['text'], output: ['text'], chat: false },
];

/** Resolved answers, so a per-request check is not a table scan. */
const cache = new Map<string, ModelCapabilities>();

/**
 * A gateway id reduced to the vendor's own.
 *
 * OpenRouter and friends prefix ids with the vendor — `anthropic/claude-opus-5`
 * — and a prefix table keyed on the model's real name would match none of
 * them. Both spellings are tried rather than the table carrying two entries
 * per family, which would double it and let the halves drift apart.
 */
function candidates(model: string): string[] {
  const lower = model.toLowerCase().trim();
  const slash = lower.indexOf('/');
  return slash === -1 ? [lower] : [lower, lower.slice(slash + 1)];
}

/** Whether a value from settings is a modality this platform can carry. */
function readModalities(raw: unknown): Modality[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const clean = raw.filter((v): v is Modality =>
    typeof v === 'string' && (MODALITIES as string[]).includes(v));
  // Deduplicated, and empty means "not stated" rather than "accepts nothing":
  // a model that accepts nothing cannot be talked to, so it is never what
  // someone meant to write.
  const unique = [...new Set(clean)];
  return unique.length > 0 ? unique : undefined;
}

/**
 * What this model takes and returns.
 *
 * @param model - the id as the provider will receive it, gateway prefix and all.
 * @param settings - consulted for a user override; omitted means built-ins only.
 */
export function getModelCapabilities(
  model: string,
  settings?: AicoSettings,
): ModelCapabilities {
  const override = settings?.modelCapabilities?.[model];
  if (override) {
    const input = readModalities(override.input);
    const output = readModalities(override.output);
    if (input || output) {
      // Text is added back rather than trusted from the override. Every model
      // reachable here is being sent a prompt, so an override naming only
      // `image` describes something that cannot exist and is more likely a
      // reader saying "it also does images".
      const resolvedInput = input ? [...new Set<Modality>(['text', ...input])] : CONSERVATIVE.input;
      const resolvedOutput = output ? [...new Set<Modality>(['text', ...output])] : CONSERVATIVE.output;
      return {
        input: resolvedInput,
        output: resolvedOutput,
        // An override says what a model takes, not whether it is a chat model.
        // Since text is added back to both sides above, an override always
        // describes something the agent can run on — which is right: someone
        // writing one is describing a model they intend to use.
        chat: true,
        known: true,
      };
    }
  }

  const cached = cache.get(model);
  if (cached) return cached;

  let best: { entry: CapabilityEntry; length: number } | undefined;
  for (const name of candidates(model)) {
    for (const entry of BUILTIN_CAPABILITIES) {
      if (!name.startsWith(entry.match)) continue;
      if (entry.match.length > (best?.length ?? 0)) best = { entry, length: entry.match.length };
    }
  }

  const resolved: ModelCapabilities = best
    ? Object.freeze({
      input: Object.freeze([...best.entry.input]),
      output: Object.freeze([...(best.entry.output ?? ['text'])]),
      chat: best.entry.chat ?? true,
      known: true,
    })
    : CONSERVATIVE;
  cache.set(model, resolved);
  return resolved;
}

/** Whether this model can be sent this kind of content. */
export function modelAccepts(
  model: string,
  modality: Modality,
  settings?: AicoSettings,
): boolean {
  return getModelCapabilities(model, settings).input.includes(modality);
}

/** Whether this model can produce this kind of content. */
export function modelProduces(
  model: string,
  modality: Modality,
  settings?: AicoSettings,
): boolean {
  return getModelCapabilities(model, settings).output.includes(modality);
}

/**
 * Why a piece of content cannot go to this model, in words worth showing.
 *
 * Returns nothing when it can. An error a reader can act on has to say which
 * model, what it will not take, and what to do instead — "unsupported content
 * type" says none of those, and the reader's next move is to guess.
 */
export function explainRefusal(
  model: string,
  modality: Modality,
  settings?: AicoSettings,
): string | undefined {
  const capabilities = getModelCapabilities(model, settings);
  if (capabilities.input.includes(modality)) return undefined;
  return capabilities.known
    ? `${model} does not accept ${modality} input. Switch to a model that does, `
      + `or set modelCapabilities["${model}"] in settings if this is wrong.`
    : `Nothing describes what ${model} accepts, so it is treated as text-only and `
      + `${modality} input is not sent. Set modelCapabilities["${model}"] in settings `
      + `to say what it takes.`;
}

/**
 * Whether this model can be the one the agent runs on.
 *
 * The useful check before a run starts, and before a picker offers a choice.
 */
export function modelCanChat(model: string, settings?: AicoSettings): boolean {
  return getModelCapabilities(model, settings).chat;
}

/** Forget resolved answers. For tests, and for a settings change mid-process. */
export function resetCapabilityCache(): void {
  cache.clear();
}
