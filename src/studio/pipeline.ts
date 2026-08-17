/**
 * Studio Pipeline Engine.
 * Orchestrates phases: design → implementation (Ralph Loop) → testing → validation → gate → docs.
 * Writes all state to disk (.studio/) and reads fresh each iteration (AUTOMOTIVE pattern).
 */

import {
  readState, writeState, readTasks, readFeedback, writeFeedback,
  clearFeedback, appendContext, type StudioState, type Task,
  getParallelBatch,
} from './state.js';
import { getPhasesForTierWithOverride, type PhaseDefinition } from './phases.js';
import { StudioTracker } from './tracker.js';
import { SelfHealer } from './healer.js';
import { runValidationStack, runTypeCheck, formatValidationResult } from './validation.js';
import { buildPhasePrompt } from './prompts/phases.js';
import { showPhaseProgress, showHealerStatus } from '../ui.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineOpts {
  /** runTask injected from agent runtime — calls runAgent as sub-agent */
  runTask: (args: {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string;
  }) => Promise<string>;

  /** AskUser callback for healer escalation */
  askUser?: (question: string) => Promise<string>;

  /** Signal to abort the pipeline */
  abortSignal?: AbortSignal;
}

export interface PipelineResult {
  success: boolean;
  completedPhases: number;
  totalPhases: number;
  totalIterations: number;
  healAttempts: number;
  durationMs: number;
  summary: string;
}

// ── Pipeline runner ───────────────────────────────────────────────────────────

export async function runPipeline(
  state: StudioState,
  opts: PipelineOpts,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const healer = new SelfHealer();
  const tracker = new StudioTracker(state.projectDir);

  const phases = await getPhasesForTierWithOverride(state.tier, state.projectDir);
  let totalIterations = 0;
  let healAttempts = 0;

  try {
    for (let phaseIdx = state.currentPhase; phaseIdx < phases.length; phaseIdx++) {
      if (opts.abortSignal?.aborted) {
        throw new Error('Studio aborted');
      }

      const phase = phases[phaseIdx];
      const phaseNumber = phaseIdx + 1;

      // T2: Check phase condition before running (enables conditional pipeline flow)
      if (phase.condition && phase.condition !== 'always') {
        const cond = phase.condition.toLowerCase();
        let shouldRun = true;

        if (cond === 'skip' || cond === 'never') {
          shouldRun = false;
        } else if (cond.includes('if-previous-succeeded') || cond.includes('if-prev-success')) {
          // Only run if the previous phase succeeded
          if (phaseIdx > 0) {
            const prev = state.phases[phaseIdx - 1];
            shouldRun = prev?.status === 'done';
          }
        } else if (cond.includes('if-feedback') && cond.includes('non-empty')) {
          // Only run if FEEDBACK.md has content
          const feedback = await readFeedback(state.projectDir);
          shouldRun = !!feedback?.trim();
        } else if (cond.includes('if-feedback') && cond.includes('empty')) {
          const feedback = await readFeedback(state.projectDir);
          shouldRun = !feedback?.trim();
        }

        if (!shouldRun) {
          state.phases[phaseIdx].status = 'skipped';
          await writeState(state.projectDir, state);
          showPhaseProgress(phaseNumber, state.totalPhases, phase.name, 'skipped', `condition: ${phase.condition}`);
          continue;
        }
      }

      // Update state
      state.currentPhase = phaseNumber;
      state.phases[phaseIdx].status = 'running';
      state.phases[phaseIdx].startedAt = Date.now();
      await writeState(state.projectDir, state);

      showPhaseProgress(phaseNumber, state.totalPhases, phase.name, 'running');

      try {
        const phaseIterations = await runPhase(phase, state, opts, tracker);
        totalIterations += phaseIterations;

        // Run validation stack after implementation phases
        if (phase.runValidationAfter) {
          const valResult = await runValidationStack(state.projectDir);
          process.stdout.write(`\n${formatValidationResult(valResult)}\n`);

          if (!valResult.pass) {
            // Write errors to feedback and try healer
            await writeFeedback(state.projectDir, valResult.firstFailure?.output ?? 'Validation failed');
            const errors = valResult.firstFailure?.output ?? '';

            showHealerStatus(1, 3, 'retry', errors.split('\n')[0] ?? '');
            state.healAttempts++;
            healAttempts++;

            const healResult = await healer.heal(state, phase, errors, {
              runTask: opts.runTask,
              askUser: opts.askUser,
            });

            if (!healResult.success && !healResult.escalated) {
              state.phases[phaseIdx].status = 'failed';
              state.phases[phaseIdx].errorCount++;
              await writeState(state.projectDir, state);
              showPhaseProgress(phaseNumber, state.totalPhases, phase.name, 'failed', 'healer exhausted');
              // Continue to next phase (don't abort entire pipeline on one phase failure)
              continue;
            }
          }
        }

        // Mark phase done
        const now = Date.now();
        state.phases[phaseIdx].status = 'done';
        state.phases[phaseIdx].completedAt = now;
        state.phases[phaseIdx].durationMs = now - (state.phases[phaseIdx].startedAt ?? now);
        state.phases[phaseIdx].iterations = phaseIterations;
        await writeState(state.projectDir, state);

        const duration = ((state.phases[phaseIdx].durationMs ?? 0) / 1000).toFixed(0);
        showPhaseProgress(phaseNumber, state.totalPhases, phase.name, 'done', `${duration}s`);
        await appendContext(state.projectDir, `Phase ${phaseNumber} (${phase.name}) completed in ${duration}s`);

      } catch (phaseErr) {
        const msg = phaseErr instanceof Error ? phaseErr.message : String(phaseErr);
        if (msg === 'Studio aborted') throw phaseErr;

        state.phases[phaseIdx].status = 'failed';
        state.phases[phaseIdx].errorCount++;
        await writeState(state.projectDir, state);
        showPhaseProgress(phaseNumber, state.totalPhases, phase.name, 'failed', msg.slice(0, 60));
        await appendContext(state.projectDir, `Phase ${phaseNumber} FAILED: ${msg}`);
      }
    }

    const summary = buildDeliverySummary(state, tracker, Date.now() - startTime, healAttempts);
    return {
      success: state.phases.every(p => p.status === 'done' || p.status === 'skipped'),
      completedPhases: state.phases.filter(p => p.status === 'done').length,
      totalPhases: state.totalPhases,
      totalIterations,
      healAttempts,
      durationMs: Date.now() - startTime,
      summary,
    };

  } finally {
    tracker.close();
  }
}

// ── Phase execution ───────────────────────────────────────────────────────────

async function runPhase(
  phase: PhaseDefinition,
  state: StudioState,
  opts: PipelineOpts,
  tracker: StudioTracker,
): Promise<number> {
  if (phase.kind === 'implementation') {
    return runImplementationLoop(phase, state, opts, tracker);
  }
  return runSinglePhase(phase, state, opts, tracker);
}

/**
 * Ralph Loop — fresh agent session per iteration, disk is the only state.
 */
async function runImplementationLoop(
  phase: PhaseDefinition,
  state: StudioState,
  opts: PipelineOpts,
  tracker: StudioTracker,
): Promise<number> {
  const maxIterations = phase.maxIterations;
  let iteration = 0;

  for (iteration = 0; iteration < maxIterations; iteration++) {
    if (opts.abortSignal?.aborted) break;

    // Read state fresh from disk each iteration (AUTOMOTIVE Ralph Loop pattern)
    const tasks = await readTasks(state.projectDir);
    const remaining = tasks.filter(t => t.status === 'pending' || t.status === 'failed');

    if (remaining.length === 0) break;

    // Topological sort → find tasks with no unmet dependencies
    const batch = getParallelBatch(remaining);
    if (batch.length === 0) {
      // Deadlock: tasks with circular or unresolvable dependencies
      await writeFeedback(state.projectDir, 'Dependency deadlock: no tasks can be executed. Check DependsOn annotations in TASKS.md');
      break;
    }

    const feedback = await readFeedback(state.projectDir);
    const context = await getContextSummary(state.projectDir);

    const prompt = await buildPhasePrompt(phase, state, batch, {
      feedback: feedback || undefined,
      priorContext: context || undefined,
      iteration: iteration + 1,
    });

    // Record iteration start
    const iterRecord = tracker.startIteration(state.currentPhase, iteration + 1, phase.agentType);

    try {
      await opts.runTask({
        description: `${phase.name} — iter ${iteration + 1}/${maxIterations} (${batch.length} tasks)`,
        prompt,
        subagent_type: phase.agentType,
        ...(phase.model ? { model: phase.model } : {}),
      });

      // Quick type check between iterations (fast feedback)
      const tc = await runTypeCheck(state.projectDir);
      if (!tc.pass) {
        const errText = tc.errors.join('\n');
        await writeFeedback(state.projectDir, errText);
        tracker.completeIteration(iterRecord, 'failed', tc.errors.length);

        // Activate healer after 2nd consecutive error
        if (iteration >= 1) {
          showHealerStatus(1, 3, 'retry', tc.errors[0] ?? '');
          state.healAttempts++;

          const healer = new SelfHealer();
          const healResult = await healer.heal(
            state,
            phase,
            errText,
            { runTask: opts.runTask, askUser: opts.askUser },
          );

          if (!healResult.success && !healResult.escalated) break;
          // If replan strategy was used, TASKS.md was updated — re-read on next iteration
        }
      } else {
        await clearFeedback(state.projectDir);
        tracker.completeIteration(iterRecord, 'success', 0);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tracker.completeIteration(iterRecord, 'failed', 1);
      await writeFeedback(state.projectDir, `Agent error in iteration ${iteration + 1}: ${msg}`);
    }

    state.iteration++;
    await writeState(state.projectDir, state);
  }

  return iteration;
}

/**
 * Single-shot phase (design, testing, documentation, gate).
 */
async function runSinglePhase(
  phase: PhaseDefinition,
  state: StudioState,
  opts: PipelineOpts,
  tracker: StudioTracker,
): Promise<number> {
  const feedback = await readFeedback(state.projectDir);
  const tasks = await readTasks(state.projectDir);
  const phaseTasks = tasks.filter(t => t.phase === state.currentPhase);
  const batch = phaseTasks.length > 0 ? phaseTasks : [];

  const prompt = await buildPhasePrompt(phase, state, batch, {
    feedback: feedback || undefined,
    iteration: 1,
  });

  const iterRecord = tracker.startIteration(state.currentPhase, 1, phase.agentType);

  try {
    await opts.runTask({
      description: `${phase.name}`,
      prompt,
      subagent_type: phase.agentType,
      ...(phase.model ? { model: phase.model } : {}),
    });
    tracker.completeIteration(iterRecord, 'success', 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tracker.completeIteration(iterRecord, 'failed', 1);
    throw new Error(`Phase "${phase.name}" agent failed: ${msg}`);
  }

  return 1;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getContextSummary(projectDir: string): Promise<string> {
  const { readContext } = await import('./state.js');
  const ctx = await readContext(projectDir);
  // Return last 2000 chars of context (most recent)
  return ctx.slice(-2000);
}

function buildDeliverySummary(
  state: StudioState,
  tracker: StudioTracker,
  durationMs: number,
  healAttempts: number,
): string {
  const summary = tracker.getSummary();
  const minutes = Math.round(durationMs / 60_000);
  const completedPhases = state.phases.filter(p => p.status === 'done').length;

  return [
    `## Studio Delivery Summary`,
    ``,
    `**Project:** ${state.projectDir}`,
    `**Tier:** ${state.tier} | **Stack:** ${state.stack}`,
    `**Duration:** ${minutes} minutes`,
    ``,
    `### Pipeline Results`,
    `- Phases completed: ${completedPhases}/${state.totalPhases}`,
    `- Total iterations: ${state.iteration}`,
    `- Self-healer activations: ${healAttempts}`,
    ``,
    `### Feature Tracker`,
    `- Total features: ${summary.totalFeatures}`,
    `- Completed: ${summary.complete}`,
    `- Failed: ${summary.failed}`,
    `- Pending: ${summary.pending}`,
    ``,
    `### Phase Timeline`,
    ...state.phases.map(p => {
      const icon = p.status === 'done' ? '✅' : p.status === 'failed' ? '✖' : '⏸';
      const dur = p.durationMs ? ` (${Math.round(p.durationMs / 1000)}s)` : '';
      return `${icon} Phase ${p.index}: ${p.name}${dur}`;
    }),
    ``,
    `### How to Run`,
    `\`\`\`bash`,
    `cd ${state.projectDir}`,
    `cp .env.example .env    # configure environment variables`,
    `npm install`,
    `npm run dev`,
    `\`\`\``,
    ``,
    `Read \`${state.projectDir}/README.md\` for full setup instructions.`,
  ].join('\n');
}
