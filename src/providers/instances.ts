/**
 * Provider *instances* — the configuration model behind the settings screen.
 *
 * The old shape keyed configuration by vendor: one `anthropic`, one `openai`,
 * one `openrouter`. That made three things impossible, all of which people
 * actually want:
 *
 *   - **Two of the same vendor.** A work OpenAI key and a personal one; a
 *     staging gateway and production.
 *   - **A vendor we have never heard of.** Anything speaking the OpenAI wire
 *     protocol — vLLM, LM Studio, Together, a corporate proxy — had no way in,
 *     because the key of the map *was* the adapter.
 *   - **Naming.** "openai" is the adapter family. "Work account (gpt-5.6)" is
 *     what the person setting it up actually calls it.
 *
 * So an instance is now a record with its own id, and the vendor is a *field*
 * on it (`type`) rather than its address. `type` picks the adapter and the
 * defaults; everything else is the user's to set, including the endpoint.
 *
 * The legacy shape is still read. Migration is derivation, not a rewrite:
 * {@link listInstances} projects old settings and environment keys into
 * instances on every call, so an installation that never opens the settings
 * screen keeps working and nothing has to be migrated on disk before it does.
 *
 * @module providers/instances
 */

import type { AicoSettings } from '../settings.js';

/** Adapter families an instance can speak. */
export type ProviderType =
  | 'openrouter'
  | 'deepseek'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'zai'
  | 'ollama'
  | 'openai-compatible';

export interface ProviderInstance {
  /** Stable identifier. Also the routing key a session records. */
  id: string;
  /** Which adapter drives this instance. */
  type: ProviderType;
  /** What the user calls it. Free text; defaults to the family's name. */
  name: string;
  /**
   * Never leaves the server. Present on the in-process value so the adapter
   * can be constructed; stripped by every route that serializes an instance.
   */
  apiKey?: string;
  /** API root. Defaults to the family's endpoint when omitted. */
  baseUrl?: string;
  /** Models offered by this instance, as shown in the model picker. */
  models?: string[];
  /** Which of `models` is used when a turn does not name one. */
  defaultModel?: string;
  /** Off means "keep the configuration but do not offer it". */
  enabled?: boolean;
  /**
   * Where the key came from, for display. Never a value — only a provenance,
   * so the settings screen can distinguish "saved here" from "inherited from
   * the environment" without the secret crossing the wire.
   */
  keySource?: 'settings' | 'environment' | 'none' | 'not-required';
  /** True when this instance was derived from legacy settings or the env. */
  derived?: boolean;
}

/** What a family is called, where it lives, and how it authenticates. */
export interface ProviderTypeInfo {
  type: ProviderType;
  label: string;
  /** API root used when an instance does not override it. */
  defaultBaseUrl: string;
  /** Model assumed when the instance names none. */
  defaultModel: string;
  /** Environment variable consulted when no key is stored. */
  envVar?: string;
  /** Whether a key is required at all. */
  requiresKey: boolean;
  /** One line for the settings screen, explaining when to pick this. */
  hint: string;
}

export const PROVIDER_TYPES: Record<ProviderType, ProviderTypeInfo> = {
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    envVar: 'OPENROUTER_API_KEY',
    requiresKey: true,
    hint: 'One key, most vendors. Models are named vendor/model.',
  },
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    envVar: 'DEEPSEEK_API_KEY',
    requiresKey: true,
    hint: 'DeepSeek first-party. Context caching is automatic.',
  },
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    envVar: 'ANTHROPIC_API_KEY',
    requiresKey: true,
    hint: 'Claude models, with prompt-cache breakpoints and adaptive thinking.',
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    envVar: 'OPENAI_API_KEY',
    requiresKey: true,
    hint: 'OpenAI first-party, including the Responses API for reasoning models.',
  },
  gemini: {
    type: 'gemini',
    label: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    envVar: 'GEMINI_API_KEY',
    requiresKey: true,
    hint: 'Google AI Studio endpoint.',
  },
  zai: {
    type: 'zai',
    label: 'Z.AI (GLM)',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    envVar: 'ZAI_API_KEY',
    requiresKey: true,
    hint: 'GLM models.',
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1',
    requiresKey: false,
    hint: 'Models running on this machine. No key needed.',
  },
  'openai-compatible': {
    type: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: '',
    defaultModel: '',
    requiresKey: true,
    hint: 'Anything speaking the OpenAI wire protocol — vLLM, LM Studio, Together, a gateway, a provider newer than this list. Set the endpoint yourself.',
  },
};

export const PROVIDER_TYPE_IDS = Object.keys(PROVIDER_TYPES) as ProviderType[];

/** The endpoint an instance actually talks to. */
export function resolveBaseUrl(instance: ProviderInstance): string {
  return instance.baseUrl?.trim() || PROVIDER_TYPES[instance.type].defaultBaseUrl;
}

/**
 * The key an instance actually authenticates with.
 *
 * Stored key wins over the environment, because someone who typed a key into
 * the settings screen means it — silently preferring a stale shell variable
 * makes the screen a liar.
 */
export function resolveApiKey(instance: ProviderInstance): string {
  if (instance.apiKey?.trim()) return instance.apiKey.trim();
  const envVar = PROVIDER_TYPES[instance.type].envVar;
  return envVar ? (process.env[envVar] ?? '') : '';
}

export function keySourceOf(instance: ProviderInstance): NonNullable<ProviderInstance['keySource']> {
  if (!PROVIDER_TYPES[instance.type].requiresKey) return 'not-required';
  if (instance.apiKey?.trim()) return 'settings';
  const envVar = PROVIDER_TYPES[instance.type].envVar;
  if (envVar && process.env[envVar]) return 'environment';
  return 'none';
}

/** Usable means "enabled and has whatever credential it needs". */
export function isUsable(instance: ProviderInstance): boolean {
  if (instance.enabled === false) return false;
  return keySourceOf(instance) !== 'none';
}

/**
 * Every configured instance, newest configuration model first.
 *
 * Explicit instances are returned as stored. Anything the old shape or the
 * environment describes that has no explicit instance is appended as a derived
 * one, so an installation that has only ever set `ANTHROPIC_API_KEY` still sees
 * an Anthropic entry it can use and then edit.
 */
export function listInstances(settings: AicoSettings): ProviderInstance[] {
  const explicit = (settings.providerInstances ?? []).map(normalize);
  const claimed = new Set(explicit.map(i => i.id));
  const derived: ProviderInstance[] = [];

  const legacy = settings.providers as Record<string, LegacyProviderConfig> | undefined;

  for (const type of PROVIDER_TYPE_IDS) {
    // The catch-all family describes no particular endpoint, so there is
    // nothing to derive — it only ever exists because someone created one.
    if (type === 'openai-compatible') continue;
    if (claimed.has(type)) continue;

    const config = legacy?.[type];
    const info = PROVIDER_TYPES[type];
    const hasLegacyKey = Boolean(config?.apiKey);
    const hasEnvKey = Boolean(info.envVar && process.env[info.envVar]);
    // Ollama is local and keyless: it is offered when nothing objects, so a
    // user who has it running finds it already listed.
    if (!hasLegacyKey && !hasEnvKey && info.requiresKey) continue;

    derived.push(normalize({
      id: type,
      type,
      name: info.label,
      ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config?.defaultModel ? { defaultModel: config.defaultModel } : {}),
      derived: true,
    }));
  }

  // Ollama has no key to detect, so it is listed last as an always-available
  // option rather than suppressed for lacking a credential it never needs.
  if (!claimed.has('ollama') && !derived.some(i => i.id === 'ollama')) {
    derived.push(normalize({
      id: 'ollama', type: 'ollama', name: PROVIDER_TYPES.ollama.label, derived: true,
    }));
  }

  return [...explicit, ...derived];
}

interface LegacyProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

/** Fill in what the family knows so callers never handle a half-built record. */
export function normalize(instance: ProviderInstance): ProviderInstance {
  const info = PROVIDER_TYPES[instance.type] ?? PROVIDER_TYPES['openai-compatible'];
  const normalized: ProviderInstance = {
    ...instance,
    type: info.type,
    name: instance.name?.trim() || info.label,
    defaultModel: instance.defaultModel?.trim() || instance.models?.[0] || info.defaultModel,
  };
  normalized.keySource = keySourceOf(normalized);
  return normalized;
}

/** Find one instance by id. */
export function findInstance(settings: AicoSettings, id: string): ProviderInstance | undefined {
  return listInstances(settings).find(instance => instance.id === id);
}

/**
 * The instance a turn should run on.
 *
 * Order matters and each step is a deliberate answer to "what did the user most
 * recently say": an explicitly named instance, then the configured active one,
 * then whichever usable instance claims the model, then the first usable one.
 */
export function resolveInstance(
  settings: AicoSettings,
  opts: { instanceId?: string; model?: string } = {},
): ProviderInstance | undefined {
  const instances = listInstances(settings).filter(isUsable);
  if (instances.length === 0) return undefined;

  if (opts.instanceId) {
    const named = instances.find(i => i.id === opts.instanceId);
    if (named) return named;
  }

  const active = settings.activeProvider ?? settings.provider;
  if (active) {
    const configured = instances.find(i => i.id === active)
      // A legacy `provider: 'openai'` names a family, not an instance.
      ?? instances.find(i => i.type === active);
    if (configured) return configured;
  }

  if (opts.model) {
    const owning = instances.find(i => i.models?.includes(opts.model!));
    if (owning) return owning;
  }

  return instances[0];
}

/** Strip the secret. Every route that returns an instance goes through this. */
export function redactInstance(instance: ProviderInstance): ProviderInstance {
  const { apiKey, ...rest } = instance;
  void apiKey;
  return { ...rest, keySource: keySourceOf(instance) };
}

/**
 * Validate a submitted instance, returning the problems rather than throwing.
 *
 * Reported as a list so a form can mark every bad field at once instead of
 * revealing them one failed save at a time.
 */
export function validateInstance(
  instance: Partial<ProviderInstance>,
  existing: ProviderInstance[],
  { isNew }: { isNew: boolean },
): string[] {
  const problems: string[] = [];
  const id = instance.id?.trim() ?? '';

  if (!id) problems.push('An id is required');
  else if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    problems.push('The id may contain only letters, numbers, hyphens and underscores');
  } else if (isNew && existing.some(e => e.id === id)) {
    problems.push(`A provider with the id "${id}" already exists`);
  }

  if (!instance.type || !(instance.type in PROVIDER_TYPES)) {
    problems.push('Choose a provider type');
  } else if (instance.type === 'openai-compatible' && !instance.baseUrl?.trim()) {
    // The catch-all family has no endpoint to fall back to, so requiring it
    // here names the field while the user is still looking at the form.
    problems.push('An OpenAI-compatible provider needs an endpoint');
  }

  if (instance.baseUrl?.trim()) {
    try {
      const url = new URL(instance.baseUrl.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push('The endpoint must be an http or https URL');
      }
    } catch {
      problems.push('The endpoint is not a valid URL');
    }
  }

  return problems;
}
