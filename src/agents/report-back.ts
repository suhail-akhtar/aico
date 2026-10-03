/**
 * Background work reports back into the conversation that started it.
 *
 * Before this, a detached `Task` or a `BackgroundTask` finished into a void: the
 * result sat in a registry until a `Supervise wait` printed its first 200
 * characters, or a tray notification showed the same 200 characters to a person
 * who may not have been looking. The parent model — the one that delegated the
 * work and has to act on it — never saw the report unless it remembered to go
 * and fetch it, and a turn that had already ended had no way to be told at all
 * (ADR 0021).
 *
 * So a finished background agent (or backgrounded shell command) hands its
 * report here, and this delivers it to the owning conversation:
 *
 * - **turn running** → into the session's inbox at the next step boundary, as a
 *   `plugin` message (`background-agent` / `background-command`). Attributed,
 *   never as the person: a transcript that says "you said this" about a
 *   sub-agent's report cannot be audited.
 * - **turn ended** → the same durable inbox entry (claimed at the start of the
 *   next turn — `runAgent` drains it before the person's message), and, when
 *   `wake` is set and the session allows it, a follow-up turn is started so the
 *   model reads the report now rather than whenever the person next types.
 *
 * How a conversation is reached is the server's business, not this module's —
 * the CLI has no RunManager. The server installs a {@link ReportBackDelivery};
 * without one, a session inbox remembered by the run is used, and with neither
 * the report degrades to a tray notification (the old behaviour) rather than
 * being dropped.
 *
 * A leaf on purpose: `tools/bash.ts` uses it, and anything heavier would close
 * the bash → task → registry → bash cycle (`work/register.ts`). The spill and
 * notification modules are imported lazily for the same reason.
 *
 * What it does not do: decide *whether* to wake (the caller passes `wake`, from
 * {@link wakeOnResult}), or deduplicate against `Supervise wait` (the sub-agent
 * registry knows who is waiting; see `tools/task.ts`).
 *
 * @module agents/report-back
 */

import type { Inbox } from '../session/inbox.js';
import type { AicoSettings } from '../settings.js';

/** Which kind of background work a report came from — the message's `plugin` source. */
export type ReportPlugin = 'background-agent' | 'background-command';

export interface ReportBackRequest {
  /** The conversation (never a `sub-` session — those are routed by the caller). */
  sessionId: string;
  /** The report, already bounded with {@link boundReport}. */
  content: string;
  plugin: ReportPlugin;
  /** Start a turn to read it when none is running. */
  wake: boolean;
  /** Where that conversation's log lives, so a server can open it if it is not open. */
  cwd?: string;
  /** For the notification fallback's title. */
  title?: string;
  /** Whether it ended badly, for the notification fallback's level. */
  failed?: boolean;
}

/**
 * How it landed.
 *
 * - `step`: a turn is running; it reads the report at its next step boundary.
 * - `woken`: no turn was running; one was started to read it.
 * - `queued`: no turn was running and none was started; the next turn reads it first.
 * - `notified`: nothing could reach the conversation; a tray notification was raised.
 */
export type ReportBackOutcome = 'step' | 'woken' | 'queued' | 'notified';

export interface ReportBackDelivery {
  deliver(req: ReportBackRequest): Promise<ReportBackOutcome | false> | ReportBackOutcome | false;
}

let delivery: ReportBackDelivery | undefined;

/** Installed by the server (server/index.ts); unset in the CLI and in tests that want the fallback. */
export function setReportBackDelivery(next: ReportBackDelivery | undefined): void {
  delivery = next;
}

/**
 * Inboxes of conversations run without a server, by session id.
 *
 * The fallback for a host that installed no delivery: the run remembers its
 * inbox here (`runAgent`, depth 0), and a report is queued on it. One entry per
 * session, replaced by each turn — the inbox outlives the turn that made it.
 */
const inboxes = new Map<string, Inbox>();

export function rememberSessionInbox(sessionId: string, inbox: Inbox): void {
  inboxes.set(sessionId, inbox);
  // Bounded: a long-lived CLI process opens few sessions, a test suite many.
  if (inboxes.size > 64) inboxes.delete(inboxes.keys().next().value!);
}

/** Every report delivered in this process, newest last. Tests and diagnostics only; bounded. */
const recent: Array<ReportBackRequest & { outcome: ReportBackOutcome; at: number }> = [];

export function recentReports(): ReadonlyArray<ReportBackRequest & { outcome: ReportBackOutcome; at: number }> {
  return recent;
}

/** Deliver a report to its conversation. Never throws: a report that cannot land is notified instead. */
export async function reportBack(req: ReportBackRequest): Promise<ReportBackOutcome> {
  let outcome: ReportBackOutcome | false = false;
  try {
    if (delivery) outcome = await delivery.deliver(req);
  } catch {
    // The server could not take it (a log that would not open); fall through
    // to the fallbacks rather than losing the report.
    outcome = false;
  }
  if (!outcome) {
    const inbox = inboxes.get(req.sessionId);
    if (inbox) {
      try {
        inbox.inject(req.content, { kind: 'plugin', plugin: req.plugin });
        outcome = 'queued';
      } catch { outcome = false; }
    }
  }
  if (!outcome) {
    try {
      const { pushNotification } = await import('../background/notifications.js');
      pushNotification({
        title: req.title ?? (req.plugin === 'background-agent' ? 'Background agent finished' : 'Background command finished'),
        body: req.content.slice(0, 200),
        level: req.failed ? 'error' : 'success',
      });
    } catch { /* best effort: a notification is the last resort, not a requirement */ }
    outcome = 'notified';
  }
  recent.push({ ...req, outcome, at: Date.now() });
  if (recent.length > 100) recent.shift();
  return outcome;
}

/** The ceiling a delivered report is bounded to — the same as a `Task` result (agent.ts). */
export const REPORT_MAX_CHARS = 40_000;

/**
 * Bound a report the way a `Task` result is bounded: redacted, and past
 * {@link REPORT_MAX_CHARS} a head-and-tail excerpt with the full text spilled
 * to the session workspace and its path named, so nothing is lost.
 */
export async function boundReport(text: string, name: string, id: string): Promise<string> {
  try {
    const { spillResult } = await import('../tools/spill.js');
    return String(spillResult(text, REPORT_MAX_CHARS, name, id));
  } catch {
    return text.length > REPORT_MAX_CHARS
      ? `${text.slice(0, REPORT_MAX_CHARS)}\n\n[… ${text.length - REPORT_MAX_CHARS} more characters not shown]`
      : text;
  }
}

/** Whether a finished background agent may start a turn in a session whose turn has ended. Default yes. */
export function wakeOnResult(settings: AicoSettings | undefined): boolean {
  return settings?.agents?.wakeOnResult !== false;
}

/**
 * What a turn started only to read background reports says.
 *
 * Recorded as a `plugin` message, so it is never shown as something the person
 * typed. The reports themselves arrive just before it (drained from the inbox
 * at the start of the turn).
 */
export const WAKE_TASK = '[Background work finished while no turn was running — its report is above. '
  + 'Read it and continue: tell the user what came back, and carry on with the original request if it still '
  + 'needs work. Do not redo what the report says is done.]';
