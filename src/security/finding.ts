/**
 * The one shape every supply-chain / change-safety control reports in (ADR 0033).
 *
 * Three controls (the package guard, the diff scan, the test-tamper guard) and
 * the commit refusals all find things, and the change-evidence report (ADR 0034)
 * reads them back from the session log. One shape means the report has one
 * reader, and each control has one sink to call instead of knowing about the
 * log. The sink is injected (the engine passes {@link runFindingSink}, tests
 * pass their own), so the controls stay testable without a session and cannot
 * append anything but a `safety/finding` event.
 *
 * {@link runFindingSink} is the sink the engine uses: it appends to the log of the
 * run it is called in (the narrow `sessionLog` handle, ADR 0034), so a tool body
 * deep inside a call (the `Git` tool refusing a commit) can record without being
 * handed the session.
 *
 * `detail` is clipped and must never carry a secret value — callers pass the
 * pattern name and a length, as `shared/security/rules.mjs` does.
 *
 * @module security/finding
 */

import type { SessionEventMap } from '../session/events.js';
import { currentRunContext } from '../run-context.js';

/** A finding without the turn number, which the sink adds. */
export type SafetyFinding = Omit<SessionEventMap['safety/finding'], 'turn'>;

/** Where findings go. Must not throw into the caller's control flow. */
export type FindingSink = (finding: SafetyFinding) => void;

/** Clip free text for the record; a record is a fact, not a transcript. */
export function clipDetail(text: string, max = 300): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Call a sink without letting a failing one disturb the control that found something. */
export function emit(sink: FindingSink | undefined, finding: SafetyFinding): void {
  if (!sink) return;
  try { sink({ ...finding, detail: clipDetail(finding.detail) }); } catch { /* a lost record is a gap in a report, not a failed check */ }
}

/** The sink for the run this call is part of; a no-op when the run has no session log. */
export function runFindingSink(): FindingSink {
  return (finding) => {
    const log = currentRunContext()?.sessionLog;
    if (!log) return;
    const events = log.events();
    let turn = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'turn/start') { turn = (e.data as { turn: number }).turn; break; }
    }
    log.record('safety/finding', { turn, ...finding });
  };
}
