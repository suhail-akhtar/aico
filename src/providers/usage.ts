/**
 * Vendor-neutral token accounting.
 *
 * Providers disagree about what their "input tokens" number counts, and the
 * disagreement is silent — both conventions yield a plausible integer, so the
 * only symptom is a cost estimate that is quietly wrong.
 *
 *   **Inclusive** — OpenAI (Chat Completions and Responses), OpenRouter,
 *   Gemini and Z.AI via the OpenAI-compatible shim. `prompt_tokens` /
 *   `input_tokens` is the TOTAL prompt size, and the cached count reported in
 *   `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`
 *   is a SUBSET already inside it.
 *
 *   **Exclusive** — Anthropic. `input_tokens` counts only the tokens after the
 *   last cache breakpoint. Cache reads and writes are reported separately and
 *   are *not* part of it, so the real prompt size is
 *   `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 *
 * Applying one arithmetic to both conventions is what produced AICO's original
 * bug: `inputTokens - cachedTokens` is right for OpenAI and wrong for
 * Anthropic, where the cached tokens were never in `inputTokens` to begin with.
 * On a warm Anthropic cache that subtraction clamps to zero, so a request whose
 * true prompt was 20,500 tokens displayed as 500 and was costed as if the
 * cached 20,000 were free rather than billed at the cache-read rate.
 *
 * Every provider funnels its raw numbers through {@link normalizeUsage} so a
 * `usage` ChatEvent means exactly one thing no matter who produced it:
 * `inputTokens` is the total, and the two cache counts are subsets of it.
 *
 * @module providers/usage
 */

/** How a vendor counts the input-token number it reports. */
export type TokenCountConvention = 'inclusive' | 'exclusive';

/** Raw, still-vendor-shaped usage numbers handed in by a provider. */
export interface RawUsage {
  /** The vendor's own input/prompt token count, whatever it means to them. */
  reportedInput: number;
  outputTokens: number;
  /** Tokens served from a warm prompt cache, if the vendor reports them. */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache, if the vendor reports them. */
  cacheWriteTokens?: number;
  convention: TokenCountConvention;
}

/** Usage in AICO's single convention: `inputTokens` is the total. */
export interface NormalizedUsage {
  /** TOTAL prompt tokens, inclusive of both cache counts below. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Project a vendor's usage report onto the inclusive convention.
 *
 * For `exclusive` vendors the cache counts are added to reach the true total.
 * For `inclusive` vendors the reported number should already cover them, but
 * the larger of the two is taken rather than trusting the label: a vendor that
 * changes convention, or an OpenAI-compatible gateway that reports cache
 * counts its upstream computed differently, then under-reports nothing. The
 * failure mode of the max() is at worst a total that is correct anyway; the
 * failure mode of trusting a stale label is silently free tokens.
 */
export function normalizeUsage(raw: RawUsage): NormalizedUsage {
  const cacheReadTokens = nonNegative(raw.cacheReadTokens);
  const cacheWriteTokens = nonNegative(raw.cacheWriteTokens);
  const reported = nonNegative(raw.reportedInput);
  const cached = cacheReadTokens + cacheWriteTokens;

  const inputTokens = raw.convention === 'exclusive'
    ? reported + cached
    : Math.max(reported, cached);

  return {
    inputTokens,
    outputTokens: nonNegative(raw.outputTokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * Billing multipliers relative to a model's base input rate.
 *
 * Anthropic publishes 1.25x for a cache write at the default 5-minute TTL
 * (2x at one hour, which AICO does not request) and 0.1x for a read. OpenAI
 * discounts reads and charges no write premium, which the zero
 * `cacheWriteTokens` those providers report handles on its own — so one set of
 * constants covers both vendors without a per-provider pricing table.
 */
export const CACHE_READ_RATE_MULTIPLIER = 0.1;
export const CACHE_WRITE_RATE_MULTIPLIER = 1.25;

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}
