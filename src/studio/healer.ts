/**
 * Self-healer — 3-strategy autonomous error recovery.
 * retry → simplify → replan → AskUser (if all fail)
 */

import { classifyError, type ErrorType } from './validation.js';
import { buildHealerPrompt } from './prompts/phases.js';
import { readFeedback, writeFeedback } from './state.js';
import type { StudioState } from './state.js';
import type { PhaseDefinition } from './phases.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type HealStrategy = 'retry' | 'simplify' | 'replan';

export interface HealResult {
  success: boolean;
  strategy: HealStrategy;
  attempt: number;
  errorType: ErrorType;
  escalated: boolean;   // true if all 3 strategies failed → human needed
}

// ── Options passed in from pipeline ──────────────────────────────────────────

export interface HealerOpts {
  /** runTask function from the agent runtime — injected by pipeline */
  runTask: (args: {
    description: string;
    prompt: string;
    subagent_type: string;
  }) => Promise<string>;

  /** AskUserQuestion callback — injected from agent callbacks */
  askUser?: (question: string) => Promise<string>;
}

// ── Core healer ───────────────────────────────────────────────────────────────

export class SelfHealer {
  private readonly strategies: HealStrategy[] = ['retry', 'simplify', 'replan'];

  async heal(
    state: StudioState,
    phase: PhaseDefinition,
    errors: string,
    opts: HealerOpts,
  ): Promise<HealResult> {
    const errorType = classifyError(errors);

    for (let i = 0; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];
      const attempt = i + 1;

      const prompt = buildHealerPrompt({
        strategy,
        attempt,
        phaseName: phase.name,
        projectDir: state.projectDir,
        errors,
        errorType,
      });

      try {
        await opts.runTask({
          description: `Healer [${attempt}/3] ${strategy} — ${phase.name}`,
          prompt,
          subagent_type: 'healer',
        });

        // Check if healer resolved the errors
        const remainingFeedback = await readFeedback(state.projectDir);
        const resolved = !remainingFeedback.trim() || this.isResolved(remainingFeedback);

        if (resolved) {
          return { success: true, strategy, attempt, errorType, escalated: false };
        }

        // Update errors for next attempt
        errors = remainingFeedback || errors;

      } catch (err) {
        // Healer sub-agent itself crashed — log and try next strategy
        const errMsg = err instanceof Error ? err.message : String(err);
        await writeFeedback(
          state.projectDir,
          `Healer strategy '${strategy}' crashed: ${errMsg}\n\nOriginal errors:\n${errors}`,
        );
      }
    }

    // All 3 strategies failed — escalate to human if possible
    if (opts.askUser) {
      const answer = await opts.askUser(
        `Studio is stuck on phase "${phase.name}" after 3 heal attempts.\n` +
        `Last error: ${errors.slice(0, 200)}\n\n` +
        `Options:\n` +
        `  (1) Skip this phase and continue\n` +
        `  (2) Abort studio\n` +
        `  (3) Enter guidance for the healer\n\n` +
        `Enter 1, 2, or your custom instructions:`,
      );

      const trimmed = answer.trim();

      if (trimmed === '1' || trimmed.toLowerCase() === 'skip') {
        return { success: true, strategy: 'replan', attempt: 3, errorType, escalated: true };
      }

      if (trimmed === '2' || trimmed.toLowerCase() === 'abort') {
        throw new Error('Studio aborted by user after healer exhaustion');
      }

      // User provided guidance — try one more time with their input
      const guidedPrompt = buildHealerPrompt({
        strategy: 'retry',
        attempt: 4,
        phaseName: phase.name,
        projectDir: state.projectDir,
        errors: `User guidance: ${trimmed}\n\nErrors:\n${errors}`,
        errorType,
      });

      try {
        await opts.runTask({
          description: `Healer [guided] — ${phase.name}`,
          prompt: guidedPrompt,
          subagent_type: 'healer',
        });

        const remaining = await readFeedback(state.projectDir);
        const resolved = !remaining.trim() || this.isResolved(remaining);
        return { success: resolved, strategy: 'retry', attempt: 4, errorType, escalated: true };
      } catch {
        return { success: false, strategy: 'replan', attempt: 3, errorType, escalated: true };
      }
    }

    return { success: false, strategy: 'replan', attempt: 3, errorType, escalated: true };
  }

  private isResolved(feedback: string): boolean {
    // Consider resolved if feedback only has empty lines or comment-like content
    const meaningful = feedback
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('<!--'))
      .join('');
    return meaningful.length === 0;
  }
}

/** Format a heal result for terminal output */
export function formatHealResult(result: HealResult): string {
  if (result.success) {
    return `Healed with strategy: ${result.strategy} (attempt ${result.attempt})`;
  }
  return result.escalated
    ? `Healer escalated to human after ${result.attempt} attempts`
    : `Healer failed after ${result.attempt} attempts — manual intervention needed`;
}
