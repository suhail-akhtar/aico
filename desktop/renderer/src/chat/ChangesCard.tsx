/**
 * "4 files changed +56 −8  Review" — Antigravity's end-of-turn summary.
 *
 * Read from the engine's own change report for the session, so it counts what
 * is actually different on disk, not what the agent said it did — and only the
 * files this chat wrote. The report lists every change in the working tree, so
 * counting all of it put "25 files changed" under an answer that touched none:
 * those were the reader's own uncommitted edits. They stay on the Review page.
 *
 * @module desktop/renderer/chat/ChangesCard
 */

import React, { useEffect, useState } from 'react';
import { useStore } from '@web/store';
import { api, type ChangesReport } from '@web/api';
import { go } from '@/state/desk';
import { Icon } from '@/lib/icons';

export function ChangesCard(): React.ReactElement | null {
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);
  const lastSeq = useStore(s => s.lastSeq);
  const [report, setReport] = useState<ChangesReport | null>(null);

  useEffect(() => {
    if (busy) return;
    let live = true;
    api.changes(sessionId).then(r => { if (live) setReport(r); }).catch(() => { if (live) setReport(null); });
    return () => { live = false; };
  }, [sessionId, busy, lastSeq]);

  const files = report?.files.filter(f => f.bySession && !report.reverted.includes(f.path)) ?? [];
  if (!report || files.length === 0) return null;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <button
      className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-aico-border-subtle bg-aico-bg px-4 py-3 text-left transition-colors hover:bg-aico-hover"
      onClick={() => go('changes', { id: sessionId })}
    >
      <Icon name="file-text" size={16} className="text-aico-secondary" />
      <span className="text-[13.5px]">
        {files.length} file{files.length === 1 ? '' : 's'} changed
        <span className="ml-2 font-mono text-[12.5px] text-aico-success">+{added}</span>
        <span className="ml-1 font-mono text-[12.5px] text-aico-danger">−{removed}</span>
      </span>
      <Icon name="chevron-right" size={14} className="text-aico-muted" />
      <span className="flex-1" />
      <span className="rounded-lg border border-aico-border px-2.5 py-1 text-[12.5px] text-aico-secondary">Review</span>
    </button>
  );
}
