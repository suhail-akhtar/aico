/**
 * Artifacts — everything this chat produced or opened, in the right-hand
 * slot: documents, sheets, code canvases, exported and generated files,
 * images, attachments.
 *
 * The list is the engine's (`GET artifacts/list`, `server/artifact-routes`),
 * which joins the three stores a chat's work lives in; this panel only
 * groups and acts on it. Grouped by type (Documents, Sheets, Code, Images,
 * Files) or by topic (an export sits under the canvas it came from). A canvas
 * opens beside the chat — or beside the one already open, for a document and
 * its sheet side by side — and can be renamed, exported, or found in the chat
 * (its card is scrolled to and flashed). A file downloads through the native
 * save dialog, opens with the system app, or is renamed in place.
 *
 * Refreshed when it opens, on every canvas frame, and when a turn ends —
 * that is when exports and generated images appear. The panel belongs to the
 * chat: switching chats closes it, like Sources and the canvas.
 *
 * @module desktop/renderer/chat/ArtifactsPanel
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '@web/store';
import { api, type ArtifactItem } from '@web/api';
import { onCanvasEvent } from '@aico/ui';
import { getCanvasHost } from '@aico/shared/ui/canvas/host';
import { Icon } from '@/lib/icons';
import { ago, bytes, cls } from '@/lib/util';
import { desktop } from '@/desktop';
import { toast } from '@/state/desk';
import { useCanvasPanel } from './CanvasPanel';

export const useArtifactsPanel = create<{ open: boolean; toggle: () => void; close: () => void }>(set => ({
  open: false,
  toggle: () => set(s => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

type Grouping = 'type' | 'topic';
const GROUP_KEY = 'aico.desk.artifactsGroup';

const TYPE_GROUPS: Array<{ name: string; kinds: ArtifactItem['kind'][] }> = [
  { name: 'Documents', kinds: ['document'] },
  { name: 'Sheets', kinds: ['sheet'] },
  { name: 'Code', kinds: ['code'] },
  { name: 'Exports', kinds: ['export'] },
  { name: 'Images', kinds: ['image'] },
  { name: 'Files', kinds: ['file'] },
];

const ICON: Record<ArtifactItem['kind'], string> = {
  document: 'file-text', sheet: 'table', code: 'code', image: 'image', file: 'file', export: 'download',
};

const EXPORTS: Record<string, Array<{ format: 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv'; label: string }>> = {
  document: [{ format: 'docx', label: 'Word (.docx)' }, { format: 'pdf', label: 'PDF' }, { format: 'md', label: 'Markdown' }, { format: 'html', label: 'Web page' }],
  sheet: [{ format: 'xlsx', label: 'Excel (.xlsx)' }, { format: 'csv', label: 'CSV' }],
  code: [{ format: 'md', label: 'Markdown' }],
};

function base64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

async function saveAs(name: string, blob: Blob): Promise<void> {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const where = await desktop.dialog.saveFile({
    defaultName: name, content: base64(await blob.arrayBuffer()), encoding: 'base64',
    ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {}),
  });
  if (where) toast.success('Saved', where);
}

/** Scroll the transcript to a canvas's card and flash it — "where in the chat did this come from". */
function showInChat(id: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-canvas-card="${id}"]`);
  if (!card) return false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.animate([{ boxShadow: '0 0 0 3px var(--aico-accent)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1600 });
  return true;
}

export function ArtifactsPanel(): React.ReactElement | null {
  const open = useArtifactsPanel(s => s.open);
  const close = useArtifactsPanel(s => s.close);
  const sessionId = useStore(s => s.sessionId);
  const busy = useStore(s => s.busy);
  const [items, setItems] = useState<ArtifactItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<Grouping>(() => {
    try { return localStorage.getItem(GROUP_KEY) === 'topic' ? 'topic' : 'type'; } catch { return 'type'; }
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!sessionId) return;
    api.artifactsList(sessionId).then(r => { setItems(r.artifacts); setError(null); }, err => setError(err instanceof Error ? err.message : String(err)));
  }, [sessionId]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => { if (open && !busy) load(); }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (open ? onCanvasEvent(() => load()) : undefined), [open, load]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !document.querySelector('[role="menu"]')) close(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open, close]);

  const groups = useMemo(() => {
    const list = items ?? [];
    if (grouping === 'type') {
      return TYPE_GROUPS.map(g => ({ name: g.name, items: list.filter(a => g.kinds.includes(a.kind)) })).filter(g => g.items.length);
    }
    const by = new Map<string, ArtifactItem[]>();
    for (const a of list) by.set(a.topic, [...(by.get(a.topic) ?? []), a]);
    return [...by.entries()].map(([name, xs]) => ({ name, items: xs.sort((x, y) => (x.source === 'canvas' ? -1 : 0) - (y.source === 'canvas' ? -1 : 0)) }));
  }, [items, grouping]);

  if (!open) return null;

  const setGroup = (g: Grouping): void => { setGrouping(g); try { localStorage.setItem(GROUP_KEY, g); } catch { /* not remembered */ } };
  const ref = (a: ArtifactItem) => ({ id: a.id, title: a.title, kind: a.kind as 'document' | 'sheet' | 'code', ...(a.language ? { language: a.language } : {}) });
  const openCanvas = (a: ArtifactItem, beside = false): void => {
    if (beside) useCanvasPanel.getState().showBeside(ref(a)); else useCanvasPanel.getState().show(ref(a));
    close();
  };
  const fileBlob = (a: ArtifactItem): Promise<Blob> => api.artifactFile(sessionId, a.source === 'attachment' ? { attachment: a.id } : { path: a.id });

  const rename = async (a: ArtifactItem, name: string): Promise<void> => {
    setRenaming(null);
    const next = name.trim();
    if (!next || next === a.title) return;
    try {
      if (a.source === 'canvas') await api.canvasRename(sessionId, a.id, next);
      else if (a.source === 'file') await api.artifactRename(sessionId, a.id, next);
      load();
    } catch (err) { toast.error('Not renamed', err instanceof Error ? err.message : String(err)); }
  };

  const exportCanvas = async (a: ArtifactItem, format: 'docx' | 'pdf' | 'md' | 'html' | 'xlsx' | 'csv'): Promise<void> => {
    setMenuFor(null);
    const host = getCanvasHost();
    if (!host?.exportFile) return;
    try {
      const { blob, name } = await host.exportFile(a.id, format);
      await saveAs(name, blob);
    } catch (err) { toast.error('Export failed', err instanceof Error ? err.message : String(err)); }
  };

  const row = (a: ArtifactItem): React.ReactElement => {
    const canvas = a.source === 'canvas';
    const canOpenBeside = canvas && useCanvasPanel.getState().open && useCanvasPanel.getState().open!.id !== a.id;
    return (
      <li key={a.key} className="group relative rounded-xl px-2 py-1.5 hover:bg-aico-hover" data-artifact={a.key}>
        <div className="flex items-center gap-2.5">
          {a.kind === 'image' && a.source !== 'canvas' ? (
            <img alt="" className="h-8 w-8 shrink-0 rounded-md border border-aico-border-subtle object-cover" loading="lazy"
              src={a.source === 'attachment'
                ? `/api/attachments/file?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(a.id)}`
                : `/api/artifacts/file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(a.id)}`} />
          ) : (
            <span className={cls('grid h-8 w-8 shrink-0 place-items-center rounded-md',
              a.kind === 'sheet' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-aico-accent-soft text-aico-accent')}>
              <Icon name={ICON[a.kind]} size={16} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {renaming === a.key ? (
              <input autoFocus defaultValue={a.title} className="input h-7 w-full py-0 text-[13px]" aria-label="New name"
                onBlur={e => void rename(a, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <button className="block w-full truncate text-left text-[13.5px] font-medium text-aico-primary" title={canvas ? 'Open beside the chat' : 'Save a copy'}
                onClick={() => (canvas ? openCanvas(a) : void fileBlob(a).then(b => saveAs(a.title, b)))}>{a.title}</button>
            )}
            <div className="truncate text-[11.5px] text-aico-muted">
              {a.kind === 'export' ? 'export' : a.kind}{a.ext && a.kind !== 'export' ? ` · .${a.ext}` : a.ext ? ` .${a.ext}` : ''}
              {a.bytes !== undefined ? ` · ${bytes(a.bytes)}` : ''} · {ago(a.updatedAt)}{a.uploaded ? ' · uploaded' : ''}
            </div>
          </div>
          <button className="icon-btn-sm opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Actions for ${a.title}`} aria-haspopup="menu"
            onClick={() => setMenuFor(menuFor === a.key ? null : a.key)}><Icon name="more" size={16} /></button>
        </div>
        {menuFor === a.key && (
          <div role="menu" className="absolute right-2 top-10 z-20 flex w-[220px] flex-col rounded-xl border border-aico-border bg-aico-panel p-1 text-[13px] shadow-lg">
            {canvas && <button role="menuitem" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-aico-hover" onClick={() => { setMenuFor(null); openCanvas(a); }}>Open</button>}
            {canvas && (
              <button role="menuitem" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-aico-hover disabled:opacity-50" disabled={!canOpenBeside}
                title={canOpenBeside ? 'Open next to the canvas already open' : 'Open another canvas first'}
                onClick={() => { setMenuFor(null); openCanvas(a, true); }}>Open beside {canOpenBeside ? `"${useCanvasPanel.getState().open!.title ?? ''}"` : ''}</button>
            )}
            {canvas && (EXPORTS[a.kind] ?? []).map(x => (
              <button key={x.format} role="menuitem" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-aico-hover" onClick={() => void exportCanvas(a, x.format)}>Export as {x.label}</button>
            ))}
            {!canvas && <button role="menuitem" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-aico-hover" onClick={() => { setMenuFor(null); void fileBlob(a).then(b => saveAs(a.title, b)); }}>Download…</button>}
            {a.source !== 'attachment' && <button role="menuitem" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-aico-hover" onClick={() => { setMenuFor(null); setRenaming(a.key); }}>Rename</button>}
            {canvas && (
              <button role="menuitem" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-aico-hover"
                onClick={() => { setMenuFor(null); if (!showInChat(a.id)) toast.info('Not in the visible chat', 'Its card is further up — scroll up to load earlier messages.'); }}>Show in chat</button>
            )}
          </div>
        )}
      </li>
    );
  };

  const count = items?.length ?? 0;
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-aico-border-subtle bg-aico-bg animate-fade-in" aria-label="Artifacts" data-artifacts-panel="">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h2 className="text-[15px] font-semibold">Artifacts</h2>
        <span className="text-[13px] text-aico-muted">· {count}</span>
        <span className="flex-1" />
        <div className="flex rounded-lg border border-aico-border-subtle p-0.5 text-[12px]" role="radiogroup" aria-label="Group by">
          {(['type', 'topic'] as const).map(g => (
            <button key={g} role="radio" aria-checked={grouping === g} className={cls('rounded-md px-2 py-0.5', grouping === g ? 'bg-aico-hover text-aico-primary' : 'text-aico-muted')}
              onClick={() => setGroup(g)}>{g === 'type' ? 'Type' : 'Topic'}</button>
          ))}
        </div>
        <button className="icon-btn-sm" onClick={load} title="Refresh" aria-label="Refresh"><Icon name="refresh" size={15} /></button>
        <button className="icon-btn-sm" onClick={close} title="Close (Esc)" aria-label="Close artifacts"><Icon name="x" size={16} /></button>
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-4" onClick={(e) => { if (!(e.target as HTMLElement).closest('[role="menu"],[aria-haspopup]')) setMenuFor(null); }}>
        {error && <p className="px-3 py-2 text-[12.5px] text-aico-danger">{error}</p>}
        {items && count === 0 && (
          <p className="px-3 py-6 text-center text-[13px] text-aico-muted">Nothing yet. Documents, sheets, exports and images this chat makes appear here.</p>
        )}
        {!items && !error && <p className="px-3 py-2 text-[12.5px] text-aico-muted">Loading…</p>}
        {groups.map(g => (
          <section key={g.name} aria-label={g.name}>
            <div className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-[11.5px] font-medium uppercase tracking-wide text-aico-muted">
              <Icon name="folder" size={12} />{g.name}<span className="font-normal normal-case">· {g.items.length}</span>
            </div>
            <ul>{g.items.map(row)}</ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
