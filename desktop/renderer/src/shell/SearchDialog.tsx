/**
 * Search chats — titles instantly, then transcripts on the engine's disk.
 *
 * Titles and folders match as you type. For anything longer than a couple of
 * characters, the full text of recent chats is fetched once (Markdown export)
 * and searched too, so "that chat where we fixed the CORS header" is findable
 * by what was said, not only by what it was called.
 *
 * @module desktop/renderer/shell/SearchDialog
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { useDesk } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { ago, cls, dayBucket } from '@/lib/util';
import { openChat } from '@/chat/actions';
import { Modal } from './Modal';

const textCache = new Map<string, { at: number; text: string }>();

async function fullText(id: string, updatedAt: number): Promise<string> {
  const hit = textCache.get(id);
  if (hit && hit.at >= updatedAt) return hit.text;
  const res = await fetch(`/api/session/export?id=${encodeURIComponent(id)}&format=txt`);
  const text = res.ok ? (await res.text()).toLowerCase() : '';
  textCache.set(id, { at: updatedAt, text });
  return text;
}

export function SearchDialog(): React.ReactElement {
  const open = useDesk(s => s.searchOpen);
  const setOpen = useDesk(s => s.setSearch);
  const sessions = useStore(s => s.sessions);
  const [q, setQ] = useState('');
  const [deep, setDeep] = useState<Map<string, string>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [sel, setSel] = useState(0);
  const token = useRef(0);

  useEffect(() => { if (open) { setQ(''); setDeep(new Map()); setSel(0); } }, [open]);

  const needle = q.trim().toLowerCase();
  const titleHits = useMemo(() => [...sessions]
    .filter(s => !needle || (s.title ?? '').toLowerCase().includes(needle) || (s.project ?? '').toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60), [sessions, needle]);

  useEffect(() => {
    if (!open || needle.length < 3) { setDeep(new Map()); return; }
    const my = ++token.current;
    setScanning(true);
    const timer = setTimeout(async () => {
      const found = new Map<string, string>();
      const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 150);
      for (const s of recent) {
        if (token.current !== my) return;
        try {
          const text = await fullText(s.id, s.updatedAt);
          const at = text.indexOf(needle);
          if (at >= 0) found.set(s.id, text.slice(Math.max(0, at - 50), at + needle.length + 70).replace(/\s+/g, ' '));
        } catch { /* skip unreadable */ }
        if (found.size >= 40) break;
      }
      if (token.current === my) { setDeep(found); setScanning(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [needle, open, sessions]);

  const results = useMemo(() => {
    const ids = new Set(titleHits.map(s => s.id));
    const extra = sessions.filter(s => deep.has(s.id) && !ids.has(s.id));
    return [...titleHits, ...extra];
  }, [titleHits, deep, sessions]);

  const choose = (id: string): void => { setOpen(false); void openChat(id); };
  let bucket = '';

  return (
    <Modal open={open} onClose={() => setOpen(false)} width={680} hideClose>
      <div className="flex items-center gap-3 border-b border-aico-border-subtle px-5 py-3.5">
        <Icon name="search" size={18} className="text-aico-muted" />
        <input autoFocus value={q} onChange={e => { setQ(e.target.value); setSel(0); }} placeholder="Search chats"
          className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-aico-muted" aria-label="Search chats"
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
            if (e.key === 'Enter' && results[sel]) choose(results[sel]!.id);
          }} />
        {scanning && <span className="spinner" title="Searching transcripts" />}
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close"><Icon name="x" size={18} /></button>
      </div>
      <div className="thin-scroll max-h-[60vh] overflow-y-auto p-2">
        {results.length === 0 && <div className="py-10 text-center text-[13px] text-aico-muted">{needle ? 'No chats match.' : 'No chats yet.'}</div>}
        {results.map((s, i) => {
          const b = dayBucket(s.updatedAt);
          const head = b !== bucket ? b : null;
          bucket = b;
          const snippet = deep.get(s.id);
          return (
            <React.Fragment key={s.id}>
              {head && <div className="px-3 pb-1 pt-3 text-[12px] font-medium text-aico-muted">{head}</div>}
              <button className={cls('flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left', i === sel ? 'bg-aico-hover' : 'hover:bg-aico-hover')}
                onMouseMove={() => setSel(i)} onClick={() => choose(s.id)}>
                <Icon name="chat" size={16} className="mt-0.5 shrink-0 text-aico-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{s.title || 'New chat'}</span>
                  {snippet && <span className="mt-0.5 block truncate text-[12.5px] text-aico-muted">…{snippet}…</span>}
                </span>
                <span className="shrink-0 text-[12px] text-aico-muted">{ago(s.updatedAt)}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </Modal>
  );
}
