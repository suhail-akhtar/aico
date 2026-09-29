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
 * Resolution, strongest first:
 *
 *   1. a settings override — somebody looked and decided;
 *   2. what was *learned* about the model and cached on disk: a live probe
 *      (an image was sent and the model named its colour, or the endpoint
 *      refused it as unsupported), then a provider catalogue that states
 *      modalities (OpenRouter's `architecture.input_modalities`, Kimi's
 *      `supports_image_in`);
 *   3. the built-in table, matched longest-prefix-first;
 *   4. text-only, marked unknown.
 *
 * The same ladder {@link module:context-window} climbs, for the same reason:
 * context window and modality are the same kind of fact, learned the same
 * ways. Learned facts are only ever written by an explicit test or probe, or
 * by a catalogue listing the picker already fetched — never by sending
 * something to a model mid-turn to see whether it breaks.
 *
 * @module model-capabilities
 */

import fs from 'fs';
import path from 'path';
import { mkdir, rename, writeFile } from 'fs/promises';
import { aicoHome } from './home.js';
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
  /**
   * Which rung of the ladder answered. Optional so a value built elsewhere
   * still type-checks; everything this module returns sets it.
   */
  source?: CapabilitySource;
  /** When a learned answer was established (ms since epoch). Only for `probe` and `catalogue`. */
  checkedAt?: number;
}

/**
 * Where a capability answer came from.
 *
 * `probe` is the strongest learned evidence: a picture was actually sent and
 * the model either named what was in it or the endpoint refused it.
 * `catalogue` is the provider saying so in its model list, which is good but
 * second-hand — a gateway's listing describes the model, not necessarily what
 * the gateway passes through.
 */
export type CapabilitySource = 'user' | 'probe' | 'catalogue' | 'table' | 'assumed';

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
  source: 'assumed',
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
  //
  // Not listed, deliberately: `chat-latest`, which the catalogue really does
  // return under that bare name. It is a moving alias, so any capability
  // written here would describe whatever it pointed at on the day it was
  // written and go quietly wrong the next time OpenAI repoints it. Left
  // undescribed, it reads as text-only and says so — which is the safe
  // direction, and the badge invites an override from someone who knows what
  // it currently is. Resist the urge to "fix" this by guessing.
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

  // ── Moonshot Kimi ──
  // The vision guide (read 2026-09-03) lists K3, K2.7 Code (both variants) and
  // K2.6 as taking images and video. The bare `kimi-` fallback stays text-only
  // on purpose: the retired moonshot-v1 line and anything newer than this
  // table should not be credited with sight until the catalogue says so.
  { match: 'kimi-k3', input: ['text', 'image', 'video'] },
  { match: 'kimi-k2.7', input: ['text', 'image', 'video'] },
  { match: 'kimi-k2.6', input: ['text', 'image', 'video'] },
  { match: 'kimi-', input: ['text'] },
  { match: 'moonshot-v1', input: ['text'] },

  // ── DeepSeek ──
  // V4 reads images; the V3-era chat and reasoning endpoints do not. Left
  // narrow on purpose: the bare `deepseek-` fallback claiming vision would
  // extend it to every future id including text-only ones.
  // The experimental vision build is the one id that certainly reads images;
  // the gateways list the plain flash and pro ids as text. Named first so the
  // broader v4 rule below cannot shadow it.
  { match: 'deepseek/deepseek-v4-flash-vision', input: ['text', 'image'] },
  { match: 'deepseek-v4-flash-vision', input: ['text', 'image'] },
  { match: 'deepseek/deepseek-v4', input: ['text', 'image'] },
  { match: 'deepseek-v4', input: ['text', 'image'] },
  { match: 'deepseek/deepseek-chat', input: ['text'] },
  { match: 'deepseek/deepseek-r1', input: ['text'] },
  { match: 'deepseek-reasoner', input: ['text'] },
  { match: 'deepseek-chat', input: ['text'] },

  // ── Others in common use through gateways ──
  // GLM 5.3 Flash and the 5v line read images and video (OpenRouter lists
  // text/image/video for z-ai/glm-5.3-flash); the plain 5.3 is text. Bare
  // `glm-` stays text-only so an unknown newer id is not credited with sight.
  { match: 'glm-5.3-flash', input: ['text', 'image', 'video'] },
  { match: 'glm-5v', input: ['text', 'image', 'video'] },
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

/** Resolved table answers, so a per-request check is not a table scan. */
const cache = new Map<string, ModelCapabilities>();

// ── Learned capabilities: probes and catalogues, cached on disk ──────

/** One learned fact about one model, as the cache file holds it. */
export interface LearnedCapability {
  /** The provider instance (or family) it was learned through. */
  provider: string;
  model: string;
  /** Input modalities, text included. */
  input: Modality[];
  source: 'probe' | 'catalogue';
  /** When (ms since epoch). */
  at: number;
}

interface CapabilityCacheFile {
  version: 1;
  entries: LearnedCapability[];
}

/**
 * Learned facts, keyed by model id exactly as the provider receives it.
 *
 * Not by provider and model together, because resolution is asked by model
 * alone — every caller that gates a request knows the model and not which
 * instance will serve it. The provider is kept in the entry so a reader can see
 * where a fact came from; the rare id served by two endpoints that disagree
 * gets whichever was checked last, which is also what a person re-running the
 * probe would expect.
 */
const learned = new Map<string, LearnedCapability>();
let learnedLoaded = false;

/** Where learned capabilities live: beside the other caches, under the AICO home. */
export function capabilityCachePath(): string {
  return path.join(aicoHome(), 'cache', 'model-capabilities.json');
}

/**
 * Read the cache file once, synchronously, the first time anything asks.
 *
 * Lazy rather than at import, because `AICO_HOME` is read at call time (see
 * `home.ts`) and a module imported early must not freeze the answer. Sync,
 * because resolution is sync and runs before every request — it cannot await.
 * A missing or damaged file is an empty cache, never an error: the table
 * still answers.
 */
function ensureLearnedLoaded(): void {
  if (learnedLoaded) return;
  learnedLoaded = true;
  let parsed: Partial<CapabilityCacheFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(capabilityCachePath(), 'utf8')) as Partial<CapabilityCacheFile>;
  } catch {
    return;
  }
  for (const raw of Array.isArray(parsed.entries) ? parsed.entries : []) {
    const entry = readLearned(raw);
    if (entry) learned.set(entry.model, entry);
  }
}

/** Validate one entry from disk; anything malformed is dropped rather than trusted. */
function readLearned(raw: unknown): LearnedCapability | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const input = readModalities(r.input);
  if (typeof r.model !== 'string' || !r.model || !input) return undefined;
  if (r.source !== 'probe' && r.source !== 'catalogue') return undefined;
  return {
    provider: typeof r.provider === 'string' ? r.provider : '',
    model: r.model,
    input: [...new Set<Modality>(['text', ...input])],
    source: r.source,
    at: typeof r.at === 'number' ? r.at : 0,
  };
}

/**
 * Writes go one at a time, for the reason `context-window` gives: each is a
 * whole-file write, and two in flight would each start from the same "before".
 * The file is replaced by rename so a reader never sees half of one.
 */
let persistQueue: Promise<void> = Promise.resolve();

function persistLearned(): Promise<void> {
  const next = persistQueue.then(async () => {
    const file = capabilityCachePath();
    await mkdir(path.dirname(file), { recursive: true });
    const body: CapabilityCacheFile = {
      version: 1,
      entries: [...learned.values()].sort((a, b) => a.model.localeCompare(b.model)),
    };
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(body, null, 2));
    await rename(temporary, file);
  });
  persistQueue = next.catch(() => undefined);
  return next;
}

/** Wait for any pending cache write. For tests and for a caller about to exit. */
export function flushCapabilityCache(): Promise<void> {
  return persistQueue;
}

/**
 * Record what was learned about a model, and persist it.
 *
 * A probe always replaces what was there: it is the most direct evidence
 * available, and re-running one is how a person says "check again". A
 * catalogue never replaces a probe — a listing that says "image" does not
 * outrank having sent an image and watched it be refused — but does replace an
 * older catalogue answer, since listings change when models do.
 *
 * @returns whether anything changed (and so whether a write was queued).
 */
export function recordModelCapabilities(fact: {
  provider: string;
  model: string;
  input: readonly Modality[];
  source: 'probe' | 'catalogue';
  at?: number;
}): boolean {
  ensureLearnedLoaded();
  const input = readModalities([...fact.input]);
  if (!fact.model || !input) return false;
  const entry: LearnedCapability = {
    provider: fact.provider,
    model: fact.model,
    input: [...new Set<Modality>(['text', ...input])],
    source: fact.source,
    at: fact.at ?? Date.now(),
  };
  const existing = learned.get(fact.model);
  if (existing?.source === 'probe' && entry.source === 'catalogue') return false;
  if (existing && existing.source === entry.source && existing.provider === entry.provider
    && existing.input.length === entry.input.length && existing.input.every(m => entry.input.includes(m))) {
    // Unchanged. A catalogue re-listed on every picker open would otherwise
    // rewrite the file each time for nothing.
    if (entry.source === 'catalogue') return false;
  }
  learned.set(fact.model, entry);
  void persistLearned().catch(() => { /* the in-memory answer still holds */ });
  return true;
}

/**
 * Record every modality a catalogue listing stated.
 *
 * @returns how many models' entries changed.
 */
export function recordCatalogueModalities(
  provider: string,
  modalities: Record<string, readonly Modality[]> | undefined,
): number {
  let changed = 0;
  for (const [model, input] of Object.entries(modalities ?? {})) {
    if (recordModelCapabilities({ provider, model, input, source: 'catalogue' })) changed++;
  }
  return changed;
}

/** What was learned about this model, if anything. */
export function learnedCapabilities(model: string): LearnedCapability | undefined {
  ensureLearnedLoaded();
  return learned.get(model);
}

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
        source: 'user',
      };
    }
  }

  const fromTable = tableCapabilities(model);

  /*
    Learned facts outrank the table and nothing else.

    They replace only the *input* side — which is all a probe or a catalogue's
    modality list speaks to. Output and whether it is a chat model at all stay
    with the table, because an image probe that succeeded says nothing about
    either.
  */
  ensureLearnedLoaded();
  const fact = learned.get(model);
  if (fact) {
    return {
      input: fact.input,
      output: fromTable.output,
      chat: fromTable.chat,
      known: true,
      source: fact.source,
      checkedAt: fact.at,
    };
  }
  return fromTable;
}

/** The built-in table's answer, memoised. */
function tableCapabilities(model: string): ModelCapabilities {
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
      source: 'table' as const,
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

/**
 * Forget resolved answers. For tests, and for a settings change mid-process.
 *
 * Learned facts are forgotten too, but only from memory: the next question
 * reads them back from the cache file, which is the point — a reset proves the
 * file, not the process, is what holds them.
 */
export function resetCapabilityCache(): void {
  cache.clear();
  learned.clear();
  learnedLoaded = false;
}
