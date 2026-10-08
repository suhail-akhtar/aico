/**
 * The narrow door a tool gets onto its run's session log (ADR 0034).
 *
 * The change packet is built from the log, and two of the facts it reports
 * were never in it: a check's exit code and counts as data, and whether a
 * person allowed a call. The code that knows them — `RunChecks`, the permission
 * guard — runs deep inside a tool call, far from the `Session`. Threading the
 * session through every signature was rejected (it is why `RunContext` exists),
 * and handing tools the whole `Session` was rejected harder: a tool that can
 * append any event can append a `user/message` or a `tool/result`, which is
 * forging the surface the model is shown.
 *
 * So the handle can read, and can append exactly the record events whose
 * writers are in the engine. It never throws: a failed append loses a fact in
 * a report, and must not fail the tool call that produced it.
 *
 * @module session/log-handle
 */

import type { SessionLogHandle } from '../run-context.js';
import type { Session } from './session.js';

export function sessionLogHandle(session: Session): SessionLogHandle {
  return {
    events: () => session.events,
    record: (type, data) => {
      try { session.append(type, data); }
      catch { /* a lost record is a gap in a report; it must not fail the call (ADR 0034) */ }
    },
  };
}
