/**
 * The sandbox's consumer: a monotonic guard on the tool pipeline.
 *
 * A capability with no consumer is decoration, so this is the half that makes
 * the sandbox real. It runs as a **guard** rather than a pre-execute stage
 * precisely because guards can only deny — no later-registered stage can turn a
 * sandbox refusal into an approval.
 *
 * ## Which argument is the path
 *
 * Tools name their path argument differently, and guessing wrong means either
 * failing open (worse) or blocking valid calls (annoying). The mapping is
 * explicit per tool, and a write-capable tool whose path argument is missing is
 * refused rather than allowed: an unrecognised shape is the one not to permit.
 *
 * ## Bash
 *
 * Not path-checkable — a command line is not a path, and parsing shell syntax
 * to find writes is a losing game. Under `read-only` the bash safety classifier
 * and plan mode already restrict it; this guard records that subprocess
 * enforcement is `partial` rather than pretending otherwise.
 *
 * @module sandbox/guard
 */

import type { GuardVerdict, ToolCallContext, ToolPipeline } from '../tools/pipeline.js';
import type { SandboxCapability, SandboxPolicy } from './types.js';

/**
 * Tools that write, and the argument naming their target.
 *
 * Only tools whose effects this backend actually governs appear here. `Bash` is
 * deliberately absent — see the module note.
 */
const WRITE_PATH_ARGUMENTS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Tools that read a specific path, checked so `check()` sees every effect. */
const READ_PATH_ARGUMENTS: Record<string, string> = {
  Read: 'file_path',
};

export interface SandboxGuardOptions {
  sandbox: SandboxCapability;
  policy: SandboxPolicy;
  /**
   * Called when a decision is enforced only partially, so a deployment can
   * surface or escalate it. Without this the distinction would exist in the
   * types and nowhere a user could see it.
   */
  onPartialEnforcement?: (toolName: string, reason: string) => void;
}

/**
 * Register sandbox confinement on a pipeline.
 *
 * @returns a disposer that removes the guard.
 */
export function installSandboxGuard(
  pipeline: ToolPipeline,
  options: SandboxGuardOptions,
): () => void {
  const { sandbox, policy, onPartialEnforcement } = options;

  return pipeline.onGuard('sandbox', (ctx: ToolCallContext): GuardVerdict => {
    if (policy.mode === 'danger-full-access') return { kind: 'abstain' };

    // Subprocesses: permitted, but the caller is told what is not enforced.
    if (ctx.name === 'Bash' || ctx.name === 'BashOutput') {
      const decision = sandbox.describeSubprocessEnforcement(policy);
      if (decision.enforcement === 'partial' && decision.reason) {
        onPartialEnforcement?.(ctx.name, decision.reason);
      }
      return decision.allowed
        ? { kind: 'abstain' }
        : { kind: 'deny', reason: decision.reason ?? 'blocked by sandbox policy' };
    }

    const writeArg = WRITE_PATH_ARGUMENTS[ctx.name];
    if (writeArg !== undefined) {
      const raw = ctx.arguments[writeArg];
      if (typeof raw !== 'string' || raw === '') {
        // A write tool with no analysable target is refused, not allowed.
        return {
          kind: 'deny',
          reason: `sandbox: ${ctx.name} has no "${writeArg}" argument to check`,
        };
      }
      const decision = sandbox.check(raw, 'write', policy);
      return decision.allowed
        ? { kind: 'abstain' }
        : { kind: 'deny', reason: `sandbox: ${decision.reason ?? 'write denied'}` };
    }

    const readArg = READ_PATH_ARGUMENTS[ctx.name];
    if (readArg !== undefined) {
      const raw = ctx.arguments[readArg];
      if (typeof raw === 'string' && raw !== '') {
        const decision = sandbox.check(raw, 'read', policy);
        if (!decision.allowed) {
          return { kind: 'deny', reason: `sandbox: ${decision.reason ?? 'read denied'}` };
        }
      }
    }

    return { kind: 'abstain' };
  });
}
