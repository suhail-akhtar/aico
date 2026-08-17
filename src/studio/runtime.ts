/**
 * Studio pipeline runtime adapter.
 *
 * The pipeline engine (src/studio/pipeline.ts) expects a `runTask` callback
 * shaped as `(args: {description, prompt, subagent_type}) => Promise<string>`.
 * The real sub-agent dispatcher in src/tools/task.ts needs a richer `RunTaskOpts`
 * (model, depth, settings, UI callbacks). This adapter bridges the two so the
 * pipeline can spawn sub-agents without knowing about the REPL internals.
 *
 * It also supplies the `askUser` callback the healer uses for escalation, and
 * forwards the session AbortSignal so a cancel/timeout tears down the pipeline.
 */

import { runTask } from '../tools/task.js';
import type { SubAgentType } from '../tools/index.js';
import type { SubAgentRecord } from '../tools/task.js';
import type { AicoSettings } from '../settings.js';

export interface StudioRuntimeOpts {
  model: string;
  autoApprove: boolean;
  verbose: boolean;
  settings?: AicoSettings;
  onSubagentStart?: (rec: SubAgentRecord) => void;
  onSubagentStop?: (rec: SubAgentRecord) => void;
  /** Resolves when the user answers an escalation question. */
  askUser?: (question: string) => Promise<string>;
  /** Aborts the pipeline (cancel/timeout). */
  abortSignal?: AbortSignal;
  /**
   * Optional: per-phase model overrides. Maps phase index (0-based) or phase
   * name to a model ID. When a phase has an entry here (or its PhaseDefinition
   * has a `model` field), that model is used instead of the session default.
   * Enables multi-model pipelines: architect on Claude, backend on GLM, etc.
   */
  phaseModels?: Record<string, string>;
}

/**
 * Build the PipelineOpts.runTask / askUser pair from REPL session state.
 * The returned runTask closes over the session config so callers don't need
 * to thread it through every invocation.
 */
export function createStudioRuntime(opts: StudioRuntimeOpts): {
  runTask: (args: {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string;
  }) => Promise<string>;
  askUser: (question: string) => Promise<string>;
} {
  const runTaskFn = async (args: {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string;
  }): Promise<string> => {
    // Per-phase model: if the phase passes a model, use it; otherwise fall back
    // to the session default. This lets different phases use different models.
    const phaseModel = args.model ?? opts.model;
    return runTask(
      {
        description: args.description,
        prompt: args.prompt,
        // Studio agents run at depth 1 (the pipeline is the top-level orchestrator)
        subagent_type: args.subagent_type as SubAgentType,
      },
      {
        model: phaseModel,
        autoApprove: opts.autoApprove,
        verbose: opts.verbose,
        depth: 1,
        settings: opts.settings,
        onSubagentStart: opts.onSubagentStart,
        onSubagentStop: opts.onSubagentStop,
        abortSignal: opts.abortSignal,
      },
    );
  };

  const askUserFn = async (question: string): Promise<string> => {
    if (opts.askUser) return opts.askUser(question);
    // Default: auto-acknowledge so the pipeline can continue unattended.
    return 'continue';
  };

  return { runTask: runTaskFn, askUser: askUserFn };
}
