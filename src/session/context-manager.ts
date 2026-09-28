/**
 * Keeping a long run's context focused while it is still running.
 *
 * Compaction used to happen only *between* turns, which cannot help the case
 * it matters most for: one autonomous turn that runs for a hundred steps and
 * fills the window on its own. When that happened the provider rejected the
 * request and the turn simply ended. This runs before every step instead, and
 * does the cheap, lossless-ish thing first:
 *
 *   1. **Measure** the context the next request will carry — from what the
 *      provider actually reported for the last one, plus an estimate of only
 *      what was appended since. The old trigger estimated from message text
 *      alone and missed the system prompt, the tool schemas and every tool
 *      call's arguments, so it fired late.
 *   2. **Mask** old tool output (`session/mask.ts`) once past a lower mark —
 *      the single biggest saving, and the one the evidence says costs nothing
 *      in solve rate. In batches, so the cached prefix breaks rarely.
 *   3. **Compact inside the turn** only if masking was not enough, cutting on a
 *      step boundary and writing a handoff that carries the person's words,
 *      the plan, the todos and the files changed from the record itself.
 *   4. **Refuse to thrash.** If compacting does not bring the context back
 *      under the mark twice running, the turn stops with a message naming why
 *      rather than burning money summarizing summaries.
 *
 * @module session/context-manager
 */

import type { AicoSettings } from '../settings.js';
import { getEffectiveContextBudget } from '../context-window.js';
import { getCompactionThreshold } from '../compact.js';
import { estimateTokens } from '../tokens.js';
import { saveSpill } from '../tools/spill.js';
import type { Todo } from '../tools/todo.js';
import { composeSummary, foldRange, planMidTurnCut } from './compact.js';
import { maskState } from './derive.js';
import { MASK_INPUT_MIN_CHARS, isMaskable, maskedCall, maskedResult, spillPathIn } from './mask.js';
import type { Seq, SessionEvent } from './events.js';
import type { Session } from './session.js';

/**
 * What the model is asked for when a mid-turn compaction needs its account.
 *
 * Plain text rather than a schema: it is read back by the same model, and the
 * sections that must be exact — the person's words, the plan, the todos, the
 * files — are carried separately from the log, so this only has to cover what
 * the log cannot: what the model learned and what it was about to do.
 */
export const HANDOFF_INSTRUCTION = [
  '[Context checkpoint — from the harness, not from the user.] Your context is nearly full, '
    + 'so the conversation above is about to be condensed. Write a handoff note for yourself '
    + 'that will stand in for it. Do not call any tools. Under 500 words, short bullets:',
  '- Done so far: what is finished, and the evidence it works (tests run, output seen).',
  '- In progress: exactly what you were in the middle of.',
  '- Key facts: names, values, paths, commands, ids and findings that would be expensive to rediscover.',
  '- Errors hit, and how each was resolved (or that it was not).',
  '- Next step: the precise next action.',
  'Do not restate the user\'s messages, the plan, the todo list or the list of files — those are '
    + 'carried over word for word separately.',
].join('\n');

/** Raised when compaction cannot bring the context back under the limit. */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

export interface ContextManagerOptions {
  session: Session;
  model: string;
  settings?: AicoSettings;
  /** Estimated tokens of everything a request carries besides its messages. */
  overheadTokens: number;
  /** The model's handoff narrative for a compaction; undefined when unavailable. */
  summarize?: () => Promise<string | undefined>;
  /** The session's todo list, for the handoff. */
  readTodos?: () => Promise<Todo[]>;
  /** Tell the person what happened. */
  notice?: (text: string) => void;
  /** Tell the model something it should know before its context changes. */
  warn?: (text: string) => void;
}

/** What one run's context management did, for telemetry and tests. */
export interface ContextStats {
  masks: number;
  tokensMasked: number;
  compactions: number;
}

/** Rough tokens a derived message costs, arguments included. */
function messageTokens(event: SessionEvent, maskedThrough: Seq, spills: Record<string, string>): number {
  if (event.type === 'assistant/message') {
    const data = event.data as {
      content: string;
      toolCalls?: Array<{ id: string; name: string; input: unknown }>;
      reasoning?: { content?: string };
    };
    const calls = event.seq <= maskedThrough
      ? (data.toolCalls ?? []).map(c => maskedCall(c as never))
      : (data.toolCalls ?? []);
    // A reasoning trace goes back with a step that called tools (DeepSeek's
    // documented rule, and the shape Anthropic's signed thinking takes). It is
    // often the largest part of such a step — leaving it out of the estimate
    // made a condensation look worthless when it would have freed the most.
    const trace = calls.length > 0 ? (data.reasoning?.content ?? '') : '';
    return estimateTokens(data.content + trace + (calls.length ? JSON.stringify(calls) : '')) + 4;
  }
  const data = event.data as { content: string; name?: string; isError?: boolean };
  if (event.type === 'tool/result' && event.seq <= maskedThrough
      && isMaskable(data.name ?? '', data.content, data.isError)) {
    return estimateTokens(maskedResult(data.name ?? '', data.content, spills[String(event.seq)])) + 4;
  }
  return estimateTokens(data.content) + 4;
}

export class ContextManager {
  private lastInput: number | undefined;
  private estimateAtRequest = 0;
  private compactedAtStep = -1;
  private thrash = 0;
  private warned = false;
  readonly stats: ContextStats = { masks: 0, tokensMasked: 0, compactions: 0 };

  constructor(private readonly o: ContextManagerOptions) {}

  /** Estimated tokens of the message history the next request would carry. */
  estimateHistory(): number {
    const { through, spills } = maskState(this.o.session.events);
    return this.o.session.surfaceEvents().reduce((n, e) => n + messageTokens(e, through, spills), 0);
  }

  /** Estimated tokens the visible events in `[start, end]` cost a request. */
  private rangeTokens(start: Seq, end: Seq): number {
    const { through, spills } = maskState(this.o.session.events);
    return this.o.session.surfaceEvents()
      .filter(e => e.seq >= start && e.seq <= end)
      .reduce((n, e) => n + messageTokens(e, through, spills), 0);
  }

  /** Call as a request goes out. */
  noteRequest(): void {
    this.estimateAtRequest = this.estimateHistory();
  }

  /** Call with the prompt size the provider reported for that request. */
  noteUsage(inputTokens: number): void {
    if (inputTokens > 0) this.lastInput = inputTokens;
  }

  /**
   * The context the next request will carry, in tokens.
   *
   * Anchored on the provider's own count for the last request whenever there
   * is one, so the estimate only has to cover what changed since — a few tool
   * results, not the whole conversation plus every schema.
   */
  measure(): number {
    const now = this.estimateHistory();
    if (this.lastInput === undefined) return now + this.o.overheadTokens;
    return Math.max(0, this.lastInput + (now - this.estimateAtRequest));
  }

  private limits(): { budget: number; maskAt: number; compactAt: number; keep: number; keepSteps: number; minFree: number } {
    const cfg = this.o.settings?.contextManagement;
    const budget = getEffectiveContextBudget(this.o.model, this.o.settings);
    const compactAt = getCompactionThreshold(this.o.model, this.o.settings);
    const maskDefault = Math.min(Math.floor(budget / 2), 100_000);
    return {
      budget,
      compactAt,
      // Always below the compaction mark, so the cheap step gets its chance first.
      maskAt: Math.min(cfg?.maskAtTokens ?? maskDefault, Math.floor(compactAt * 0.85)),
      keep: Math.max(1, cfg?.keepRecentToolResults ?? 6),
      keepSteps: Math.max(1, cfg?.keepRecentSteps ?? 8),
      // A mask breaks the cached prefix once; it has to free enough to be worth that.
      minFree: Math.max(2_000, Math.floor(budget * 0.03)),
    };
  }

  /**
   * Mask older tool output, keeping the most recent `keep` results whole.
   *
   * @returns estimated tokens freed; 0 when there was not enough to be worth
   *   breaking the cache for, in which case nothing is written.
   */
  mask(keep: number, minFree: number, dryRun = false, keepSteps = 1): number {
    const { session } = this.o;
    const current = maskState(session.events);
    const visible = session.surfaceEvents();
    // The window counts outputs worth masking. Counting every result let a
    // run of tiny ones — a todo update after each read — fill the window, so
    // a real output fell out of it on nearly every step.
    const results = visible.filter((e) => {
      if (e.type !== 'tool/result') return false;
      const d = e.data as { name: string; content: string; isError?: boolean };
      return isMaskable(d.name, d.content, d.isError);
    });
    if (results.length <= keep) return 0;

    /*
      And it is a window of *steps* as well as of results.

      Counted in results alone, a model that reads eight files at once had
      output masked one step after it first saw it — before it had written a
      single value down. It read the file again, which was masked again: 162
      reads for 30 files and a turn that never finished, watched live on
      gpt-6-luna. The study this is based on keeps ten steps of observations;
      nothing from the last `keepSteps` steps is touched here, however much
      there is of it.
    */
    const assistants = visible.filter(e => e.type === 'assistant/message').map(e => e.seq);
    const stepsSince = (seq: Seq): number => assistants.filter(a => a > seq).length;
    const outside = (count: number, steps: number) => (e: SessionEvent, i: number): boolean =>
      i < results.length - count && stepsSince(e.seq) >= steps;

    // Nothing unmasked has aged out of both windows: no mask, however full.
    if (!results.some((e, i) => e.seq > current.through && outside(keep, keepSteps)(e, i))) return 0;
    /*
      When a mask does happen, it reaches further back than the windows — half
      of each stays whole — so they refill over several steps before the next
      one. Masking exactly down to the window meant every new result pushed
      one old one out and every step broke the cached prefix: watched live,
      twelve masks in one turn. This is what "clear at least" is for.
    */
    const older = results.filter(outside(Math.max(1, Math.ceil(keep / 2)), Math.max(1, Math.ceil(keepSteps / 2))));
    if (older.length === 0) return 0;
    const eligible = older.filter((e) => {
      const d = e.data as { name: string; content: string; isError?: boolean };
      return e.seq > current.through && isMaskable(d.name, d.content, d.isError);
    });
    const through = older[older.length - 1]!.seq;

    let freed = 0;
    for (const e of eligible) {
      const d = e.data as { name: string; content: string };
      freed += estimateTokens(d.content) - estimateTokens(maskedResult(d.name, d.content));
    }
    for (const e of session.surfaceEvents()) {
      if (e.type !== 'assistant/message' || e.seq <= current.through || e.seq > through) continue;
      for (const call of (e.data as { toolCalls?: Array<{ input: unknown }> }).toolCalls ?? []) {
        for (const value of Object.values((call.input ?? {}) as Record<string, unknown>)) {
          if (typeof value === 'string' && value.length > MASK_INPUT_MIN_CHARS) freed += estimateTokens(value) - 20;
        }
      }
    }
    if (freed < minFree) return 0;
    if (dryRun) return freed;

    // Restorable: whatever is not already on disk is put there first, so the
    // placeholder can say where the full text went.
    const spills: Record<string, string> = {};
    for (const e of eligible) {
      const d = e.data as { name: string; content: string; callId: string };
      if (spillPathIn(d.content)) continue;
      const ref = saveSpill(d.name, d.content, d.callId);
      if (ref) spills[String(e.seq)] = ref.path;
    }
    session.append('context/masked', {
      throughSeq: through,
      ...(Object.keys(spills).length > 0 ? { spills } : {}),
      tokensFreed: freed,
    });
    this.stats.masks++;
    this.stats.tokensMasked += freed;
    return freed;
  }

  /**
   * Run before each step's request.
   *
   * @param step - the loop's step counter, used to tell a compaction that did
   *   not hold from one that did.
   * @throws ContextOverflowError when compaction keeps failing to make room.
   */
  async beforeStep(step: number): Promise<void> {
    const cfg = this.o.settings?.contextManagement;
    if (cfg?.enabled === false) return;
    const { budget, maskAt, compactAt, keep, keepSteps, minFree } = this.limits();

    let size = this.measure();

    /*
      Say it before it happens, once per run.

      A model that does not know old output will vanish reads, remembers
      nothing, and reads again — the trajectory gets longer, the one cost
      masking is known for. Anthropic's context editing warns the model to
      save what it needs before clearing; this is the same idea for every
      provider: record values and findings where they will survive, while
      they are still in view.
    */
    if (!this.warned && size > maskAt * 0.75 && this.o.warn) {
      this.warned = true;
      this.o.warn(
        'Context note: this is a long run, and older tool output will soon be cleared from your '
        + 'context to keep it focused (the files stay on disk; only what you were shown goes). Keep '
        + 'the values, findings and decisions you will need later somewhere that survives — your '
        + 'todo list, the file you are producing, or a short running summary in your replies — '
        + 'rather than planning to read things again.',
      );
    }

    if (size > maskAt) {
      const freed = this.mask(keep, minFree, false, keepSteps);
      if (freed > 0) {
        size = this.measure();
        this.o.notice?.(
          `Cleared older tool output from the context (~${freed.toLocaleString('en-US')} tokens); `
          + `the ${keep} most recent results stay in full.`,
        );
      }
    }

    if (size <= compactAt) {
      this.thrash = 0;
      return;
    }

    // Over the compaction mark: clear everything but the latest result before
    // summarizing anything — a summary is lossy and costs a model call, a mask
    // is neither — but only when that lands clearly under the mark. When what
    // fills the window is the model's own text and reasoning, which no mask
    // touches, squeezing just under the line meant squeezing again next step,
    // and the step after: watched live, a cache break on every step and the
    // condensation that would actually have helped never running.
    const wouldFree = this.mask(1, minFree, true);
    const squeezed = wouldFree > 0 && size - wouldFree < compactAt * 0.8 ? this.mask(1, minFree) : 0;
    if (squeezed > 0) {
      size = this.measure();
      this.o.notice?.(
        `Cleared older tool output to make room (~${squeezed.toLocaleString('en-US')} tokens); `
        + 'only the latest result stays in full.',
      );
      if (size <= compactAt) {
        this.thrash = 0;
        return;
      }
    }
    if (cfg?.midTurnCompaction === false) return;

    // Compacted just before the last request, and still over: the history is
    // not what fills the window. Once more, then stop rather than loop.
    if (this.compactedAtStep === step - 1) {
      this.thrash++;
      if (this.thrash >= 2) {
        throw new ContextOverflowError(
          `The context stays above ${compactAt.toLocaleString('en-US')} tokens even after compacting `
          + `(now ~${size.toLocaleString('en-US')}). The most recent step alone is too large for this `
          + 'model\'s window — read files in smaller ranges, or use a model with a larger window.',
        );
      }
    }

    // What history may occupy: the mark less the fixed part of every request
    // (system prompt, tools, tail), which no compaction can shrink. Measured
    // from the provider's own count when there is one — the estimate of the
    // fixed part is the least reliable number here.
    const history = this.estimateHistory();
    const fixed = this.lastInput !== undefined
      ? Math.max(0, this.lastInput - this.estimateAtRequest)
      : this.o.overheadTokens;
    const room = Math.max(2_000, compactAt - fixed);
    const tooBig = (): void => {
      if (size > budget * 0.95) {
        throw new ContextOverflowError(
          `The fixed part of each request plus the most recent step fill ~${size.toLocaleString('en-US')} `
          + `of this model's ${budget.toLocaleString('en-US')}-token window, so there is nothing earlier `
          + 'worth condensing. Read files in smaller ranges, or use a model with a larger window.',
        );
      }
    };

    const cut = planMidTurnCut(this.o.session, Math.floor(room * 0.3));
    // A fold has to be worth its summary: a handoff note is a few hundred to a
    // couple of thousand tokens, and folding less than that grows the context.
    // Watched live before this check: "~39,680 → ~40,161 tokens".
    const foldable = cut ? this.rangeTokens(cut.start, cut.end) : 0;
    if (!cut || foldable < Math.max(minFree, 3_000)) {
      tooBig();
      return;
    }

    const narrative = cfg?.modelSummary === false
      ? undefined
      : await this.o.summarize?.().catch(() => undefined);
    const todos = await this.o.readTodos?.().catch(() => undefined);
    const summary = composeSummary(this.o.session, this.o.settings, cut, narrative, todos);
    if (history - foldable + estimateTokens(summary) >= history - 1_000) {
      tooBig();
      return;
    }
    foldRange(this.o.session, this.o.settings, cut, summary, size);
    this.compactedAtStep = step;
    this.stats.compactions++;
    this.o.notice?.(
      `Condensed ${cut.foldedSteps} earlier step(s) of this turn into a handoff note to make room `
      + `(~${size.toLocaleString('en-US')} → ~${this.measure().toLocaleString('en-US')} tokens); `
      + `the ${cut.keptSteps} most recent step(s) stay in full.${narrative ? '' : ' (heuristic summary)'}`,
    );
  }
}
