/**
 * The command-line sandbox: run a program, feed it, read what it said.
 *
 * Pipes only, for now: stdout and stderr stay apart, which is the contract most
 * tools are judged on, and TERM, COLUMNS and LINES are set so a program that
 * sizes itself from the environment behaves. A program that insists on a real
 * terminal (an isatty check, raw mode) will behave differently here than
 * under a person. A pseudo-terminal needs the native node-pty module, which
 * is not a dependency of AICO (a new dependency needs its own ADR), so the PTY
 * adapter is a recorded follow-up in ADR 0041 and is not simulated here.
 *
 * What the observation holds: raw stdout/stderr, the exit code or signal, the
 * wall time, and `screen` — the ANSI stream replayed onto a grid (ansi.ts) so
 * a TUI can be compared by what it displayed.
 *
 * A program that does not exit within the idle window after a `run` stays
 * alive as the "live" process: `stdin` and `signal` stimuli act on it and
 * `observe` returns everything it has written so far.
 *
 * @module cleanroom/sandbox-cli
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { renderScreen, screenText, stripAnsi } from './ansi.js';
import type { LaunchSpec, Observation, Sandbox, StateFingerprint, Stimulus } from './types.js';
import { createHash } from 'node:crypto';

const IDLE_MS = 250;
const MAX_CAPTURE = 1_000_000;

interface Live { child: ChildProcess; out: string; err: string; started: number; exit?: { code: number | null; signal: string | null } }

export class CliSandbox implements Sandbox {
  readonly kind = 'cli' as const;
  private spec!: Extract<LaunchSpec, { kind: 'cli' }>;
  private live?: Live;
  private last: Observation = { at: new Date().toISOString(), kind: 'cli' };
  private signal?: AbortSignal;

  async start(spec: LaunchSpec, signal?: AbortSignal): Promise<void> {
    if (spec.kind !== 'cli') throw new Error('CliSandbox starts a cli target');
    this.spec = spec; this.signal = signal;
  }

  async inject(s: Stimulus): Promise<void> {
    if (s.type === 'run') return this.run(s.args, s.stdin, s.env);
    if (s.type === 'stdin') {
      const l = this.live;
      if (!l || l.exit) { this.last = { ...this.last, at: iso(), error: 'no live process to write to' }; return; }
      l.child.stdin?.write(s.data);
      await settle(l);
      this.last = this.fromLive(l);
      return;
    }
    if (s.type === 'signal') {
      const l = this.live;
      if (!l || l.exit) { this.last = { ...this.last, at: iso(), error: 'no live process to signal' }; return; }
      l.child.kill(s.signal);
      await waitExit(l, 2000);
      this.last = this.fromLive(l);
      return;
    }
    if (s.type === 'wait') { await new Promise(r => setTimeout(r, Math.min(s.ms, 30_000))); if (this.live) this.last = this.fromLive(this.live); return; }
    throw new Error(`a command-line target cannot take a "${s.type}" stimulus`);
  }

  async observe(): Promise<Observation> { return this.last; }

  async snapshot(): Promise<StateFingerprint> {
    const o = this.last;
    return createHash('sha256').update(JSON.stringify([o.exitCode ?? null, o.signal ?? null, stripAnsi(o.stdout ?? '').slice(-400), (o.stderr ?? '').slice(-200)])).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    const l = this.live;
    if (l && !l.exit) { l.child.kill('SIGKILL'); await waitExit(l, 1000); }
    this.live = undefined;
  }

  private async run(args: string[], stdin?: string, env?: Record<string, string>): Promise<void> {
    await this.stop();
    const started = Date.now();
    const columns = this.spec.columns ?? 80, rows = this.spec.rows ?? 24;
    const e = { ...process.env, ...this.spec.env, ...env, TERM: 'xterm-256color', COLUMNS: String(columns), LINES: String(rows) };
    const child = spawn(this.spec.command, [...(this.spec.args ?? []), ...args], { cwd: this.spec.cwd, env: e, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const l: Live = { child, out: '', err: '', started };
    child.stdout?.on('data', (d: Buffer) => { if (l.out.length < MAX_CAPTURE) l.out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (l.err.length < MAX_CAPTURE) l.err += d.toString('utf8'); });
    child.on('error', (err: Error) => { l.err += `\n[spawn error] ${err.message}`; l.exit = { code: null, signal: null }; });
    child.on('close', (code, sig) => { l.exit = { code, signal: sig }; });
    this.live = l;
    this.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    // A one-shot gets EOF so it cannot wait for input forever; an interactive target keeps stdin open.
    if (stdin !== undefined) child.stdin?.end(stdin);
    else if (!this.spec.interactive) child.stdin?.end();
    await settle(l, this.spec.timeoutMs ?? 15_000);
    this.last = this.fromLive(l);
  }

  private fromLive(l: Live): Observation {
    const columns = this.spec.columns ?? 80, rows = this.spec.rows ?? 24;
    return {
      at: iso(), kind: 'cli', stdout: l.out, stderr: l.err,
      exitCode: l.exit ? l.exit.code : undefined, signal: l.exit?.signal ?? null,
      screen: screenText(renderScreen(l.out, columns, rows)), durationMs: Date.now() - l.started,
    };
  }
}

const iso = (): string => new Date().toISOString();

/** Wait until the process exits, or has been silent for the idle window, or the deadline passes. */
async function settle(l: Live, deadlineMs = 15_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  let lastSize = -1, quietSince = Date.now();
  while (Date.now() < end) {
    if (l.exit) { await new Promise(r => setTimeout(r, 20)); return; }
    const size = l.out.length + l.err.length;
    if (size !== lastSize) { lastSize = size; quietSince = Date.now(); }
    else if (Date.now() - quietSince >= IDLE_MS && size > 0) return; // alive and quiet: an interactive program waiting
    await new Promise(r => setTimeout(r, 25));
  }
}

async function waitExit(l: Live, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!l.exit && Date.now() < end) await new Promise(r => setTimeout(r, 20));
}
