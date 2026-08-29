import { CACHE_READ_RATE_MULTIPLIER, CACHE_WRITE_RATE_MULTIPLIER } from './providers/usage.js';
import type { AicoSettings } from './settings.js';

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
  // ── Z.AI GLM (docs.z.ai/guides/overview/pricing, read 2026-08-30) ──
  // Caching is implicit and the cached rate is a real discount — around 5x on
  // the 5.x line — so `cacheRead` is not decoration here. GLM reports
  // cached_tokens in usage, and aico's prefixes are stable across turns, so
  // most input on a long session is billed at the cheaper rate.
  //
  // `glm-5.3-flash` is listed at half price until 2026-09-09. These are the
  // LIST prices, not the promotional ones: a promo that expires silently makes
  // every estimate wrong the next morning, and a cost ceiling that fires a
  // little early is a smaller problem than one that fires too late.
  //
  // Order matters only for readability — lookupCostRate takes the longest
  // matching prefix, so `glm-5.3-flash` wins over `glm-5.3` over `glm-5`.
  // Cached rates are FRACTIONS of `input`, not absolute prices — Z.AI's
  // published cached figures divided by its input figures, which land close to
  // a consistent 0.18-0.20 across the line.
  { match: 'glm-5.3-flash',    rate: { input: 0.15, output: 0.50, cacheRead: 0.20, cacheWrite: 1 } },
  { match: 'glm-5.3',          rate: { input: 1.40, output: 4.40, cacheRead: 0.186, cacheWrite: 1 } },
  { match: 'glm-5.2',          rate: { input: 1.40, output: 4.40, cacheRead: 0.186, cacheWrite: 1 } },
  { match: 'glm-5.1',          rate: { input: 1.40, output: 4.40, cacheRead: 0.186, cacheWrite: 1 } },
  { match: 'glm-5',            rate: { input: 1.00, output: 3.20, cacheRead: 0.20, cacheWrite: 1 } },
  { match: 'glm-4.7-flashx',   rate: { input: 0.07, output: 0.40, cacheRead: 0.143, cacheWrite: 1 } },
  { match: 'glm-4.7-flash',    rate: { input: 0,    output: 0 } },
  { match: 'glm-4.7',          rate: { input: 0.60, output: 2.20, cacheRead: 0.183, cacheWrite: 1 } },
  { match: 'glm-4.6v-flashx',  rate: { input: 0.04, output: 0.40, cacheRead: 0.10,  cacheWrite: 1 } },
  { match: 'glm-4.6v-flash',   rate: { input: 0,    output: 0 } },
  { match: 'glm-4.6v',         rate: { input: 0.30, output: 0.90, cacheRead: 0.167, cacheWrite: 1 } },
  { match: 'glm-4.6',          rate: { input: 0.60, output: 2.20, cacheRead: 0.183, cacheWrite: 1 } },
  { match: 'glm-4.5-flash',    rate: { input: 0,    output: 0 } },
  { match: 'glm-4.5-air',      rate: { input: 0.14, output: 0.56 } },
  { match: 'glm-4.5',          rate: { input: 0.60, output: 2.20, cacheRead: 0.183, cacheWrite: 1 } },
  { match: 'glm-',             rate: { input: 0.60, output: 2.20, cacheRead: 0.183, cacheWrite: 1 } },
  // ── Meta Llama (via OpenRouter) ──
  { match: 'llama',            rate: { input: 0.20, output: 0.60 } },
  // ── Local ──
  { match: 'ollama',           rate: { input: 0.0,  output: 0.0 } },
];

/**
 * What an unlisted model is costed at, in the absence of anything better.
 *
 * These numbers are invented. They are the middle of a very wide range — real
 * rates among models AICO can reach span from nothing at all (a local Ollama
 * model) to $75 per million output tokens, so any single default is wrong for
 * almost everybody, and wrong by more than an order of magnitude at both ends.
 *
 * That is tolerable only because every path that uses them also reports
 * {@link isEstimated}, and every surface that shows a figure derived from them
 * says so. A number this speculative presented as a fact is worse than no
 * number: it invites the reader to reason about a budget that does not exist.
 *
 * The real fix for any given deployment is `settings.modelPricing` — the
 * operator of an OpenAI-compatible gateway knows their rates and this file
 * never can.
 */
const DEFAULT_RATE: CostRate = { input: 1.0, output: 5.0 };

/**
 * Provider types whose model ids say nothing about what they cost.
 *
 * A custom endpoint can serve any model under any name. `gpt-5.6-terra` on
 * someone's gateway matches the `gpt-5` prefix in the table below and is then
 * costed at OpenAI's list price — which is a coincidence of naming, not
 * knowledge, and the reseller may charge half that or triple it. A local
 * Ollama model matched against any prefix is worse still: it is free, and the
 * table will confidently bill it.
 *
 * So for these, a prefix match is not treated as knowing. The rate is still
 * used — a plausible number beside honest tokens beats no number at all — but
 * it is reported as an estimate, and `settings.modelPricing` is how it stops
 * being one.
 */
const UNPRICED_PROVIDER_TYPES = new Set(['openai-compatible', 'ollama']);

/** A rate stated by the reader, which beats anything guessed here. */
function configuredRate(model: string, settings?: AicoSettings): CostRate | undefined {
  const entry = settings?.modelPricing?.[model];
  if (!entry) return undefined;
  const input = Number(entry.input);
  const output = Number(entry.output);
  // Both halves or neither. A rate with only one side would silently cost the
  // other at zero, which reads as "this model's output is free" rather than as
  // a half-finished setting.
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return undefined;
  }
  const cacheRead = Number(entry.cacheRead);
  const cacheWrite = Number(entry.cacheWrite);
  return {
    input,
    output,
    ...Number.isFinite(cacheRead) && cacheRead >= 0 ? { cacheRead } : {},
    ...Number.isFinite(cacheWrite) && cacheWrite >= 0 ? { cacheWrite } : {},
  };
}

/**
 * Find the cost rate for a model. Exact id match wins; otherwise the longest
 * prefix match is used (e.g. 'deepseek/' covers all 'deepseek/...' models).
 * Returns undefined when nothing matches → caller falls back to DEFAULT_RATE
 * and flags the estimate as approximate.
 */
function lookupCostRate(model: string, settings?: AicoSettings): CostRate | undefined {
  const stated = configuredRate(model, settings);
  if (stated) return stated;

  const direct = matchCostRate(model);
  if (direct) return direct;

  /*
    Nothing matched, so try again without the vendor prefix.

    A model can arrive as `glm-5.3-flash` or as `z-ai/glm-5.3-flash` — the same
    model, one of them named the way a router names it. Every `glm-` entry
    matches the first and none matches the second, so a session on the prefixed
    form was costed at the invented default rate and reported with a `?`. Real
    token counts, made-up money.

    A second pass rather than stripping up front, because the prefix sometimes
    *is* the distinguishing fact: `deepseek/...` on OpenRouter is priced
    differently from `deepseek-...` on DeepSeek's own platform, and both are
    listed. Trying the full id first keeps that entry winning, and this only
    runs when the full id matched nothing at all.
  */
  const slash = model.indexOf('/');
  if (slash > 0) return matchCostRate(model.slice(slash + 1));
  return undefined;
}

/** Exact id, then the longest matching prefix. */
function matchCostRate(model: string): CostRate | undefined {
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
  /**
   * Requests whose numbers were counted here rather than reported by the API.
   *
   * A gateway that rejects `stream_options` gets it switched off for the life
   * of the provider, after which no usage arrives at all and the turn is
   * costed from a character-count heuristic. That is a legitimate fallback —
   * the alternative is a turn that appears free and slips past the spend
   * ceiling — but it is not a measurement, and reporting it as one is how
   * "the output tokens behave differently" starts.
   */
  let estimatedRequests = 0;

  return {
    /**
     * Record one request's usage. `input` is the TOTAL prompt size and the two
     * cache counts are subsets of it — providers normalize to that convention
     * before the numbers get here (see providers/usage.ts).
     */
    add(input: number, output: number, cached = 0, cacheWrite = 0, measured = true): void {
      if (!measured) estimatedRequests++;
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
     * Whether any of these counts were guessed rather than reported.
     *
     * Separate from {@link isEstimated}, which is about not knowing the
     * *price*. These are the two independent ways a cost figure can be soft,
     * and a reader deserves to know which: unknown pricing still has real token
     * counts behind it, whereas unreported usage does not.
     */
    hasEstimatedUsage(): boolean {
      return estimatedRequests > 0;
    },

    /**
     * Whether the cost estimate for `model` uses the fallback default rate
     * (i.e. the model has no known pricing). Callers use this to flag the
     * estimate as approximate rather than presenting a fabricated number.
     */
    isEstimated(model: string, settings?: AicoSettings, providerType?: string): boolean {
      // An explicit rate is never an estimate, whoever serves the model.
      if (configuredRate(model, settings)) return false;
      if (providerType && UNPRICED_PROVIDER_TYPES.has(providerType)) return true;
      return lookupCostRate(model, settings) === undefined;
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
    estimateCost(model: string, settings?: AicoSettings): number {
      const rate = lookupCostRate(model, settings) ?? DEFAULT_RATE;
      const readMultiplier = rate.cacheRead ?? CACHE_READ_RATE_MULTIPLIER;
      const writeMultiplier = rate.cacheWrite ?? CACHE_WRITE_RATE_MULTIPLIER;
      const uncachedInput = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);
      const inputCost = (uncachedInput / 1_000_000) * rate.input;
      const cacheReadCost = (cachedTokens / 1_000_000) * (rate.input * readMultiplier);
      const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (rate.input * writeMultiplier);
      const outputCost = (outputTokens / 1_000_000) * rate.output;
      return inputCost + outputCost + cacheReadCost + cacheWriteCost;
    },

    format(model?: string, settings?: AicoSettings, providerType?: string): string {
      const cost = model ? this.estimateCost(model, settings) : 0;
      const est = model && this.isEstimated(model, settings, providerType) ? ' (est.)' : '';
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

/**
 * A tracker for one sub-agent that also feeds its parent's totals.
 *
 * Sub-agents used to share the parent's tracker outright, which kept session
 * accounting correct and made per-agent accounting impossible: with four
 * researchers running in parallel against one tracker, none of them can tell
 * its own spend from its siblings'. A runaway agent was therefore invisible
 * until it had consumed the whole session's budget on everyone's behalf.
 *
 * This keeps its own counters and forwards every entry upward, so the child
 * can be held to a ceiling of its own while the parent still sees the total.
 *
 * One consequence, stated because it is a real limit rather than an oversight:
 * inside a child, the *session* ceiling is measured against the child's own
 * numbers and so will not fire there. The parent re-checks at its next step
 * boundary with the full picture, and the per-sub-agent ceiling is what stops
 * a single child before it gets that far. The two are meant to be set
 * together.
 */
export function createChildTracker(parent: ReturnType<typeof createTokenTracker>) {
  const child = createTokenTracker();
  return {
    ...child,
    add(input: number, output: number, cached = 0, cacheWrite = 0, measured = true): void {
      child.add(input, output, cached, cacheWrite, measured);
      parent.add(input, output, cached, cacheWrite, measured);
    },
    // Bound explicitly rather than left to the spread: the methods above close
    // over `child`'s own state, and a spread copies the function references
    // without rebinding `this` for the ones that use it.
    getUsage: () => child.getUsage(),
    estimateCost: (model: string, settings?: AicoSettings) => child.estimateCost(model, settings),
    isEstimated: (model: string, settings?: AicoSettings, providerType?: string) =>
      child.isEstimated(model, settings, providerType),
    hasEstimatedUsage: () => child.hasEstimatedUsage(),
    format: (model?: string, settings?: AicoSettings, providerType?: string) =>
      child.format(model, settings, providerType),
  };
}
