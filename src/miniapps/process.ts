/**
 * Running an App that is a real program.
 *
 * ## What changes, and what does not
 *
 * A page App runs no code the model wrote on the server — that is why the page
 * can be trusted with a database it cannot send SQL to. A process App is server
 * code by definition. There is no version of it that keeps that guarantee, so
 * the guarantee here is a different one, stated plainly rather than implied:
 *
 * **It runs in its own process, on its own port, with nothing of aico's.**
 *
 *   - Its own process, so stopping it is `kill` rather than hoping. A crash
 *     takes down the app and not the workspace.
 *   - Its own port, so it is its own origin. One app's JavaScript cannot read
 *     another app's data, and neither can reach the aico API — the same
 *     browser-enforced boundary the page host relies on, one level up.
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
 * ## One runner, any framework
 *
 * The runner used to know one command: `npx next dev`. It now runs whatever the
 * app's manifest declares (`app.json.run`, copied from its template): an install
 * command when `node_modules` is absent, a dev command with `{port}` filled in,
 * and a readiness pattern to watch the output for. Next.js, Hono, Astro and an
 * Expo web preview are the same to it. Apps from before templates keep the
 * profile they always had — see `runProfileFor` in the store.
 *
 * ## Other stacks, containers and bundles (ADR 0031)
 *
 * The same runner starts a Python, Java, .NET, Go or PHP app from its manifest:
 * the scaffolded check follows `stack.manifestFile`, install is skipped by
 * `run.installedMarker`, readiness is the output regex *or* an HTTP health
 * poll, and a missing toolchain is a refusal that says what to install (and
 * that Docker could run it instead). With `docker: true` the identical command
 * runs in a container whose only mount is the app directory and whose only
 * port is on 127.0.0.1 (`apps/docker-run.ts`). A bundle starts several
 * services, as a compose project or as native processes in dependency order.
 *
 * @module miniapps/process
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import net from 'net';
import path from 'path';
import { effectiveKind, runProfileFor, type MiniApp, type RunProfile } from './store.js';
import { KNOWN_MANIFEST_FILES, manifestPresent } from '../apps/stack.js';
import { aliasCommand, checkRequirements, dockerImageFor, type ToolStatus } from '../apps/toolchain.js';
import { dockerBase, dockerReady, dockerRunPlan } from '../apps/docker-run.js';
import { hasCode, nativeBlockers, planNative, previewService, writeGeneratedCompose } from '../apps/bundle.js';

export type AppState =
  | 'stopped'
  /** `npm install` is running. First start of an app takes a while. */
  | 'installing'
  /** The dev server is starting but has not reported a URL yet. */
  | 'starting'
  | 'running'
  | 'failed'
  /** A deploy or install-only command is running; nothing is served. */
  | 'working'
  /** A deploy or install-only command finished cleanly. */
  | 'done';

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
   * Kept because an app that will not start says why — a syntax error, a
   * missing dependency, a port clash — and that message is the entire content
   * of "it did not work". Without it the panel can only report the failure, and
   * the reader has to go and find the terminal.
   */
  output: string[];
  startedAt: number;
  /** How it is running: on the machine's toolchain, in a container, or as a compose project. */
  mode?: 'native' | 'docker' | 'compose';
  /** For a bundle: each service's own state, port and log tail. */
  services?: RunningService[];
}

/** One service of a running bundle. */
export interface RunningService {
  id: string;
  role: string;
  state: 'pending' | 'installing' | 'starting' | 'running' | 'failed' | 'stopped';
  port?: number;
  url?: string;
  error?: string;
  output: string[];
}

interface Entry {
  record: RunningApp;
  child?: ChildProcess;
  /** A bundle's service processes (or its compose log follower). */
  children?: Map<string, ChildProcess>;
  /** A container started with `docker run`, removed by name on stop. */
  container?: string;
  /** A compose project, brought down on stop. */
  compose?: { dir: string; file: string; project: string; env: NodeJS.ProcessEnv };
  /** Cancels health polls when the app stops or exits. */
  health?: AbortController;
}

/** How many lines of process output to keep. Enough for a stack trace. */
const OUTPUT_LINES = 60;

const running = new Map<string, Entry>();
let listeners: Array<(apps: RunningApp[]) => void> = [];

export function subscribeToApps(fn: (apps: RunningApp[]) => void): () => void {
  listeners.push(fn);
  fn(snapshot());
  return () => { listeners = listeners.filter(l => l !== fn); };
}

function copyRecord(r: RunningApp): RunningApp {
  return { ...r, output: [...r.output], ...(r.services ? { services: r.services.map(s => ({ ...s, output: [...s.output] })) } : {}) };
}

function snapshot(): RunningApp[] {
  return [...running.values()].map(v => copyRecord(v.record));
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
  return entry ? copyRecord(entry.record) : undefined;
}

export function runningApps(): RunningApp[] {
  return snapshot();
}

/**
 * A port nothing is listening on.
 *
 * Asked of the OS and then released, which leaves a gap between choosing and
 * binding. Dev servers take a port on their command line, so there is no way
 * to hand one an already-bound socket; the gap is small and the failure is
 * visible in the child's own output rather than silent.
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
 * The environment an App process gets.
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
  // Frameworks read this and behave differently; being explicit beats
  // inheriting whatever the parent shell happened to have.
  out.NODE_ENV = 'development';
  return out;
}

/**
 * Split a declared command into an executable and its arguments.
 *
 * Commands come from a manifest a person can edit, so quoting is honoured:
 * `node "deploy/build image.mjs"` is one argument. Nothing else — no pipes, no
 * redirection — because the runner hands the pieces to `spawn`, not to a shell
 * that would interpret them.
 */
export function splitCommand(command: string): { file: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  const [file = '', ...args] = parts;
  return { file, args };
}

interface SpawnOpts {
  port?: number;
  /** The env var that carries the port. Default `PORT`; `""` for none. */
  portEnv?: string;
  /** Non-secret extras (run.env, bundle wiring), applied after the scrub. */
  env?: Record<string, string>;
  /** Node-only: `NODE_ENV=development`. Off for other stacks, where it means nothing. */
  nodeEnv?: boolean;
}

/** Run a command string, or an exact argv (the Docker forms, which must not go through a shell). */
type Launch = string | { file: string; args: string[] };

function spawnIn(dir: string, command: Launch, opts: SpawnOpts = {}): ChildProcess {
  const base = scrubbedEnv();
  if (opts.nodeEnv === false) delete base.NODE_ENV;
  const portEnv = opts.portEnv ?? 'PORT';
  const env = { ...base, ...(opts.env ?? {}), ...(opts.port && portEnv ? { [portEnv]: String(opts.port) } : {}) };
  if (typeof command !== 'string') {
    // Docker: an executable, spawned directly. A shell on Windows would re-join the arguments unquoted.
    return spawn(command.file, command.args, { cwd: dir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  }
  const { file, args } = splitCommand(command);
  return spawn(file, args, {
    cwd: dir,
    env,
    // Windows resolves `npm`/`npx` through a shim, which needs a shell.
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Kill a process and everything under it. */
async function killTree(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

/** Run docker to completion, discarding output; true when it exited 0. */
function dockerQuiet(args: string[], dir?: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const { file, prefix } = dockerBase();
  return new Promise<boolean>(resolve => {
    const child = spawn(file, [...prefix, ...args], { cwd: dir, env: env ?? scrubbedEnv(), shell: false, stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

/**
 * Stop a running app.
 *
 * On Windows a dev server is a tree — the shim, npm, and node under it — and
 * killing the parent leaves the port held by a grandchild. `taskkill /T` is the
 * only thing that reliably takes the whole tree down; elsewhere the process
 * group does it. Containers are removed by name (killing `docker run`'s client
 * does not stop the container), and a compose project is brought down without
 * deleting its volumes: a database's data is the person's.
 */
export async function stopApp(slug: string): Promise<boolean> {
  const entry = running.get(slug);
  if (!entry) return false;
  running.delete(slug);
  emit();
  entry.health?.abort();
  const kills: Array<Promise<unknown>> = [killTree(entry.child), ...[...(entry.children?.values() ?? [])].map(c => killTree(c))];
  if (entry.container) kills.push(dockerQuiet(['rm', '-f', entry.container]));
  if (entry.compose) {
    kills.push(dockerQuiet(['compose', '-f', entry.compose.file, '-p', entry.compose.project, 'down', '--remove-orphans'], entry.compose.dir, entry.compose.env));
  }
  await Promise.all(kills);
  return true;
}

export async function stopAllApps(): Promise<void> {
  await Promise.all([...running.keys()].map(slug => stopApp(slug)));
}

export interface StartOptions {
  /** Run in a container instead of on the machine's own toolchain (ADR 0031 section 4). */
  docker?: boolean;
  /** For a bundle: force a mode. Default: compose when Docker is ready and a compose file exists, else native. */
  mode?: 'compose' | 'native';
}

type StartableApp = Pick<MiniApp, 'kind' | 'run'> & Partial<Pick<MiniApp, 'stack' | 'services' | 'compose' | 'preview'>>;

/** The ready regex for a profile: declared, else the generic one. Case-insensitive. */
function readyPattern(profile: RunProfile): RegExp {
  return new RegExp(profile.ready ?? 'ready in|listening on|Local:\\s+http|http://', 'i');
}

/** Wait between polls; resolves early when aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * Poll an HTTP health path on the app's own port until it answers 2xx or 3xx.
 *
 * Output regexes are fragile across stacks (Uvicorn, Spring, Kestrel and
 * Laravel each phrase it differently), while "does /healthz answer" means the
 * same everywhere. Either signal marks the app ready. The URL is always
 * 127.0.0.1 and a port the engine chose, never a manifest value.
 */
async function pollHealth(url: string, signal: AbortSignal, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' }); // security-allow: fetch-unguarded — 127.0.0.1 and a port the engine chose, never a manifest or model value
      if (res.status < 400) return true;
    } catch { /* not up yet */ }
    await sleep(500, signal);
  }
  return false;
}

/** Whether an install can be skipped: its marker exists. Node defaults to `node_modules`; other stacks must declare one or install idempotently every start. */
function installDone(dir: string, profile: RunProfile, app: StartableApp): boolean {
  const marker = profile.installedMarker ?? (!app.stack?.toolchain || app.stack.toolchain.id === 'node' ? 'node_modules' : undefined);
  return marker ? existsSync(path.join(dir, marker)) : false;
}

function isNodeStack(app: StartableApp): boolean {
  return !app.stack?.toolchain || app.stack.toolchain.id === 'node';
}

/** Substitute `{port}` in declared environment values. */
function envFor(profile: RunProfile, port: number): Record<string, string> {
  return Object.fromEntries(Object.entries(profile.env ?? {}).map(([k, v]) => [k, v.replace(/\{port\}/g, String(port))]));
}

/**
 * Start an App's dev server, installing its dependencies first if needed.
 *
 * Returns as soon as the work is under way rather than when the server is
 * ready: a first install can take minutes, and a call that blocked for them
 * would make the UI look hung during the one operation that most needs a
 * progress report. Progress arrives through {@link subscribeToApps}.
 *
 * `app` supplies the run profile; without it the legacy Next.js profile is
 * assumed, which is what every caller before templates meant. A declared stack
 * adds a real toolchain probe (a missing Python is "install Python", not a
 * spawn error), the manifest file that means "scaffolded", an install marker,
 * an HTTP health poll, and, with `opts.docker`, the same app in a container.
 * A bundle starts every service (compose or native, see {@link startBundle}).
 */
export async function startApp(
  slug: string,
  dir: string,
  app: StartableApp = { kind: 'nextjs' },
  opts: StartOptions = {},
): Promise<RunningApp> {
  const existing = running.get(slug);
  if (existing && !['failed', 'stopped', 'done'].includes(existing.record.state)) {
    return { ...existing.record, output: [...existing.record.output] };
  }
  if (existing) await stopApp(slug);

  const record: RunningApp = { slug, state: 'starting', output: [], startedAt: Date.now() };
  running.set(slug, { record });
  emit();

  if (effectiveKind(app) === 'bundle') {
    return startBundle(slug, dir, app, opts);
  }

  const profile = runProfileFor(app);
  const manifests = app.stack?.manifestFile;
  if (manifests ? !manifestPresent(dir, manifests) : !manifestPresent(dir, KNOWN_MANIFEST_FILES.slice())) {
    patch(slug, {
      state: 'failed',
      error: manifests
        ? `no ${[manifests].flat().join(' or ')} — this app has not been scaffolded yet`
        : 'no package.json (or other project file such as pyproject.toml, go.mod, pom.xml) — this app has not been scaffolded yet',
    });
    return appState(slug)!;
  }
  if (!profile.dev) {
    patch(slug, { state: 'failed', error: 'this app declares no dev command (app.json run.dev)' });
    return appState(slug)!;
  }

  // The toolchain this stack needs, probed for real. A refusal names the install and the container option.
  const toolchain = app.stack?.toolchain;
  let statuses: ToolStatus[] = [];
  if (toolchain && !opts.docker) {
    const report = checkRequirements({ toolchain });
    statuses = report.statuses;
    if (!report.ok) {
      patch(slug, { state: 'failed', error: report.message });
      return appState(slug)!;
    }
  }
  let dockerImage: string | undefined;
  if (opts.docker) {
    dockerImage = dockerImageFor(app.stack);
    const ready = dockerReady();
    if (!dockerImage || !ready.ok) {
      patch(slug, { state: 'failed', error: dockerImage ? ready.message : 'this app declares no toolchain, so there is no container image to run it in (app.json stack.toolchain or stack.docker.image)' });
      return appState(slug)!;
    }
  }

  const abort = new AbortController();
  running.get(slug)!.health = abort;
  const nodeStack = isNodeStack(app);

  void (async () => {
    try {
      if (!opts.docker && profile.install && !installDone(dir, profile, app)) {
        patch(slug, { state: 'installing' });
        const install = aliasCommand(profile.install, statuses);
        note(slug, `${install} — first run, this takes a while`);
        const code = await run(slug, dir, install, { env: profile.env, nodeEnv: nodeStack });
        if (code !== 0) {
          patch(slug, { state: 'failed', error: `install failed (exit ${code})` });
          return;
        }
      }

      const port = await freePort();
      patch(slug, { state: 'starting', port, ...(opts.docker ? { mode: 'docker' as const } : { mode: 'native' as const }) });
      const url = `http://127.0.0.1:${port}`;
      const ready = readyPattern(profile);
      let child: ChildProcess;
      if (opts.docker) {
        const dockerSpec = app.stack?.docker;
        const containerPort = dockerSpec?.containerPort ?? port;
        const devCommand = (dockerSpec?.dev ?? profile.dev!).replace(/\{port\}/g, String(containerPort));
        const plan = dockerRunPlan({
          slug, dir, image: dockerImage!, command: devCommand,
          // The container has none of the host's installs (a Windows .venv is no use to Linux), so it installs
          // itself: the template's `docker.setup`, else the declared install (idempotent by contract).
          ...((dockerSpec?.setup ?? profile.install) ? { setup: (dockerSpec?.setup ?? profile.install)! } : {}),
          env: { ...envFor(profile, containerPort), ...(profile.portEnv === '' ? {} : { [profile.portEnv ?? 'PORT']: String(containerPort) }) },
          port: { host: port, container: containerPort },
          ...(dockerSpec?.cache ? { cache: dockerSpec.cache } : {}),
        });
        note(slug, `starting in a container (${dockerImage}) on port ${port}`);
        child = spawnIn(dir, { file: plan.file, args: plan.args });
        const entry = running.get(slug);
        if (entry) entry.container = plan.name;
      } else {
        const command = aliasCommand(profile.dev!.replace(/\{port\}/g, String(port)), statuses);
        note(slug, `starting on port ${port}: ${command}`);
        child = spawnIn(dir, command, { port, portEnv: profile.portEnv, env: envFor(profile, port), nodeEnv: nodeStack });
      }
      const entry = running.get(slug);
      if (!entry) { child.kill(); return; }
      entry.child = child;

      const markRunning = (): void => {
        if (running.get(slug)?.record.state === 'starting') patch(slug, { state: 'running', url });
      };
      const watch = (chunk: Buffer): void => {
        const text = chunk.toString();
        note(slug, text);
        // The server announces readiness; until then the page would 404 and a
        // panel saying "running" would be lying by a few seconds.
        if (ready.test(text)) markRunning();
      };
      child.stdout?.on('data', watch);
      child.stderr?.on('data', watch);
      if (profile.health) {
        void pollHealth(`${url}${profile.health}`, abort.signal).then(ok => { if (ok) markRunning(); });
      }

      child.on('error', (err) => {
        patch(slug, { state: 'failed', error: err.message });
      });
      child.on('close', (code) => {
        const still = running.get(slug);
        if (!still) return;  // stopped deliberately
        abort.abort();
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

/** Output line routing for a service: its own ring, and a prefixed line in the app's. */
function serviceNote(slug: string, id: string, text: string): void {
  const entry = running.get(slug);
  if (!entry) return;
  const svc = entry.record.services?.find(s => s.id === id);
  for (const part of text.split(/\r?\n/)) {
    const clean = part.trimEnd();
    if (!clean) continue;
    if (svc) {
      svc.output.push(clean);
      if (svc.output.length > OUTPUT_LINES) svc.output.splice(0, svc.output.length - OUTPUT_LINES);
    }
    entry.record.output.push(`[${id}] ${clean}`);
  }
  if (entry.record.output.length > OUTPUT_LINES) entry.record.output.splice(0, entry.record.output.length - OUTPUT_LINES);
  emit();
}

function patchService(slug: string, id: string, changes: Partial<RunningService>): void {
  const svc = running.get(slug)?.record.services?.find(s => s.id === id);
  if (!svc) return;
  Object.assign(svc, changes);
  emit();
}

/**
 * Start a bundle: every service, as one app.
 *
 * Compose when Docker's engine answers and a compose file exists (or can be
 * generated from `services`): `docker compose up -d --build --wait`, one
 * published port on 127.0.0.1, per-service logs from `compose logs`. Native
 * otherwise: each service that has code is its own process on its own free
 * port, started in dependency order, each waiting for its dependencies to be
 * ready, env wired by `{service.<id>.url|host|port}`. Native cannot run a bare
 * image (a database), so it refuses that case with the service named instead of
 * starting a frontend that can only fail. The record's `url` is the preview
 * service's.
 */
async function startBundle(slug: string, dir: string, app: StartableApp, opts: StartOptions): Promise<RunningApp> {
  const services = app.services ?? [];
  if (services.length === 0) {
    patch(slug, { state: 'failed', error: 'this bundle declares no services (app.json services)' });
    return appState(slug)!;
  }
  patch(slug, {
    services: services.map(s => ({ id: s.id, role: s.role, state: 'pending' as const, output: [] })),
  });
  const composeFile = path.join(dir, app.compose?.file ?? 'compose.yaml');
  const docker = dockerReady();
  const wantCompose = opts.mode === 'compose' || (opts.mode !== 'native' && docker.ok && (existsSync(composeFile) || app.compose?.generate));
  if (opts.mode === 'compose' && !docker.ok) {
    patch(slug, { state: 'failed', error: docker.message });
    return appState(slug)!;
  }
  const abort = new AbortController();
  running.get(slug)!.health = abort;
  const preview = previewService(app as Pick<MiniApp, 'slug' | 'services' | 'preview' | 'compose'>);

  if (wantCompose) {
    void (async () => {
      try {
        if (!existsSync(composeFile)) await writeGeneratedCompose({ slug, ...(app as object), services } as never, dir);
        const hostPort = await freePort();
        const project = `aico-${slug}`;
        const env: NodeJS.ProcessEnv = { ...scrubbedEnv(), AICO_PREVIEW_PORT: String(hostPort), AICO_MAIL_PORT: String(await freePort()) };
        delete env.NODE_ENV;
        const entry = running.get(slug);
        if (!entry) return;
        entry.compose = { dir, file: composeFile, project, env };
        patch(slug, { state: 'installing', mode: 'compose', port: hostPort });
        note(slug, `docker compose up --build --wait (project ${project}) — building images the first time takes a while`);
        const { file, prefix } = dockerBase();
        const up = spawn(file, [...prefix, 'compose', '-f', composeFile, '-p', project, 'up', '-d', '--build', '--wait'], { cwd: dir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        entry.child = up;
        up.stdout?.on('data', (c: Buffer) => note(slug, c.toString()));
        up.stderr?.on('data', (c: Buffer) => note(slug, c.toString()));
        const code = await new Promise<number>(resolve => { up.on('error', () => resolve(-1)); up.on('close', c => resolve(c ?? -1)); });
        if (!running.has(slug)) return;
        if (code !== 0) {
          patch(slug, { state: 'failed', error: `docker compose up failed (exit ${code})` });
          return;
        }
        const url = `http://127.0.0.1:${hostPort}`;
        for (const s of services) patchService(slug, s.id, { state: 'running' });
        patch(slug, { state: 'running', url, port: hostPort });
        // Follow the logs so the panel keeps its per-service tails.
        const logs = spawn(file, [...prefix, 'compose', '-f', composeFile, '-p', project, 'logs', '-f', '--no-color', '--tail', '20'], { cwd: dir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const cur = running.get(slug);
        if (cur) cur.children = new Map([['logs', logs]]);
        logs.stdout?.on('data', (c: Buffer) => {
          for (const line of c.toString().split(/\r?\n/)) {
            const m = /^([a-z0-9][a-z0-9_.-]*?)(?:-\d+)?\s+\|\s?(.*)$/i.exec(line);
            if (m) serviceNote(slug, m[1]!, m[2] ?? ''); else if (line.trim()) note(slug, line);
          }
        });
      } catch (err) {
        patch(slug, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return appState(slug)!;
  }

  // Native mode.
  const blockers = nativeBlockers(app as Pick<MiniApp, 'slug' | 'services' | 'preview' | 'compose'>);
  if (blockers.length) {
    patch(slug, {
      state: 'failed',
      error: `${blockers.join('; ')}. ${docker.ok ? 'Start it with mode: compose.' : `Docker is needed for it. ${docker.message}`}`,
    });
    return appState(slug)!;
  }
  // Every code-bearing service's toolchain, checked before anything starts.
  const missing: string[] = [];
  for (const s of services.filter(hasCode)) {
    const tc = s.stack?.toolchain;
    if (!tc) continue;
    const report = checkRequirements({ toolchain: tc });
    if (!report.ok) missing.push(`${s.id}: ${report.message}`);
  }
  if (missing.length) {
    patch(slug, { state: 'failed', error: `${missing.join(' ')}${docker.ok ? ' Docker is available: start the bundle with mode: compose instead.' : ''}` });
    return appState(slug)!;
  }

  void (async () => {
    try {
      const ports = new Map<string, number>();
      // Ports first (the wiring needs every service's port before any starts), then the plan.
      for (const s of services.filter(hasCode)) ports.set(s.id, await freePort());
      const wired = planNative(app as Pick<MiniApp, 'slug' | 'services' | 'preview' | 'compose'>, id => ports.get(id)!);
      const entry = running.get(slug);
      if (!entry) return;
      entry.children = new Map();
      const readyFlags = new Map<string, Promise<boolean>>();
      patch(slug, { state: 'starting', mode: 'native', ...(preview && ports.get(preview.id) ? { port: ports.get(preview.id)! } : {}) });

      for (const step of wired.steps) {
        const s = step.service;
        const svcDir = path.join(dir, step.cwd);
        // Wait for what this one needs.
        for (const dep of s.dependsOn ?? []) {
          const ok = await (readyFlags.get(dep) ?? Promise.resolve(true));
          if (!ok) { throw new Error(`service "${dep}" did not become ready, so "${s.id}" was not started`); }
        }
        const profile = runProfileFor({ kind: 'process', run: step.run, ...(s.stack ? { stack: s.stack } : {}) });
        if (!profile.dev) { throw new Error(`service "${s.id}" declares no dev command (services[].run.dev)`); }
        const nodeStack = !s.stack?.toolchain || s.stack.toolchain.id === 'node';
        const statuses = s.stack?.toolchain ? checkRequirements({ toolchain: s.stack.toolchain }).statuses : [];
        if (profile.install && !installDone(svcDir, profile, { kind: 'process', ...(s.stack ? { stack: s.stack } : {}) })) {
          patchService(slug, s.id, { state: 'installing' });
          serviceNote(slug, s.id, `${profile.install} — first run`);
          const code = await new Promise<number>(resolve => {
            const c = spawnIn(svcDir, aliasCommand(profile.install!, statuses), { nodeEnv: nodeStack, env: step.env });
            c.stdout?.on('data', (b: Buffer) => serviceNote(slug, s.id, b.toString()));
            c.stderr?.on('data', (b: Buffer) => serviceNote(slug, s.id, b.toString()));
            c.on('error', () => resolve(-1));
            c.on('close', x => resolve(x ?? -1));
          });
          if (code !== 0) throw new Error(`install of "${s.id}" failed (exit ${code})`);
        }
        const command = aliasCommand(profile.dev.replace(/\{port\}/g, String(step.port)), statuses);
        patchService(slug, s.id, { state: 'starting', port: step.port, url: `http://127.0.0.1:${step.port}` });
        serviceNote(slug, s.id, `starting on port ${step.port}: ${command}`);
        const child = spawnIn(svcDir, command, { port: step.port, portEnv: profile.portEnv, env: { ...envFor(profile, step.port), ...step.env }, nodeEnv: nodeStack });
        entry.children!.set(s.id, child);
        const ready = readyPattern(profile);
        const url = `http://127.0.0.1:${step.port}`;
        readyFlags.set(s.id, new Promise<boolean>(resolve => {
          let settled = false;
          const done = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            if (ok) patchService(slug, s.id, { state: 'running' });
            resolve(ok);
          };
          const watch = (chunk: Buffer): void => {
            const text = chunk.toString();
            serviceNote(slug, s.id, text);
            if (ready.test(text)) done(true);
          };
          child.stdout?.on('data', watch);
          child.stderr?.on('data', watch);
          const hp = s.healthPath ?? profile.health;
          if (hp) void pollHealth(`${url}${hp}`, abort.signal).then(done);
          child.on('error', err => { patchService(slug, s.id, { state: 'failed', error: err.message }); done(false); });
          child.on('close', code => {
            if (!running.has(slug)) { done(false); return; }
            patchService(slug, s.id, { state: 'failed', error: `exited (code ${code ?? 'unknown'})` });
            if (!settled) done(false);
            else patch(slug, { state: 'failed', error: `service "${s.id}" exited (code ${code ?? 'unknown'})` });
          });
          setTimeout(() => done(false), 300_000).unref();
        }));
      }
      // Everything started: the app is running once the last service is.
      const all = await Promise.all([...readyFlags.values()]);
      if (!running.has(slug)) return;
      if (all.every(Boolean)) {
        const pv = preview && ports.get(preview.id);
        patch(slug, { state: 'running', ...(pv ? { url: `http://127.0.0.1:${pv}`, port: pv } : {}) });
      } else {
        throw new Error('not every service became ready');
      }
    } catch (err) {
      const entry = running.get(slug);
      if (entry) {
        for (const c of entry.children?.values() ?? []) await killTree(c);
        entry.children = undefined;
      }
      patch(slug, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return appState(slug)!;
}

/**
 * Install an app's dependencies without starting it.
 *
 * What the create path does the moment a template is copied, so the minutes
 * an install takes are spent while the reader is still typing their brief
 * rather than after they press Start.
 */
export async function installApp(slug: string, dir: string, profile: RunProfile, app?: StartableApp): Promise<RunningApp> {
  const existing = running.get(slug);
  if (existing && !['failed', 'stopped', 'done'].includes(existing.record.state)) {
    return { ...existing.record, output: [...existing.record.output] };
  }
  const record: RunningApp = { slug, state: 'installing', output: [], startedAt: Date.now() };
  running.set(slug, { record });
  emit();
  if (!profile.install) { patch(slug, { state: 'done' }); return appState(slug)!; }
  const statuses = app?.stack?.toolchain ? checkRequirements({ toolchain: app.stack.toolchain }).statuses : [];
  const install = aliasCommand(profile.install, statuses);
  note(slug, install);
  void run(slug, dir, install, { env: profile.env, nodeEnv: app ? isNodeStack(app) : true }).then(code => {
    if (!running.has(slug)) return;
    if (code === 0) patch(slug, { state: 'done' });
    else patch(slug, { state: 'failed', error: `install failed (exit ${code})` });
  });
  return appState(slug)!;
}

/**
 * Run one declared command to completion under an app's record — a deploy
 * script, a one-off build — with its output kept like a dev server's.
 */
export async function runAppCommand(slug: string, dir: string, command: string): Promise<RunningApp> {
  const existing = running.get(slug);
  if (existing && !['failed', 'stopped', 'done'].includes(existing.record.state)) {
    return { ...existing.record, output: [...existing.record.output] };
  }
  const record: RunningApp = { slug, state: 'working', output: [], startedAt: Date.now() };
  running.set(slug, { record });
  emit();
  note(slug, command);
  void run(slug, dir, command).then(code => {
    if (!running.has(slug)) return;
    if (code === 0) patch(slug, { state: 'done' });
    else patch(slug, { state: 'failed', error: `${command} exited with ${code}` });
  });
  return appState(slug)!;
}

/** Run a command to completion, streaming its output into the record. */
function run(slug: string, dir: string, command: string, opts: { env?: Record<string, string> | undefined; nodeEnv?: boolean } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnIn(dir, command, { ...(opts.env ? { env: opts.env } : {}), ...(opts.nodeEnv !== undefined ? { nodeEnv: opts.nodeEnv } : {}) });
    const entry = running.get(slug);
    if (entry) entry.child = child;
    child.stdout?.on('data', (c: Buffer) => note(slug, c.toString()));
    child.stderr?.on('data', (c: Buffer) => note(slug, c.toString()));
    child.on('error', (err) => { note(slug, err.message); resolve(-1); });
    child.on('close', (code) => resolve(code ?? -1));
  });
}
