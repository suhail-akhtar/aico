/**
 * Terminal tabs in the bottom panel — xterm.js over a real pseudo-terminal.
 *
 * Opens one terminal in the current project on first show. Other parts of the
 * app ask for a terminal with a `desk:terminal` event ({ cwd, run }); a plugin
 * command or the agent uses the same door, and a command is always visible in
 * the tab it runs in.
 *
 * @module desktop/renderer/ide/TerminalPanel
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '@web/store';
import { invoke, on } from '@/desktop';
import { useDesk } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { basename, cls } from '@/lib/util';

interface Tab { id: string; title: string; cwd: string; exited?: boolean }

function themeFromCss(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string): string => css.getPropertyValue(n).trim();
  const dark = document.documentElement.classList.contains('dark');
  return {
    background: v('--aico-bg'), foreground: v('--aico-text-primary'), cursor: v('--aico-accent'),
    selectionBackground: dark ? 'rgba(120,160,255,0.3)' : 'rgba(40,90,220,0.22)',
    black: dark ? '#1e1e1e' : '#000000', red: '#e5534b', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5',
    magenta: '#b083f0', cyan: '#39c5cf', white: dark ? '#d0d0d0' : '#6e7781',
    brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#7ee787', brightYellow: '#e3b341', brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: dark ? '#ffffff' : '#24292f',
  };
}

export function TerminalPanel(): React.ReactElement {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const project = useStore(s => s.project);
  const created = useRef(false);

  const create = useCallback(async (opts?: { cwd?: string; run?: string }) => {
    const t = await invoke<{ id: string; title: string; cwd: string }>('term:create', { cwd: opts?.cwd ?? project ?? undefined });
    setTabs(ts => [...ts, { id: t.id, title: t.title, cwd: t.cwd }]);
    setActive(t.id);
    if (opts?.run) setTimeout(() => void invoke('term:write', t.id, `${opts.run}\r`), 500);
    return t.id;
  }, [project]);

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    void invoke<Tab[]>('term:list').then(list => {
      if (list.length) { setTabs(list); setActive(list[list.length - 1]!.id); }
      else void create();
    }).catch(() => void create());
  }, [create]);

  useEffect(() => {
    const onReq = (e: Event): void => {
      const d = (e as CustomEvent<{ cwd?: string; run?: string }>).detail ?? {};
      void create(d);
    };
    window.addEventListener('desk:terminal', onReq);
    const offExit = on<{ id: string; code: number }>('term:exit', ({ id }) => setTabs(ts => ts.map(t => t.id === id ? { ...t, exited: true } : t)));
    const offCreated = on<{ id: string; title: string; cwd: string }>('term:created', (t) => {
      setTabs(ts => ts.some(x => x.id === t.id) ? ts : [...ts, t]);
      setActive(t.id);
      useDesk.getState().setPanel({ open: true, tab: 'terminal' });
    });
    return () => { window.removeEventListener('desk:terminal', onReq); offExit(); offCreated(); };
  }, [create]);

  const close = (id: string): void => {
    void invoke('term:kill', id);
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id);
      if (active === id) setActive(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1">
        {tabs.map(t => <XTerm key={t.id} id={t.id} visible={t.id === active} />)}
        {tabs.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <button className="btn-outline" onClick={() => void create()}><Icon name="terminal" size={15} />New terminal</button>
          </div>
        )}
      </div>
      <div className="flex w-44 shrink-0 flex-col border-l border-aico-border-subtle">
        <div className="flex items-center px-2 py-1">
          <span className="flex-1 text-[11.5px] text-aico-muted">Terminals</span>
          <button className="icon-btn-sm" onClick={() => void create()} title="New terminal" aria-label="New terminal"><Icon name="plus" size={14} /></button>
        </div>
        <div className="thin-scroll flex-1 overflow-y-auto px-1">
          {tabs.map(t => (
            <div key={t.id} className={cls('group flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]', t.id === active ? 'bg-aico-hover text-aico-primary' : 'text-aico-secondary hover:bg-aico-hover')}>
              <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setActive(t.id)} title={t.cwd}>
                <Icon name="terminal" size={12} className={t.exited ? 'text-aico-muted' : ''} />
                <span className={cls('truncate', t.exited && 'text-aico-muted line-through')}>{t.title} · {basename(t.cwd)}</span>
              </button>
              <button className="icon-btn-sm h-5 w-5 opacity-0 group-hover:opacity-100" onClick={() => close(t.id)} aria-label="Close terminal"><Icon name="x" size={11} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function XTerm({ id, visible }: { id: string; visible: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const mode = useDesk(s => s.mode);
  const codeFont = useDesk(s => s.prefs.codeFont);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: codeFont, fontSize: 13, lineHeight: 1.2, cursorBlink: true, allowProposedApi: true,
      scrollback: 10000, theme: themeFromCss(), convertEol: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    term.current = t; fit.current = f;
    t.open(host.current!);
    void invoke<string>('term:tail', id).then(tail => { if (tail) t.write(tail); });
    const offData = on<{ id: string; data: string }>('term:data', (m) => { if (m.id === id) t.write(m.data); });
    const offExit = on<{ id: string; code: number }>('term:exit', (m) => { if (m.id === id) t.write(`\r\n\x1b[90m[process exited with code ${m.code}]\x1b[0m\r\n`); });
    const disp = t.onData(d => void invoke('term:write', id, d));
    t.attachCustomKeyEventHandler((e) => {
      // Ctrl+C copies when there is a selection; otherwise it is an interrupt.
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'c' && t.hasSelection()) { void navigator.clipboard.writeText(t.getSelection()); return false; }
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'v') { void navigator.clipboard.readText().then(txt => invoke('term:write', id, txt)); return false; }
      return true;
    });
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return;
      try { f.fit(); void invoke('term:resize', id, t.cols, t.rows); } catch { /* not laid out yet */ }
    });
    ro.observe(host.current!);
    return () => { offData(); offExit(); disp.dispose(); ro.disconnect(); t.dispose(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => { if (term.current) term.current.options.theme = themeFromCss(); }, [mode]);
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => { try { fit.current?.fit(); term.current?.focus(); if (term.current) void invoke('term:resize', id, term.current.cols, term.current.rows); } catch { /* hidden */ } });
  }, [visible, id]);

  return <div ref={host} className={cls('h-full w-full px-2 pt-1', !visible && 'hidden')} />;
}
