/**
 * `GenerateImage` — make pictures with the person's own image-capable key.
 *
 * The one tool of its group that needs a key, and the one that costs money,
 * so it is explicit about both: which provider and model drew the picture, and
 * roughly what it cost, are in every result. It never looks for a key anywhere
 * the chat providers do not — a provider instance's own key, or its
 * environment variable — and never writes one into a message, a log or an
 * error.
 *
 * Each picture ends up in two places, for two different readers:
 *
 *   - **a real file** in the project (`generated-images/…` by default), because
 *     a picture someone asked for is a deliverable they will want to use;
 *   - **the session's attachment store**, which the server can serve back by
 *     id (`GET /api/attachments/file`), so the ```images block the model pastes
 *     renders in the chat — and still renders when the session is reopened.
 *
 * In a terminal run there is no attachment store, so there is no URL to give;
 * the result says so and offers the file alone.
 *
 * @module tools/generate-image
 */

import path from 'path';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import type { AicoSettings } from '../settings.js';
import { loadSettings } from '../settings.js';
import { currentCwd, currentRunContext } from '../run-context.js';
import { listInstances, isUsable, resolveApiKey, resolveBaseUrl, type ProviderInstance } from '../providers/instances.js';
import { getWorkspaceRuntime } from '../workspace.js';
import { requestJson, request, fencedBlock, round, NetError } from './net.js';
import { sniffImageType, extensionFor, type ToolImageMediaType } from './tool-images.js';

export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536';
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

export interface GenerateImageInput {
  prompt: string;
  size?: ImageSize;
  n?: number;
  style?: string;
  quality?: ImageQuality;
  /** Where to save, relative to the project (or absolute). Default: generated-images/<prompt>-<time>.png */
  path?: string;
}

/** The folder pictures land in when the caller names none. */
export const GENERATED_IMAGES_DIR = 'generated-images';

const SIZES: readonly ImageSize[] = ['1024x1024', '1536x1024', '1024x1536'];
const ASPECT: Record<ImageSize, string> = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' };

export interface ImageBackend {
  kind: 'openai' | 'gemini';
  instance: ProviderInstance;
  model: string;
}

/**
 * Which configured provider will draw, or why none can.
 *
 * OpenAI first when nothing is said, because its image model is the one most
 * people with a key can use; Gemini's image models need a billed project. A
 * named `imageGeneration.provider` is honoured exactly, and a name that matches
 * nothing usable is an error rather than a silent fallback to someone else's
 * bill.
 */
export function pickImageBackend(settings: AicoSettings): ImageBackend | { error: string } {
  const prefs = settings.imageGeneration ?? {};
  const usable = listInstances(settings).filter(isUsable);
  const kindOf = (i: ProviderInstance): ImageBackend['kind'] | undefined =>
    i.type === 'openai' ? 'openai' : i.type === 'gemini' ? 'gemini' : undefined;

  let chosen: ProviderInstance | undefined;
  let kind: ImageBackend['kind'] | undefined;
  if (prefs.provider) {
    const byId = usable.find(i => i.id === prefs.provider);
    chosen = byId ?? usable.find(i => i.type === prefs.provider);
    if (chosen) {
      // An explicitly named OpenAI-compatible endpoint is trusted to speak
      // OpenAI's images API; anything else is not an image provider.
      kind = kindOf(chosen) ?? (chosen.type === 'openai-compatible' && byId ? 'openai' : undefined);
    }
    if (!chosen || !kind) {
      return {
        error: `settings.imageGeneration.provider is "${prefs.provider}", but no usable OpenAI or Gemini provider `
          + 'with that id or type is configured. ' + NO_KEY_HELP,
      };
    }
  } else {
    chosen = usable.find(i => i.type === 'openai') ?? usable.find(i => i.type === 'gemini');
    kind = chosen ? kindOf(chosen) : undefined;
  }
  if (!chosen || !kind) return { error: `Image generation needs an OpenAI or Google Gemini API key, and none is configured. ${NO_KEY_HELP}` };
  const model = prefs.model?.trim() || (kind === 'openai' ? 'gpt-image-1' : 'gemini-2.5-flash-image');
  return { kind, instance: chosen, model };
}

const NO_KEY_HELP = 'Supported: OpenAI (gpt-image-1, the default; gpt-image-1-mini) and Google Gemini '
  + '(gemini-2.5-flash-image, imagen-4 models). Add a key in Settings → Providers (an OpenAI or Google Gemini provider), '
  + 'or set OPENAI_API_KEY / GEMINI_API_KEY. To choose one explicitly, set "imageGeneration": '
  + '{ "provider": "openai" | "gemini", "model": "…" } in settings.json.';

interface Generated { bytes: Buffer; mediaType: ToolImageMediaType; revisedPrompt?: string }
interface Batch { images: Generated[]; usage?: { input_tokens?: number; output_tokens?: number } }

/** The body sent to OpenAI's images endpoint. Exported so the tests can pin it. */
export function openAiImageRequest(model: string, prompt: string, n: number, size: ImageSize, quality: ImageQuality): Record<string, unknown> {
  return {
    model,
    prompt,
    n,
    size,
    // gpt-image models take a quality and always answer in base64; DALL·E
    // takes neither the same qualities nor answers in base64 unless asked.
    ...(model.startsWith('gpt-image') ? { quality } : {}),
    ...(model.startsWith('dall-e') ? { response_format: 'b64_json' } : {}),
  };
}

async function fromOpenAI(backend: ImageBackend, prompt: string, n: number, size: ImageSize, quality: ImageQuality): Promise<Batch> {
  const base = resolveBaseUrl(backend.instance).replace(/\/+$/, '');
  const key = resolveApiKey(backend.instance);
  const r = await requestJson<{
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>(`${base}/images/generations`, {
    what: `OpenAI image generation (${backend.model})`,
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(openAiImageRequest(backend.model, prompt, n, size, quality)),
    timeoutMs: 240_000,
  });
  const images: Generated[] = [];
  for (const item of r.data ?? []) {
    let bytes: Buffer | undefined;
    if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else if (item.url) bytes = Buffer.from(await (await request(item.url, { what: 'Downloading the generated image', timeoutMs: 60_000 })).arrayBuffer());
    const mediaType = bytes ? sniffImageType(bytes) : undefined;
    if (bytes && mediaType) images.push({ bytes, mediaType, ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}) });
  }
  return { images, ...(r.usage ? { usage: r.usage } : {}) };
}

async function fromGemini(backend: ImageBackend, prompt: string, n: number, size: ImageSize): Promise<Batch> {
  // The Gemini provider may be configured with its OpenAI-compatible root;
  // image generation lives on the native API beside it.
  const base = resolveBaseUrl(backend.instance).replace(/\/+$/, '').replace(/\/openai$/, '');
  const headers = { 'x-goog-api-key': resolveApiKey(backend.instance), 'Content-Type': 'application/json' };
  const images: Generated[] = [];

  if (backend.model.startsWith('imagen')) {
    const r = await requestJson<{ predictions?: Array<{ bytesBase64Encoded?: string }> }>(
      `${base}/models/${encodeURIComponent(backend.model)}:predict`, {
        what: `Google Imagen (${backend.model})`, method: 'POST', headers, timeoutMs: 240_000,
        body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: n, aspectRatio: ASPECT[size] } }),
      });
    for (const p of r.predictions ?? []) {
      if (!p.bytesBase64Encoded) continue;
      const bytes = Buffer.from(p.bytesBase64Encoded, 'base64');
      const mediaType = sniffImageType(bytes);
      if (mediaType) images.push({ bytes, mediaType });
    }
    return { images };
  }

  // Gemini image models return one picture per request.
  for (let i = 0; i < n; i++) {
    const r = await requestJson<{
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }> } }>;
    }>(`${base}/models/${encodeURIComponent(backend.model)}:generateContent`, {
      what: `Google Gemini image generation (${backend.model})`, method: 'POST', headers, timeoutMs: 240_000,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ASPECT[size] } },
      }),
    });
    for (const part of r.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;
      if (!data) continue;
      const bytes = Buffer.from(data, 'base64');
      const mediaType = sniffImageType(bytes);
      if (mediaType) { images.push({ bytes, mediaType }); break; }
    }
  }
  return { images };
}

/** List prices, USD per million tokens, for models whose usage is reported. */
const TOKEN_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-image-1': { input: 5, output: 40 },
  'gpt-image-1-mini': { input: 2, output: 8 },
};

/** Per-image list prices for gpt-image-1, used when no usage came back. */
const GPT_IMAGE_1_PER_IMAGE: Record<Exclude<ImageQuality, 'auto'>, { square: number; wide: number }> = {
  low: { square: 0.011, wide: 0.016 },
  medium: { square: 0.042, wide: 0.063 },
  high: { square: 0.167, wide: 0.25 },
};

/**
 * What this probably cost, and on what basis — or nothing, when we would be guessing.
 *
 * From the tokens the provider reported where it did, at list price; from the
 * published per-image table otherwise. Always "estimated": the bill is the
 * provider's, and a discount or a price change is invisible from here.
 */
export function estimateImageCost(
  model: string, quality: ImageQuality, size: ImageSize, count: number,
  usage?: { input_tokens?: number; output_tokens?: number },
): { usd: number; basis: string } | undefined {
  const prices = TOKEN_PRICES[model];
  if (prices && usage && (usage.input_tokens || usage.output_tokens)) {
    const usd = ((usage.input_tokens ?? 0) * prices.input + (usage.output_tokens ?? 0) * prices.output) / 1_000_000;
    return { usd, basis: `from the ${usage.output_tokens ?? 0} image tokens ${model} reported, at list price` };
  }
  if (model === 'gpt-image-1') {
    const row = GPT_IMAGE_1_PER_IMAGE[quality === 'auto' ? 'high' : quality];
    return { usd: row[size === '1024x1024' ? 'square' : 'wide'] * count, basis: `${model} list price per ${quality} image` };
  }
  if (model.startsWith('gemini-2.5-flash-image')) return { usd: 0.039 * count, basis: `${model} list price per image` };
  return undefined;
}

function slugOf(prompt: string): string {
  return prompt.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, 6).join('-') || 'image';
}

function stamp(now = new Date()): string {
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** A path that does not exist yet, so a second generation never overwrites the first. */
function freePath(target: string): string {
  if (!existsSync(target)) return target;
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function describeBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function generateImage(input: GenerateImageInput, deps: { settings?: AicoSettings } = {}): Promise<string> {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('GenerateImage needs a prompt describing the picture.');
  if (prompt.length > 4000) throw new Error('The prompt is over 4,000 characters — shorten it.');
  const size: ImageSize = input.size ?? '1024x1024';
  if (!SIZES.includes(size)) throw new Error(`size must be one of ${SIZES.join(', ')}.`);
  const n = Math.max(1, Math.min(4, Math.round(input.n ?? 1)));

  const settings = deps.settings ?? currentRunContext()?.settings ?? getWorkspaceRuntime().settings ?? await loadSettings();
  const backend = pickImageBackend(settings);
  if ('error' in backend) throw new Error(backend.error);
  const quality: ImageQuality = input.quality ?? settings.imageGeneration?.quality ?? 'medium';
  const fullPrompt = input.style?.trim() ? `${prompt}\n\nStyle: ${input.style.trim()}` : prompt;

  let batch: Batch;
  try {
    batch = backend.kind === 'openai'
      ? await fromOpenAI(backend, fullPrompt, n, size, quality)
      : await fromGemini(backend, fullPrompt, n, size);
  } catch (err) {
    if (err instanceof NetError && (err.status === 401 || err.status === 403)) {
      throw new Error(`${backend.instance.name} refused the request (HTTP ${err.status}) — the key may be invalid or lack access to ${backend.model}. ${err.message}`);
    }
    throw err;
  }
  if (batch.images.length === 0) {
    throw new Error(`${backend.instance.name} (${backend.model}) returned no image. The prompt may have been declined by its safety filter — try rewording it.`);
  }

  // Files first: they are the deliverable, and they must exist even if the
  // attachment store is full or absent.
  const cwd = currentCwd();
  const baseName = `${slugOf(prompt)}-${stamp()}`;
  const saved: Array<{ file: string; data: Buffer; bytes: number; mediaType: ToolImageMediaType; url?: string }> = [];
  for (const [i, image] of batch.images.entries()) {
    const ext = extensionFor(image.mediaType);
    let target: string;
    if (input.path?.trim()) {
      const wanted = path.resolve(cwd, input.path.trim());
      const stem = wanted.slice(0, wanted.length - path.extname(wanted).length);
      target = `${stem}${batch.images.length > 1 ? `-${i + 1}` : ''}${ext}`;
    } else {
      target = path.join(cwd, GENERATED_IMAGES_DIR, `${baseName}${batch.images.length > 1 ? `-${i + 1}` : ''}${ext}`);
    }
    target = freePath(target);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, image.bytes);
    saved.push({ file: target, data: image.bytes, bytes: image.bytes.length, mediaType: image.mediaType });
  }

  // Then the store, for a URL the chat can render.
  const ctx = currentRunContext();
  const sink = ctx?.toolImages;
  const storeNotes: string[] = [];
  if (sink?.persistent && ctx?.sessionId) {
    for (const item of saved) {
      try {
        const ref = await sink.store({ bytes: item.data, mediaType: item.mediaType, name: path.basename(item.file) });
        if (ref) item.url = `/api/attachments/file?session=${encodeURIComponent(ctx.sessionId)}&id=${encodeURIComponent(ref.id)}`;
      } catch (err) {
        storeNotes.push(`${path.basename(item.file)} could not be added to the chat's attachments (${err instanceof Error ? err.message : String(err)}); the file is saved.`);
      }
    }
  }

  const cost = backend.kind === 'openai' || backend.model.startsWith('gemini')
    ? estimateImageCost(backend.model, quality, size, batch.images.length, batch.usage)
    : undefined;
  const via = `${backend.instance.name} ${backend.model}`;
  const lines = [
    `Generated ${batch.images.length} image${batch.images.length === 1 ? '' : 's'} with ${via} `
      + `(${size}${backend.kind === 'openai' && backend.model.startsWith('gpt-image') ? `, quality ${quality}` : ''}).`
      + (cost ? ` Estimated cost: ~$${cost.usd < 0.01 ? cost.usd.toFixed(4) : round(cost.usd, 3)} (${cost.basis}).` : ' Cost not estimated for this model.'),
    ...(batch.images.length < n ? [`Asked for ${n}; the provider returned ${batch.images.length}.`] : []),
    'Saved:',
    ...saved.map(s => `- ${s.file} (${describeBytes(s.bytes)})`),
    ...batch.images.filter(i => i.revisedPrompt).slice(0, 1).map(i => `The provider rewrote the prompt as: ${i.revisedPrompt}`),
    ...storeNotes,
  ];

  const withUrls = saved.filter(s => s.url);
  if (withUrls.length) {
    lines.push('Show them to the user by pasting these blocks as they are (captions may be edited):');
    lines.push(fencedBlock('images', {
      title: prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt,
      images: withUrls.map(s => ({ url: s.url!, caption: path.basename(s.file), alt: prompt.slice(0, 200), source: via })),
    }));
  } else {
    lines.push('This run has no chat attachment store (e.g. a terminal session), so there is no image URL to show — point the user to the file.');
    lines.push('List the files by pasting this block as it is:');
  }
  lines.push(fencedBlock('files', {
    files: saved.map(s => ({ path: s.file, name: path.basename(s.file), size: s.bytes, kind: 'image' })),
  }));
  lines.push('Read a file if you need to look at the picture yourself.');
  return lines.join('\n');
}

export const generateImageDefinition = {
  name: 'GenerateImage',
  description:
    'Create images from a text prompt with the user\'s own image-capable key (OpenAI gpt-image-1 by default, or Google Gemini). '
    + 'Costs money on the user\'s account — generate only when asked, and say the estimated cost reported in the result. '
    + 'Saves each picture as a file in the project (generated-images/ unless `path` is given) and returns a ready-to-paste '
    + '```images block that shows them in the chat plus a ```files block for the saved files. '
    + 'If no key is configured it says which providers work and how to add one.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw. Be specific about subject, composition, colours and any text in the image.' },
      size: { type: 'string', enum: SIZES, description: '1024x1024 (square, default), 1536x1024 (landscape) or 1024x1536 (portrait).' },
      n: { type: 'number', description: 'How many variations, 1–4 (default 1). Each one costs.' },
      style: { type: 'string', description: 'Optional style direction ("watercolour", "flat vector icon", "photorealistic").' },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'OpenAI gpt-image quality: low ≈ $0.01, medium ≈ $0.04 (default), high ≈ $0.17 per square image.' },
      path: { type: 'string', description: 'Where to save, relative to the project (e.g. "assets/hero.png"). Default: generated-images/<prompt>-<time>.png.' },
    },
    required: ['prompt'],
  },
};
