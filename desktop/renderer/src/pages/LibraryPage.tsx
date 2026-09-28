/**
 * Library — ChatGPT's page for everything made in your chats.
 *
 * Collected from the engine's own record of what each recent chat created or
 * changed (its deliverables), plus the built-in browser's screenshots and
 * downloads. Grid or list; filter by kind; open in the editor, the system app,
 * or the chat it came from.
 *
 * @module desktop/renderer/pages/LibraryPage
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { api } from '@web/api';
import { invoke, desktop } from '@/desktop';
import { useDesk, go } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { ago, basename, cls } from '@/lib/util';
import { openChat } from '@/chat/actions';

interface Item { path: string; name: string; kind: 'image' | 'doc' | 'code' | 'data' | 'other'; source: 'chat' | 'screenshot' | 'download'; sessionId?: string; chatTitle?: string; action?: string; at: number }

const KIND = (name: string): Item['kind'] => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['md', 'pdf', 'docx', 'txt', 'html', 'pptx', 'xlsx'].includes(ext)) return 'doc';
  if (['json', 'csv', 'yaml', 'yml', 'xml', 'sql', 'db', 'sqlite'].includes(ext)) return 'data';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cs', 'css', 'scss', 'sh', 'ps1', 'c', 'cpp', 'rb', 'php', 'kt', 'swift'].includes(ext)) return 'code';
  return 'other';
};
const ICON: Record<Item['kind'], string> = { image: 'image', doc: 'file-text', code: 'code', data: 'database', other: 'file' };

function resolve(project: string | undefined, p: string): string {
  if (/^([a-z]:[\\/]|\/)/i.test(p) || !project) return p;
  return `${project.replace(/[\\/]+$/, '')}/${p}`;
}

export function LibraryPage(): React.ReactElement {
  const sessions = useStore(s => s.sessions);
  const info = useDesk(s => s.info);
  const [items, setItems] = useState<Item[] | null>(null);
  const [tab, setTab] = useState<'all' | 'images' | 'docs' | 'code' | 'browser'>('all');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
      const out: Item[] = [];
      await Promise.all(recent.map(async (s) => {
        try {
          const t = await api.trajectory(s.id, { limit: 1 });
          for (const d of t.deliverables) {
            const path = resolve(s.project, d.path);
            out.push({ path, name: basename(path), kind: KIND(path), source: 'chat', sessionId: s.id, chatTitle: s.title, action: d.action, at: s.updatedAt });
          }
        } catch { /* a chat without a log */ }
      }));
      if (info) {
        for (const [sub, source] of [['browser/screenshots', 'screenshot'], ['browser/downloads', 'download']] as const) {
          try {
            const list = await invoke<Array<{ name: string; path: string; dir: boolean; mtime: number }>>('fs:list', `${info.desktopDir}/${sub}`);
            for (const f of list.filter(x => !x.dir)) out.push({ path: f.path, name: f.name, kind: KIND(f.name), source, at: f.mtime });
          } catch { /* none yet */ }
        }
      }
      const seen = new Set<string>();
      const unique = out.sort((a, b) => b.at - a.at).filter(i => { const k = i.path.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
      if (live) setItems(unique);
    })();
    return () => { live = false; };
  }, [sessions, info]);

  const shown = useMemo(() => (items ?? []).filter(i =>
    (tab === 'all' || (tab === 'images' && i.kind === 'image') || (tab === 'docs' && (i.kind === 'doc' || i.kind === 'data')) || (tab === 'code' && i.kind === 'code') || (tab === 'browser' && i.source !== 'chat'))
    && (!q || i.name.toLowerCase().includes(q.toLowerCase()) || (i.chatTitle ?? '').toLowerCase().includes(q.toLowerCase()))), [items, tab, q]);

  const openItem = (i: Item): void => {
    if (i.kind === 'code' || i.kind === 'data' || /\.(md|txt|html)$/i.test(i.name)) go('files', { root: i.path.replace(/[\\/][^\\/]+$/, ''), open: i.path });
    else void desktop.shell.openPath(i.path);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 pb-16 pt-8">
        <div className="flex items-center gap-3">
          <h1 className="text-[26px] font-semibold tracking-tight">Library</h1>
          <div className="flex-1" />
          <div className="segmented">
            <button aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')} aria-label="Grid"><Icon name="apps" size={15} /></button>
            <button aria-pressed={layout === 'list'} onClick={() => setLayout('list')} aria-label="List"><Icon name="list" size={15} /></button>
          </div>
          <div className="relative w-72">
            <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-aico-muted" />
            <input className="input rounded-full pl-9" placeholder="Search library" value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </div>
        <div className="mt-5 flex gap-1">
          {([['all', 'Suggested'], ['images', 'Images'], ['docs', 'Documents'], ['code', 'Code'], ['browser', 'Browser']] as const).map(([id, label]) => (
            <button key={id} className={cls('rounded-full px-3.5 py-1.5 text-[13.5px]', tab === id ? 'bg-aico-hover font-medium' : 'text-aico-secondary hover:text-aico-primary')} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        {items === null && <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">{[0, 1, 2, 3, 4, 5, 6, 7].map(i => <div key={i} className="skeleton h-44" />)}</div>}
        {items !== null && shown.length === 0 && (
          <div className="flex flex-col items-center py-24 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-aico-hover"><Icon name="library" size={24} /></span>
            <div className="mt-3 text-[15px] font-medium">Nothing here yet</div>
            <p className="mt-1 max-w-sm text-[13px] text-aico-muted">Files the agent creates or edits, browser screenshots and downloads show up here.</p>
          </div>
        )}
        {layout === 'grid' ? (
          <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {shown.map(i => <Card key={i.path} item={i} onOpen={() => openItem(i)} />)}
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-aico-border-subtle">
            {shown.map(i => (
              <div key={i.path} className="flex items-center gap-3 border-b border-aico-border-subtle px-4 py-2 text-[13px] last:border-b-0 hover:bg-aico-hover">
                <Icon name={ICON[i.kind]} size={16} className="text-aico-muted" />
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => openItem(i)} title={i.path}>{i.name}</button>
                {i.chatTitle && <button className="max-w-[240px] truncate text-[12px] text-aico-muted hover:text-aico-primary" onClick={() => i.sessionId && void openChat(i.sessionId)}>{i.chatTitle}</button>}
                <span className="w-12 text-right text-[12px] text-aico-muted">{ago(i.at)}</span>
                <button className="icon-btn-sm" onClick={() => void desktop.shell.showItemInFolder(i.path)} aria-label="Reveal"><Icon name="folder-open" size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ item, onOpen }: { item: Item; onOpen: () => void }): React.ReactElement {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (item.kind !== 'image') return;
    void invoke<string>('fs:readDataUrl', item.path).then(setThumb).catch(() => {});
  }, [item]);
  return (
    <div className="card group flex flex-col overflow-hidden transition-shadow hover:shadow-[var(--desk-shadow)]">
      <button className="flex h-32 items-center justify-center overflow-hidden bg-aico-surface" onClick={onOpen} title={item.path}>
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <Icon name={ICON[item.kind]} size={34} className={item.kind === 'doc' ? 'text-aico-danger' : 'text-aico-accent'} />}
      </button>
      <div className="p-3">
        <div className="truncate text-[13.5px] font-medium" title={item.name}>{item.name}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-aico-muted">
          <span>{item.source === 'chat' ? (item.action === 'created' ? 'Created' : 'Modified') : item.source === 'screenshot' ? 'Screenshot' : 'Download'}</span>
          <span>· {ago(item.at)}</span>
          <div className="flex-1" />
          {item.sessionId && <button className="opacity-0 hover:text-aico-primary group-hover:opacity-100" onClick={() => void openChat(item.sessionId!)} title={item.chatTitle}><Icon name="chat" size={13} /></button>}
          <button className="opacity-0 hover:text-aico-primary group-hover:opacity-100" onClick={() => void desktop.shell.showItemInFolder(item.path)} aria-label="Reveal"><Icon name="folder-open" size={13} /></button>
        </div>
      </div>
    </div>
  );
}
