/**
 * Running a custom tool: one argv through `spawn` with no shell, or one HTTP
 * call through the ops `HttpRequest` client — the two runners AICO already
 * trusts (design §5.2, ADR 0009).
 *
 * WHY THESE RULES.
 *
 *  - **No shell, ever, on POSIX.** `spawn(file, args)` hands each element to
 *    the program as one argument; `; rm -rf ~` in a value is a strange file
 *    name, not a second command.
 *  - **Windows `.cmd`/`.bat` shims are the exception the platform forces.**
 *    `CreateProcess` cannot run a batch file, so it goes through `cmd.exe`,
 *    which re-parses the whole line — the bug class this codebase already hit
 *    twice (the MCP client and the VS Code spawn, both "spaces in Program
 *    Files"). Quoting cannot make `%VAR%` or `^` inert there, so for a shim
 *    any argument carrying cmd syntax (`" % ! ^ & | < > ( )`) is refused
 *    before anything starts, and the rest are double-quoted. A real `.exe` is
 *    spawned directly; Node's own quoting keeps every element whole.
 *  - **Secrets are bound here, in trusted code.** `{{secret:name}}` in `env`
 *    is resolved through the broker for this one call under the tool's own
 *    scope (`tool:<name>`), so policy, approval and audit apply. The value goes
 *    into the child's environment and nowhere else — not the arguments, the
 *    log or the stream; whatever the child prints is redacted by the pipeline.
 *  - **`{{secret-file:name}}` is a temp file that does not outlive the call**
 *    (ADR 0010, amending 0006): a fresh 0700 directory, a 0600 file, deleted in
 *    `finally` — on success, failure, timeout, a spawn error or a secret that
 *    failed to resolve half-way — and swept at process exit as a last resort.
 *  - **Every call has a deadline** (`timeoutSec`, default 60 s) and the whole
 *    process tree is killed when it passes, the abort signal included.
 *  - **Failures are results.** A non-zero exit, a timeout or a missing program
 *    comes back as `{error, …}` the model can act on; nothing throws through
 *    the loop.
 *
 * Not here: deciding whether the call may run (the pipeline's custom-tool
 * guard does that), output caps (the caller spills at `output.maxChars`).
 *
 * @module custom-tools/runner
 */

import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVault, type ApprovalPrompter } from '../vault/index.js';
import { runWithOpsPrompter } from '../tools/ops/common.js';
import { httpRequest } from '../tools/ops/http.js';
import {
  DEFAULT_TIMEOUT_SEC, describeCall, fieldsOf, parseSecretRef, renderArgv, renderHttp, type CustomToolDef,
} from './format.js';

export interface RunContext {
  /** The run's directory: `${workspace}` and relative `cwd` resolve here. */
  cwd: string;
  signal?: AbortSignal;
  sessionId?: string;
  /** Who approves a credential use when no process-wide prompter is set. */
  prompter?: ApprovalPrompter;
}

/** Whether a Windows argument can be handed to cmd.exe without it being re-parsed. */
const CMD_UNSAFE = /["%!^&|<>()\r\n]/;
/** Bytes kept from each stream while it runs; the caller excerpts to the tool's cap. */
const MAX_STREAM = 4 * 1024 * 1024;

// ── secret files ─────────────────────────────────────────────────────

/** Where temp-file secrets live while a call runs. One directory per call under it. */
export function secretFileRoot(): string {
  return path.join(os.tmpdir(), 'aico-secret-files');
}

const liveDirs = new Set<string>();
let exitSweepInstalled = false;

function installExitSweep(): void {
  if (exitSweepInstalled) return;
  exitSweepInstalled = true;
  // The last resort only: every call deletes its own in `finally`. This covers
  // a process killed between write and cleanup by an orderly exit.
  process.once('exit', () => {
    for (const dir of liveDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ } }
  });
}

function writeSecretFile(dir: string, index: number, value: string): string {
  const file = path.join(dir, `secret-${index}`);
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
  return file;
}

function removeDir(dir: string | undefined): void {
  if (!dir) return;
  liveDirs.delete(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reported by the next sweep; never fatal to the call */ }
}

/**
 * The child's environment for one call. Resolves each secret through the
 * broker; returns the directory to delete when secret files were written.
 * On any failure the directory is already gone when this throws.
 */
async function bindEnv(def: CustomToolDef, args: Record<string, unknown>, ctx: RunContext): Promise<{ env: Record<string, string>; dir?: string }> {
  const env: Record<string, string> = {};
  let dir: string | undefined;
  try {
    let files = 0;
    for (const [key, value] of Object.entries(def.run?.env ?? {})) {
      const ref = parseSecretRef(value);
      if (!ref) { env[key] = value; continue; }
      const resolved = await getVault().resolve(ref.ref, {
        tool: `tool:${def.name}`,
        purpose: `run the custom tool ${def.name}: ${describeCall(def, args)}`.slice(0, 1500),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      }, ctx.prompter);
      let secret: string;
      // `name.field` was resolved with its field, so the default value is that field.
      try { secret = resolved.value(); } finally { resolved.release(); }
      if (ref.kind === 'secret') { env[key] = secret; continue; }
      if (!dir) {
        fs.mkdirSync(secretFileRoot(), { recursive: true, mode: 0o700 });
        dir = fs.mkdtempSync(path.join(secretFileRoot(), 'call-'));
        fs.chmodSync(dir, 0o700);
        liveDirs.add(dir);
        installExitSweep();
      }
      env[key] = writeSecretFile(dir, ++files, secret);
    }
    return { env, ...(dir ? { dir } : {}) };
  } catch (err) {
    removeDir(dir);
    throw err;
  }
}

// ── Windows program resolution ───────────────────────────────────────

/**
 * What `program` will actually run on Windows, and whether it is a batch
 * shim that needs cmd.exe. PATH × PATHEXT, as CreateProcess's caller would
 * search; unresolved names are left to fail as "not found".
 */
export function resolveWindowsProgram(program: string, env: NodeJS.ProcessEnv = process.env): { file: string; shim: boolean } {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase());
  const isShim = (file: string): boolean => /\.(cmd|bat)$/i.test(file);
  const candidates = (base: string): string[] => (path.extname(base) ? [base] : exts.map(e => base + e));
  const exists = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (/[\\/]/.test(program) || path.isAbsolute(program)) {
    const found = candidates(program).find(exists);
    return { file: found ?? program, shim: isShim(found ?? program) };
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const d of dirs) {
    const found = candidates(path.join(d, program)).find(exists);
    if (found) return { file: found, shim: isShim(found) };
  }
  return { file: program, shim: isShim(program) };
}

/**
 * How to spawn `program args` with no shell interpreting the arguments.
 * Throws (before anything starts) when a Windows shim would be handed an
 * argument cmd.exe would re-parse.
 */
export function spawnPlan(program: string, args: readonly string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): {
  file: string; args: string[]; windowsVerbatimArguments?: boolean;
} {
  if (platform !== 'win32') return { file: program, args: [...args] };
  const { file, shim } = resolveWindowsProgram(program, env);
  if (!shim) return { file, args: [...args] };
  const unsafe = [file, ...args].find(a => CMD_UNSAFE.test(a));
  if (unsafe !== undefined) {
    throw new Error(`${path.basename(file)} is a batch file, which Windows runs through cmd.exe; the argument ${JSON.stringify(unsafe.slice(0, 80))} `
      + 'contains characters cmd.exe would interpret (" % ! ^ & | < > ( )), so it was refused rather than passed. Point the tool at the real .exe, or use a value without them.');
  }
  const q = (a: string): string => (a === '' || /[\s,;=]/.test(a) ? `"${a}"` : a);
  // `/s /c "…"`: cmd strips exactly the outer quotes and runs the rest as written.
  return {
    file: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[q(file), ...args.map(q)].join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined); } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

export interface ProcessOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

/** Spawn and collect, with a deadline and the signal. Never rejects. */
export function runProcess(program: string, args: readonly string[], opts: {
  cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal;
}): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let plan: ReturnType<typeof spawnPlan>;
    try { plan = spawnPlan(program, args); } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: (err as Error).message });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    child.stdout?.on('data', (c: Buffer) => { if (stdout.length < MAX_STREAM) stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { if (stderr.length < MAX_STREAM) stderr += c.toString('utf8'); });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs);
    const onAbort = (): void => { aborted = true; killTree(child); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    const finish = (outcome: Omit<ProcessOutcome, 'stdout' | 'stderr' | 'timedOut' | 'aborted'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...outcome, stdout, stderr, timedOut, aborted });
    };
    child.on('error', (err) => finish({ exitCode: null, spawnError: err.message }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
}

const tail = (text: string, n: number): string => (text.length > n ? `…${text.slice(-n)}` : text);

/** Where the command runs. */
function workingDir(def: CustomToolDef, ctx: RunContext): string {
  const raw = def.run?.cwd;
  if (!raw) return ctx.cwd;
  const expanded = raw.replace(/\$\{workspace\}/g, ctx.cwd);
  return path.resolve(ctx.cwd, expanded);
}

/**
 * Run one validated call. `args` must already have passed `validateArgs`.
 * Returns the result the model sees (before redaction and the output cap).
 */
export async function runCustomTool(def: CustomToolDef, args: Record<string, unknown>, ctx: RunContext): Promise<Record<string, unknown>> {
  if (def.http) return runHttp(def, args, ctx);
  const run = def.run!;
  const argv = renderArgv(run.argv, args, fieldsOf(def));
  let bound: { env: Record<string, string>; dir?: string };
  try {
    bound = await bindEnv(def, args, ctx);
  } catch (err) {
    return { error: `${def.name} did not run: ${(err as Error).message}` };
  }
  try {
    const timeoutSec = run.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const out = await runProcess(argv[0]!, argv.slice(1), {
      cwd: workingDir(def, ctx), env: bound.env, timeoutMs: timeoutSec * 1000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (out.spawnError) {
      const missing = /ENOENT/.test(out.spawnError);
      return {
        error: missing
          ? `${def.name} could not start: "${argv[0]}" was not found on PATH. Install it, or ask the person to fix the tool's argv.`
          : `${def.name} could not start: ${out.spawnError}`,
      };
    }
    if (out.timedOut) return { error: `${def.name} timed out after ${timeoutSec}s and was stopped.`, stdout: tail(out.stdout, 4000), stderr: tail(out.stderr, 2000) };
    if (out.aborted) return { error: `${def.name} was cancelled.` };
    if (out.exitCode !== 0) {
      return {
        error: `${def.name} exited with code ${out.exitCode}. Read stderr for why; fix the arguments, or tell the person if the tool itself is failing.`,
        exitCode: out.exitCode,
        stderr: tail(out.stderr, 4000),
        ...(out.stdout.trim() ? { stdout: tail(out.stdout, 4000) } : {}),
      };
    }
    return { exitCode: 0, stdout: out.stdout, ...(out.stderr.trim() ? { stderr: tail(out.stderr, 2000) } : {}) };
  } finally {
    removeDir(bound.dir);
  }
}

async function runHttp(def: CustomToolDef, args: Record<string, unknown>, ctx: RunContext): Promise<Record<string, unknown>> {
  const req = renderHttp(def.http!, args);
  try {
    // The ops client substitutes `{{secret:…}}` in headers for this request's
    // origin only, applies the SSRF guard and the credential's own policy, and
    // masks secret-shaped values in what comes back.
    return await runWithOpsPrompter(ctx.prompter, () => httpRequest({
      method: req.method, url: req.url, headers: req.headers,
      ...(req.json !== undefined ? { json: req.json } : {}),
      timeout: def.http!.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    }, ctx.signal));
  } catch (err) {
    return { error: `${def.name}: ${(err as Error).message}` };
  }
}

/** Run a tool's probe (`test` only — never during a turn). */
export async function runProbe(def: CustomToolDef, cwd: string): Promise<{ ok: boolean; detail: string }> {
  if (!def.probe?.length) return { ok: true, detail: 'no probe defined' };
  const out = await runProcess(def.probe[0]!, def.probe.slice(1), { cwd, env: {}, timeoutMs: 15_000 });
  if (out.spawnError) return { ok: false, detail: `probe could not start: ${out.spawnError}` };
  if (out.exitCode !== 0) return { ok: false, detail: `probe exited ${out.exitCode}: ${tail(out.stderr || out.stdout, 400)}` };
  return { ok: true, detail: tail(out.stdout.trim(), 200) || 'ok' };
}

/** A stable id for a file's content, for "enabled means this exact version". */
export function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
