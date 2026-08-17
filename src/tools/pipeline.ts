/**
 * The guarded tool-execution pipeline.
 *
 * Before this existed, everything that had to happen around a tool call —
 * hooks, plan-mode filtering, the bash safety classifier, the permission
 * prompt — lived inline in one closure in `agent.ts`. That works until you want
 * a per-tool timeout, or retry, or metrics, or a loop-breaking guard: each of
 * those then has to be threaded through the same closure, and none of them can
 * be added without touching the agent loop.
 *
 * Here the same concerns are ordered, named stages:
 *
 *   pre-execute (waterfall)   hooks, permission, argument rewriting
 *     → guards (monotonic)    deny or abstain; a guard can never grant
 *       → around-execute      timeout, retry, metrics — wraps dispatch
 *         → tool body
 *       → post-execute        accept / block / replace / add context
 *     → normalize             a throwing stage becomes an error result
 *
 * Two rules make the ordering meaningful rather than decorative:
 *
 *  1. **Guards are monotonic.** A guard returns `deny` or abstains. It cannot
 *     turn a denial into an allow, so owner policy cannot be laundered by
 *     registering a later, more permissive stage.
 *
 *  2. **A denied call still runs post-execute.** Observers that count calls —
 *     metrics, the repeat-tool guard — must see the calls that were refused.
 *     A model hammering a denied tool is precisely the behaviour worth
 *     reacting to, and skipping post-execute on denial would hide it.
 *
 * @module tools/pipeline
 */

import type { MessageSource } from '../session/events.js';

// ── Call context ─────────────────────────────────────────────────────

/** One tool call as it travels through the pipeline. */
export interface ToolCallContext {
  readonly callId: string;
  readonly name: string;
  /**
   * Call arguments. Mutable: a pre-execute stage may rewrite them (path
   * normalization, sandbox confinement, argument defaulting) and the body sees
   * the rewritten form.
   */
  arguments: Record<string, unknown>;
  /** Cancellation for this call. */
  readonly signal?: AbortSignal;
  /**
   * Identity of the calling agent. Guards keep per-agent state, and the tool
   * registry is process-wide, so without this one agent's behaviour would trip
   * another agent's guard.
   */
  readonly agentId: string;
  /** Per-call scratch space, keyed by stage name. */
  readonly state: Map<string, unknown>;
}

// ── Decisions ────────────────────────────────────────────────────────

/** Whether a call may proceed to the tool body. */
export type PreDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string };

/** A guard's verdict. Abstaining defers to the rest of the chain. */
export type GuardVerdict =
  | { kind: 'abstain' }
  | { kind: 'deny'; reason: string };

/** The settled outcome of a tool call. */
export interface ToolOutcome {
  /** Whatever the tool returned; serialized by the caller. */
  result: unknown;
  isError: boolean;
}

/** Model-visible context a stage wants delivered after this step's results. */
export interface AdditionalContext {
  content: string;
  source: MessageSource;
}

/** What post-execute produced. */
export interface PostDecision {
  outcome: ToolOutcome;
  /** Appended after the step's tool results, in registration order. */
  additionalContexts: AdditionalContext[];
}

/** The complete result of running one call through the pipeline. */
export interface PipelineResult {
  outcome: ToolOutcome;
  additionalContexts: AdditionalContext[];
  /** True when the call never reached the tool body. */
  denied: boolean;
  /** Set when the call was denied, for diagnostics. */
  denialReason?: string;
}

// ── Stage signatures ─────────────────────────────────────────────────

/**
 * A waterfall stage. Call `next()` to delegate to the rest of the chain;
 * returning without calling it short-circuits every later stage.
 */
export type PreExecuteStage = (
  ctx: ToolCallContext,
  next: () => Promise<PreDecision>,
) => Promise<PreDecision>;

/** Wraps dispatch. Use for timeout, retry, and metrics. */
export type AroundExecuteStage = (
  ctx: ToolCallContext,
  next: () => Promise<ToolOutcome>,
) => Promise<ToolOutcome>;

/** Observes and may transform the settled outcome. */
export type PostExecuteStage = (
  ctx: ToolCallContext,
  next: () => Promise<PostDecision>,
) => Promise<PostDecision>;

/** Deny-or-abstain policy that runs after pre-execute and cannot grant. */
export type GuardStage = (ctx: ToolCallContext) => Promise<GuardVerdict> | GuardVerdict;

interface Registered<T> {
  name: string;
  fn: T;
}

/** How the tool body is invoked once policy has allowed the call. */
export type Dispatch = (ctx: ToolCallContext) => Promise<unknown>;

// ── The pipeline ─────────────────────────────────────────────────────

/** Ordered, named stages wrapped around every tool call. */
export class ToolPipeline {
  private readonly pre: Registered<PreExecuteStage>[] = [];
  private readonly guards: Registered<GuardStage>[] = [];
  private readonly around: Registered<AroundExecuteStage>[] = [];
  private readonly post: Registered<PostExecuteStage>[] = [];

  /** Register a pre-execute stage. Returns a disposer. */
  onPreExecute(name: string, fn: PreExecuteStage): () => void {
    return this.add(this.pre, { name, fn });
  }

  /** Register a monotonic guard. Returns a disposer. */
  onGuard(name: string, fn: GuardStage): () => void {
    return this.add(this.guards, { name, fn });
  }

  /** Register an around-dispatch stage. Returns a disposer. */
  onAroundExecute(name: string, fn: AroundExecuteStage): () => void {
    return this.add(this.around, { name, fn });
  }

  /** Register a post-execute stage. Returns a disposer. */
  onPostExecute(name: string, fn: PostExecuteStage): () => void {
    return this.add(this.post, { name, fn });
  }

  private add<T>(list: Registered<T>[], entry: Registered<T>): () => void {
    list.push(entry);
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** Names of registered stages, for diagnostics and tests. */
  describe(): { pre: string[]; guards: string[]; around: string[]; post: string[] } {
    return {
      pre: this.pre.map(s => s.name),
      guards: this.guards.map(s => s.name),
      around: this.around.map(s => s.name),
      post: this.post.map(s => s.name),
    };
  }

  /**
   * Run one call through every stage.
   *
   * Never rejects: a stage or body that throws is normalized into an error
   * outcome, because a thrown pipeline is indistinguishable to the model from a
   * tool that failed, and the loop must keep a well-formed call/result pair
   * either way.
   */
  async execute(ctx: ToolCallContext, dispatch: Dispatch): Promise<PipelineResult> {
    let denied = false;
    let denialReason: string | undefined;
    let outcome: ToolOutcome;

    // ── pre-execute ──────────────────────────────────────────────────
    let decision: PreDecision;
    try {
      decision = await this.runPre(ctx);
    } catch (err) {
      return this.normalizedFailure(ctx, err, 'pre-execute');
    }

    // ── guards (monotonic: they may deny, never grant) ────────────────
    if (decision.kind === 'allow') {
      try {
        for (const guard of this.guards) {
          const verdict = await guard.fn(ctx);
          if (verdict.kind === 'deny') {
            decision = { kind: 'deny', reason: verdict.reason };
            break;
          }
        }
      } catch (err) {
        return this.normalizedFailure(ctx, err, 'guard');
      }
    }

    if (decision.kind === 'deny') {
      denied = true;
      denialReason = decision.reason;
      outcome = { result: { error: decision.reason }, isError: true };
    } else {
      // ── around-execute → body ──────────────────────────────────────
      try {
        outcome = await this.runAround(ctx, dispatch);
      } catch (err) {
        outcome = {
          result: { error: err instanceof Error ? err.message : String(err) },
          isError: true,
        };
      }
    }

    // ── post-execute (runs for denied calls too — see module header) ──
    let post: PostDecision;
    try {
      post = await this.runPost(ctx, outcome);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A failing observer must not destroy the tool's real result. Keep the
      // outcome and drop the stage's contribution.
      console.warn(`  ⚠ tool post-execute stage failed for ${ctx.name}: ${reason} (result preserved)`);
      post = { outcome, additionalContexts: [] };
    }

    return {
      outcome: post.outcome,
      additionalContexts: post.additionalContexts,
      denied,
      ...(denialReason === undefined ? {} : { denialReason }),
    };
  }

  private normalizedFailure(ctx: ToolCallContext, err: unknown, stage: string): PipelineResult {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      outcome: { result: { error: `${stage} stage failed for ${ctx.name}: ${reason}` }, isError: true },
      additionalContexts: [],
      denied: true,
      denialReason: reason,
    };
  }

  private runPre(ctx: ToolCallContext): Promise<PreDecision> {
    const stages = this.pre;
    const invoke = (index: number): Promise<PreDecision> => {
      if (index >= stages.length) return Promise.resolve<PreDecision>({ kind: 'allow' });
      return stages[index].fn(ctx, () => invoke(index + 1));
    };
    return invoke(0);
  }

  private runAround(ctx: ToolCallContext, dispatch: Dispatch): Promise<ToolOutcome> {
    const stages = this.around;
    const invoke = async (index: number): Promise<ToolOutcome> => {
      if (index >= stages.length) {
        const result = await dispatch(ctx);
        const isError =
          typeof result === 'object' && result !== null && 'error' in result;
        return { result, isError };
      }
      return stages[index].fn(ctx, () => invoke(index + 1));
    };
    return invoke(0);
  }

  private runPost(ctx: ToolCallContext, outcome: ToolOutcome): Promise<PostDecision> {
    const stages = this.post;
    const invoke = (index: number): Promise<PostDecision> => {
      if (index >= stages.length) {
        return Promise.resolve<PostDecision>({ outcome, additionalContexts: [] });
      }
      return stages[index].fn(ctx, () => invoke(index + 1));
    };
    return invoke(0);
  }
}

/**
 * Helper for post-execute stages that only want to add context.
 *
 * Prepends this stage's contribution to whatever the downstream chain produced,
 * leaving the tool's own result untouched. Replacing `outcome.result` from an
 * advisory stage would rewrite the audit trail with something the tool never
 * returned.
 */
export async function addContext(
  next: () => Promise<PostDecision>,
  contexts: AdditionalContext[],
): Promise<PostDecision> {
  const downstream = await next();
  return {
    outcome: downstream.outcome,
    additionalContexts: [...contexts, ...downstream.additionalContexts],
  };
}
