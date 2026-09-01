/**
 * How hard a model is asked to think, and which models can be asked at all.
 *
 * Two facts are deliberately kept apart here, because conflating them is what
 * would make this rot:
 *
 * 1. **Which levels a model accepts** — a property of the *model*. This file.
 * 2. **How a level is put on the wire** — a property of the *API family*. That
 *    belongs with each provider, because `reasoning.effort`, `output_config.effort`,
 *    `thinking_level` and `thinking: {type}` are four different shapes for the
 *    same idea and always will be.
 *
 * ## Why this is not just a table
 *
 * It has a table, and a table alone would be wrong for exactly the reason the
 * context window's was: models appear, and vendors change what existing ones
 * accept. Gemini replaced a token budget with named levels; OpenAI's own guide
 * says outright that "supported values are model-dependent" and declines to
 * enumerate them. A list frozen at the time of writing would quietly send a
 * rejected value for the life of the install.
 *
 * So the table is the *starting point*, every answer carries where it came
 * from, and a provider that rejects a level teaches us — see
 * {@link learnFromError}, which unlike the context window's equivalent is
 * actually called.
 *
 * ## What an unknown model gets
 *
 * Nothing. `levels: []` and `source: 'unknown'`, so a picker shows no control
 * rather than offering five settings that may all 400. Guessing here is worse
 * than abstaining: the cost of abstaining is a missing option, and the cost of
 * guessing is a turn that fails.
 *
 * @module shared/reasoning
 */


/**
 * The ladder, ascending.
 *
 * One vocabulary across every vendor, because a person choosing "high" means
 * the same thing whichever model they are on. Each provider maps these to its
 * own parameter; no vendor accepts all of them.
 *
 * `off` is a real level, not the absence of one — some models reason by default
 * and turning it off is a deliberate choice with a real effect on latency.
 */
export const LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = typeof LADDER[number];

/**
 * What the user picked, which is not the same as a level.
 *
 * `auto` means "send nothing and let the platform decide". It is distinct from
 * every level including `medium`: a provider's own default may be adaptive, and
 * pinning a middle value would replace a decision the model makes per request
 * with one made once by someone who could not see the request.
 */
export type EffortChoice = EffortLevel | 'auto';

export type ReasoningSource = 'user' | 'learned' | 'table' | 'unknown';

export interface ReasoningFact {
  /** Accepted levels, ascending. Empty means this model does not reason. */
  levels: EffortLevel[];
  /**
   * What happens when nothing is sent.
   *
   * `adaptive` means the model decides per request — the best answer, and the
   * reason `auto` is worth offering. A level here means the platform silently
   * pins that one, which is worth showing: DeepSeek defaults to `high`, and
   * "why is it thinking so long about a one-line change" has no other answer.
   */
  fallback: EffortLevel | 'adaptive' | 'unknown';
  source: ReasoningSource;
  /** When it was established. Absent for the table. */
  at?: number;
}

const NONE: ReasoningFact = { levels: [], fallback: 'unknown', source: 'unknown' };

/**
 * How long a learned fact is trusted before the table is consulted again.
 *
 * Same reasoning and the same week as the context window's: long enough that
 * nobody notices the re-check, short enough that a vendor adding a level is
 * picked up within a working cycle.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What we know, keyed by model id.
 *
 * Ordered, and the first match wins — so a specific id can override a family
 * pattern by being listed above it. Every entry names its source and when it
 * was checked, because an unsourced capability table is indistinguishable from
 * a guess six months later.
 */
interface TableEntry {
  match: RegExp;
  levels: EffortLevel[];
  fallback: ReasoningFact['fallback'];
  /** Where this came from. Read by nobody; written for whoever edits next. */
  checked: string;
}

const TABLE: TableEntry[] = [
  // ── Anthropic ────────────────────────────────────────────────────
  // `output_config.effort`. 4.6 and later think adaptively when nothing is
  // sent, which is why `auto` is the right default there rather than a level.
  {
    match: /^claude-(opus|sonnet|fable|mythos)-(4-6|4-7|4-8|5)/,
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    fallback: 'adaptive',
    checked: 'Anthropic API docs, 2026-09',
  },

  // ── OpenAI ───────────────────────────────────────────────────────
  // `reasoning.effort` on the Responses API. The guide lists the full ladder
  // and then says plainly that "supported values are model-dependent" without
  // enumerating per model — so this is the widest set, marked `table`, and
  // narrowed by `learnFromError` the first time one is refused.
  {
    match: /^(gpt-5|o[34])/,
    // `off` rather than OpenAI's own `none`: the ladder is one vocabulary and
    // the provider translates. Writing their spelling here needed a cast, and
    // the cast silenced the fact that the value did not exist.
    levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    fallback: 'medium',
    checked: 'OpenAI reasoning guide, 2026-09',
  },

  /*
    ── Google ───────────────────────────────────────────────────────

    `thinking_level`, which replaced the old `thinkingBudget`. Sets *and*
    defaults genuinely differ between models in one family, which is the
    clearest single piece of evidence that this cannot be a per-provider
    setting.

    The fallback is `adaptive`, and that is a correction: it was recorded as
    the per-model default *level* until the docs were re-read, which say
    "Gemini models engage in dynamic thinking by default, automatically
    adjusting the amount of reasoning effort based on the complexity of the
    request." A level is what the model settles on; the behaviour when nothing
    is sent is that it decides — and that is what somebody choosing `auto`
    needs told.

    `gemini-2.5-flash-lite` is the exception the docs call out: off unless
    asked.
  */
  {
    match: /^gemini-2\.5-flash-lite/,
    levels: ['off', 'low', 'medium', 'high'],
    fallback: 'off',
    checked: 'Gemini thinking docs, 2026-09',
  },
  {
    match: /^gemini-3\.7-flash/,
    levels: ['low', 'medium', 'high'],
    fallback: 'adaptive',
    checked: 'Gemini thinking docs, 2026-09',
  },
  {
    match: /^gemini-(3|2\.5)/,
    levels: ['minimal', 'low', 'medium', 'high'],
    fallback: 'adaptive',
    checked: 'Gemini thinking docs, 2026-09',
  },

  // ── DeepSeek ─────────────────────────────────────────────────────
  // `thinking: {type, reasoning_effort}`. The platform default is `high` and
  // there is no adaptive option, which is why a run of small steps thinks hard
  // about every one of them unless somebody says otherwise.
  {
    match: /^deepseek-v4|^deepseek-(chat|reasoner)/,
    levels: ['off', 'low', 'high', 'max'],
    fallback: 'high',
    checked: 'DeepSeek thinking-mode guide, 2026-09',
  },

  // ── Z.AI ─────────────────────────────────────────────────────────
  // `thinking: {type: 'enabled' | 'disabled'}` — a switch, not a ladder. Listed
  // as two levels rather than pretending to five, so a picker offers what is
  // actually there.
  {
    match: /^glm-/i,
    levels: ['off', 'high'],
    fallback: 'high',
    checked: 'Z.AI GLM API docs, 2026-09',
  },
];

/**
 * Learned corrections for this process, keyed by model.
 *
 * Module state on purpose, and the one thing here that should be: what a model
 * accepts is a fact about the model, identical for every session in the
 * process. The *choice* is not — see `run-context`, where it belongs, because
 * two sessions can be on two models with two different answers at once.
 */
const learned = new Map<string, ReasoningFact>();

/**
 * What this model can be asked for.
 *
 * Consulted in the order things deserve to be trusted: what a person told us,
 * then what a provider taught us, then the table, then nothing.
 */
export function reasoningFor(model: string, now = Date.now()): ReasoningFact {
  const known = learned.get(model);
  if (known && (known.at === undefined || now - known.at < TTL_MS)) return known;

  const entry = TABLE.find(e => e.match.test(model));
  if (!entry) return NONE;
  return { levels: [...entry.levels], fallback: entry.fallback, source: 'table' };
}

/** Whether this model can be asked to think harder at all. */
export function supportsReasoning(model: string): boolean {
  return reasoningFor(model).levels.length > 0;
}

/**
 * The level to actually send, or undefined for "send nothing".
 *
 * Returns undefined for `auto`, for an unknown model, and for a level this
 * model does not accept — the last of which matters most. A stored choice
 * outlives the model it was made for: somebody picks `xhigh` on Opus, switches
 * the session to GLM, and the request 400s on a value they cannot see.
 */
export function effortToSend(model: string, choice: EffortChoice | undefined): EffortLevel | undefined {
  if (!choice || choice === 'auto') return undefined;
  const fact = reasoningFor(model);
  if (fact.levels.includes(choice)) return choice;

  /*
    Nearest supported rather than nothing.

    Dropping the choice silently would answer "I asked for maximum effort" with
    the platform default, which on some models is the opposite. Stepping to the
    closest rung the model does have keeps the intent — and it is only ever
    reached when a choice outlived its model.
  */
  return nearest(choice, fact.levels);
}

/** The closest rung on the ladder that this model actually offers. */
function nearest(wanted: EffortLevel, levels: EffortLevel[]): EffortLevel | undefined {
  if (levels.length === 0) return undefined;
  const target = LADDER.indexOf(wanted);
  let best = levels[0];
  let bestDistance = Math.abs(LADDER.indexOf(best) - target);
  for (const level of levels) {
    const distance = Math.abs(LADDER.indexOf(level) - target);
    if (distance < bestDistance) { best = level; bestDistance = distance; }
  }
  return best;
}

/**
 * Patterns a provider uses to refuse a reasoning level.
 *
 * Deliberately narrow. A pattern loose enough to match any 400 would "learn"
 * from an unrelated failure and permanently narrow a model's real capability —
 * which is worse than never learning, because it is wrong in a direction
 * nobody would think to check.
 */
const REFUSALS: RegExp[] = [
  // OpenAI: Invalid value: 'xhigh'. Supported values are: 'low', 'medium'…
  /invalid value:\s*'?([a-z]+)'?\..*supported values are:?\s*(.+)/i,
  // Generic OpenAI-compatible gateways
  /unsupported (?:value|reasoning_effort)[^:]*:\s*'?([a-z]+)'?.*(?:expected|supported|must be)\s*:?\s*(.+)/i,
];

/**
 * Learn a model's real level set from a provider's rejection.
 *
 * Returns the levels it now believes, or undefined when the message was not a
 * refusal it recognises. Called from the provider error path — unlike the
 * context window's equivalent, which was written, tested, and never wired to
 * anything, so it has never corrected a single window in production.
 */
export function learnFromError(model: string, message: string): EffortLevel[] | undefined {
  for (const pattern of REFUSALS) {
    const hit = pattern.exec(message);
    if (!hit) continue;

    const offered = (hit[2] ?? '')
      .split(/[,\s]+/)
      .map(word => word.replace(/['"`.]/g, '').trim().toLowerCase())
      .filter((word): word is EffortLevel => (LADDER as readonly string[]).includes(word));

    if (offered.length === 0) {
      /*
        A refusal we understood without a list to replace it with. The rejected
        value is removed and the rest kept — less information than a full list,
        and still enough to stop sending the one value known to fail.
      */
      const rejected = hit[1]?.toLowerCase();
      const current = reasoningFor(model);
      if (!rejected || !current.levels.includes(rejected as EffortLevel)) return undefined;
      const narrowed = current.levels.filter(l => l !== rejected);
      learned.set(model, { ...current, levels: narrowed, source: 'learned', at: Date.now() });
      return narrowed;
    }

    const current = reasoningFor(model);
    learned.set(model, {
      levels: offered,
      fallback: current.fallback,
      source: 'learned',
      at: Date.now(),
    });
    return offered;
  }
  return undefined;
}

/** Tests establish their own state; detection is process-wide otherwise. */
export function resetReasoningForTest(): void {
  learned.clear();
}

/**
 * Whether a loose string is a choice we can act on.
 *
 * `effort` reaches the engine from HTTP bodies and settings files as a plain
 * string, and an unrecognised one must be ignored rather than sent. A gateway
 * that starts accepting a level we do not model should produce no reasoning
 * parameter, not a 400 on every request.
 */
export function isEffortChoice(value: unknown): value is EffortChoice {
  return value === 'auto' || (LADDER as readonly unknown[]).includes(value);
}
