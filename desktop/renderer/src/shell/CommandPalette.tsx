/**
 * Ctrl+K: every command every enabled plugin contributes, plus chats and
 * projects, fuzzy-matched. The same list the agent reads through `ide_describe`
 * and runs through `ide_run_command`.
 *
 * @module desktop/renderer/shell/CommandPalette
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { useDesk } from '@/state/desk';
import { useCommands } from '@/plugins/registry';
import { Icon } from '@/lib/icons';
import { cls, prettyKey } from '@/lib/util';
import { openChat } from '@/chat/actions';
import { createPortal } from 'react-dom';
import { useOverlay } from '@/lib/overlay';

interface Entry { id: string; title: string; sub?: string; icon: string; key?: string; run: () => void; group: string }

/** Subsequence match with a score that prefers word starts and contiguity. */
export function fuzzy(needle: string, hay: string): number {
  if (!needle) return 1;
  const n = needle.toLowerCase(); const h = hay.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) return 1000 - direct + (direct === 0 || /\W/.test(h[direct - 1] ?? ' ') ? 200 : 0);
  let score = 0; let hi = 0; let run = 0;
  for (const ch of n) {
    const at = h.indexOf(ch, hi);
    if (at < 0) return -1;
    run = at === hi ? run + 1 : 0;
    score += 10 + run * 5 - (at - hi);
    hi = at + 1;
  }
  return score;
}

export function CommandPalette(): React.ReactElement | null {
  const open = useDesk(s => s.paletteOpen);
  const setOpen = useDesk(s => s.setPalette);
  const commands = useCommands();
  const sessions = useStore(s => s.sessions);
  const projects = useProjects();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 10); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const close = (): void => setOpen(false);
    const out: Entry[] = commands.map(c => ({
      id: `cmd:${c.id}`, title: c.title, sub: c.category, icon: c.icon ?? 'zap', key: c.keybinding, group: 'Commands',
      run: () => { close(); void Promise.resolve(c.run()).catch(e => useDesk.getState().toast({ kind: 'error', title: c.title, body: (e as Error).message })); },
    }));
    for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200)) {
      out.push({ id: `chat:${s.id}`, title: s.title || 'New chat', sub: 'Chat', icon: 'chat', group: 'Chats', run: () => { close(); void openChat(s.id); } });
    }
    for (const p of projects.filter(x => !x.isWorkspace)) {
      out.push({ id: `proj:${p.path}`, title: p.name, sub: p.path, icon: 'folder', group: 'Projects', run: () => { close(); useDesk.getState().navigate({ view: 'project', params: { path: p.path } }); } });
    }
    return out;
  }, [commands, sessions, projects, setOpen]);

  const results = useMemo(() => {
    const needle = q.trim();
    const scored = entries.map(e => ({ e, s: Math.max(fuzzy(needle, e.title) + (e.group === 'Commands' ? 40 : 0), fuzzy(needle, `${e.sub ?? ''} ${e.title} ${e.id.replace(/^cmd:/, '').replace(/[.:_-]/g, ' ')}`) - 50) }))
      .filter(x => x.s >= 0);
    if (!needle) return scored.filter(x => x.e.group === 'Commands').slice(0, 60).map(x => x.e)
      .concat(scored.filter(x => x.e.group === 'Chats').slice(0, 8).map(x => x.e));
    return scored.sort((a, b) => b.s - a.s).slice(0, 80).map(x => x.e);
  }, [entries, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); results[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-center bg-black/25 pt-[12vh] animate-fade-in" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="flex max-h-[62vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-aico-border-subtle bg-aico-bg shadow-[var(--desk-shadow)] animate-pop-in" role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-3 border-b border-aico-border-subtle px-4 py-3">
          <Icon name="search" size={18} className="text-aico-muted" />
          <input ref={input} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Type a command, a chat, or a project"
            className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-aico-muted" aria-label="Search commands" />
          <span className="kbd">Esc</span>
        </div>
        <div ref={list} className="thin-scroll overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-aico-muted">Nothing matches “{q}”.</div>}
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <React.Fragment key={r.id}>
                {header && <div className="px-3 pb-1 pt-2 text-[11.5px] font-medium text-aico-muted">{header}</div>}
                <button data-index={i} role="option" aria-selected={i === sel}
                  className={cls('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13.5px]', i === sel ? 'bg-aico-hover' : 'hover:bg-aico-hover')}
                  onMouseMove={() => setSel(i)} onClick={r.run}>
                  <Icon name={r.icon} size={16} className="text-aico-secondary" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  {r.sub && <span className="max-w-[40%] truncate text-[12px] text-aico-muted">{r.sub}</span>}
                  {r.key && <span className="kbd">{prettyKey(r.key)}</span>}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
