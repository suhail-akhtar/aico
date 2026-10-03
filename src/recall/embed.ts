/**
 * Embeddings for Recall: turn text into vectors through the provider the
 * `embed` role resolves to (ADR 0017), or not at all.
 *
 * OFF BY DEFAULT, AND PERSONAL. Memories, past sessions and About-you facts
 * are the person's own data, so nothing is embedded unless `resolveRole('embed')`
 * comes back `ok` — which already refuses a cloud endpoint when personal data
 * is set to stay local. No role means words-only search, and that is a
 * complete feature, not a degraded one.
 *
 * THREE WIRE SHAPES, because that is what the providers speak:
 * - OpenAI-compatible `POST {base}/embeddings` (OpenAI, OpenRouter, any
 *   `openai-compatible` endpoint such as LM Studio or vLLM, Z.AI, Kimi);
 * - Ollama `POST {base}/api/embed`;
 * - Gemini `POST {base}/models/{model}:batchEmbedContents`, key in the
 *   `x-goog-api-key` header rather than the URL, so it never lands in a log.
 * Anthropic and DeepSeek have no embeddings endpoint; the role resolver
 * already rejects a non-embedding model, and an unsupported family here
 * reports itself instead of guessing.
 *
 * KEYS. Read through providers/instances at the point of the request and put
 * only in a header. Errors carry the HTTP status and a clipped, key-free body.
 *
 * @module recall/embed
 */

import type { AicoSettings } from '../settings.js';
import { resolveRole, type RoleResolution } from '../models/roles.js';
import { findInstance, resolveApiKey, resolveBaseUrl, type ProviderInstance } from '../providers/instances.js';
import { embeddingsFor, itemsNeedingEmbedding, setEmbedding } from './store.js';

/** What search and sync need from an embedder. Tests pass a stub. */
export interface Embedder {
  /** Stored beside each vector; a different model means re-embedding. */
  model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

const BATCH = 32;
const REQUEST_TIMEOUT_MS = 20_000;
/** Embedded text is clipped: a whole session's outcome is not one meaning. */
const MAX_CHARS = 2_000;

/** The `embed` role for this run, or why there is none. */
export function embedRole(settings: AicoSettings | undefined, mainModel: string): RoleResolution {
  return resolveRole('embed', { settings, mainModel: mainModel || settings?.model || '' });
}

function trimSlash(s: string): string { return s.replace(/\/+$/, ''); }

function errorText(status: number, body: string): string {
  // A provider error body is about the request, not the key, but clip it and
  // strip anything key-shaped anyway: this text can reach a log.
  return `embedding request failed (HTTP ${status}): ${body.replace(/(?:sk|key|AIza)[-_A-Za-z0-9]{12,}/g, '[redacted]').slice(0, 160)}`;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(errorText(res.status, text));
  try { return JSON.parse(text); } catch { throw new Error('embedding response was not JSON'); }
}

/** An embedder speaking to one provider instance. */
export function embedderForInstance(instance: ProviderInstance, model: string): Embedder {
  const base = trimSlash(resolveBaseUrl(instance));
  const key = resolveApiKey(instance);
  const embedBatch = async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    switch (instance.type) {
      case 'ollama': {
        const out = await postJson(`${base.replace(/\/v1$/, '')}/api/embed`, {}, { model, input: texts }, signal) as { embeddings?: number[][] };
        if (!Array.isArray(out.embeddings) || out.embeddings.length !== texts.length) throw new Error('Ollama returned no embeddings');
        return out.embeddings.map(v => Float32Array.from(v));
      }
      case 'gemini': {
        const name = model.startsWith('models/') ? model : `models/${model}`;
        const out = await postJson(`${base}/${name}:batchEmbedContents`, key ? { 'x-goog-api-key': key } : {}, {
          requests: texts.map(t => ({ model: name, content: { parts: [{ text: t }] } })),
        }, signal) as { embeddings?: Array<{ values?: number[] }> };
        if (!Array.isArray(out.embeddings) || out.embeddings.length !== texts.length) throw new Error('Gemini returned no embeddings');
        return out.embeddings.map(e => Float32Array.from(e.values ?? []));
      }
      case 'openai': case 'openrouter': case 'openai-compatible': case 'zai': case 'kimi': {
        const out = await postJson(`${base}/embeddings`, key ? { authorization: `Bearer ${key}` } : {}, { model, input: texts }, signal) as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };
        if (!Array.isArray(out.data) || out.data.length !== texts.length) throw new Error('the endpoint returned no embeddings');
        const sorted = [...out.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return sorted.map(d => Float32Array.from(d.embedding ?? []));
      }
      default:
        throw new Error(`${instance.name} (${instance.type}) has no embeddings endpoint AICO can call`);
    }
  };
  return {
    model,
    async embed(texts, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...await embedBatch(texts.slice(i, i + BATCH).map(t => t.slice(0, MAX_CHARS)), signal));
      }
      return out;
    },
  };
}

/** The embedder the settings allow, or undefined for words-only. */
export function embedderFromSettings(settings: AicoSettings | undefined, mainModel: string): Embedder | undefined {
  if (!settings) return undefined;
  const role = embedRole(settings, mainModel);
  if (!role.ok || !role.model || !role.instanceId) return undefined;
  const instance = findInstance(settings, role.instanceId);
  if (!instance) return undefined;
  return embedderForInstance(instance, role.model);
}

/**
 * Give vectors to rows that have none from this model, within a time budget.
 * Returns how many were embedded. A failure stops this round quietly — search
 * still works by words, and the next round tries again.
 */
export async function embedPending(embedder: Embedder, opts: { budgetMs?: number; max?: number; signal?: AbortSignal } = {}): Promise<{ embedded: number; error?: string }> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 8_000;
  const max = opts.max ?? 256;
  let embedded = 0;
  while (embedded < max && Date.now() - started < budget) {
    const rows = itemsNeedingEmbedding(embedder.model, Math.min(BATCH, max - embedded));
    if (!rows.length) break;
    try {
      const vectors = await embedder.embed(rows.map(r => `${r.title}\n${r.text}`), opts.signal);
      rows.forEach((r, i) => { if (vectors[i]?.length) setEmbedding(r.id, embedder.model, vectors[i]!); });
      embedded += rows.length;
    } catch (err) {
      return { embedded, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { embedded };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Rows ranked by similarity to `query`, best first. */
export function nearest(model: string, query: Float32Array, limit: number, allow?: (id: string) => boolean): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const { id, vector } of embeddingsFor(model)) {
    if (allow && !allow(id)) continue;
    scored.push({ id, score: cosine(query, vector) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
