/**
 * Hands a pending tool approval to VS Code, and the answer back to the run.
 *
 * Renders nothing. The whole decision happens in a native modal, so there is no
 * markup to draw — which is the point of Phase 3: an approval that lives in the
 * panel can be scrolled past and disappears when the view is hidden, while the
 * turn stays blocked on it.
 *
 * ## Why a component rather than a subscription in the store
 *
 * The store is shared with the browser client, which has no `vscode` to ask and
 * will one day render this in-page instead. Keeping the bridge here means the
 * shared state describes *what is pending* and each surface decides how to ask.
 *
 * @module components/PermissionBridge
 */

import { useEffect, useRef } from 'react';
import { useStore } from '@web/store';
import { onPermissionDecided, requestPermission } from '../host';

export function PermissionBridge(): null {
  const permission = useStore(s => s.permission);
  const permit = useStore(s => s.permit);

  /**
   * The request already handed to VS Code.
   *
   * Without it, every re-render while a modal is open would open another one:
   * `permission` stays set for the whole time the user is deciding, and a
   * second modal for the same call would leave one of them unanswerable.
   */
  const asked = useRef<string | null>(null);

  useEffect(() => onPermissionDecided(({ id, allow }) => {
    // Ignore a decision for a call that is no longer the pending one — a turn
    // can end while a modal is open, and answering then would resolve nothing
    // or, worse, the next call.
    if (useStore.getState().permission?.id !== id) return;
    void permit(allow);
  }), [permit]);

  useEffect(() => {
    if (!permission) { asked.current = null; return; }
    if (asked.current === permission.id) return;
    asked.current = permission.id;
    requestPermission(permission);
  }, [permission]);

  return null;
}
