/**
 * Add a task without leaving the board: one line, Enter, and the box stays for the next.
 *
 * The line is read by the engine's own parser (shared/delivery/quickadd): `!1` priority, `#label`,
 * `@person`, `due:2026-10-20` (or today, tomorrow, +3d) and `type:bug`; anything else is the title. A task made here has no acceptance criteria yet, which the
 * drawer invites you to add; the full dialog (N) is for the task that needs them up front.
 * It is created in the column it is opened from (Backlog, or Ready).
 *
 * @module web/components/delivery/QuickAdd
 */

import React, { useState } from 'react';
import { api } from '../../api';
import { upsertTask } from '../../delivery';
import { parseQuickAdd } from '../../../../shared/delivery/quickadd';
import type { Task } from '../../delivery-types';
import { INPUT } from './ui';

export function QuickAdd({ project, status, placeholder, onCreated, onError, onCancel, autoFocus }: {
  project: string; status: 'backlog' | 'ready'; placeholder?: string; onCreated: (t: Task) => void; onError: (m: string) => void; onCancel?: () => void; autoFocus?: boolean;
}): React.ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    const p = parseQuickAdd(text);
    if (!p.title) return;
    setBusy(true);
    try {
      let t = await api.deliveryCreate({
        project, title: p.title, ...(p.priority ? { priority: p.priority } : {}), ...(p.labels.length ? { labels: p.labels } : {}),
        ...(p.type ? { type: p.type } : {}), ...(p.dueDate ? { dueDate: p.dueDate } : {}),
        ...(p.assignee ? { assignee: { kind: /^agent\b/i.test(p.assignee) ? 'agent' as const : 'person' as const, name: p.assignee } } : {}),
      });
      if (status === 'ready') t = await api.deliveryUpdate(t.id, project, { status: 'ready' });
      upsertTask(t);
      onCreated(t);
      setText('');
    } catch (e) { onError(`Could not add the task: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input
        autoFocus={autoFocus} value={text} disabled={busy} onChange={e => setText(e.target.value)} aria-label={status === 'ready' ? 'Add a task to Ready' : 'Add a task to the backlog'}
        placeholder={placeholder ?? 'Add a task  (Enter)'} className={`${INPUT} !py-1.5 !text-[12.5px]`}
        onKeyDown={e => { if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } }}
      />
    </form>
  );
}
