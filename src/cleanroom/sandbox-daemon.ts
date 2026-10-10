/**
 * The daemon sandbox: start a background process, wait until it is ready, then
 * talk to it the ways a daemon is talked to.
 *
 *  - **Channels.** A TCP port, a Unix-domain socket or a Windows named pipe
 *    (`net.connect` takes all three: a pipe is just a path under `\\.\pipe\`).
 *    `send` writes bytes, then reads the reply until the connection closes or
 *    goes quiet.
 *  - **Signals.** SIGHUP, SIGTERM and SIGINT, to see reloads and graceful
 *    shutdown. On Windows there are no such signals; the process is ended
 *    outright and the observation says `delivery: 'forced'`, the same honesty
 *    as the command-line sandbox (ADR 0041).
 *  - **Watched folders.** `fs-write` and `fs-delete` create or remove a file in a
 *    folder the daemon is expected to watch; the observation lists what changed
 *    on disk, and whatever the daemon printed in reaction.
 *
 * "Ready" is explicit, because a daemon does not exit: it is ready when a line
 * of its output matches `ready.logMatch` (a capture group names the TCP port it
 * chose), or when `ready.port` / `ready.socket` accepts a connection.
 *
 * Every observation carries the output written since the last one, so a
 * stimulus and its effect stay together: `State + Event -> State + SideEffect`.
 * D-Bus is not covered; it needs a bus and a platform-specific client.
 *
 * @module cleanroom/sandbox-daemon
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DaemonResult, LaunchSpec, Observation, Sandbox, StateFingerprint, Stimulus } from './types.js';

type DaemonSpec = Extract<LaunchSpec, { kind: 'daemon' }>;
const WIN = process.platform === 'win32';
const CAP = 4000;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export class DaemonSandbox implements Sandbox {
  readonly kind = 'daemon' as const;
  private spec!: DaemonSpec;
  private child?: ChildProcess;
  private out = ''; private err = '';
  private outCursor = 0; private errCursor = 0;
  private exit?: { code: number | null; signal: string | null };
  private port?: number;
  private delivery?: 'signal' | 'forced';
  private last: Observation = { at: new Date().toISOString(), kind: 'daemon' };
  /** What was found in the watched folders at the last look. */
  private files = new Map<string, string>();

  async start(spec: LaunchSpec, signal?: AbortSignal): Promise<void> {
    if (spec.kind !== 'daemon') throw new Error('DaemonSandbox starts a daemon target');
    this.spec = spec;
    this.out = this.err = ''; this.outCursor = this.errCursor = 0; this.exit = undefined; this.port = undefined; this.delivery = undefined;
    const child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => { if (this.out.length < 200_000) this.out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { if (this.err.length < 200_000) this.err += d.toString('utf8'); });
    child.on('error', (e: Error) => { this.err += `\n[spawn error] ${e.message}`; this.exit = { code: null, signal: null }; });
    child.on('close', (code, sig) => { this.exit = { code, signal: sig }; });
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    await this.waitReady();
    this.files = this.scan();
    // Not `result()`: that would consume the startup output, and the first observation is where it belongs.
    this.last = { at: new Date().toISOString(), kind: 'daemon', daemon: { alive: true, ...(this.port ? { port: this.port } : {}) } };
  }

  private async waitReady(): Promise<void> {
    const r = this.spec.ready ?? {};
    const end = Date.now() + (r.timeoutMs ?? 15_000);
    const re = r.logMatch ? new RegExp(r.logMatch) : undefined;
    while (Date.now() < end) {
      if (this.exit) throw new Error(`the daemon exited before it was ready (code ${this.exit.code}): ${(this.err || this.out).trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
      if (re) {
        const m = re.exec(this.out + '\n' + this.err);
        if (m) { if (m[1] && /^\d+$/.test(m[1])) this.port = Number(m[1]); return; }
      } else if (r.port || r.socket) {
        if (await this.canConnect(r.socket ? { path: r.socket } : { host: '127.0.0.1', port: r.port! })) { this.port = r.port; return; }
      } else { await sleep(300); return; } // nothing to wait for: give it a moment to start
      await sleep(60);
    }
    throw new Error('the daemon was not ready within the wait (no ready signal appeared)');
  }

  private canConnect(o: net.NetConnectOpts): Promise<boolean> {
    return new Promise(resolve => { const s = net.connect(o); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
  }

  private channelOpts(channel: string): net.NetConnectOpts {
    if (channel === 'tcp') { if (!this.port) throw new Error('no TCP port is known (the output did not name one); use tcp:host:port'); return { host: '127.0.0.1', port: this.port }; }
    if (channel.startsWith('tcp:')) { const [, h, p] = channel.split(':'); return { host: h!, port: Number(p) }; }
    if (channel.startsWith('socket:') || channel.startsWith('pipe:')) return { path: channel.slice(channel.indexOf(':') + 1) };
    throw new Error(`unknown channel "${channel}"`);
  }

  async inject(s: Stimulus): Promise<void> {
    if (s.type === 'wait') { await sleep(Math.min(s.ms, 30_000)); this.last = this.result({}); return; }
    if (s.type === 'send') { this.last = this.result(await this.send(s.channel, s.data, s.waitMs ?? 300)); return; }
    if (s.type === 'signal') {
      const c = this.child;
      if (!c || this.exit) { this.last = { ...this.result({}), error: 'the daemon is not running' }; return; }
      this.delivery = WIN ? 'forced' : 'signal';
      c.kill(s.signal);
      const end = Date.now() + 3000;
      while (!this.exit && Date.now() < end) { await sleep(30); if (!WIN && s.signal === 'SIGHUP') { await sleep(300); break; } } // a reload keeps running: give its output a moment
      this.last = this.result({});
      return;
    }
    if (s.type === 'fs-write' || s.type === 'fs-delete') {
      const before = this.scan();
      const p = path.resolve(s.path);
      if (s.type === 'fs-write') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s.content); } else fs.rmSync(p, { force: true });
      await sleep(500); // time for a watcher to notice and react
      const after = this.scan();
      this.files = after;
      const changes: NonNullable<DaemonResult['fsChanges']> = [];
      for (const [f, sig] of after) { if (!before.has(f)) changes.push({ path: path.basename(f), kind: 'added' }); else if (before.get(f) !== sig) changes.push({ path: path.basename(f), kind: 'changed' }); }
      for (const f of before.keys()) if (!after.has(f)) changes.push({ path: path.basename(f), kind: 'removed' });
      this.last = this.result({ fsChanges: changes });
      return;
    }
    throw new Error(`a daemon target cannot take a "${s.type}" stimulus`);
  }

  private async send(channel: string, data: string, waitMs: number): Promise<Partial<DaemonResult>> {
    let opts: net.NetConnectOpts;
    try { opts = this.channelOpts(channel); } catch (e) { return { connectError: e instanceof Error ? e.message : String(e) }; }
    return new Promise(resolve => {
      const sock = net.connect(opts);
      let reply = '', closed = false, settled = false, idle: NodeJS.Timeout | undefined;
      const finish = (extra: Partial<DaemonResult> = {}): void => {
        if (settled) return; settled = true; clearTimeout(idle); clearTimeout(hard); sock.destroy();
        resolve({ reply: reply.slice(0, CAP), closed, ...extra });
      };
      const arm = (): void => { clearTimeout(idle); idle = setTimeout(() => finish(), waitMs); };
      const hard = setTimeout(() => finish(), Math.max(waitMs * 6, 5000));
      sock.once('connect', () => { if (data) sock.write(data.replace(/\\r/g, '\r').replace(/\\n/g, '\n')); arm(); });
      sock.on('data', d => { reply += d.toString('utf8'); arm(); });
      sock.on('end', () => { closed = true; finish(); });
      sock.on('close', () => { closed = true; finish(); });
      sock.once('error', e => finish({ connectError: e.message }));
    });
  }

  /** The files in the watched folders, each with a cheap signature (size and mtime). */
  private scan(): Map<string, string> {
    const m = new Map<string, string>();
    for (const d of this.spec.watchDirs ?? []) {
      const walk = (dir: string, depth: number): void => {
        let ents: fs.Dirent[] = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else { try { const st = fs.statSync(p); m.set(p, `${st.size}:${Math.floor(st.mtimeMs)}`); } catch { /* gone */ } }
        }
      };
      walk(path.resolve(d), 0);
    }
    return m;
  }

  private result(extra: Partial<DaemonResult>): Observation {
    const newOut = this.out.slice(this.outCursor), newErr = this.err.slice(this.errCursor);
    this.outCursor = this.out.length; this.errCursor = this.err.length;
    const d: DaemonResult = {
      alive: !this.exit, ...(this.exit ? { exitCode: this.exit.code, signal: this.exit.signal } : {}),
      ...(newOut ? { newStdout: newOut.slice(0, CAP) } : {}), ...(newErr ? { newStderr: newErr.slice(0, CAP) } : {}),
      ...(this.delivery ? { signalDelivery: this.delivery } : {}), ...(this.port ? { port: this.port } : {}), ...extra,
    };
    return { at: new Date().toISOString(), kind: 'daemon', daemon: d, durationMs: 0 };
  }

  async observe(): Promise<Observation> { return this.last; }

  async snapshot(): Promise<StateFingerprint> {
    const d = this.last.daemon;
    return createHash('sha256').update(JSON.stringify([d?.alive, d?.exitCode ?? null, d?.reply?.slice(0, 200) ?? '', d?.connectError ?? '', (d?.newStdout ?? '').slice(0, 120), (d?.fsChanges ?? []).length])).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    const c = this.child;
    this.child = undefined;
    if (c && !this.exit) { c.kill('SIGKILL'); const end = Date.now() + 1500; while (!this.exit && Date.now() < end) await sleep(30); }
  }
}
