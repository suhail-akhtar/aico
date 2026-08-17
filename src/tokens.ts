import { CACHE_READ_RATE_MULTIPLIER, CACHE_WRITE_RATE_MULTIPLIER } from './providers/usage.js';

export interface TokenUsage {
  /** TOTAL prompt tokens, inclusive of `cachedTokens` and `cacheWriteTokens`. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` served from a warm prompt cache (billed ~0.1x). */
  cachedTokens: number;
  /** Subset of `inputTokens` written to the prompt cache (billed 1.25x on Anthropic). */
  cacheWriteTokens: number;
  sessions: number;
}

interface CostRate {
  input: number;  // per 1M tokens (uncached / cache-miss rate)
  output: number; // per 1M tokens
  /**
   * Cache-read price as a fraction of `input`. Defaults to the vendor-neutral
   * {@link CACHE_READ_RATE_MULTIPLIER} (0.1), which is Anthropic's and roughly
   * OpenAI's discount. DeepSeek's is far steeper — $0.0028 read against $0.14
   * miss on v4-flash, a factor of 0.02 — so assuming 0.1 for it would
   * overstate the bill by 5x on a well-cached session.
   */
  cacheRead?: number;
  /**
   * Cache-write price as a multiple of `input`. Defaults to
   * {@link CACHE_WRITE_RATE_MULTIPLIER} (1.25, Anthropic's 5-minute TTL).
   * Vendors whose caching is automatic charge no write premium.
   */
  cacheWrite?: number;
}

/**
 * Per-1M-token pricing. Keys may be exact model ids OR prefixes (e.g.
 * 'deepseek/' matches any 'deepseek/...' model). lookupCostRate() tries an
 * exact match first, then the longest matching prefix.
 *
 * Rates approximate public list prices as of mid-2026; they drift over time.
 * When a model isn't listed, the default rate is used and the estimate is
 * flagged as approximate (see createTokenTracker.format / isEstimated).
 */
const COST_RATES: Array<{ match: string; rate: CostRate }> = [
  // ── Anthropic ──
  { match: 'claude-opus',      rate: { input: 15.0, output: 75.0 } },
  { match: 'claude-sonnet',    rate: { input: 3.0,  output: 15.0 } },
  { match: 'claude-haiku',     rate: { input: 0.25, output: 1.25 } },
  // ── OpenAI ──
  { match: 'gpt-4.1-mini',     rate: { input: 0.40, output: 1.60 } },
  { match: 'gpt-4.1',          rate: { input: 2.0,  output: 8.0 } },
  { match: 'gpt-4o-mini',      rate: { input: 0.15, output: 0.60 } },
  { match: 'gpt-4o',           rate: { input: 2.5,  output: 10.0 } },
  { match: 'gpt-5',            rate: { input: 5.0,  output: 15.0 } },
  // ── Google Gemini ──
  { match: 'gemini-2',         rate: { input: 1.25, output: 5.0 } },
  { match: 'gemini-flash',     rate: { input: 0.15, output: 0.60 } },
  // ── DeepSeek Platform (api.deepseek.com; `input` is the cache-MISS rate) ──
  // Caching is automatic with no write premium, and a hit costs ~1/50th of a
  // miss — the steepest cache discount of any provider AICO speaks to.
  { match: 'deepseek-v4-flash', rate: { input: 0.14,  output: 0.28, cacheRead: 0.02, cacheWrite: 1 } },
  { match: 'deepseek-v4-pro',   rate: { input: 0.435, output: 0.87, cacheRead: 0.00833, cacheWrite: 1 } },
  { match: 'deepseek-',         rate: { input: 0.14,  output: 0.28, cacheRead: 0.02, cacheWrite: 1 } },
  // ── DeepSeek (via OpenRouter) ──
  { match: 'deepseek/',        rate: { input: 0.27, output: 1.10 } },
  // ── Z.AI GLM (glm-4.6 ~$0.60/$2.20; glm-4.5-air cheaper; glm-5 flagship) ──
  { match: 'glm-5',            rate: { input: 0.80, output: 2.20 } },
  { match: 'glm-4.6',          rate: { input: 0.60, output: 2.20 } },
  { match: 'glm-4.5-air',      rate: { input: 0.14, output: 0.56 } },
  { match: 'glm-4.5',          rate: { input: 0.60, output: 2.20 } },
  { match: 'glm-',             rate: { input: 0.60, output: 2.20 } },
  // ── Meta Llama (via OpenRouter) ──
  { match: 'llama',            rate: { input: 0.20, output: 0.60 } },
  // ── Local ──
  { match: 'ollama',           rate: { input: 0.0,  output: 0.0 } },
];

const DEFAULT_RATE: CostRate = { input: 1.0, output: 5.0 };

/**
 * Find the cost rate for a model. Exact id match wins; otherwise the longest
 * prefix match is used (e.g. 'deepseek/' covers all 'deepseek/...' models).
 * Returns undefined when nothing matches → caller falls back to DEFAULT_RATE
 * and flags the estimate as approximate.
 */
function lookupCostRate(model: string): CostRate | undefined {
  const exact = COST_RATES.find(r => r.match === model);
  if (exact) return exact.rate;
  let best: { rate: CostRate; len: number } | undefined;
  for (const { match, rate } of COST_RATES) {
    if (model.startsWith(match) && match.length > (best?.len ?? 0)) {
      best = { rate, len: match.length };
    }
  }
  return best?.rate;
}

export function createTokenTracker() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;
  let sessions = 0;

  return {
    /**
     * Record one request's usage. `input` is the TOTAL prompt size and the two
     * cache counts are subsets of it — providers normalize to that convention
     * before the numbers get here (see providers/usage.ts).
     */
    add(input: number, output: number, cached = 0, cacheWrite = 0): void {
      inputTokens += Math.ceil(input);
      outputTokens += Math.ceil(output);
      cachedTokens += Math.ceil(cached);
      cacheWriteTokens += Math.ceil(cacheWrite);
      sessions++;
    },

    getUsage(): TokenUsage {
      return { inputTokens, outputTokens, cachedTokens, cacheWriteTokens, sessions };
    },

    /**
     * Whether the cost estimate for `model` uses the fallback default rate
     * (i.e. the model has no known pricing). Callers use this to flag the
     * estimate as approximate rather than presenting a fabricated number.
     */
    isEstimated(model: string): boolean {
      return lookupCostRate(model) === undefined;
    },

    /**
     * Estimate spend across the three input tiers plus output.
     *
     * `inputTokens` is the whole prompt, so the cache counts are subtracted out
     * and re-added at their own rates rather than charged twice. Cache writes
     * cost *more* than plain input (1.25x on Anthropic's default 5-minute TTL),
     * which is why they are a separate term and not folded in with reads — a
     * cold first turn is more expensive than an uncached one, and an estimate
     * that ignores that makes caching look strictly free.
     */
    estimateCost(model: string): number {
      const rate = lookupCostRate(model) ?? DEFAULT_RATE;
      const readMultiplier = rate.cacheRead ?? CACHE_READ_RATE_MULTIPLIER;
      const writeMultiplier = rate.cacheWrite ?? CACHE_WRITE_RATE_MULTIPLIER;
      const uncachedInput = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
      const inputCost = (uncachedInput / 1_000_000) * rate.input;
      const cacheReadCost = (cachedTokens / 1_000_000) * (rate.input * readMultiplier);
      const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (rate.input * writeMultiplier);
      const outputCost = (outputTokens / 1_000_000) * rate.output;
      return inputCost + outputCost + cacheReadCost + cacheWriteCost;
    },

    format(model?: string): string {
      const cost = model ? this.estimateCost(model) : 0;
      const est = model && this.isEstimated(model) ? ' (est.)' : '';
      // ⚡ reads (cheap) and ✎ writes (a 1.25x premium) are shown separately —
      // collapsing them would hide that a cold turn costs more, not less.
      const cacheStr =
        (cachedTokens > 0 ? ` ⚡${cachedTokens.toLocaleString()}` : '') +
        (cacheWriteTokens > 0 ? ` ✎${cacheWriteTokens.toLocaleString()}` : '');
      const costStr = cost > 0 ? ` (~$${cost.toFixed(4)}${est})` : '';
      return `\u2191 ${inputTokens.toLocaleString()} \u2193 ${outputTokens.toLocaleString()}${cacheStr}${costStr}`;
    },
  };
}

/**
 * Estimate token count from a string.
 * Heuristic: ASCII chars ≈ 4 chars/token; non-ASCII (CJK, emoji) ≈ 1.5 chars/token.
 * Significantly more accurate than a flat /4 for multilingual content.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) nonAscii++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}
