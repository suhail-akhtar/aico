/**
 * Find out whether a model really reads images, by showing it one.
 *
 * The capability table is a prefix list written from vendor documentation, and
 * a catalogue listing is a provider describing its models — both second-hand.
 * Neither can say what *this endpoint* does with *this id* today: whether a
 * gateway passes the picture through, whether an experimental build has vision
 * switched on, whether a model released after the table was written can see.
 * The only first-hand answer is to send a picture and look at what comes back.
 *
 * So the probe sends one tiny image — a solid square of a colour chosen per
 * probe, built here in code — and asks what colour it is:
 *
 *   - the model names the colour → it reads images;
 *   - the endpoint rejects the request for carrying an image, or the model
 *     says it sees none → it does not, through this endpoint;
 *   - anything else (a bad key, a rate limit, a wrong colour, an empty reply)
 *     → nothing is learned and nothing is recorded.
 *
 * The third bucket is deliberately wide. A wrong answer written to the cache
 * is worse than no answer: "reads images" when it does not breaks every later
 * request that replays a picture; "text-only" when it can see refuses the
 * reader for no reason. Unknown leaves the table in charge, which is where
 * things stood before the probe ran.
 *
 * It costs a real request, so it only ever runs when someone asks — the probe
 * route or a connection test that names a model — and never per turn.
 *
 * @module providers/capability-probe
 */

import zlib from 'zlib';
import type { AicoSettings } from '../settings.js';
import type { ProviderAPI } from './types.js';
import {
  getModelCapabilities, recordModelCapabilities, type ModelCapabilities,
} from '../model-capabilities.js';

export type ProbeColour = 'red' | 'green' | 'blue' | 'yellow';

/**
 * The probe colours, far enough apart that no reasonable reading of one is
 * another, and each with the words a model might use for it.
 */
const COLOURS: Record<ProbeColour, { rgb: [number, number, number]; words: RegExp }> = {
  red: { rgb: [220, 20, 20], words: /\b(red|crimson|scarlet)\b/i },
  green: { rgb: [20, 170, 40], words: /\b(green|lime|emerald)\b/i },
  blue: { rgb: [20, 60, 230], words: /\b(blue|navy|azure|cobalt)\b/i },
  yellow: { rgb: [245, 215, 20], words: /\b(yellow|gold|golden)\b/i },
};

/**
 * Edge of the probe image, in pixels.
 *
 * Not 1×1 or 8×8: some vision endpoints refuse images below a minimum size
 * (tens of pixels), and that refusal mentions "image" — which would read as
 * "this model takes no images" and record exactly the wrong answer. 64 is
 * above every published minimum and still compresses to a couple of hundred
 * bytes.
 */
const PROBE_EDGE = 64;

// ── A PNG, from nothing ──────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A solid-colour PNG, built in code.
 *
 * No image library and no file on disk: eight-bit RGB, one IDAT, filter type
 * zero on every row. Exported so the tests can hand the same bytes to `Read`.
 */
export function solidPng(rgb: readonly [number, number, number], edge = PROBE_EDGE): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  const row = Buffer.alloc(1 + edge * 3);
  for (let x = 0; x < edge; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: edge }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The probe image for a colour. */
export function probeImage(colour: ProbeColour): Buffer {
  return solidPng(COLOURS[colour].rgb);
}

// ── Classification ───────────────────────────────────────────────────

export type ImageProbeVerdict = 'image' | 'text-only' | 'unknown';

export interface ImageProbeResult {
  verdict: ImageProbeVerdict;
  /** Why, in a sentence a settings screen can show. */
  reason: string;
  /** The colour that was sent. */
  colour: ProbeColour;
  /** What the model said, trimmed, when it said anything. */
  answer?: string;
  /** The provider's error, when the request failed. */
  error?: string;
  latencyMs?: number;
}

/**
 * Words in a provider's refusal that are about the image being there at all.
 *
 * Anchored on vocabulary that only an image refusal uses: DeepSeek's text
 * endpoint answers `unknown variant image_url, expected text`; others say
 * "does not support image input", "multimodal", "vision". A key, quota or
 * rate-limit failure uses none of them and stays unknown.
 */
const IMAGE_REFUSAL = /image[_ ]?url|input_image|\bimages?\b|vision|multi-?modal|modalit/i;

/**
 * Words that make an image-mentioning error about the image's *size* or
 * *shape* rather than its presence. Those say the model reads images and
 * disliked this one, so they must not be recorded as "text-only".
 */
const IMAGE_SHAPE = /too (small|large|big)|dimension|resolution|pixel|min(imum)? size|max(imum)? size|aspect/i;

/** A model saying it was shown nothing. */
const SAW_NOTHING = /\bnone\b|no image|(can ?not|can't|cannot|unable to|not able to|don't|do not) (see|view|perceive|access)|text[- ]only|only (process|read) text/i;

/**
 * Turn what came back into a verdict.
 *
 * Pure, so the rules above can be tested without a network.
 */
export function classifyImageProbe(
  outcome: { answer?: string; error?: string },
  colour: ProbeColour,
): Omit<ImageProbeResult, 'colour' | 'latencyMs'> {
  if (outcome.error !== undefined) {
    const error = outcome.error.slice(0, 400);
    if (IMAGE_REFUSAL.test(error) && !IMAGE_SHAPE.test(error)) {
      return { verdict: 'text-only', reason: 'The endpoint refused a request carrying an image.', error };
    }
    return { verdict: 'unknown', reason: 'The request failed for a reason that says nothing about images.', error };
  }
  const answer = (outcome.answer ?? '').trim().slice(0, 200);
  if (!answer) return { verdict: 'unknown', reason: 'The model gave no answer.' };
  if (COLOURS[colour].words.test(answer)) {
    return { verdict: 'image', reason: `It named the colour of the image it was sent (${colour}).`, answer };
  }
  if (SAW_NOTHING.test(answer)) {
    return {
      verdict: 'text-only',
      reason: 'The request was accepted, but the model said it saw no image — it does not reach the model through this endpoint.',
      answer,
    };
  }
  return { verdict: 'unknown', reason: `It answered, but not with the colour it was sent (${colour}).`, answer };
}

const PROBE_PROMPT = 'What single colour fills this image? Answer with one word. '
  + 'If no image is visible to you, answer NONE.';

/** Long enough for a slow reasoning model, short enough that a hung endpoint does not hold a settings screen. */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Send the probe through a provider and classify the answer.
 *
 * Nothing is recorded here; {@link probeModelImageInput} does that. Kept
 * separate so a test can drive it with a scripted provider.
 */
export async function runImageProbe(opts: {
  provider: ProviderAPI;
  model: string;
  colour?: ProbeColour;
  signal?: AbortSignal;
}): Promise<ImageProbeResult> {
  const choices = Object.keys(COLOURS) as ProbeColour[];
  // Chosen per probe, so a text-only model cannot pass by always guessing the
  // same plausible colour.
  const colour = opts.colour ?? choices[Math.floor(Math.random() * choices.length)]!;
  const started = Date.now();
  let answer = '';
  try {
    const signal = opts.signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS);
    for await (const event of opts.provider.chat({
      model: opts.model,
      systemPrompt: 'You answer questions about images in one word.',
      messages: [{
        role: 'user',
        content: PROBE_PROMPT,
        images: [{ data: probeImage(colour).toString('base64'), mediaType: 'image/png', name: 'probe.png' }],
      }],
      tools: [],
      // Room for a reasoning model to think before its one word.
      maxTokens: 400,
      signal,
    })) {
      if (event.type === 'text') answer += event.content;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...classifyImageProbe({ error }, colour), colour, latencyMs: Date.now() - started };
  }
  return { ...classifyImageProbe({ answer }, colour), colour, latencyMs: Date.now() - started };
}

/**
 * Probe one model on one provider instance and remember the answer.
 *
 * `provider` names an instance id or a family; omitted, the instance that
 * would serve this model in a run is used — so the probe tests the same
 * endpoint a turn would reach.
 */
export async function probeModelImageInput(opts: {
  settings: AicoSettings;
  model: string;
  provider?: string;
  /** For tests: skip instance resolution and use this provider. */
  providerApi?: ProviderAPI;
  colour?: ProbeColour;
}): Promise<ImageProbeResult & {
  model: string;
  provider: string;
  recorded: boolean;
  capabilities: ModelCapabilities;
}> {
  let api = opts.providerApi;
  let providerId = opts.provider ?? api?.id ?? '';
  if (!api) {
    const { listInstances, resolveInstance } = await import('./instances.js');
    const { providerFromInstance } = await import('./index.js');
    const instance = opts.provider
      ? listInstances(opts.settings).find(i => i.id === opts.provider)
        ?? listInstances(opts.settings).find(i => i.type === opts.provider)
      : resolveInstance(opts.settings, { model: opts.model });
    if (!instance) throw new Error(opts.provider ? `No provider "${opts.provider}"` : 'No usable provider is configured');
    api = providerFromInstance(instance, opts.model, opts.settings);
    providerId = instance.id;
  }
  const result = await runImageProbe({
    provider: api, model: opts.model, ...(opts.colour ? { colour: opts.colour } : {}),
  });
  const recorded = result.verdict !== 'unknown' && recordModelCapabilities({
    provider: providerId,
    model: opts.model,
    input: result.verdict === 'image' ? ['text', 'image'] : ['text'],
    source: 'probe',
  });
  return {
    ...result,
    model: opts.model,
    provider: providerId,
    recorded,
    capabilities: getModelCapabilities(opts.model, opts.settings),
  };
}
