/**
 * Running a Mini App that is a real Node application.
 *
 * ## What changes, and what does not
 *
 * A single-page Mini App runs no code the model wrote on the server — that is
 * why the page can be trusted with a database it cannot send SQL to. A Next.js
 * app is server code by definition. There is no version of it that keeps that
 * guarantee, so the guarantee here is a different one, stated plainly rather
 * than implied:
 *
 * **It runs in its own process, on its own port, with nothing of aico's.**
 *
 *   - Its own process, so stopping it is `kill` rather than hoping. A crash
 *     takes down the app and not the workspace.
 *   - Its own port, so it is its own origin. One app's JavaScript cannot read
 *     another app's data, and neither can reach the aico API — the same
 *     browser-enforced boundary the single-page host relies on, one level up.
 *   - A scrubbed environment. Every `*_API_KEY`, every `AICO_*`, every token in
 *     the parent's environment is removed before the child sees it. A generated
 *     `page.tsx` that logs `process.env` gets nothing worth having.
 *
 * ## What is NOT contained, and you should know it
 *
 * The child runs Node with your user's permissions. `cwd` is pinned to the app
 * directory, but nothing stops server code from reading elsewhere on the disk
 * or opening a socket. `npm install` runs third-party postinstall scripts. This
 * is the same trust you extend to any repository you clone and run — it is not
 * a sandbox, and calling it one would be the dishonest part.
 *
 * @module miniapps/process
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import net from 'net';
import path from 'path';

export type AppState =
  | 'stopped'
  /** `npm install` is running. First start of an app takes a while. */
  | 'installing'
  /** The dev server is starting but has not reported a URL yet. */
  | 'starting'
  | 'running'
  | 'failed';

export interface RunningApp {
  slug: string;
  state: AppState;
  port?: number;
  url?: string;
  /** Why it failed, when it did. */
  error?: string;
  /**
   * The tail of what the process printed.
   *
   * Kept because a Next.js app that will not start says why — a syntax error, a
   * missing dependency, a port clash — and that message is the entire content
   * of "it did not work". Without it the panel can only report the failure, and
   * the reader has to go and find the terminal.
   */
  output: string[];
  startedAt: number;
}

/** How many lines of process output to keep. Enough for a stack trace. */
const OUTPUT_LINES = 60;

const running = new Map<string, { record: RunningApp; child?: ChildProcess }>();
let listeners: Array<(apps: RunningApp[]) => void> = [];

export function subscribeToApps(fn: (apps: RunningApp[]) => void): () => void {
  listeners.push(fn);
  fn(snapshot());
  return () => { listeners = listeners.filter(l => l !== fn); };
}

function snapshot(): RunningApp[] {
  return [...running.values()].map(v => ({ ...v.record, output: [...v.record.output] }));
}

function emit(): void {
  const apps = snapshot();
  listeners.forEach(l => l(apps));
}

function patch(slug: string, changes: Partial<RunningApp>): void {
  const entry = running.get(slug);
  if (!entry) return;
  Object.assign(entry.record, changes);
  emit();
}

function note(slug: string, line: string): void {
  const entry = running.get(slug);
  if (!entry) return;
  for (const part of line.split(/\r?\n/)) {
    const clean = part.trimEnd();
    if (!clean) continue;
    entry.record.output.push(clean);
  }
  // Bounded: a dev server left running for a day would otherwise hold its
  // entire log in memory, and only the recent part answers any question.
  if (entry.record.output.length > OUTPUT_LINES) {
    entry.record.output.splice(0, entry.record.output.length - OUTPUT_LINES);
  }
  emit();
}

export function appState(slug: string): RunningApp | undefined {
  const entry = running.get(slug);
  return entry ? { ...entry.record, output: [...entry.record.output] } : undefined;
}

export function runningApps(): RunningApp[] {
  return snapshot();
}

/**
 * A port nothing is listening on.
 *
 * Asked of the OS and then released, which leaves a gap between choosing and
 * binding. Next needs a port on its command line, so there is no way to hand it
 * an already-bound socket; the gap is small and the failure is visible in the
 * child's own output rather than silent.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The environment a Mini App process gets.
 *
 * An allow-by-exception copy: everything the parent has, minus anything that
 * looks like a credential. Removing by pattern rather than listing what to keep
 * is deliberate — a keep-list would have to be updated every time aico learns a
 * new provider, and the failure mode of forgetting is handing out a key.
 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/_API_KEY$|^AICO_|TOKEN|SECRET|_KEY$|PASSWORD|CREDENTIAL/i.test(key)) continue;
    out[key] = value;
  }
  // Next reads this and behaves differently; being explicit beats inheriting
  // whatever the parent shell happened to have.
  out.NODE_ENV = 'development';
  return out;
}

function spawnIn(
  dir: string, command: string, args: string[], port?: number,
): ChildProcess {
  return spawn(command, args, {
    cwd: dir,
    env: { ...scrubbedEnv(), ...(port ? { PORT: String(port) } : {}) },
    // Windows resolves `npm`/`npx` through a shim, which needs a shell.
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Stop a running app.
 *
 * On Windows a dev server is a tree — the shim, npm, and node under it — and
 * killing the parent leaves the port held by a grandchild. `taskkill /T` is the
 * only thing that reliably takes the whole tree down; elsewhere the process
 * group does it.
 */
export async function stopApp(slug: string): Promise<boolean> {
  const entry = running.get(slug);
  if (!entry) return false;
  const child = entry.child;
  running.delete(slug);
  emit();
  if (!child?.pid) return true;

  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  return true;
}

export async function stopAllApps(): Promise<void> {
  await Promise.all([...running.keys()].map(slug => stopApp(slug)));
}

/**
 * Start a Next.js Mini App, installing its dependencies first if needed.
 *
 * Returns as soon as the work is under way rather than when the server is
 * ready: a first install can take minutes, and a call that blocked for them
 * would make the UI look hung during the one operation that most needs a
 * progress report. Progress arrives through {@link subscribeToApps}.
 */
export async function startApp(slug: string, dir: string): Promise<RunningApp> {
  const existing = running.get(slug);
  if (existing && existing.record.state !== 'failed' && existing.record.state !== 'stopped') {
    return { ...existing.record, output: [...existing.record.output] };
  }
  if (existing) await stopApp(slug);

  const record: RunningApp = { slug, state: 'starting', output: [], startedAt: Date.now() };
  running.set(slug, { record });
  emit();

  if (!existsSync(path.join(dir, 'package.json'))) {
    patch(slug, { state: 'failed', error: 'no package.json — this app has not been scaffolded yet' });
    return appState(slug)!;
  }

  void (async () => {
    try {
      if (!existsSync(path.join(dir, 'node_modules'))) {
        patch(slug, { state: 'installing' });
        note(slug, 'npm install — first run, this takes a while');
        const code = await run(slug, dir, 'npm', ['install', '--no-audit', '--no-fund']);
        if (code !== 0) {
          patch(slug, { state: 'failed', error: `npm install failed (exit ${code})` });
          return;
        }
      }

      const port = await freePort();
      patch(slug, { state: 'starting', port });
      note(slug, `starting on port ${port}`);

      const child = spawnIn(dir, 'npx', ['next', 'dev', '--port', String(port)], port);
      const entry = running.get(slug);
      if (!entry) { child.kill(); return; }
      entry.child = child;

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        note(slug, text);
        // Next announces readiness; until then the page would 404 and a panel
        // saying "running" would be lying by a few seconds.
        if (/ready in|started server|Local:\s+http/i.test(text)) {
          patch(slug, { state: 'running', url: `http://127.0.0.1:${port}` });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => note(slug, chunk.toString()));

      child.on('error', (err) => {
        patch(slug, { state: 'failed', error: err.message });
      });
      child.on('close', (code) => {
        const still = running.get(slug);
        if (!still) return;  // stopped deliberately
        patch(slug, {
          state: 'failed',
          error: `the dev server exited (code ${code ?? 'unknown'})`,
        });
      });
    } catch (err) {
      patch(slug, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return appState(slug)!;
}

/** Run a command to completion, streaming its output into the record. */
function run(slug: string, dir: string, command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnIn(dir, command, args);
    const entry = running.get(slug);
    if (entry) entry.child = child;
    child.stdout?.on('data', (c: Buffer) => note(slug, c.toString()));
    child.stderr?.on('data', (c: Buffer) => note(slug, c.toString()));
    child.on('error', (err) => { note(slug, err.message); resolve(-1); });
    child.on('close', (code) => resolve(code ?? -1));
  });
}
