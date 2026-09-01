/**
 * Hands a pending file write to VS Code, and the outcome back to the run.
 *
 * Renders nothing, for the same reason `PermissionBridge` renders nothing: the
 * work happens in the editor. The panel's part is only to notice that a write is
 * outstanding, pass it along, and report what came back.
 *
 * The reporting is not optional. A tool call is blocked on this — the engine is
 * holding a promise, the server is holding its resolver — so an outcome that
 * never arrives is a turn that never finishes. Every path here ends in a report,
 * including the ones that fail.
 *
 * @module components/EditBridge
 */

import { useEffect, useRef } from 'react';
import { useStore } from '@web/store';
import { onEditDone, requestEdit } from '../host';

export function EditBridge(): null {
  const edit = useStore(s => s.edit);
  const reportEdit = useStore(s => s.reportEdit);

  /** The write already handed over, so a re-render does not apply it twice. */
  const sent = useRef<string | null>(null);

  useEffect(() => onEditDone(({ id, applied, reason }) => {
    // A report for a write that is no longer outstanding would be refused by
    // the server anyway; skipping it here keeps a pointless round trip off the
    // wire and out of the log.
    if (useStore.getState().edit?.id !== id) return;
    void reportEdit(id, applied, reason);
  }), [reportEdit]);

  useEffect(() => {
    if (!edit) { sent.current = null; return; }
    if (sent.current === edit.id) return;
    sent.current = edit.id;
    requestEdit(edit);
  }, [edit]);

  return null;
}
