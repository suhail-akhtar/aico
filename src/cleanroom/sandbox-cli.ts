/**
 * The command-line sandbox: run a program, feed it, read what it said.
 *
 * Two ways to run it, chosen by `pty` in the launch spec.
 *
 * Pipes (default): stdout and stderr stay apart, which is the contract most
 * tools are judged on, and TERM/COLUMNS/LINES are set so a program that sizes
 * itself from the environment behaves.
 *
 * A pseudo-terminal (`pty: true`): the program sees a real terminal (isatty is
 * true, raw mode works, a TUI draws itself), stdout and stderr arrive merged as
 * a terminal merges them, keys are sent as the sequences a terminal sends
 * (`press`), and the window can be resized. It needs the prebuilt
 * `@lydell/node-pty` module, an *optional* dependency (the desktop terminal
 * already ships it, ADR 0019/0041): where it is not installed the sandbox says
 * so and refuses, instead of quietly running on pipes and reporting terminal
 * behaviour it did not observe.
 *
 * Signals, honestly. A POSIX signal reaches the program's handler. On Windows
 * there are no such signals: under a pty a Ctrl-C keystroke is a real
 * interrupt (the program's SIGINT handler runs), but SIGTERM and SIGHUP can
 * only end the process outright. Each observation records `signalDelivery`
 * ('signal', 'ctrl-c' or 'forced') and the platform it ran on, so a spec and a
 * twin-test never claim a handler ran when it could not.
 *
 * What the observation holds: raw output, the exit code or signal, the wall
 * time, and `screen` — the stream replayed onto a grid (ansi.ts) so a TUI is
 * compared by what it displayed. A program that is still running and quiet
 * after a `run` stays alive as the "live" process: `stdin`, `press`, `resize`
 * and `signal` act on it, and `observe` returns everything written so far.
 *
 * @module cleanroom/sandbox-cli
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { renderScreen, screenText, stripAnsi } from './ansi.js';
import type { LaunchSpec, Observation, Sandbox, StateFingerprint, Stimulus } from './types.js';

const IDLE_MS = 250;
const MAX_CAPTURE = 1_000_000;
const WIN = process.platform === 'win32';

interface Live {
  write(data: string): void;
  endInput(): void;
  kill(signal: string): void;
  resize?(columns: number, rows: number): void;
  out: string; err: string; started: number;
  exit?: { code: number | null; signal: string | null };
  tty: boolean;
  delivery?: 'signal' | 'ctrl-c' | 'forced';
}

type Pty = { onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number; signal?: number }) => void): void; write(d: string): void; kill(s?: string): void; resize(c: number, r: number): void };
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): Pty };

/** The pty module, if this install has it. Looked up by a variable so the bundler does not resolve it. */
async function loadPty(): Promise<PtyModule | undefined> {
  const name = '@lydell/node-pty';
  try { const m = await import(/* @vite-ignore */ name) as PtyModule & { default?: PtyModule }; return typeof m.spawn === 'function' ? m : m.default; } catch { return undefined; }
}

export function ptyAvailable(): Promise<boolean> { return loadPty().then(Boolean); }

/** Key names a test or an explorer writes, as the bytes a terminal sends for them. */
export function keyToSequence(key: string): string {
  const k = key.trim();
  const named: Record<string, string> = {
    Enter: '\r', Return: '\r', Tab: '\t', Escape: '\x1b', Esc: '\x1b', Backspace: '\x7f', Delete: '\x1b[3~', Space: ' ',
    ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
    Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
  };
  if (named[k] !== undefined) return named[k]!;
  const ctrl = /^(?:ctrl|control)\+([a-z])$/i.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1]!.toLowerCase().charCodeAt(0) - 96);
  const f = /^F([1-9]|1[0-2])$/.exec(k);
  if (f) return ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~'][Number(f[1]) - 1]!;
  return k;
}

export class CliSandbox implements Sandbox {
  readonly kind = 'cli' as const;
  private spec!: Extract<LaunchSpec, { kind: 'cli' }>;
  private live?: Live;
  private last: Observation = { at: new Date().toISOString(), kind: 'cli' };
  private signal?: AbortSignal;

  async start(spec: LaunchSpec, signal?: AbortSignal): Promise<void> {
    if (spec.kind !== 'cli') throw new Error('CliSandbox starts a cli target');
    if (spec.pty && !(await ptyAvailable())) throw new Error('a pseudo-terminal was asked for but @lydell/node-pty is not installed here (it is an optional dependency); run without pty, or install it');
    this.spec = spec; this.signal = signal;
  }

  async inject(s: Stimulus): Promise<void> {
    if (s.type === 'run') return this.run(s.args, s.stdin, s.env);
    if (s.type === 'wait') { await new Promise(r => setTimeout(r, Math.min(s.ms, 30_000))); if (this.live) this.last = this.fromLive(this.live); return; }
    const l = this.live;
    if (!l || l.exit) { this.last = { ...this.last, at: iso(), error: `no live process for "${s.type}"` }; return; }
    if (s.type === 'stdin') { l.write(s.data); await settle(l); }
    else if (s.type === 'press') { l.write(keyToSequence(s.key)); await settle(l); }
    else if (s.type === 'resize') {
      if (!l.resize) { this.last = { ...this.fromLive(l), error: 'resize needs a pseudo-terminal' }; return; }
      l.resize(s.columns, s.rows); this.spec = { ...this.spec, columns: s.columns, rows: s.rows }; await settle(l);
    } else if (s.type === 'signal') {
      // Ctrl-C on a pty is a real interrupt on every platform; every other signal is a signal on POSIX and only a kill on Windows.
      if (s.signal === 'SIGINT' && l.tty) { l.write('\x03'); l.delivery = 'ctrl-c'; }
      else { l.delivery = WIN ? 'forced' : 'signal'; l.kill(s.signal); }
      await waitExit(l, 3000);
    } else throw new Error(`a command-line target cannot take a "${s.type}" stimulus`);
    this.last = this.fromLive(l);
  }

  async observe(): Promise<Observation> { return this.last; }

  async snapshot(): Promise<StateFingerprint> {
    const o = this.last;
    const body = this.spec?.pty ? (o.screen ?? []).join('\n') : stripAnsi(o.stdout ?? '').slice(-400);
    return createHash('sha256').update(JSON.stringify([o.exitCode ?? null, o.signal ?? null, body, (o.stderr ?? '').slice(-200)])).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    const l = this.live;
    if (l && !l.exit) { l.kill('SIGKILL'); await waitExit(l, 1000); }
    this.live = undefined;
  }

  private async run(args: string[], stdin?: string, env?: Record<string, string>): Promise<void> {
    await this.stop();
    const columns = this.spec.columns ?? 80, rows = this.spec.rows ?? 24;
    const e = { ...process.env, ...this.spec.env, ...env, TERM: 'xterm-256color', COLUMNS: String(columns), LINES: String(rows) } as Record<string, string>;
    const argv = [...(this.spec.args ?? []), ...args];
    const l = this.spec.pty ? await this.spawnPty(argv, e, columns, rows) : this.spawnPipes(argv, e);
    this.live = l;
    this.signal?.addEventListener('abort', () => l.kill('SIGKILL'), { once: true });
    if (stdin !== undefined) { l.write(stdin); if (!this.spec.interactive) l.endInput(); }
    else if (!this.spec.interactive) l.endInput(); // a one-shot gets EOF so it cannot wait for input forever
    await settle(l, this.spec.timeoutMs ?? 15_000, !this.spec.interactive && l.tty);
    this.last = this.fromLive(l);
  }

  private spawnPipes(argv: string[], env: Record<string, string>): Live {
    const child: ChildProcess = spawn(this.spec.command, argv, { cwd: this.spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const l: Live = {
      out: '', err: '', started: Date.now(), tty: false,
      write: d => { child.stdin?.write(d); }, endInput: () => { child.stdin?.end(); },
      kill: sig => { child.kill(sig as NodeJS.Signals); },
    };
    child.stdout?.on('data', (d: Buffer) => { if (l.out.length < MAX_CAPTURE) l.out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (l.err.length < MAX_CAPTURE) l.err += d.toString('utf8'); });
    child.on('error', (err: Error) => { l.err += `\n[spawn error] ${err.message}`; l.exit = { code: null, signal: null }; });
    child.on('close', (code, sig) => { l.exit = { code, signal: sig }; });
    return l;
  }

  private async spawnPty(argv: string[], env: Record<string, string>, columns: number, rows: number): Promise<Live> {
    const mod = (await loadPty())!;
    const term = mod.spawn(this.spec.command, argv, { name: 'xterm-256color', cols: columns, rows, cwd: this.spec.cwd ?? process.cwd(), env });
    const l: Live = {
      out: '', err: '', started: Date.now(), tty: true,
      write: d => { term.write(d); },
      // A terminal has no EOF byte stream: Ctrl-D (POSIX) or Ctrl-Z + Enter (Windows) is what a person types.
      endInput: () => { term.write(WIN ? '\x1a\r' : '\x04'); },
      kill: sig => { try { term.kill(WIN ? undefined : sig); } catch { /* already gone */ } },
      resize: (c, r) => { term.resize(c, r); },
    };
    term.onData(d => { if (l.out.length < MAX_CAPTURE) l.out += d; });
    term.onExit(ev => { l.exit = { code: ev.exitCode, signal: ev.signal ? `SIG${ev.signal}` : null }; });
    return l;
  }

  private fromLive(l: Live): Observation {
    const columns = this.spec.columns ?? 80, rows = this.spec.rows ?? 24;
    return {
      at: iso(), kind: 'cli', stdout: l.out, stderr: l.err,
      exitCode: l.exit ? l.exit.code : undefined, signal: l.exit?.signal ?? null,
      screen: screenText(renderScreen(l.out, columns, rows)), durationMs: Date.now() - l.started,
      ...(l.delivery ? { signalDelivery: l.delivery } : {}),
      terminal: { tty: l.tty, platform: process.platform },
    };
  }
}

const iso = (): string => new Date().toISOString();

/** Wait until the process exits, or has been silent for the idle window, or the deadline passes. */
async function settle(l: Live, deadlineMs = 15_000, expectExit = false): Promise<void> {
  const end = Date.now() + deadlineMs;
  let lastSize = -1, quietSince = Date.now();
  while (Date.now() < end) {
    if (l.exit) { await new Promise(r => setTimeout(r, 20)); return; }
    const size = l.out.length + l.err.length;
    if (size !== lastSize) { lastSize = size; quietSince = Date.now(); }
    // Alive and quiet: an interactive program waiting. A one-shot on a pty gets longer, because a Windows
    // pseudo-terminal reports the exit a moment after the last output.
    else if (Date.now() - quietSince >= (expectExit ? 1800 : IDLE_MS) && size > 0) return;
    await new Promise(r => setTimeout(r, 25));
  }
}

async function waitExit(l: Live, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!l.exit && Date.now() < end) await new Promise(r => setTimeout(r, 20));
}
