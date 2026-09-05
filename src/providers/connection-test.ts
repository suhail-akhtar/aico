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
  /**
   * The API root that actually answered, when it is not the one that was typed.
   *
   * A test that goes green against a URL the caller then throws away is worse
   * than a red one: every later request would go to the path that did not work.
   * So the root is reported and the caller saves *this* rather than the input.
   */
  baseUrl?: string;
}

/** Where each provider lists its models, and how it wants to be addressed. */
const PROBES: Record<string, { url: string; auth: 'bearer' | 'x-api-key' | 'query' | 'none' }> = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', auth: 'bearer' },
  deepseek:   { url: 'https://api.deepseek.com/models', auth: 'bearer' },
  // Reports `context_length`, `supports_image_in` and `supports_reasoning`
  // per model — one of the few catalogues that says what it serves.
  kimi:       { url: 'https://api.moonshot.ai/v1/models', auth: 'bearer' },
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
 * Where to look for a catalogue under a supplied base URL, likeliest first.
 *
 * "Base URL" is documented two incompatible ways and users paste both. OpenAI,
 * DeepSeek and most single-vendor endpoints publish a base that *already ends
 * in the version segment* — `https://api.deepseek.com/v1` — so `/models` is
 * simply appended. Self-hosted gateways publish the bare host as the base and
 * document the route as `/v1/models`, so appending `/models` asks for a path
 * that does not exist on them.
 *
 * That second case used to fail in the least helpful way available. A gateway
 * serving a console SPA answers an unknown path with its `index.html` and a
 * **200**, so the probe parsed HTML as JSON and the user got
 * `Unexpected token '<'` — a message about our parser, describing nothing they
 * could act on, for a provider whose only real problem was a missing `/v1`.
 *
 * So both are tried, and the root that answered comes back with the result.
 */
function probeCandidates(base: string): Array<{ url: string; root: string }> {
  // A pasted *endpoint* URL carries the same information as its parent root,
  // and pasting the full URL from a docs page is at least as common as pasting
  // the base. Normalising here means it is also what gets saved.
  const root = base.replace(/\/+$/, '').replace(/\/models$/, '');
  const candidates = [{ url: `${root}/models`, root }];
  if (!/\/v\d+[a-z0-9]*$/i.test(root)) {
    candidates.push({ url: `${root}/v1/models`, root: `${root}/v1` });
  }
  return candidates;
}

/**
 * How much a failed attempt is worth saying out loud.
 *
 * With more than one candidate, the failures have to be ranked or the wrong one
 * gets reported: a gateway that serves its console at `/models` and a real 401
 * at `/v1/models` should say "key rejected", not "there is no API here". So
 * anything that proves something is *listening and speaking API* outranks
 * "nothing at that path", and the first attempt only wins ties.
 */
const SPOKE_API = 2;
const NOTHING_HERE = 1;

/**
 * Probe a provider with the key the user just typed.
 *
 * `baseUrl` overrides the built-in endpoint for self-hosted or proxied setups.
 * A built-in probe URL is already complete; a supplied one is resolved against
 * {@link probeCandidates}.
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

  const supplied = baseUrl?.trim();
  if (!supplied && !probe?.url) {
    return { ok: false, error: 'This provider needs an endpoint before it can be tested' };
  }
  const candidates = supplied
    ? probeCandidates(supplied)
    : [{ url: probe!.url, root: '' }];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (auth === 'x-api-key') {
    headers['x-api-key'] = apiKey;
    // Anthropic requires a version header; without it the request 400s in a way
    // that reads as a bad key.
    headers['anthropic-version'] = '2023-06-01';
  }

  let best: { rank: number; result: ProviderTestResult } | undefined;
  for (const candidate of candidates) {
    const url = auth === 'query'
      ? `${candidate.url}?key=${encodeURIComponent(apiKey)}`
      : candidate.url;
    const attempt = await probeOnce(url, headers, providerId);
    if (attempt.result.ok) {
      // Only worth reporting when it is not what was asked for — an unchanged
      // root would just be the caller's own input handed back.
      const moved = candidate.root && candidate.root !== supplied?.replace(/\/+$/, '');
      return moved ? { ...attempt.result, baseUrl: candidate.root } : attempt.result;
    }
    if (!best || attempt.rank > best.rank) best = attempt;
    // A host that cannot be reached at all will not be reached under a
    // different path either — and each candidate costs a full timeout.
    if (attempt.fatal) break;
  }
  return best!.result;
}

/** One request, classified by whether anything at that path spoke API. */
async function probeOnce(
  url: string,
  headers: Record<string, string>,
  providerId: string,
): Promise<{ rank: number; fatal?: boolean; result: ProviderTestResult }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    const body = await res.text().catch(() => '');

    if (!res.ok) {
      return {
        // A 404 says "not at this path", which the next candidate may fix. Every
        // other status is about the endpoint itself and is the real answer.
        rank: res.status === 404 ? NOTHING_HERE : SPOKE_API,
        result: { ok: false, latencyMs, error: describeFailure(res.status, body) },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        rank: NOTHING_HERE,
        result: {
          ok: false, latencyMs,
          error: 'That address returned a web page, not an API response — the endpoint is '
               + 'probably missing its version segment (try adding /v1).',
        },
      };
    }

    if (!hasCatalogueEnvelope(parsed)) {
      return {
        rank: NOTHING_HERE,
        result: {
          ok: false, latencyMs,
          error: 'The endpoint answered, but with no model list in it — check the base URL.',
        },
      };
    }

    const catalogue = extractCatalogue(parsed);
    const contextWindows: Record<string, number> = {};
    for (const entry of catalogue) {
      if (entry.contextWindow !== undefined) contextWindows[entry.id] = entry.contextWindow;
    }
    return {
      rank: SPOKE_API,
      result: {
        ok: true,
        latencyMs,
        models: catalogue.map(entry => entry.id),
        ...Object.keys(contextWindows).length > 0 ? { contextWindows } : {},
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    // A transport failure is about the host, not the path, so trying another
    // path under the same host cannot improve on it.
    if (providerId === 'ollama' && /fetch failed|ECONNREFUSED/i.test(message)) {
      return {
        rank: SPOKE_API, fatal: true,
        result: { ok: false, latencyMs, error: 'No Ollama server answered on localhost:11434 — is it running?' },
      };
    }
    return { rank: SPOKE_API, fatal: true, result: { ok: false, latencyMs, error: message } };
  }
}

/**
 * Does this JSON look like a catalogue at all?
 *
 * An empty catalogue is a success — "authenticated, but no models for you" is a
 * real and reportable state. A body with no list *anywhere* in it is not: it is
 * some other endpoint answering, and saying so lets the next candidate run
 * instead of accepting zero models as the truth about the provider.
 */
function hasCatalogueEnvelope(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.data) || Array.isArray(d.models) || Array.isArray(d.tags);
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
