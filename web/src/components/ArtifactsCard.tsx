/**
 * Artifacts in the browser portal — the list view of what this chat made or
 * opened (documents, sheets, code, exports, images, files), in the side rail.
 *
 * The desktop has the full panel (open beside, split view, rename, export
 * menu); the browser has no side slot for a canvas, so here a canvas row
 * scrolls to its card in the conversation and opens it in place, and a file
 * row downloads. The list comes from the engine (`GET artifacts/list`), the
 * same one the desktop draws; it stays collapsed until opened, refreshes when
 * a turn ends, and hides itself while the chat has made nothing.
 *
 * @module components/ArtifactsCard
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import { api, type ArtifactItem } from '../api';

const LABEL: Record<ArtifactItem['kind'], string> = {
  document: 'Document', sheet: 'Sheet', code: 'Code', image: 'Image', file: 'File', export: 'Export',
};

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ArtifactsCard(): React.ReactElement | null {
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!sessionId) return;
    api.artifactsList(sessionId).then(r => setItems(r.artifacts), () => setItems([]));
  }, [sessionId]);
  useEffect(() => { setItems([]); load(); }, [sessionId, load]);
  useEffect(() => { if (!busy) load(); }, [busy, load]);

  if (!items.length) return null;

  const act = (a: ArtifactItem): void => {
    if (a.source === 'canvas') {
      const card = document.querySelector<HTMLElement>(`[data-canvas-card="${a.id}"]`);
      if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.click(); }
      return;
    }
    void api.artifactFile(sessionId, a.source === 'attachment' ? { attachment: a.id } : { path: a.id }).then(b => download(a.title, b));
  };

  return (
    <section className="pointer-events-auto shrink-0 overflow-hidden rounded-xl border border-aico-border bg-aico-panel/95 shadow-sm backdrop-blur-sm" aria-label="Artifacts">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <span className="text-[11px] font-medium text-aico-primary">Artifacts</span>
        <span className="text-[11px] text-aico-muted">{items.length}</span>
        <span className="ml-auto text-[10px] text-aico-muted">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className="max-h-[320px] overflow-y-auto px-1.5 pb-2">
          {items.map(a => (
            <li key={a.key}>
              <button onClick={() => act(a)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-aico-hover"
                title={a.source === 'canvas' ? 'Show it in the chat' : 'Download'}>
                <span className="w-[54px] shrink-0 text-[10px] uppercase tracking-wide text-aico-muted">{LABEL[a.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-aico-primary">{a.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
