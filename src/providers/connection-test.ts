/**
 * Provider connection testing — "does this key actually work?"
 *
 * Onboarding a provider fails in two very different ways, and a settings screen
 * that cannot tell them apart is worse than none: a *typo in the key* and a
 * *provider that is up but has no models for you* both look like "it didn't
 * work". So this returns the HTTP status and the provider's own error text
 * rather than a boolean, and treats "authenticated but empty catalogue" as
 * success.
 *
 * Each vendor authenticates differently and lists models at a different path.
 * There is no OpenAI-compatible shape that covers Anthropic (`x-api-key` plus a
 * dated version header), Gemini (key in the query string), or Ollama (no auth
 * at all and a `/api/tags` catalogue). Pretending otherwise is what makes a
 * "test connection" button report failures that are really our own request.
 *
 * @module providers/connection-test
 */

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
  /**
   * Context windows the endpoint volunteered, by model id.
   *
   * Only the models that said. Most catalogues list an id and nothing else, so
   * this is usually sparse or absent — which is the honest shape for it.
   */
  contextWindows?: Record<string, number>;
  /** How long the round trip took — surfaced so a slow endpoint is visible. */
  latencyMs?: number;
}

/** Where each provider lists its models, and how it wants to be addressed. */
const PROBES: Record<string, { url: string; auth: 'bearer' | 'x-api-key' | 'query' | 'none' }> = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', auth: 'bearer' },
  deepseek:   { url: 'https://api.deepseek.com/models', auth: 'bearer' },
  openai:     { url: 'https://api.openai.com/v1/models', auth: 'bearer' },
  anthropic:  { url: 'https://api.anthropic.com/v1/models', auth: 'x-api-key' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'query' },
  zai:        { url: 'https://api.z.ai/api/paas/v4/models', auth: 'bearer' },
  ollama:     { url: 'http://localhost:11434/api/tags', auth: 'none' },
  // No endpoint of its own: the instance must supply one, which the caller
  // passes as `baseUrl`. Listed so the family is recognised rather than
  // falling through to "unknown provider".
  'openai-compatible': { url: '', auth: 'bearer' },
};

const TIMEOUT_MS = 15_000;

/**
 * Probe a provider with the key the user just typed.
 *
 * `baseUrl` overrides the built-in endpoint for self-hosted or proxied setups;
 * it is treated as an API root, so `/models` is appended the way the
 * OpenAI-compatible convention expects.
 */
export async function testProvider(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<ProviderTestResult> {
  const probe = PROBES[providerId];
  if (!probe && !baseUrl) {
    return { ok: false, error: `Unknown provider "${providerId}" and no base URL given` };
  }

  const auth = probe?.auth ?? 'bearer';
  if (auth !== 'none' && !apiKey) {
    return { ok: false, error: 'An API key is required for this provider' };
  }

  const root = baseUrl?.trim() || probe?.url;
  if (!root) {
    return { ok: false, error: 'This provider needs an endpoint before it can be tested' };
  }
  // A supplied base URL is an API root, so `/models` is appended the way the
  // OpenAI-compatible convention expects. A built-in probe URL is already complete.
  let url = baseUrl?.trim() ? `${baseUrl.trim().replace(/\/+$/, '')}/models` : root;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (auth === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    // Anthropic requires a version header; without it the request 400s in a way
    // that reads as a bad key.
    headers['anthropic-version'] = '2023-06-01';
  }
  if (auth === 'query') url += `?key=${encodeURIComponent(apiKey)}`;

  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, latencyMs, error: describeFailure(res.status, body) };
    }

    const catalogue = extractCatalogue(await res.json());
    const contextWindows: Record<string, number> = {};
    for (const entry of catalogue) {
      if (entry.contextWindow !== undefined) contextWindows[entry.id] = entry.contextWindow;
    }
    return {
      ok: true,
      latencyMs,
      models: catalogue.map(entry => entry.id),
      ...Object.keys(contextWindows).length > 0 ? { contextWindows } : {},
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    if (providerId === 'ollama' && /fetch failed|ECONNREFUSED/i.test(message)) {
      return { ok: false, latencyMs, error: 'No Ollama server answered on localhost:11434 — is it running?' };
    }
    return { ok: false, latencyMs, error: message };
  }
}

/**
 * Turn a status code into something a user can act on.
 *
 * The provider's own message is kept, because it is often the specific thing
 * that is wrong ("insufficient credits", "model not available in your region"),
 * but it is prefixed with what the status means so a 401 is never mistaken for
 * an outage.
 */
function describeFailure(status: number, body: string): string {
  const detail = body.trim().slice(0, 240);
  const label =
    status === 401 || status === 403 ? 'Key rejected'
    : status === 404 ? 'Endpoint not found — check the base URL'
    : status === 429 ? 'Rate limited — the key works but is throttled'
    : status >= 500 ? 'The provider is failing'
    : `HTTP ${status}`;
  return detail ? `${label} (${status}): ${detail}` : `${label} (${status})`;
}

/** One entry in a provider catalogue, reduced to what AICO can use. */
interface CatalogueEntry {
  id: string;
  /** Context length, when the endpoint says. Most do not. */
  contextWindow?: number;
}

/**
 * The names each catalogue shape uses for "how much context does this take".
 *
 * There is no standard. OpenRouter says `context_length`, vLLM and most
 * self-hosted OpenAI-compatible servers say `max_model_len`, some gateways say
 * `context_window`, Ollama nests it under model info. Reading all of them costs
 * nothing and is the difference between knowing a model's real window and
 * falling back to a 128K guess that is wrong in both directions — compacting a
 * 1M-context model eight times too early, or overrunning an 8K one entirely.
 */
const CONTEXT_KEYS = [
  'context_length', 'max_model_len', 'context_window',
  'max_context_length', 'max_input_tokens', 'context_size',
] as const;

function readContextWindow(model: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_KEYS) {
    const value = Number(model[key]);
    // Bounded rather than merely finite: a gateway reporting 0, or a byte
    // count where tokens were meant, would otherwise be persisted as fact and
    // drive compaction from then on.
    if (Number.isInteger(value) && value >= 1_000 && value <= 20_000_000) return value;
  }
  return undefined;
}

/** Every catalogue shape we have seen, reduced to ids and what else was said. */
function extractCatalogue(data: unknown): CatalogueEntry[] {
  const d = data as {
    data?: Array<Record<string, unknown>>;
    models?: Array<Record<string, unknown>>;
    // Ollama
    tags?: Array<Record<string, unknown>>;
  };
  const raw = d?.data ?? d?.models ?? d?.tags ?? [];
  return raw
    .map((model) => {
      const id = String(model.id ?? model.name ?? '')
        // Gemini returns "models/gemini-2.0-flash"; the bare id is what callers use.
        .replace(/^models\//, '');
      const contextWindow = readContextWindow(model);
      return { id, ...contextWindow === undefined ? {} : { contextWindow } };
    })
    .filter(entry => entry.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Probe one configured instance.
 *
 * The instance already knows its endpoint and credential, so this is the form
 * every caller that has an instance should use — passing the family id instead
 * would test the family's default endpoint rather than the one the user set.
 */
export async function testInstance(instance: {
  type: string; apiKey?: string; baseUrl?: string;
}): Promise<ProviderTestResult> {
  return testProvider(instance.type, instance.apiKey ?? '', instance.baseUrl);
}

/**
 * Back-compat shim for the OpenAI-compatible path.
 *
 * @deprecated Prefer {@link testProvider}, which knows how each vendor
 * authenticates instead of assuming a bearer token.
 */
export async function testProviderConnection(
  apiKey: string,
  baseUrl: string,
): Promise<ProviderTestResult> {
  if (!apiKey || !baseUrl) return { ok: false, error: 'API key and base URL are required' };
  return testProvider('openai', apiKey, baseUrl);
}
