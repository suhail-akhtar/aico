/**
 * The "Agent" terminal tab: the active chat's shell commands, as they run.
 *
 * WHY. The agent's Bash / Terminal calls were visible only as cards in the
 * chat; someone watching a build in the terminal panel could not see the
 * agent's own commands beside theirs. This draws them in a read-only xterm —
 * `$ command`, the output as it streams (the `tool-progress` events the
 * store already keeps), the exit status — with a Stop that cancels the turn.
 *
 * Read-only on purpose: there is no input here and nothing it shows can be
 * typed into a shell. It mirrors; the commands themselves went through the
 * agent's approvals and the Sentinel before they ran. Output arrives already
 * redacted by the engine's sink.
 *
 * @module desktop/renderer/ide/TerminalAgentView
 */

import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useStore } from '@web/store';
import { useDesk } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { themeFromCss } from './terminal-theme';

const SHELL_TOOLS = new Set(['Bash', 'Terminal']);

interface Seen { written: string; done: boolean; header: boolean }

/** Text of a tool result: Bash/Terminal give {stdout, stderr, exit_code}; errors are strings. */
function resultText(r: unknown): { text: string; exit: number | null } {
  if (r == null) return { text: '', exit: null };
  if (typeof r === 'string') return { text: r, exit: null };
  const o = r as { stdout?: unknown; stderr?: unknown; exit_code?: unknown; error?: unknown };
  const text = [o.stdout, o.stderr, o.error].filter(x => typeof x === 'string' && x).join(o.stdout && o.stderr ? '\n' : '');
  return { text, exit: typeof o.exit_code === 'number' ? o.exit_code : null };
}

const crlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

export function TerminalAgentView({ visible }: { visible: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const seen = useRef(new Map<string, Seen>());
  const lastSession = useRef<string | null>(null);
  const mode = useDesk(s => s.mode);
  const codeFont = useDesk(s => s.prefs.codeFont);
  const tools = useStore(s => s.draft.tools);
  const sessionId = useStore(s => s.sessionId);
  const title = useStore(s => s.title);
  const busy = useStore(s => s.busy);
  const running = [...tools.values()].some(t => SHELL_TOOLS.has(t.toolName ?? '') && t.toolRunning);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: codeFont, fontSize: 13, lineHeight: 1.2, cursorBlink: false, disableStdin: true, convertEol: true,
      scrollback: 10000, theme: themeFromCss(), allowProposedApi: true, cursorStyle: 'bar', cursorInactiveStyle: 'none',
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t; fit.current = f;
    t.write('\x1b[90mThe agent\'s shell commands in this chat appear here as they run. This view is read-only.\x1b[0m\r\n');
    const ro = new ResizeObserver(() => { if (host.current?.offsetParent !== null) try { f.fit(); } catch { /* hidden */ } });
    ro.observe(host.current!);
    return () => { ro.disconnect(); t.dispose(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (term.current) term.current.options.theme = themeFromCss(); }, [mode]);
  useEffect(() => { if (visible) requestAnimationFrame(() => { try { fit.current?.fit(); } catch { /* hidden */ } }); }, [visible]);

  // Mirror the draft's shell calls. Written once each; output appended as it grows.
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    if (sessionId !== lastSession.current) {
      lastSession.current = sessionId;
      if (sessionId) t.write(`\r\n\x1b[90m── chat: ${(title || 'New chat').replace(/[\x00-\x1f]/g, ' ').slice(0, 80)} ──\x1b[0m\r\n`);
    }
    const calls = [...tools.values()].filter(m => SHELL_TOOLS.has(m.toolName ?? '')).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    for (const m of calls) {
      const id = m.toolCallId ?? m.id;
      let s = seen.current.get(id);
      if (!s) { s = { written: '', done: false, header: false }; seen.current.set(id, s); }
      if (s.done) continue;
      if (!s.header) {
        const args = (m.toolArgs ?? {}) as { command?: unknown; cwd?: unknown };
        const cmd = typeof args.command === 'string' ? args.command : '(command)';
        t.write(`\r\n\x1b[1;36m$\x1b[0m \x1b[1m${crlf(cmd)}\x1b[0m${typeof args.cwd === 'string' ? `  \x1b[90m(${args.cwd})\x1b[0m` : ''}\r\n`);
        s.header = true;
      }
      const { text, exit } = resultText(m.toolResult);
      if (text.startsWith(s.written)) {
        const more = text.slice(s.written.length);
        if (more) t.write(crlf(more));
        s.written = text;
      } else if (!m.toolRunning && !s.written) {
        t.write(crlf(text));
        s.written = text;
      }
      if (!m.toolRunning) {
        s.done = true;
        const code = m.toolRunning ? null : exit;
        const line = code === null ? '\x1b[90m[finished]\x1b[0m' : code === 0 ? '\x1b[32m✓ exit 0\x1b[0m' : `\x1b[31m✗ exit ${code}\x1b[0m`;
        t.write(`${s.written && !s.written.endsWith('\n') ? '\r\n' : ''}${line}\r\n`);
      }
    }
  }, [tools, sessionId, title]);

  return (
    <div className={cls('flex h-full w-full flex-col', !visible && 'hidden')}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-aico-border-subtle px-3 text-[12px]">
        <Icon name="bot" size={13} className="text-aico-secondary" />
        <span className="truncate text-aico-secondary">Agent commands · {title || 'this chat'}</span>
        <span className="rounded bg-aico-hover px-1.5 py-px text-[10.5px] text-aico-muted">read-only</span>
        <div className="flex-1" />
        {running && <span className="flex items-center gap-1 text-[11.5px] text-aico-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-aico-accent" />running</span>}
        <button className="btn-ghost btn-sm" disabled={!busy} onClick={() => void useStore.getState().cancel()} title="Stop the agent's turn (and the command it is running)">
          <Icon name="stop" size={12} />Stop
        </button>
      </div>
      <div ref={host} className="min-h-0 flex-1 px-2 pt-1" />
    </div>
  );
}
