/**
 * One bounded, unattended run of the agent, for a pipeline (ADR 0034).
 *
 * `aico -p` was written for a person at a terminal who happens to pipe the
 * answer. A CI job needs different guarantees: a hard ceiling on spend and on
 * wall-clock, a log it can read afterwards (the change packet is built from
 * it), a way to hand the model a *smaller* tool set than usual, and no chance
 * of waiting for a human who is not there. Those four are this module; nothing
 * else is, so `review` and `fix-ci` stay about what they decide.
 *
 * `readOnly` is a tool allow-list, not a mode flag the prompt asks the model to
 * respect: the names below are the only tools the run is given (no shell, no
 * writes, no web, no delegation), enforced by the same scope guard that bounds
 * a custom agent. A reviewer that cannot run a command cannot be talked into
 * running one by text in the diff it reads.
 *
 * Deliberately not here: any GitHub call. The process that holds the model's
 * text never holds a repository token (the action's posting step does).
 *
 * @module ci/headless
 */

import { runAgent } from '../agent.js';
import { generateSessionId } from '../history.js';
import { openSession } from '../session/index.js';
import { selectProvider } from '../providers/index.js';
import { createTokenTracker } from '../tokens.js';
import type { Session } from '../session/index.js';
import type { ProviderAPI } from '../providers/types.js';
import type { AicoSettings } from '../settings.js';

/** What a read-only review is allowed to use. No Bash, no WebFetch/WebSearch (an exfiltration path), no Write, no Task. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'Pwd', 'CodebaseMap', 'CodeGraph'] as const;

export interface HeadlessOptions {
  task: string;
  model: string;
  cwd: string;
  settings: AicoSettings;
  /** Give the run only the read-only tool set and no delegation. */
  readOnly: boolean;
  /** Stop once the estimated cost of the run passes this many USD. */
  budgetUsd?: number;
  /** Wall-clock ceiling for the run, in minutes. */
  maxMinutes?: number;
  /** A session name for the log. */
  name?: string;
  /** Tests inject a scripted provider; a real run selects one from settings. */
  provider?: ProviderAPI;
}

export interface HeadlessResult {
  text: string;
  sessionId: string;
  session: Session;
  /** Set when the run was stopped by the cost or time ceiling rather than finishing. */
  stoppedBy?: 'budget' | 'time';
}

export async function runHeadless(o: HeadlessOptions): Promise<HeadlessResult> {
  if (!o.provider) selectProvider(o.model, o.settings); // throws with the fix named when no key is configured
  const sessionId = generateSessionId();
  const opened = await openSession(sessionId, o.cwd, o.name);
  // Limits are applied to the settings object in memory: nothing on disk to forge or forget.
  const settings: AicoSettings = {
    ...o.settings,
    safetyLimits: {
      ...o.settings.safetyLimits,
      ...(o.budgetUsd !== undefined && o.budgetUsd > 0 ? { maxCostPerSession: o.budgetUsd } : {}),
    },
    ...(o.maxMinutes !== undefined && o.maxMinutes > 0 ? { agentTimeout: Math.round(o.maxMinutes * 60_000) } : {}),
    // A review edits nothing, so the completion gate has nothing to hold it to.
    ...(o.readOnly ? { completionGate: { ...o.settings.completionGate, enabled: false } } : {}),
  };
  let text = '';
  try {
    text = await runAgent({
      task: o.task,
      model: o.model,
      showPlan: false,
      // Unattended: a call that needs a person is refused (headless), and a
      // read-only run asks for nothing. A writing run (fix-ci) auto-approves the
      // ordinary tool calls, with shell confinement and the Sentinel still in force.
      autoApprove: !o.readOnly,
      verbose: false,
      silent: true,
      headless: true,
      conversationHistory: [],
      sessionId,
      cwd: o.cwd,
      settings,
      session: opened.session,
      // Without a tracker the loop has nothing to measure spend against and the cost ceiling is silently inert
      // (`aico -p` has this gap today; a pipeline cannot afford it).
      tokenTracker: createTokenTracker(),
      ...(o.readOnly ? { agentSpecTools: [...READ_ONLY_TOOLS], canDelegate: false } : {}),
      ...(o.provider ? { provider: o.provider } : {}),
    });
  } finally {
    await opened.close().catch(() => undefined);
  }
  const turnEnd = [...opened.session.events].reverse().find(e => e.type === 'turn/end');
  const reason = turnEnd ? (turnEnd.data as { reason: { kind: string; cause?: string } }).reason : undefined;
  const stoppedBy = reason?.kind === 'aborted'
    ? (/budget|cost|spend/i.test(reason.cause ?? '') ? 'budget' : /time/i.test(reason.cause ?? '') ? 'time' : undefined)
    : undefined;
  return { text, sessionId, session: opened.session, ...(stoppedBy ? { stoppedBy } : {}) };
}
