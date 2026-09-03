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
import { aicoHome } from './home.js';
import type { AicoSettings } from './settings.js';
import type { ProviderInstance } from './providers/instances.js';
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
  // The 5 family holds 1M, not 200K. Confirmed against Anthropic's own
  // `/v1/models`, which reports `max_input_tokens: 1000000` — and which the
  // detector above now reads directly, so these are only the fallback for a
  // run with no key to ask with. The blanket `claude-` entry claiming 200K was
  // five times too small for every current model.
  { match: 'claude-opus-5',           tokens: 1_000_000 },
  { match: 'claude-sonnet-5',         tokens: 1_000_000 },
  { match: 'claude-fable-5',          tokens: 1_000_000 },
  { match: 'claude-opus-4',           tokens: 200_000 },
  { match: 'claude-sonnet-4',         tokens: 200_000 },
  { match: 'claude-haiku-4',          tokens: 200_000 },
  { match: 'claude-opus',             tokens: 200_000 },
  { match: 'claude-sonnet',           tokens: 200_000 },
  { match: 'claude-haiku',            tokens: 200_000 },
  { match: 'claude-',                 tokens: 200_000 },

  // ── OpenAI GPT ──
  // OpenAI's `/v1/models` reports no length at all — verified against the live
  // endpoint — so these come from published documentation and carry the date
  // they were checked. They are the entries most likely to go stale, because
  // nothing here can refresh them automatically.
  { match: 'gpt-5.6',                 tokens: 1_048_576 },  // 5.6 family, checked 2026-09
  { match: 'gpt-5',                   tokens: 400_000 },    // earlier 5.x
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
 * Where a context window came from, best first.
 *
 * The point of recording this is that a number alone cannot be re-evaluated.
 * A table entry written in September and a figure the vendor's API returned
 * this morning are not the same kind of fact, and treating them alike is how a
 * stale guess outlives the model it describes.
 *
 * - `user`    — set deliberately in settings. Final, never expires, never
 *               overwritten by detection. Somebody decided; that ends it.
 * - `api`     — the provider's own endpoint said so. Authoritative, but
 *               re-checked, because vendors change windows on live models.
 * - `learned` — parsed out of the provider's own "maximum context length is N"
 *               rejection. Just as authoritative as `api`, costs nothing, and
 *               is the only source that works for a model released tomorrow.
 * - `table`   — the built-in list. A dated guess. Always replaceable.
 * - `assumed` — nothing knew. Flagged so it can be shown as a guess rather
 *               than printed in the same style as a measured number.
 */
/**
 * Where a window figure came from, strongest first.
 *
 * `observed` is evidence from use: a prompt larger than the held window went
 * through, so the window is at least that. It outranks the table and the
 * assumption it corrects, and is itself replaced by anything the provider or
 * the user states.
 */
export type WindowSource = 'user' | 'api' | 'learned' | 'observed' | 'table' | 'assumed';

export interface WindowFact {
  tokens: number;
  source: WindowSource;
  /** When it was established. Absent for the table and the assumption. */
  at?: number;
}

/**
 * How long a detected or tabulated window is trusted before it is checked again.
 *
 * The reason this is not "forever": a model's window is not a constant.
 * Anthropic moved Claude from 200K to 1M on ids that already existed, and a
 * value persisted permanently on the old number would have kept compacting at a
 * fifth of the real window indefinitely, with nothing to make anyone look.
 *
 * A week is short enough that a change is picked up in a working cycle and long
 * enough that nobody notices the check.
 */
const WINDOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Facts for this process, keyed by model. */
const _runtimeCache = new Map<string, WindowFact>();

/** Whether a fact is old enough to be worth re-establishing. */
export function isStale(fact: WindowFact | undefined, now = Date.now()): boolean {
  if (!fact) return true;
  // A person's decision does not go stale, and an assumption is already the
  // weakest thing available — re-checking either changes nothing.
  if (fact.source === 'user') return false;
  if (fact.source === 'table' || fact.source === 'assumed') return true;
  return fact.at === undefined || now - fact.at > WINDOW_TTL_MS;
}

/**
 * Read a stored entry, accepting both shapes.
 *
 * Older settings hold a bare number, because that is all this used to record.
 * Those are treated as `api` with no timestamp — which `isStale` reports as
 * stale, so the first run after upgrading re-establishes them instead of
 * inheriting a figure of unknown age.
 */
function storedFact(value: unknown): WindowFact | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { tokens: value, source: 'api' };
  }
  if (value && typeof value === 'object') {
    const v = value as { tokens?: unknown; source?: unknown; at?: unknown };
    const tokens = Number(v.tokens);
    if (Number.isFinite(tokens) && tokens > 0) {
      return {
        tokens,
        source: (['user', 'api', 'learned', 'observed', 'table', 'assumed'] as const)
          .includes(v.source as WindowSource) ? v.source as WindowSource : 'api',
        ...(typeof v.at === 'number' ? { at: v.at } : {}),
      };
    }
  }
  return undefined;
}

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
  return resolveWindow(model, settings).tokens;
}

/**
 * The window *and* where it came from.
 *
 * Separate from `getContextWindow` so callers that only need a number are not
 * forced to care, while the ones that should — the UI, and anything deciding
 * whether to go and ask the provider — can tell a measured figure from a guess.
 */
export function resolveWindow(model: string, settings?: AicoSettings): WindowFact {
  const cached = _runtimeCache.get(model);
  if (cached) return cached;

  // A value written into settings by hand outranks everything, including a
  // live answer from the vendor. Somebody looked at this and decided.
  const stored = storedFact(settings?.contextWindows?.[model]);
  if (stored) {
    _runtimeCache.set(model, stored);
    return stored;
  }

  // The table — longest prefix match wins.
  //
  // Tried twice: once as given, once without the vendor prefix. `glm-5.3` and
  // `z-ai/glm-5.3` are the same model named two ways, and only the first
  // matched anything — so the routed form silently fell back to the default
  // window and compacted a 1M-context model as though it held 128K.
  const m = model.toLowerCase();
  const found = matchWindow(m) ?? (m.includes('/') ? matchWindow(m.slice(m.indexOf('/') + 1)) : undefined);
  if (found !== undefined) return { tokens: found, source: 'table' };

  /*
    Nothing knew, so this is a guess and is labelled one.

    A model released after this build exists is the normal case, not an edge
    one, and printing 128K for it in the same style as a measured number is how
    somebody ends up trusting it. Detection and error-learning both replace
    this the first time either gets a chance.
  */
  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'assumed' };
}

/**
 * Patterns that state a real limit inside a provider's rejection.
 *
 * Each must capture the *window*, never the request size — the two appear in
 * the same sentence and getting them the wrong way round would persist a number
 * that shrinks every time it is learned.
 *
 * Deliberately anchored on the vendor's own wording rather than "any number
 * near the word tokens", because these strings are read once and then written
 * to a user's settings as fact.
 */
const LIMIT_PATTERNS: RegExp[] = [
  // OpenAI: "This model's maximum context length is 128000 tokens, however you
  // requested 130000 tokens..."
  /maximum context length is\s+(\d[\d,_]*)\s*tokens/i,
  // Anthropic: "prompt is too long: 250000 tokens > 200000 maximum"
  /(?:>|exceeds)\s*(\d[\d,_]*)\s*maximum/i,
  // Google: "input token count (X) exceeds the maximum number of tokens allowed (Y)"
  /maximum number of tokens allowed\s*\((\d[\d,_]*)\)/i,
  // vLLM and several gateways: "maximum context length is 32768 tokens"
  /context (?:length|window)(?: is)?(?: limited to)?\s*(\d[\d,_]*)/i,
  // Mistral / others: "max_tokens_limit: 32000"
  /max(?:imum)?[ _-]?(?:context|model)[ _-]?len(?:gth)?["'\s:=]+(\d[\d,_]*)/i,
];

/**
 * Take a model's real window from the error it just produced.
 *
 * This is the source that keeps working without anybody maintaining anything.
 * A provider that rejects an oversized request nearly always says what the
 * limit *is*, and that sentence is authoritative, free, and available for
 * models that did not exist when this code was written — which is the case a
 * built-in table can never cover.
 *
 * Returns the learned figure, or nothing if the message says no such thing.
 * Refusing to guess is the whole point: a wrong number here is persisted and
 * then trusted.
 */
export function learnWindowFromError(message: string): number | undefined {
  for (const pattern of LIMIT_PATTERNS) {
    const found = pattern.exec(message);
    if (!found) continue;
    const value = plausibleWindow(found[1]?.replace(/[,_]/g, ''));
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Record what an error revealed, if it revealed anything.
 *
 * Called from the failure path rather than a probe, so it costs nothing: the
 * request had already been made and had already failed.
 */
export async function noteWindowFromError(
  model: string,
  message: string,
  settings?: AicoSettings,
): Promise<number | undefined> {
  const learned = learnWindowFromError(message);
  if (learned === undefined) return undefined;

  // A deliberate setting is not overruled by an error message. If somebody
  // wrote a smaller number on purpose — to cap spend, to leave headroom — a
  // rejection at the real limit is not evidence they were wrong.
  const current = resolveWindow(model, settings);
  if (current.source === 'user') return undefined;

  await setContextWindow(model, learned, { source: 'learned' });
  return learned;
}

/**
 * The windows models are actually sold with, smallest first.
 *
 * An accepted prompt of 131,072 tokens does not mean the window is 131,072; it
 * means the window is one of the sizes vendors ship that is at least that
 * big. Rounding up to the next one is still a floor — a later, larger prompt
 * raises it again — but it stops the meter reading "100% of 131.1k" on a
 * model that plainly holds more.
 */
const STANDARD_WINDOWS = [
  32_000, 64_000, 128_000, 200_000, 256_000, 400_000, 512_000, 1_000_000, 2_000_000, 10_000_000,
];

/** The smallest standard window that holds `tokens`. */
export function standardWindowAtLeast(tokens: number): number {
  return STANDARD_WINDOWS.find(w => w >= tokens) ?? Math.ceil(tokens / 1_000_000) * 1_000_000;
}

/**
 * Record what a *successful* request revealed.
 *
 * A model that has just accepted a prompt of N tokens holds at least N,
 * whatever the table or the default said. This is the correction the reported
 * case needed: the window was assumed at 128K, prompts of 130K were going
 * through without complaint, and compaction fired on every turn against a
 * limit the model had already disproved. Nothing was learning from the
 * successes; only failures were listened to.
 *
 * Only an assumption, a table entry, or an earlier observation is corrected.
 * A figure the user typed, one the provider reported, or one learned from a
 * refusal is stronger evidence than a single accepted prompt and is left
 * alone.
 *
 * Synchronous on purpose: the runtime cache is updated before this returns,
 * so the usage event emitted next already carries the corrected window.
 * Persisting to settings happens in the background and cannot fail the turn.
 */
export function noteWindowFromUsage(
  model: string,
  promptTokens: number,
  settings?: AicoSettings,
): WindowFact | undefined {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return undefined;
  const current = resolveWindow(model, settings);
  if (promptTokens <= current.tokens) return undefined;
  if (current.source !== 'assumed' && current.source !== 'table' && current.source !== 'observed') {
    return undefined;
  }
  const fact: WindowFact = { tokens: standardWindowAtLeast(promptTokens), source: 'observed', at: Date.now() };
  _runtimeCache.set(model, fact);
  void persistContextWindow(model, fact).catch(() => { /* the cache still holds it */ });
  return fact;
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
  options?: { silent?: boolean; source?: WindowSource },
): Promise<void> {
  // Stamped, so it can expire. A figure with no age is a figure nothing can
  // ever decide to re-check, which is how a value written when a model held
  // 200K survives the day it becomes 1M.
  const fact: WindowFact = { tokens, source: options?.source ?? 'api', at: Date.now() };
  _runtimeCache.set(model, fact);

  if (options?.silent) return;

  try {
    await persistContextWindow(model, fact);
  } catch {
    // Persist failure is non-fatal — the runtime cache still holds the value
  }
}

/**
 * Persist a context-window override to ~/.aico/settings.json.
 * Merges into the contextWindows map without clobbering other entries.
 */
/**
 * Writes to settings.json go one at a time.
 *
 * Each persist is a read-modify-write of the whole file. Two in flight at
 * once — a detection landing while an accepted prompt raises the same model's
 * window, or two sub-agents on one model — each read the same "before",
 * and whichever wrote last erased the other. The runtime cache was right and
 * the file was wrong, which is the worse way round: the file is what the next
 * process starts from.
 */
let persistQueue: Promise<void> = Promise.resolve();

function persistContextWindow(model: string, fact: WindowFact): Promise<void> {
  const next = persistQueue.then(() => writeContextWindow(model, fact));
  // The queue itself never rejects, so one failed write cannot wedge the rest.
  persistQueue = next.catch(() => undefined);
  return next;
}

async function writeContextWindow(model: string, fact: WindowFact): Promise<void> {
  const dir = aicoHome();
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
  // Written as an object rather than a bare number so the provenance and the
  // timestamp survive a restart. A hand-written number still reads correctly —
  // `storedFact` accepts both shapes — so nobody's existing settings break.
  const ctxMap = (existing.contextWindows as Record<string, unknown>) ?? {};
  ctxMap[model] = { tokens: fact.tokens, source: fact.source, at: fact.at };
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
  /**
   * The instance that serves this model, when the caller resolved one.
   *
   * Without it the detectors fall back to "the first instance of this type",
   * which is a guess about which server to ask. With two compatible endpoints
   * configured that guess asks the wrong one, learns nothing, and the model
   * runs on an assumed 128K for ever.
   */
  instance?: ProviderInstance,
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
        const target = instance
          ?? listInstances(settings ?? {}).find(i => i.type === 'openai-compatible');
        if (!target?.baseUrl) return undefined;
        /*
          Through the same probe the settings screen uses to test a provider.
          It already knows every shape a compatible endpoint takes — `/models`
          and `/v1/models`, six names for the context length, bounds on what is
          believable — and a second, thinner copy of that knowledge here was
          the one that failed the reported case.
        */
        const { testProvider } = await import('./providers/connection-test.js');
        const probe = await testProvider(target.type, resolveApiKey(target), target.baseUrl);
        detected = windowFromCatalogue(model, probe.contextWindows);
        break;
      }
      /*
        Anthropic publishes it, and the comment here used to say otherwise.

        `GET /v1/models` returns `max_input_tokens` per model. That was checked
        against the live endpoint rather than assumed, and it matters: it
        reports 1,000,000 for the current Claude models while the table below
        had `claude-` at 200,000. Five times too small means compaction fires at
        a fifth of the real window — the transcript gets summarised away while
        four fifths of the context sits unused.

        A hardcoded table is a snapshot of the day it was written. Where a
        vendor will tell us, ask.
      */
      case 'anthropic': {
        detected = await detectViaAnthropic(model, settings);
        break;
      }
      // Gemini reports `inputTokenLimit` on its models endpoint, in its own
      // shape rather than the OpenAI one.
      case 'gemini': {
        detected = await detectViaGemini(model, settings);
        break;
      }
      // OpenAI genuinely does not expose it: `/v1/models` returns id, object,
      // created, owned_by and a shutdown date, and nothing about length.
      // Verified against the live endpoint. The table is the only source.
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

/**
 * The window a catalogue reports for this model, matched forgivingly.
 *
 * Ids drift between what a gateway lists and what a person types: a vendor
 * prefix present on one side (`poolside/laguna-s-2.1` against `laguna-s-2.1`),
 * or a difference of case. Exact wins; otherwise case-insensitive; otherwise
 * the bare name after the last slash. A miss on the exact spelling used to be
 * the end of it.
 */
export function windowFromCatalogue(
  model: string,
  catalogue: Record<string, number> | undefined,
): number | undefined {
  if (!catalogue) return undefined;
  if (catalogue[model] !== undefined) return catalogue[model];
  const bare = (id: string): string => id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  const wanted = bare(model);
  const hit = Object.keys(catalogue).find(id => id.toLowerCase() === model.toLowerCase())
    ?? Object.keys(catalogue).find(id => bare(id) === wanted);
  return hit ? catalogue[hit] : undefined;
}

/** OpenRouter: GET /api/v1/models returns context_length per model */
async function detectViaOpenRouter(model: string): Promise<number | undefined> {
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) return undefined;
  const data = await res.json() as { data?: Array<{ id: string; context_length?: number }> };
  const catalogue: Record<string, number> = {};
  for (const m of data.data ?? []) {
    if (typeof m.context_length === 'number') catalogue[m.id] = m.context_length;
  }
  return windowFromCatalogue(model, catalogue);
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
/**
 * How wide a reported number may be before it is disbelieved.
 *
 * Bounded rather than merely finite: a server reporting 0, or a byte count
 * where tokens were meant, would otherwise be persisted as fact and drive
 * compaction from then on. Shared so every detector applies the same standard
 * to the number it found.
 */
function plausibleWindow(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1_000 && n <= 20_000_000 ? n : undefined;
}

/**
 * Anthropic: `GET /v1/models` reports `max_input_tokens` per model.
 *
 * Authoritative, and the reason this exists: the built-in table said every
 * `claude-` model held 200K, while the vendor's own endpoint says the current
 * ones hold 1M.
 *
 * `max_tokens` is also present and is deliberately not used — that is the
 * maximum *output*, and treating it as the window would shrink the budget to a
 * tenth rather than expanding it.
 */
async function detectViaAnthropic(
  model: string,
  settings?: AicoSettings,
): Promise<number | undefined> {
  const instance = listInstances(settings ?? {}).find(i => i.type === 'anthropic');
  const apiKey = (instance ? resolveApiKey(instance) : '') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;

  const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) return undefined;
  const body = await res.json() as { data?: Array<Record<string, unknown>> };
  const found = body.data?.find(m => m.id === model);
  return found ? plausibleWindow(found.max_input_tokens) : undefined;
}

/**
 * Gemini: `GET /v1beta/models` reports `inputTokenLimit`.
 *
 * Its own shape rather than the OpenAI one — the key is camelCase, ids are
 * prefixed `models/`, and the key rides in the query string because the
 * endpoint takes no bearer token.
 */
async function detectViaGemini(
  model: string,
  settings?: AicoSettings,
): Promise<number | undefined> {
  const instance = listInstances(settings ?? {}).find(i => i.type === 'gemini');
  const apiKey = (instance ? resolveApiKey(instance) : '')
    || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return undefined;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) return undefined;
  const body = await res.json() as { models?: Array<Record<string, unknown>> };
  // Gemini returns `models/gemini-2.5-pro`; callers use the bare id.
  const found = body.models?.find(m => String(m.name ?? '').replace(/^models\//, '') === model);
  return found ? plausibleWindow(found.inputTokenLimit) : undefined;
}

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
  instance?: ProviderInstance,
): Promise<number> {
  /*
    Ask again when what we hold is not good enough, rather than never.

    The old rule was "if anything is stored, stop" — which meant a figure
    written months ago outlived the model it described, and a `table` guess was
    treated as settled fact that detection would never get another chance to
    improve. `isStale` encodes when it is worth looking: a deliberate user
    setting never is; a detected value is after a week; a guess always is.
  */
  const known = resolveWindow(model, settings);
  if (!isStale(known)) return known.tokens;

  const detected = await detectContextWindow(model, provider, settings, instance);
  if (detected && detected > 0) return detected;

  /*
    Nothing answered. Hold the fallback for this process so every turn does not
    re-attempt a detection that is not going to work — but do *not* persist it.

    Writing a guess to disk is how it stops looking like a guess: the next run
    would read it back as a stored fact, and the model's real window would never
    be asked for again.
  */
  _runtimeCache.set(model, known);
  return known.tokens;
}

/**
 * Clear the runtime cache (useful for testing).
 */
/**
 * Forget what is held for one model, so detection gets another chance.
 *
 * The complement of `setContextWindow`. A user who typed a figure and later
 * learns the endpoint reports one needs a way to say "ask again", and the
 * only alternative was editing settings.json by hand.
 */
export async function clearContextWindow(model: string): Promise<void> {
  _runtimeCache.delete(model);
  const { loadSettings, saveUserSetting } = await import('./settings.js');
  const settings = await loadSettings();
  const map = { ...(settings.contextWindows ?? {}) };
  if (!(model in map)) return;
  delete map[model];
  await saveUserSetting('contextWindows', map);
}

export function resetContextWindowCache(): void {
  _runtimeCache.clear();
}
