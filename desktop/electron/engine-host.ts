/**
 * Starts, watches and stops the AICO engine.
 *
 * The engine is `serve()` in an Electron utility process. This module owns
 * that process: it resolves `ready()` with the engine's origin and token once
 * it is listening, restarts it with backoff if it dies unexpectedly, and tells
 * every window what state it is in so the interface can say so rather than
 * spin.
 *
 * The token stays in main. Requests from the renderer reach the engine through
 * the `aico://` proxy (see protocol.ts), which attaches it on the way past.
 *
 * @module desktop/electron/engine-host
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import os from 'node:os';
import { EventEmitter } from 'node:events';

export type EngineState =
  | { status: 'starting'; attempt: number }
  | { status: 'ready'; origin: string; startedAt: number }
  | { status: 'crashed'; message: string; attempt: number; retryInMs: number }
  | { status: 'stopped' };

export interface EngineEndpoint {
  origin: string;
  token: string;
}

const MAX_BACKOFF_MS = 30_000;

export class EngineHost extends EventEmitter {
  private child: UtilityProcess | null = null;
  private endpoint: EngineEndpoint | null = null;
  private waiters: Array<(e: EngineEndpoint) => void> = [];
  private attempt = 0;
  private quitting = false;
  private lastLog: string[] = [];
  state: EngineState = { status: 'stopped' };

  constructor(private readonly entry: string, private env: Record<string, string>) {
    super();
  }

  /** Add environment for the next start (the MCP endpoint is only known after main is ready). */
  setEnv(extra: Record<string, string>): void {
    this.env = { ...this.env, ...extra };
  }

  /** Call the engine's API from main (token attached). */
  async request(route: string, body?: unknown): Promise<unknown> {
    const e = await this.ready(30_000);
    const res = await fetch(`${e.origin}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-aico-token': e.token, origin: e.origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  /** The engine's endpoint, waiting for it if it is still starting. */
  ready(timeoutMs = 90_000): Promise<EngineEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== done);
        reject(new Error('The AICO engine did not start in time.'));
      }, timeoutMs);
      const done = (e: EngineEndpoint): void => { clearTimeout(timer); resolve(e); };
      this.waiters.push(done);
    });
  }

  current(): EngineEndpoint | null { return this.endpoint; }

  /** The last lines the engine printed — shown when it fails to start. */
  recentLog(): string[] { return [...this.lastLog]; }

  start(): void {
    if (this.child || this.quitting) return;
    this.attempt += 1;
    this.setState({ status: 'starting', attempt: this.attempt });
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'AICO Engine',
      stdio: 'pipe',
      // Never a folder inside app.asar: that is not a real directory once
      // packaged, and the process would fail to start with no output at all.
      cwd: this.env.AICO_DESKTOP_CWD ?? os.homedir(),
      env: { ...process.env, ...this.env },
    });
    this.child = child;
    const capture = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.lastLog.push(line);
        if (this.lastLog.length > 200) this.lastLog.shift();
        this.emit('log', line);
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    child.on('message', (msg: { type?: string; url?: string; message?: string }) => {
      if (msg?.type === 'ready' && msg.url) {
        const u = new URL(msg.url);
        const token = u.searchParams.get('token') ?? '';
        this.endpoint = { origin: u.origin, token };
        this.attempt = 0;
        this.setState({ status: 'ready', origin: u.origin, startedAt: Date.now() });
        const waiting = this.waiters;
        this.waiters = [];
        for (const w of waiting) w(this.endpoint);
      } else if (msg?.type === 'error') {
        this.lastLog.push(msg.message ?? 'unknown error');
      }
    });

    child.on('exit', (code) => {
      this.child = null;
      this.endpoint = null;
      if (this.quitting) { this.setState({ status: 'stopped' }); return; }
      const retryInMs = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 5));
      const tail = this.lastLog.slice(-3).join('\n');
      this.setState({
        status: 'crashed',
        message: `The engine exited (code ${code}).${tail ? `\n${tail}` : ''}`,
        attempt: this.attempt,
        retryInMs,
      });
      setTimeout(() => this.start(), retryInMs);
    });
  }

  /** Stop and start again — used by "Restart engine" and after a settings change that needs it. */
  async restart(): Promise<void> {
    await this.stop(false);
    this.attempt = 0;
    this.start();
  }

  /** Ask the engine to close its runs and socket; kill it if it does not. */
  async stop(final = true): Promise<void> {
    if (final) this.quitting = true;
    const child = this.child;
    if (!child) return;
    const wasQuitting = this.quitting;
    this.quitting = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.postMessage({ type: 'shutdown' }); } catch { child.kill(); }
    });
    this.child = null;
    this.endpoint = null;
    this.quitting = wasQuitting && final;
    if (!final) this.quitting = false;
  }

  private setState(state: EngineState): void {
    this.state = state;
    this.emit('state', state);
  }
}
