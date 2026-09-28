/**
 * Real terminals: a pseudo-terminal per tab (node-pty), drawn by xterm.js in
 * the interface. PowerShell (or cmd) on Windows, the login shell elsewhere.
 *
 * Output is batched per animation-frame-ish tick so a chatty build does not
 * send ten thousand IPC messages a second, and each terminal keeps a tail of
 * its output so re-opening the panel shows what happened while it was closed.
 *
 * @module desktop/electron/terminal
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesktopContext } from './context';

type Pty = {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
};

interface Term {
  id: string;
  pty: Pty;
  title: string;
  cwd: string;
  shell: string;
  tail: string;
  pending: string;
  timer: NodeJS.Timeout | null;
  exited: boolean;
  createdAt: number;
}

const TAIL = 200_000;

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'].find(p => fs.existsSync(p));
    return pwsh ? { file: pwsh, args: ['-NoLogo'] } : { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

export function registerTerminal(ctx: DesktopContext): void {
  let ptyMod: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => Pty } | null = null;
  const load = (): NonNullable<typeof ptyMod> => {
    if (!ptyMod) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ptyMod = require('@lydell/node-pty');
    }
    return ptyMod!;
  };
  const terms = new Map<string, Term>();
  let seq = 0;

  const flush = (t: Term): void => {
    t.timer = null;
    if (!t.pending) return;
    ctx.emit('term:data', { id: t.id, data: t.pending });
    t.pending = '';
  };

  ctx.handle('term:create', (opts?: { cwd?: string; cols?: number; rows?: number; shell?: string; title?: string }) => {
    const shell = opts?.shell ? { file: opts.shell, args: [] as string[] } : defaultShell();
    let cwd = opts?.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    if (!fs.statSync(cwd).isDirectory()) cwd = path.dirname(cwd);
    const pty = load().spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(20, opts?.cols ?? 100),
      rows: Math.max(5, opts?.rows ?? 24),
      cwd,
      env: { ...process.env, TERM_PROGRAM: 'AICO', COLORTERM: 'truecolor' },
      useConpty: true,
    });
    const id = `t${++seq}`;
    const t: Term = {
      id, pty, cwd, shell: shell.file,
      title: opts?.title ?? path.basename(shell.file).replace(/\.exe$/i, ''),
      tail: '', pending: '', timer: null, exited: false, createdAt: Date.now(),
    };
    pty.onData((d) => {
      t.tail = (t.tail + d).slice(-TAIL);
      t.pending += d;
      if (!t.timer) t.timer = setTimeout(() => flush(t), 12);
    });
    pty.onExit((e) => {
      flush(t);
      t.exited = true;
      ctx.emit('term:exit', { id, code: e.exitCode });
    });
    terms.set(id, t);
    return { id, title: t.title, cwd, shell: shell.file, pid: pty.pid };
  });

  ctx.handle('term:write', (id: string, data: string) => { terms.get(id)?.pty.write(data); });
  ctx.handle('term:resize', (id: string, cols: number, rows: number) => {
    const t = terms.get(id);
    if (t && !t.exited) try { t.pty.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch { /* raced with exit */ }
  });
  ctx.handle('term:kill', (id: string) => {
    const t = terms.get(id);
    if (!t) return;
    try { t.pty.kill(); } catch { /* already gone */ }
    terms.delete(id);
  });
  ctx.handle('term:list', () => [...terms.values()].map(t => ({ id: t.id, title: t.title, cwd: t.cwd, exited: t.exited, createdAt: t.createdAt })));
  ctx.handle('term:tail', (id: string) => terms.get(id)?.tail ?? '');
  ctx.handle('term:rename', (id: string, title: string) => { const t = terms.get(id); if (t) t.title = title; });

  /** Run one command and return its output — for the agent's `ide_terminal_run` and plugin actions. */
  ctx.handle('term:run', (command: string, cwd?: string) => runInNewTerminal(command, cwd));

  function runInNewTerminal(command: string, cwd?: string): { id: string } {
    const shell = defaultShell();
    const pty = load().spawn(shell.file, shell.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), env: process.env, useConpty: true });
    const id = `t${++seq}`;
    const t: Term = { id, pty, cwd: cwd ?? os.homedir(), shell: shell.file, title: command.slice(0, 30), tail: '', pending: '', timer: null, exited: false, createdAt: Date.now() };
    pty.onData((d) => { t.tail = (t.tail + d).slice(-TAIL); t.pending += d; if (!t.timer) t.timer = setTimeout(() => flush(t), 12); });
    pty.onExit((e) => { flush(t); t.exited = true; ctx.emit('term:exit', { id, code: e.exitCode }); });
    terms.set(id, t);
    ctx.emit('term:created', { id, title: t.title, cwd: t.cwd });
    setTimeout(() => pty.write(`${command}\r`), 400);
    return { id };
  }

  ctx.services.terminal = {
    list: () => [...terms.values()].map(t => ({ id: t.id, title: t.title, cwd: t.cwd, exited: t.exited })),
    tail: (id: string) => terms.get(id)?.tail ?? '',
    run: runInNewTerminal,
    write: (id: string, data: string) => terms.get(id)?.pty.write(data),
  };

  process.on('exit', () => { for (const t of terms.values()) try { t.pty.kill(); } catch { /* exiting */ } });
}
