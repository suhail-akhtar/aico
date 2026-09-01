/**
 * Provider selection logic for aico.
 *
 * Priority (highest → lowest):
 *   1. Explicit settings.provider field
 *   2. Model-name prefix detection (claude-* → Anthropic, gpt-* → OpenAI, gemini-* → Gemini)
 *   3. Available API keys in environment (OPENROUTER > ANTHROPIC > OPENAI > GEMINI)
 *   4. Ollama (local, no key required)
 *
 * DeepSeek V4 models are served by default via OpenRouter:
 *   deepseek/deepseek-chat   = DeepSeek V4 Flash (fast, cheap)
 *   deepseek/deepseek-r1     = DeepSeek R1 (reasoning / pro)
 */

import { OpenAICompatibleProvider } from './openai.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { AnthropicProvider } from './anthropic.js';
import { DeepSeekProvider } from './deepseek.js';
import {
  ANTHROPIC_DIALECT,
  DEEPSEEK_DIALECT,
  DEFAULT_DIALECT,
  GEMINI_DIALECT,
  OPENAI_DIALECT,
} from '../prompt/dialects.js';
import type { PromptDialect } from '../prompt/types.js';
import type { ProviderAPI } from './types.js';
import type { AicoSettings } from '../settings.js';
import {
  PROVIDER_TYPES, resolveApiKey, resolveBaseUrl, resolveInstance,
} from './instances.js';
import type { ProviderInstance } from './instances.js';
import { isDirectVendor, isDeepSeekPlatformModel, isOpenAIModel, isZAIModel, vendorForModel } from './model-vendor.js';
export { isDeepSeekPlatformModel, isDirectVendor, vendorForModel } from './model-vendor.js';

/**
 * Whether a model must be driven through `/v1/responses` rather than
 * `/v1/chat/completions`.
 *
 * The gpt-5.6 family rejects function tools whenever a reasoning effort is set
 * on Chat Completions, so an agent harness has to choose between tools and
 * reasoning there. Responses supports both. Verified live against
 * `gpt-5.6-luna` and `gpt-5.6-terra`.
 *
 * Kept as an explicit prefix list rather than "everything gpt-5+": the earlier
 * gpt-5.x models work fine on Chat Completions, and silently rerouting them
 * would change behaviour nobody asked to change.
 */
export function requiresResponsesApi(model: string): boolean {
  return /^gpt-5\.6(-|$)/i.test(model);
}

// ── Default models per provider ─────────────────────────────────────
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'deepseek/deepseek-v4-flash',  // DeepSeek V4 Flash (default)
  deepseek:   'deepseek-v4-flash',           // DeepSeek Platform, first-party
  anthropic:  'claude-sonnet-5',
  openai:     'gpt-4o-mini',
  gemini:     'gemini-2.0-flash',
  zai:        'glm-4.6',
  ollama:     'llama3.1',
};

// ── Provider display names ──────────────────────────────────────────
export const PROVIDER_DISPLAY: Record<string, string> = {
  openrouter: 'OpenRouter',
  deepseek:   'DeepSeek',
  anthropic:  'Anthropic',
  openai:     'OpenAI',
  gemini:     'Google Gemini',
  zai:        'Z.AI (GLM)',
  ollama:     'Ollama',
};

/**
 * Prompt dialect for a model routed through OpenRouter.
 *
 * OpenRouter is a router, not a vendor: the same endpoint fronts Claude, GPT,
 * Gemini and open models, each with its own documented prompt preferences. The
 * namespaced model id is the only signal available, and it is a reliable one —
 * `anthropic/claude-…` really is Claude, so it gets XML.
 *
 * Anything unrecognized takes the default rather than guessing, since a wrong
 * dialect is worse than a neutral one.
 */
export function dialectForRoutedModel(model: string): PromptDialect {
  if (/^anthropic\//i.test(model)) return ANTHROPIC_DIALECT;
  if (/^(openai|azure)\//i.test(model)) return OPENAI_DIALECT;
  if (/^google\//i.test(model)) return GEMINI_DIALECT;
  if (/^deepseek\//i.test(model)) return DEEPSEEK_DIALECT;
  return DEFAULT_DIALECT;
}

/**
 * Resolve the effective provider ID from settings + environment.
 * Returns the provider ID string ('openrouter', 'anthropic', etc.) or null if none found.
 */
export function detectProviderType(model: string, settings?: AicoSettings): string | null {
  const explicit = settings?.provider;

  // Model-name prefix detection takes PRIORITY over the explicit provider
  // setting. This ensures --model glm-4.6 routes to Z.AI even when the default
  // provider is OpenRouter, and --model claude-* routes to Anthropic. A model
  // prefix is an unambiguous signal that overrides the default.
  if (model.startsWith('claude-')   && apiKey('anthropic'))  return 'anthropic';
  if (isOpenAIModel(model)           && apiKey('openai'))     return 'openai';
  if (model.startsWith('gemini-')   && apiKey('gemini'))      return 'gemini';
  if (isZAIModel(model)              && apiKey('zai'))        return 'zai';
  // A bare `deepseek-*` id belongs to the DeepSeek Platform; prefer its own API
  // when the key exists. It is the model's home, and only the first-party
  // endpoint reports the cache-hit counts the OpenAI-compatible shim cannot see.
  if (isDeepSeekPlatformModel(model) && apiKey('deepseek'))    return 'deepseek';
  if (model.startsWith('deepseek/') || isDeepSeekPlatformModel(model)) {
    if (apiKey('openrouter')) return 'openrouter';
  }

  // Explicit provider that has a key → use it (when the model didn't match a
  // known prefix above)
  if (explicit === 'openrouter' && apiKey('openrouter')) return 'openrouter';
  if (explicit === 'deepseek'   && apiKey('deepseek'))   return 'deepseek';
  if (explicit === 'anthropic'  && apiKey('anthropic'))  return 'anthropic';
  if (explicit === 'openai'     && apiKey('openai'))     return 'openai';
  if (explicit === 'gemini'     && apiKey('gemini'))     return 'gemini';
  if (explicit === 'zai'        && apiKey('zai'))        return 'zai';
  if (explicit === 'ollama')                             return 'ollama';

  // Fallback by key priority. DeepSeek sits below OpenRouter deliberately:
  // OpenRouter has always been the default router here, and promoting a newly
  // added key above it would silently reroute existing users' traffic.
  if (apiKey('openrouter')) return 'openrouter';
  if (apiKey('deepseek'))   return 'deepseek';
  if (apiKey('anthropic'))  return 'anthropic';
  if (apiKey('openai'))     return 'openai';
  if (apiKey('zai'))        return 'zai';
  if (apiKey('gemini'))     return 'gemini';

  // Ollama (local, no key required) — last resort
  return 'ollama';
}

/**
 * Select and instantiate the appropriate provider for the given model.
 * Throws a descriptive error if no provider can be found.
 */
export function selectProvider(model: string, settings?: AicoSettings): ProviderAPI {
  // Explicitly configured instances take precedence over model-name sniffing.
  // Only when someone has actually configured one, though: an installation
  // driven entirely by environment variables must keep behaving exactly as it
  // did, and deriving instances for it here would change its routing silently.
  if (settings?.providerInstances?.length) {
    const instance = resolveInstance(settings, { model });
    if (instance) return providerFromInstance(instance, model, settings);
  }

  const provId = detectProviderType(model, settings);
  // Prompt caching is on by default; disabled only when explicitly opted out.
  const cacheControl = settings?.promptCaching?.enabled !== false;

  switch (provId) {
    case 'openrouter': {
      const key = apiKey('openrouter')!;
      // Live API testing confirmed:
      //  - stream_options.include_usage works for DeepSeek AND Anthropic via OR,
      //    returning cached_tokens, cache_write_tokens, and cost. The provider
      //    self-heals (retries without it) if a model ever rejects it.
      //  - Top-level cache_control triggers Anthropic ephemeral caching on OR,
      //    giving ~90% input-cost reduction on repeat turns (verified: $0.005 → $0.0005).
      //    DeepSeek caching is implicit/automatic and needs no flag.
      //  - session_id enables provider sticky routing so repeat requests hit the
      //    warm cache instead of a cold backend.
      return new OpenAICompatibleProvider({
        id: 'openrouter',
        reasoningShape: 'openrouter',
        displayName: 'OpenRouter',
        apiKey: key,
        baseURL: 'https://openrouter.ai/api/v1',
        supportsStreamUsage: true,
        cacheControl,
        sessionId: 'aico-' + (settings?.model ?? 'default'),
        // Derived from the routed model: OpenRouter fronts several vendors.
        promptDialect: dialectForRoutedModel(model),
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/suhailakhtar/aico',
          'X-Title': 'aico',
        },
      });
    }

    case 'deepseek': {
      const key = apiKey('deepseek');
      if (!key) break;
      // Context caching is automatic and needs no flag — the platform enables
      // it for every request and simply reports the hit/miss split. Thinking
      // defaults to the platform's own `high`; it is only lowered when the user
      // asks, because silently downgrading reasoning turns a reasoning model
      // into a cheaper worse one without saying so.
      return new DeepSeekProvider({
        apiKey: key,
        ...(settings?.providers?.deepseek?.baseUrl
          ? { baseURL: settings.providers.deepseek.baseUrl }
          : {}),
        ...(settings?.providers?.deepseek?.thinking
          ? { thinking: settings.providers.deepseek.thinking }
          : {}),
        ...(settings?.providers?.deepseek?.maxOutputTokens
          ? { maxOutputTokens: settings.providers.deepseek.maxOutputTokens }
          : {}),
      });
    }

    case 'anthropic': {
      const key = apiKey('anthropic');
      if (!key) break;
      return new AnthropicProvider({
        apiKey: key,
        cacheControl,
        ...(settings?.providers?.anthropic?.thinking
          ? { thinking: settings.providers.anthropic.thinking }
          : {}),
        ...(settings?.providers?.anthropic?.effort
          ? { effort: settings.providers.anthropic.effort }
          : {}),
        ...(settings?.providers?.anthropic?.maxTokens
          ? { maxTokens: settings.providers.anthropic.maxTokens }
          : {}),
      });
    }

    case 'openai': {
      const key = apiKey('openai');
      if (!key) break;
      const baseURL = settings?.providers?.openai?.baseUrl;
      // Models that refuse function tools alongside reasoning on Chat
      // Completions must go through the Responses API, or the harness has to
      // disable the reasoning it is paying for. See openai-responses.ts.
      const configuredEffort = settings?.providers?.openai?.reasoningEffort;
      if (requiresResponsesApi(model)) {
        const configured = configuredEffort;
        return new OpenAIResponsesProvider({
          id: 'openai',
          displayName: 'OpenAI',
          apiKey: key,
          ...(baseURL ? { baseURL } : {}),
          ...(configured ? { reasoningEffort: configured } : {}),
          ...(settings?.providers?.openai?.maxOutputTokens
            ? { maxOutputTokens: settings.providers.openai.maxOutputTokens }
            : {}),
        });
      }
      return new OpenAICompatibleProvider({
        id: 'openai',
        reasoningShape: 'openai',
        displayName: 'OpenAI',
        apiKey: key,
        ...(baseURL ? { baseURL } : {}),
        // Same sticky-routing intent as OpenRouter's session_id above, under
        // OpenAI's own parameter name. Keyed on the model so two concurrent
        // sessions on different models do not fight over one cache slot.
        promptCacheKey: 'aico-' + (settings?.model ?? 'default'),
        promptDialect: OPENAI_DIALECT,
        // Applied here as well as on the Responses path — a reasoning model
        // driven through Chat Completions was previously ignoring this setting.
        ...(configuredEffort ? { reasoningEffort: configuredEffort } : {}),
      });
    }

    case 'gemini': {
      const key = apiKey('gemini');
      if (!key) break;
      return new OpenAICompatibleProvider({
        id: 'gemini',
        displayName: 'Google Gemini',
        apiKey: key,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        promptDialect: GEMINI_DIALECT,
      });
    }

    case 'zai': {
      const key = apiKey('zai');
      if (!key) break;
      // Z.AI (z.ai) provides OpenAI-compatible endpoints for GLM models.
      // Two base URLs exist:
      //   - General:  https://api.z.ai/api/paas/v4   (all GLM models)
      //   - Coding:   https://api.z.ai/api/coding/paas/v4  (GLM Coding Plan)
      // Caching is implicit/automatic — no cache_control flag needed. The API
      // reports cached_tokens in usage.prompt_tokens_details on repeat turns.
      // Per the official docs (docs.z.ai/guides/capabilities/cache), the system
      // automatically caches repeated system prompts and conversation prefixes.
      const codingBase = settings?.providers?.zai?.useCodingEndpoint === true;
      const baseURL = settings?.providers?.zai?.baseUrl
        ?? (codingBase ? 'https://api.z.ai/api/coding/paas/v4' : 'https://api.z.ai/api/paas/v4');
      return new OpenAICompatibleProvider({
        id: 'zai',
        reasoningShape: 'zai',
        displayName: 'Z.AI (GLM)',
        apiKey: key,
        baseURL,
        // GLM supports stream_options.include_usage — needed to report cached_tokens.
        supportsStreamUsage: true,
        // GLM caching is automatic (no cache_control needed), but session_id
        // helps with sticky routing for cache warmth.
        sessionId: 'aico-zai-' + (settings?.model ?? 'default'),
        // Four times the shared OpenAI-compatible default, which is a floor
        // chosen for unknown endpoints and an order of magnitude below what
        // GLM can do — glm-5.3 documents a 1M context and a 128K output limit.
        // At 8192 a single file write was being cut off mid-tool-call, which
        // writes nothing and bills for the attempt; three of those in a row is
        // what a stuck-looking session turned out to be.
        maxOutputTokens: settings?.providers?.zai?.maxTokens ?? 32_768,
      });
    }

    case 'ollama': {
      const baseURL = settings?.providers?.ollama?.baseUrl ?? 'http://localhost:11434/v1';
      return new OpenAICompatibleProvider({
        id: 'ollama',
        displayName: 'Ollama',
        apiKey: 'ollama',
        baseURL,
      });
    }
  }

  // Nothing matched → helpful error
  throw new Error(
    'No AI provider is configured. Set one of these environment variables:\n\n' +
    '  OPENROUTER_API_KEY   — routes any model (default: DeepSeek V4)\n' +
    '  DEEPSEEK_API_KEY     — DeepSeek Platform (deepseek-v4-flash, deepseek-v4-pro)\n' +
    '  ANTHROPIC_API_KEY    — Claude models\n' +
    '  OPENAI_API_KEY       — GPT / O-series models\n' +
    '  GEMINI_API_KEY       — Google Gemini models\n' +
    '  ZAI_API_KEY          — Z.AI GLM models (glm-4.6, glm-5, glm-5.2)\n\n' +
    'Or add "provider": "ollama" to ~/.aico/settings.json for local Ollama.\n' +
    'Run /doctor inside aico for a full environment check.',
  );
}

/**
 * Build the adapter one configured instance describes.
 *
 * The instance supplies identity (id, display name), credential and endpoint;
 * the family supplies behaviour. Vendor-specific tuning still comes from the
 * legacy `providers.<family>` block, because those knobs — Anthropic's thinking
 * mode, OpenAI's reasoning effort — are properties of the *family*, and every
 * instance of that family wants the same answer.
 *
 * `openai-compatible` is the interesting case: it deliberately enables nothing
 * beyond plain chat completions. A gateway that happens to support cache
 * breakpoints or usage-in-stream will not be harmed by our not using them,
 * whereas assuming either and being wrong produces a 400 on every request.
 */
export function providerFromInstance(
  instance: ProviderInstance,
  model: string,
  settings: AicoSettings,
): ProviderAPI {
  const apiKey = resolveApiKey(instance);
  const baseURL = resolveBaseUrl(instance);
  const cacheControl = settings.promptCaching?.enabled !== false;
  const info = PROVIDER_TYPES[instance.type];

  if (info.requiresKey && !apiKey) {
    throw new Error(
      `The provider "${instance.name}" has no API key. Add one in Settings, ` +
      (info.envVar ? `or set ${info.envVar} in the environment.` : 'or remove it.'),
    );
  }

  const family = settings.providers as Record<string, Record<string, unknown>> | undefined;
  const tuning = family?.[instance.type] ?? {};
  const pick = <T,>(key: string): T | undefined => tuning[key] as T | undefined;

  switch (instance.type) {
    case 'anthropic': {
      const thinking = pick<'adaptive' | 'off'>('thinking');
      const effort = pick<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('effort');
      const maxTokens = pick<number>('maxTokens');
      return new AnthropicProvider({
        apiKey,
        cacheControl,
        ...(instance.baseUrl ? { baseURL } : {}),
        ...(thinking ? { thinking } : {}),
        ...(effort ? { effort } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      });
    }

    case 'deepseek': {
      const thinking = pick<'low' | 'high' | 'max' | 'off'>('thinking');
      const maxOutputTokens = pick<number>('maxOutputTokens');
      return new DeepSeekProvider({
        apiKey,
        baseURL,
        ...(thinking ? { thinking } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      });
    }

    case 'openai': {
      const reasoningEffort = pick<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('reasoningEffort');
      // Models that refuse function tools alongside reasoning on Chat
      // Completions must go through the Responses API, or the harness has to
      // disable the reasoning it is paying for.
      if (requiresResponsesApi(model)) {
        const maxOutputTokens = pick<number>('maxOutputTokens');
        return new OpenAIResponsesProvider({
          id: instance.id,
          displayName: instance.name,
          apiKey,
          baseURL,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        });
      }
      return new OpenAICompatibleProvider({
        id: instance.id,
        reasoningShape: 'openai',
        displayName: instance.name,
        apiKey,
        baseURL,
        promptCacheKey: `aico-${instance.id}`,
        promptDialect: OPENAI_DIALECT,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    }

    case 'gemini':
      return new OpenAICompatibleProvider({
        id: instance.id,
        displayName: instance.name,
        apiKey,
        // Gemini's OpenAI-compatible surface lives under /openai; the bare
        // v1beta root is the native API and answers 404 to these requests.
        baseURL: instance.baseUrl ? baseURL : 'https://generativelanguage.googleapis.com/v1beta/openai',
        /*
          No `reasoningShape`, and that is a decision rather than an omission.

          Gemini's reasoning control is `thinking_level` on the *native* API.
          What its OpenAI-compatible surface accepts — whether it maps
          `reasoning_effort`, ignores it, or 400s — has not been read from
          Google's documentation, and a guess here fails every request rather
          than degrading. Reasoning stays unsent until somebody checks.

          The table in `shared/reasoning` still describes Gemini's levels, so
          the picker can show what the model is capable of; this is only about
          what we are willing to put on the wire.
        */
        promptDialect: GEMINI_DIALECT,
      });

    case 'openrouter':
      return new OpenAICompatibleProvider({
        id: instance.id,
        reasoningShape: 'openrouter',
        displayName: instance.name,
        apiKey,
        baseURL,
        supportsStreamUsage: true,
        cacheControl,
        sessionId: `aico-${instance.id}`,
        promptDialect: dialectForRoutedModel(model),
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/suhailakhtar/aico',
          'X-Title': 'aico',
        },
      });

    case 'zai':
      return new OpenAICompatibleProvider({
        id: instance.id,
        reasoningShape: 'zai',
        displayName: instance.name,
        apiKey,
        baseURL,
        supportsStreamUsage: true,
        sessionId: `aico-${instance.id}`,
      });

    case 'ollama':
      return new OpenAICompatibleProvider({
        id: instance.id,
        displayName: instance.name,
        // Ollama ignores the value but the OpenAI client insists on one.
        apiKey: apiKey || 'ollama',
        baseURL: baseURL.replace(/\/v1\/?$/, '') + '/v1',
      });

    case 'openai-compatible':
      // Deliberately plain: a gateway that supports cache breakpoints or
      // usage-in-stream is not harmed by our not using them, whereas assuming
      // either and being wrong produces a 400 on every single request.
      return new OpenAICompatibleProvider({
        id: instance.id,
        displayName: instance.name,
        apiKey,
        baseURL,
      });
  }
}

/**
 * Human-readable label for the current provider + model.
 * Safe to call even when no provider is configured (returns empty string).
 */
export function providerLabel(model: string, settings?: AicoSettings): string {
  try {
    const id = detectProviderType(model, settings) ?? '';
    const display = PROVIDER_DISPLAY[id] ?? id;
    // Shorten the model name for display
    const shortModel = model
      .replace('claude-', '')
      .replace('gpt-', 'gpt/')
      .replace('deepseek/', 'ds/')
      .replace('-latest', '');
    return `${display} · ${shortModel}`;
  } catch {
    return '';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function apiKey(provider: string): string | undefined {
  switch (provider) {
    case 'openrouter': return process.env.OPENROUTER_API_KEY;
    case 'deepseek':   return process.env.DEEPSEEK_API_KEY;
    case 'anthropic':  return process.env.ANTHROPIC_API_KEY;
    case 'openai':     return process.env.OPENAI_API_KEY;
    case 'gemini':     return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    case 'zai':        return process.env.ZAI_API_KEY;
  }
}


