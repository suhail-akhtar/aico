/**
 * The library sandbox: load a module in its own process and call into it.
 *
 * A worker (library-workers.ts) loads the target and answers JSON lines; this
 * class starts it, speaks to it, and turns each reply into an {@link Observation}.
 * It is what lets a library be treated like any other target: `inject` a call,
 * `observe` the result, `snapshot` a fingerprint of it.
 *
 * Confinement. A Node library runs under the permission model: it can read its
 * own package folder (and the `node_modules` it sits in) and write only to a
 * scratch folder that is deleted afterwards, and it cannot start processes. That
 * is what makes fuzzing safe to run on a library whose job is deleting files or
 * running commands: the calls land in the scratch folder or are refused. It does
 * not limit the network. Python has no portable equivalent: the worker runs in
 * isolated mode (`-I`) from a scratch directory with a minimal environment, which
 * protects the environment but NOT the filesystem, and this is recorded in each
 * observation's spec `unknowns` (spec.ts) instead of being implied away.
 *
 * Failure handling: a call that does not return within the timeout kills the
 * worker (a synchronous infinite loop cannot be interrupted any other way) and
 * starts a fresh one; handles to objects the old worker held are gone, and the
 * next call that uses one says so.
 *
 * @module cleanroom/sandbox-library
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NODE_WORKER, PYTHON_WORKER } from './library-workers.js';
import { permissionFlags, realish } from './wall.js';
import type { CallResult, LaunchSpec, LibExportInfo, Observation, Sandbox, StateFingerprint, Stimulus } from './types.js';

type LibSpec = Extract<LaunchSpec, { kind: 'library' }>;
interface Reply { id?: number; event?: string; error?: CallResult['error']; exports?: LibExportInfo[]; [k: string]: unknown }

export function detectLanguage(entry: string): 'node' | 'python' {
  const ext = path.extname(entry).toLowerCase();
  if (ext === '.py') return 'python';
  try { if (fs.statSync(entry).isDirectory()) return fs.existsSync(path.join(entry, '__init__.py')) ? 'python' : 'node'; } catch { /* decided by the extension */ }
  return 'node';
}

/** The folder that holds the package: the nearest parent with a package.json (Node), or the entry's own folder. */
function packageRoot(entry: string): string {
  let dir = fs.existsSync(entry) && fs.statSync(entry).isDirectory() ? entry : path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return fs.existsSync(entry) && fs.statSync(entry).isDirectory() ? entry : path.dirname(entry);
}

function pythonCommand(): string | undefined {
  for (const c of [process.env.AICO_PYTHON, 'python3', 'python', 'py'].filter((x): x is string => !!x)) {
    try { const r = spawnSync(c, ['--version'], { encoding: 'utf8', windowsHide: true }); if (r.status === 0) return c; } catch { /* next */ }
  }
  return undefined;
}

export class LibrarySandbox implements Sandbox {
  readonly kind = 'library' as const;
  private spec!: LibSpec;
  private language: 'node' | 'python' = 'node';
  private child?: ChildProcessWithoutNullStreams;
  private scratch = '';
  private nextId = 1;
  private waiting = new Map<number, (r: Reply) => void>();
  private events: Reply[] = [];
  private buf = '';
  private last: Observation = { at: new Date().toISOString(), kind: 'library' };
  confined = false;

  async start(spec: LaunchSpec): Promise<void> {
    if (spec.kind !== 'library') throw new Error('LibrarySandbox starts a library target');
    const resolved = path.resolve(spec.cwd ?? process.cwd(), spec.entry);
    if (!fs.existsSync(resolved)) throw new Error(`${resolved} does not exist`);
    // The permission model compares path *strings*: a Windows 8.3 short name (SUHAIL~1) is not the long path it was allowed under, so the real path is used everywhere.
    this.spec = { ...spec, entry: realish(resolved) };
    this.language = spec.language ?? detectLanguage(this.spec.entry);
    this.scratch = realish(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-lib-')));
    await this.spawnWorker();
  }

  private async spawnWorker(): Promise<void> {
    const entry = this.spec.entry;
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'PATHEXT', 'LANG']) if (process.env[k]) env[k] = process.env[k]!;
    let cmd: string, args: string[];
    if (this.language === 'node') {
      const worker = path.join(this.scratch, 'worker.mjs');
      fs.writeFileSync(worker, NODE_WORKER);
      const root = packageRoot(entry);
      const reads = new Set([realish(root), realish(this.scratch)]);
      if (path.basename(path.dirname(root)) === 'node_modules') reads.add(realish(path.dirname(root))); // dependencies hoisted beside the package
      const base = permissionFlags(this.scratch);
      this.confined = !!base;
      const flags = base ? [base[0]!, ...[...reads].map(r => `--allow-fs-read=${r}`), `--allow-fs-write=${realish(this.scratch)}`] : [];
      cmd = process.execPath; args = [...flags, worker, entry];
    } else {
      const py = pythonCommand();
      if (!py) throw new Error('no Python was found on this machine (set AICO_PYTHON to its path)');
      const worker = path.join(this.scratch, 'worker.py');
      fs.writeFileSync(worker, PYTHON_WORKER);
      cmd = py; args = ['-I', '-B', worker, entry];
      this.confined = false;
    }
    this.buf = ''; this.events = [];
    const child = spawn(cmd, args, { cwd: this.scratch, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
    child.stdout.on('data', d => this.onData(String(d)));
    child.on('close', () => { for (const [id, f] of this.waiting) f({ id, error: { name: 'WorkerExited', message: (stderr.trim().split('\n').pop() ?? 'the worker exited').slice(0, 200) } }); this.waiting.clear(); });
    const ready = await this.waitEvent(['ready', 'load-failed'], 15_000);
    if (!ready) throw new Error(`the library did not finish loading within 15s${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
    if (ready.event === 'load-failed') throw new Error(`the library could not be loaded: ${ready.error?.name}: ${ready.error?.message}`);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: Reply;
      try { m = JSON.parse(line) as Reply; } catch { continue; }
      if (m.id !== undefined && this.waiting.has(m.id)) { const f = this.waiting.get(m.id)!; this.waiting.delete(m.id); f(m); }
      else if (m.event) this.events.push(m);
    }
  }

  private async waitEvent(names: string[], ms: number): Promise<Reply | undefined> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = this.events.find(x => names.includes(x.event ?? ''));
      if (e) return e;
      if (this.child && this.child.exitCode !== null) return this.events.find(x => names.includes(x.event ?? ''));
      await new Promise(r => setTimeout(r, 20));
    }
    return undefined;
  }

  private rpc(msg: Record<string, unknown>, ms: number): Promise<Reply | 'timeout'> {
    return new Promise(resolve => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.waiting.delete(id); resolve('timeout'); }, ms);
      this.waiting.set(id, r => { clearTimeout(timer); resolve(r); });
      this.child!.stdin.write(JSON.stringify({ id, ...msg }) + '\n');
    });
  }

  /** The module's exports, before anything is called. */
  async list(): Promise<LibExportInfo[]> {
    const r = await this.rpc({ op: 'list' }, this.spec.timeoutMs ?? 8000);
    if (r === 'timeout' || !r.exports) throw new Error('could not list the library exports');
    return r.exports;
  }

  async inject(s: Stimulus): Promise<void> {
    if (s.type === 'wait') { await new Promise(r => setTimeout(r, Math.min(s.ms, 30_000))); return; }
    if (s.type !== 'call' && s.type !== 'get') throw new Error(`a library target cannot take a "${s.type}" stimulus`);
    const ms = this.spec.timeoutMs ?? 8000;
    const started = Date.now();
    const r = await this.rpc(s.type === 'call' ? { op: 'call', fn: s.fn, args: s.args ?? [], on: s.on, construct: !!s.construct } : { op: 'get', prop: s.prop, on: s.on }, ms);
    if (r === 'timeout') {
      // A call that never returns cannot be interrupted: end the worker and start a clean one.
      this.child?.kill('SIGKILL');
      this.last = { at: new Date().toISOString(), kind: 'library', durationMs: Date.now() - started, call: { ok: false, error: { name: 'Timeout', message: `the call did not return within ${ms / 1000}s (the worker was restarted; earlier object handles are gone)` } } };
      await this.spawnWorker().catch(() => undefined);
      return;
    }
    const { id: _id, event: _e, ...rest } = r;
    this.last = { at: new Date().toISOString(), kind: 'library', durationMs: Date.now() - started, call: rest as unknown as CallResult };
  }

  async observe(): Promise<Observation> { return this.last; }

  async snapshot(): Promise<StateFingerprint> {
    const c = this.last.call;
    const shape = c ? (c.ok ? `${c.kind}|${c.async ? 'async' : 'sync'}|${JSON.stringify(c.value)?.slice(0, 200)}` : `throws|${c.error?.name}|${c.error?.message?.slice(0, 80)}`) : 'none';
    return createHash('sha256').update(shape).digest('hex').slice(0, 16);
  }

  async stop(): Promise<void> {
    const c = this.child;
    this.child = undefined;
    if (c && c.exitCode === null) { c.kill('SIGKILL'); await new Promise(r => setTimeout(r, 50)); }
    if (this.scratch) { try { fs.rmSync(this.scratch, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left behind in the temp folder */ } }
    this.scratch = '';
  }
}
