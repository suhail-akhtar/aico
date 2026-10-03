/**
 * Background agents a restart interrupted: listing them and resuming them.
 *
 * The ledger used to mark every agent that was running at a restart `lost`,
 * which for a background agent meant its work simply stopped and its owner was
 * never told why. Its conversation was on disk the whole time (`sub-<id>`), and
 * so was everything needed to run it again — so now such a row comes back
 * `interrupted` with its spec (work/ledger), and this module continues it
 * (ADR 0021):
 *
 * - only **detached** agents (a `BackgroundTask`, a `Task {detach}`) are resumed
 *   by themselves — a blocking sub-agent's parent turn died with the process, so
 *   nobody is waiting for its answer; it stays `interrupted` and can be resumed
 *   by hand (`Task {resume}`, `POST /api/agents/resume`);
 * - only top-level ones — an agent another agent spawned is its parent's to
 *   resume, and resuming both would run the child twice;
 * - only recent ones (`agents.resumeWithinHours`, default 24) and only when
 *   `agents.resumeAfterRestart` is not off;
 * - **never by replaying a step.** The resume is a new message in the agent's
 *   own conversation saying it was interrupted; a tool call that had not
 *   returned reads as unanswered (session/derive), and the agent is told to
 *   check the real state before repeating anything with side effects.
 *
 * Its report then comes back like any background agent's: into its
 * conversation, waking it when allowed.
 *
 * @module agents/background
 */

import { ledger } from '../work/ledger.js';
import type { WorkRecord } from '../work/types.js';
import type { AicoSettings } from '../settings.js';
import type { TokenTracker } from '../agent.js';
import { runInContext } from '../run-context.js';
import { RESUME_AFTER_RESTART, resumeTask } from '../tools/task.js';
import { deserializeScope } from './scope-json.js';

/** Interrupted agents that can be continued, newest first. */
export function interruptedAgents(sessionId?: string): WorkRecord[] {
  return ledger.query({ kind: 'agent', state: 'interrupted', ...(sessionId ? { sessionId } : {}) })
    .filter(r => r.resume !== undefined)
    .reverse();
}

/** Whether a restart's interrupted agent is one to resume by itself — see the module note. */
export function autoResumable(record: WorkRecord, settings: AicoSettings | undefined, now = Date.now()): boolean {
  if (settings?.agents?.resumeAfterRestart === false) return false;
  const spec = record.resume;
  if (!spec || record.state !== 'interrupted' || !spec.detach) return false;
  if (spec.spawnedFrom?.startsWith('sub-')) return false;
  const hours = settings?.agents?.resumeWithinHours;
  const windowMs = (typeof hours === 'number' && hours > 0 ? hours : 24) * 3_600_000;
  return now - record.heartbeatAt <= windowMs;
}

export interface ResumeOptions {
  settings?: AicoSettings;
  /** The model a resumed agent falls back to when its own is gone. */
  model: string;
  /** The conversation's token tracker, so resumed spend counts against its ceilings. */
  trackerFor?: (sessionId: string, cwd: string) => Promise<TokenTracker | undefined>;
  /** The follow-up it is resumed with. Defaults to {@link RESUME_AFTER_RESTART}. */
  prompt?: string;
}

/**
 * Resume one interrupted (or finished) agent from outside any run — the boot
 * sweep and the API route. Runs in its owner's context so it is filed, bounded
 * and reported exactly as if its parent had asked.
 */
export async function resumeAgentFromOutside(agentId: string, opts: ResumeOptions & { detach?: boolean }): Promise<string> {
  const id = agentId.replace(/^agent:/, '').replace(/^sub-/, '');
  const record = ledger.get(`agent:${id}`);
  const spec = record?.resume;
  if (!spec) return `[error] No resumable agent "${id}".`;
  const owner = spec.owner;
  const tracker = owner && opts.trackerFor ? await opts.trackerFor(owner, spec.logCwd).catch(() => undefined) : undefined;
  const scope = deserializeScope(spec.scope);
  return runInContext(
    {
      cwd: spec.logCwd,
      model: spec.model || opts.model,
      ...(owner ? { sessionId: owner } : {}),
      ...(opts.settings ? { settings: opts.settings } : {}),
    },
    () => resumeTask(
      { resume: id, prompt: opts.prompt ?? RESUME_AFTER_RESTART, detach: opts.detach ?? spec.detach },
      {
        model: spec.model || opts.model,
        autoApprove: spec.autoApprove ?? opts.settings?.autoApprove ?? false,
        verbose: false,
        // The parent's depth: the resumed child is one below it, as before.
        depth: Math.max(0, spec.depth - 1),
        ...(opts.settings ? { settings: opts.settings } : {}),
        ...(tracker ? { tokenTracker: tracker } : {}),
        ...(spec.planMode ? { planMode: true } : {}),
        ...(scope ? { toolScope: scope } : {}),
        ...(spec.toolGroups?.length ? { toolGroups: spec.toolGroups } : {}),
      },
    ),
  );
}

/**
 * The boot sweep: resume what {@link autoResumable} allows. Returns the ids it
 * resumed. Each one runs detached; their reports come back as usual.
 */
export async function resumeInterruptedAgents(opts: ResumeOptions): Promise<string[]> {
  const resumed: string[] = [];
  for (const record of interruptedAgents()) {
    if (!autoResumable(record, opts.settings)) continue;
    const out = await resumeAgentFromOutside(record.id, { ...opts, detach: true }).catch(err => `[error] ${String(err)}`);
    if (!out.startsWith('[error]')) resumed.push(record.id);
  }
  return resumed;
}
