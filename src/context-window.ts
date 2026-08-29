/**
 * Dynamic model context-window detection.
 *
 * Instead of hardcoding context limits (which are frequently wrong — e.g.
 * DeepSeek V4 has 1M context, not 128K), this module:
 *
 *   1. Starts with a corrected built-in table of known models
 *   2. Reads user-confirmed overrides from settings.contextWindows
 *   3. Can query provider model-info endpoints at runtime to auto-detect
 *   4. Persists detected values back to settings so they're permanent
 *
 * The flow on first interaction with a model:
 *   built-in lookup → provider API detection → persist to settings
 * On subsequent interactions:
 *   settings override (permanent) → built-in fallback
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AicoSettings } from './settings.js';
import { listInstances, resolveApiKey } from './providers/instances.js';

// ── Built-in context windows (corrected July 2026) ──────────────────
// These are the AUTHORITATIVE limits as published by each vendor.
// Format: [prefix_match, context_window_tokens]
// Checked longest-first so 'deepseek/deepseek-v4' wins over 'deepseek/'.
const BUILTIN_CONTEXT_WINDOWS: Array<{ match: string; tokens: number }> = [
  // ── DeepSeek (corrected! V4 = 1M context, not 128K) ──
  { match: 'deepseek/deepseek-v4',    tokens: 1_000_000 },  // V4: 1M context
  { match: 'deepseek/deepseek-chat',  tokens: 128_000 },     // V3 chat: 128K
  { match: 'deepseek/deepseek-r1',    tokens: 128_000 },     // R1: 128K
  { match: 'deepseek/',               tokens: 128_000 },     // default fallback
  // First-party platform ids (no `deepseek/` prefix). Both v4 models are 1M —
  // the bare `deepseek-` fallback below would otherwise cap them at 128K and
  // trigger compaction at roughly an eighth of the real window.
  { match: 'deepseek-v4',             tokens: 1_000_000 },
  { match: 'deepseek-',               tokens: 128_000 },

  // ── Anthropic Claude ──
  { match: 'claude-opus',             tokens: 200_000 },
  { match: 'claude-sonnet',           tokens: 200_000 },
  { match: 'claude-haiku',            tokens: 200_000 },
  { match: 'claude-',                 tokens: 200_000 },

  // ── OpenAI GPT ──
  { match: 'gpt-5',                   tokens: 400_000 },  // GPT-5: ~400K
  { match: 'gpt-4.1-mini',            tokens: 1_000_000 },
  { match: 'gpt-4.1',                 tokens: 1_000_000 },
  { match: 'gpt-4o-mini',             tokens: 128_000 },
  { match: 'gpt-4o',                  tokens: 128_000 },
  { match: 'o1',                      tokens: 200_000 },
  { match: 'o3',                      tokens: 200_000 },
  { match: 'o4',                      tokens: 200_000 },

  // ── Google Gemini ──
  { match: 'gemini-2.5',              tokens: 1_000_000 },
  { match: 'gemini-2.0',              tokens: 1_000_000 },
  { match: 'gemini-flash',            tokens: 1_000_000 },
  { match: 'gemini-1.5',              tokens: 2_000_000 },
  { match: 'gemini-',                 tokens: 1_000_000 },

  // ── Z.AI GLM ──
  // The 5.3 line documents a 1M window (docs.z.ai/guides/llm/glm-5.3). Under
  // the old blanket 128K, compaction fired at an eighth of the real budget —
  // paying a summarisation call, and discarding detail, on a model that could
  // still hold the whole conversation.
  { match: 'glm-5.3',                 tokens: 1_000_000 },
  { match: 'glm-5.2',                 tokens: 200_000 },
  { match: 'glm-5',                   tokens: 128_000 },
  { match: 'glm-4.7',                 tokens: 200_000 },
  { match: 'glm-4.6',                 tokens: 200_000 },
  { match: 'glm-4.5',                 tokens: 128_000 },
  { match: 'glm-',                    tokens: 128_000 },

  // ── Meta Llama ──
  { match: 'llama-4',                 tokens: 1_000_000 },  // Llama 4 Scout/Maverick: 10M context
  { match: 'llama-3.3',               tokens: 128_000 },
  { match: 'llama-3.1',               tokens: 128_000 },
  { match: 'llama-3',                 tokens: 8_000 },
  { match: 'llama',                   tokens: 128_000 },

  // ── Mistral ──
  { match: 'mistral-large',           tokens: 128_000 },
  { match: 'mistral-',                tokens: 32_000 },

  // ── Qwen ──
  { match: 'qwen3',                   tokens: 128_000 },
  { match: 'qwen-',                   tokens: 32_000 },
];

// Default when nothing matches at all
const DEFAULT_CONTEXT_WINDOW = 128_000;

// Minimum safe margin — never fill the context window to 100% before
// compacting. This headroom is reserved for the system prompt, tool defs,
// and the model's output budget.
const RESERVED_OUTPUT_TOKENS = 8_192;

/**
 * In-memory cache of model → context window.
 * Populated from settings on first lookup, updated by runtime detection.
 */
const _runtimeCache = new Map<string, number>();

/**
 * Look up the context window for a model.
 *
 * Resolution order:
 *   1. Runtime cache (fastest — set by detection or user correction)
 *   2. settings.contextWindows[model] (permanent user-confirmed override)
 *   3. Built-in table (longest prefix match)
 *   4. DEFAULT_CONTEXT_WINDOW (128K)
 */
export function getContextWindow(model: string, settings?: AicoSettings): number {
  // 1. Runtime cache
  const cached = _runtimeCache.get(model);
  if (cached) return cached;

  // 2. Settings override (permanent)
  if (settings?.contextWindows?.[model]) {
    const val = settings.contextWindows[model];
    _runtimeCache.set(model, val);
    return val;
  }

  // 3. Built-in table — longest prefix match wins.
  //
  // Tried twice: once as given, once without the vendor prefix. `glm-5.3` and
  // `z-ai/glm-5.3` are the same model named two ways, and only the first
  // matched anything — so the routed form silently fell back to the default
  // window and compacted a 1M-context model as though it held 128K.
  const m = model.toLowerCase();
  const found = matchWindow(m);
  if (found !== undefined) return found;
  const slash = m.indexOf('/');
  if (slash > 0) {
    const bare = matchWindow(m.slice(slash + 1));
    if (bare !== undefined) return bare;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** The table's answer for one spelling of a model name, if it has one. */
function matchWindow(model: string): number | undefined {
  let best: { tokens: number; len: number } | undefined;
  for (const { match, tokens } of BUILTIN_CONTEXT_WINDOWS) {
    if (model.startsWith(match.toLowerCase()) && match.length > (best?.len ?? 0)) {
      best = { tokens, len: match.length };
    }
  }
  return best?.tokens;
}

/**
 * Effective context budget for compaction decisions.
 * Subtracts the reserved output headroom so compaction triggers before
 * the window is truly full.
 */
export function getEffectiveContextBudget(model: string, settings?: AicoSettings): number {
  return Math.max(1_000, getContextWindow(model, settings) - RESERVED_OUTPUT_TOKENS);
}

/**
 * Permanently set the context window for a model.
 * Updates the runtime cache immediately AND persists to settings.json so
 * the value is remembered across sessions.
 *
 * Use this when the user corrects a value, or when auto-detection succeeds.
 */
export async function setContextWindow(
  model: string,
  tokens: number,
  options?: { silent?: boolean },
): Promise<void> {
  _runtimeCache.set(model, tokens);

  if (options?.silent) return;

  try {
    await persistContextWindow(model, tokens);
  } catch {
    // Persist failure is non-fatal — the runtime cache still holds the value
  }
}

/**
 * Persist a context-window override to ~/.aico/settings.json.
 * Merges into the contextWindows map without clobbering other entries.
 */
async function persistContextWindow(model: string, tokens: number): Promise<void> {
  const dir = path.join(os.homedir(), '.aico');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'settings.json');

  let existing: Record<string, unknown> = {};
  try {
    const text = await readFile(filePath, 'utf8');
    existing = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // no file yet
  }

  // Merge into contextWindows map
  const ctxMap = (existing.contextWindows as Record<string, number>) ?? {};
  ctxMap[model] = tokens;
  existing.contextWindows = ctxMap;

  await writeFile(filePath, JSON.stringify(existing, null, 2));
}

/**
 * Detect the context window from a provider's model-info endpoint.
 *
 * Supported providers:
 *   - OpenRouter: GET https://openrouter.ai/api/v1/models → context_length
 *   - OpenAI:     GET https://api.openai.com/v1/models → (not available in list)
 *   - Ollama:     POST /api/show → model_info.context_length
 *
 * Returns the detected context window, or undefined if detection failed.
 * On success, persists the value to settings.
 */
export async function detectContextWindow(
  model: string,
  provider: string,
  settings?: AicoSettings,
): Promise<number | undefined> {
  try {
    let detected: number | undefined;

    switch (provider) {
      case 'openrouter': {
        detected = await detectViaOpenRouter(model);
        break;
      }
      case 'ollama': {
        detected = await detectViaOllama(model, settings);
        break;
      }
      case 'zai': {
        detected = await detectViaOpenAICompatible(
          model,
          'https://api.z.ai/api/paas/v4/models',
          process.env.ZAI_API_KEY,
        );
        break;
      }
      // A custom endpoint is the case that needs this most and had it least:
      // its model ids are whatever its operator chose, so the built-in table's
      // 128K fallback is a guess about a model nobody has ever described. Many
      // such servers — vLLM, LM Studio, llama.cpp, most gateways — do report a
      // length, just under one of several names.
      case 'openai-compatible': {
        const instance = listInstances(settings ?? {}).find(i => i.type === 'openai-compatible');
        if (!instance?.baseUrl) return undefined;
        detected = await detectViaOpenAICompatible(
          model,
          `${instance.baseUrl.replace(/\/+$/, '')}/models`,
          resolveApiKey(instance),
        );
        break;
      }
      // OpenAI, Anthropic, Gemini don't expose context_length in their
      // model list endpoints in a reliable way — rely on built-in table
      default:
        return undefined;
    }

    if (detected && detected > 0) {
      // Persist permanently
      await setContextWindow(model, detected);
      return detected;
    }
  } catch {
    // Detection failure is silent — fall back to built-in table
  }
  return undefined;
}

// ── Provider-specific detection ─────────────────────────────────────

/** OpenRouter: GET /api/v1/models returns context_length per model */
async function detectViaOpenRouter(model: string): Promise<number | undefined> {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) return undefined;
  const data = await res.json() as { data?: Array<{ id: string; context_length?: number }> };
  const found = data.data?.find(m => m.id === model);
  return found?.context_length;
}

/** Ollama: POST /api/show returns model_info.context_length */
async function detectViaOllama(model: string, settings?: AicoSettings): Promise<number | undefined> {
  const baseUrl = settings?.providers?.ollama?.baseUrl ?? 'http://localhost:11434';
  const res = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) return undefined;
  const data = await res.json() as {
    model_info?: Record<string, unknown>;
  };
  // Ollama nests context_length under model_info with a model-specific prefix
  for (const [key, val] of Object.entries(data.model_info ?? {})) {
    if (key.endsWith('context_length') && typeof val === 'number') return val;
  }
  return undefined;
}

/** Generic OpenAI-compatible /models endpoint with context_length field */
async function detectViaOpenAICompatible(
  _model: string,
  url: string,
  apiKey?: string,
): Promise<number | undefined> {
  // Note: standard OpenAI-compatible /models endpoints don't include
  // context_length. This is a best-effort probe for providers that DO
  // include it (some do via extensions).
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return undefined;
  const data = await res.json() as { data?: Array<Record<string, unknown>> };
  const found = data.data?.find(m => m.id === _model);
  if (!found) return undefined;
  // No standard name for this. vLLM says `max_model_len`, OpenRouter
  // `context_length`, others `context_window` — reading all of them costs
  // nothing and is the difference between a real number and a 128K guess.
  for (const key of [
    'context_length', 'max_model_len', 'context_window',
    'max_context_length', 'max_input_tokens', 'context_size',
  ]) {
    const value = Number(found[key]);
    // Bounded, not merely finite: a server reporting 0, or bytes where tokens
    // were meant, would otherwise be persisted as fact and drive compaction.
    if (Number.isInteger(value) && value >= 1_000 && value <= 20_000_000) return value;
  }
  return undefined;
}

/**
 * Ensure the context window is known for a model. If it's not in settings
 * or the runtime cache yet, attempt auto-detection from the provider.
 * Called on first interaction with a model.
 *
 * Returns the resolved context window (detection result or built-in fallback).
 */
export async function ensureContextWindow(
  model: string,
  provider: string,
  settings?: AicoSettings,
): Promise<number> {
  // Check if we already have a permanent override
  if (settings?.contextWindows?.[model]) {
    return getContextWindow(model, settings);
  }
  // Check runtime cache (detection already ran this session)
  if (_runtimeCache.has(model)) {
    return _runtimeCache.get(model)!;
  }

  // Attempt detection — this persists on success
  const detected = await detectContextWindow(model, provider, settings);
  if (detected && detected > 0) {
    // Detection succeeded — context window is now permanent
    return detected;
  }

  // Detection failed or unsupported — use built-in table
  // Mark as "known" so we don't retry detection every turn
  const builtin = getContextWindow(model, settings);
  _runtimeCache.set(model, builtin);
  return builtin;
}

/**
 * Clear the runtime cache (useful for testing).
 */
export function resetContextWindowCache(): void {
  _runtimeCache.clear();
}
