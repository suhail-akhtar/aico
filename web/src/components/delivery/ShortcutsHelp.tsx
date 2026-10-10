/**
 * The keyboard shortcuts of the board, as a dialog opened with `?`.
 *
 * The list is data (delivery-board `SHORTCUTS`) so the help and the handler that
 * implements them are written beside each other and a key cannot be documented
 * without existing, or the reverse.
 *
 * @module web/components/delivery/ShortcutsHelp
 */

import React from 'react';
import { SHORTCUTS } from '../../delivery-board';
import { BTN_OUTLINE, Modal } from './ui';

export function ShortcutsHelp({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width="max-w-md">
      <dl className="divide-y divide-aico-border-subtle text-[13px]">
        {SHORTCUTS.map(s => (
          <div key={s.keys} className="flex items-center justify-between gap-4 py-2">
            <dt className="text-aico-primary">{s.does}</dt>
            <dd><kbd className="rounded-md border border-aico-border bg-aico-surface px-1.5 py-0.5 font-mono text-[12px] text-aico-secondary">{s.keys}</kbd></dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-aico-muted">Shortcuts are off while you are typing in a field or a menu is open.</p>
      <div className="mt-3 flex justify-end"><button type="button" className={BTN_OUTLINE} onClick={onClose}>Close</button></div>
    </Modal>
  );
}
