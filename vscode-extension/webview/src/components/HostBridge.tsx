/**
 * Hands a tool call to VS Code, and its answer back to the run.
 *
 * Third of a kind, and identical in shape to `EditBridge` for a reason: the
 * server has one mechanism for suspending a tool call on a client, and every
 * use of it looks the same from here. Notice that something is outstanding,
 * pass it along, report what came back.
 *
 * The reporting is not optional, and this is the component where forgetting it
 * costs most. A `VSCodeTasks` run can take two minutes; if its answer is never
 * delivered the turn sits there looking like a slow build, and the reason is
 * invisible on every surface. Every path in the extension's handler ends in an
 * answer, and every answer that arrives here is forwarded.
 *
 * @module components/HostBridge
 */

import { useEffect, useRef } from 'react';
import { useStore } from '@web/store';
import { onHostDone, requestHostCall } from '../host';

export function HostBridge(): null {
  const hostCall = useStore(s => s.hostCall);
  const reportHostCall = useStore(s => s.reportHostCall);

  /** The call already handed over, so a re-render does not run it twice. */
  const sent = useRef<string | null>(null);

  useEffect(() => onHostDone(({ id, answer }) => {
    // An answer for a call that is no longer outstanding would be refused by
    // the server anyway; dropping it here keeps a pointless round trip off the
    // wire and out of the log.
    if (useStore.getState().hostCall?.id !== id) return;
    void reportHostCall(id, answer);
  }), [reportHostCall]);

  useEffect(() => {
    if (!hostCall) { sent.current = null; return; }
    if (sent.current === hostCall.id) return;
    sent.current = hostCall.id;
    requestHostCall(hostCall);
  }, [hostCall]);

  return null;
}
