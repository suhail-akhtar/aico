/**
 * What a project is and how it is run — remembered once, with provenance.
 *
 * `detectChecks` re-derives the project's commands from its manifest on every
 * turn, which is right for a first look and wrong for the tenth: a `test`
 * script that takes ten minutes, a `dev` server on a port the reader chose, a
 * migration command that lives in a Makefile — none of that is in
 * `package.json`, and re-guessing costs a wrong guess each time. The profile
 * is the answer written down: `<project>/.aico/profile.json`, committable,
 * hand-editable, one entry per command with where it came from.
 *
 * ## Provenance decides who wins
 *
 * Every fact carries a `source`. A person's edit outranks a template's
 * defaults, which outrank what was observed to work, which outranks what was
 * detected from a manifest. `mergeProfile` never downgrades: an observed
 * `dev` command cannot overwrite the one the reader typed in Settings, however
 * many times the agent runs something else. The model never writes the
 * profile directly — it corrects a command by running the right one, and the
 * observer records the success.
 *
 * ## What it costs
 *
 * One prefix section, `project_profile`, of a few hundred cached tokens. It is
 * never fetched by tool: a tool step costs twenty to fifty times what the
 * cached read does, and the commands are needed on every turn that changes
 * source.
 *
 * @module project/profile
 */

import fs from 'fs';
import path from 'path';
import { detectChecks, type Check } from '../checks.js';
import type { RunProfile } from '../miniapps/store.js';

export type ProfileSource = 'user' | 'template' | 'observed' | 'detected';

/** Higher wins. A person's word beats a template's beats an observation beats a guess. */
const RANK: Record<ProfileSource, number> = { user: 4, template: 3, observed: 2, detected: 1 };

export type CommandName = 'setup' | 'dev' | 'typecheck' | 'lint' | 'build' | 'test' | 'migrate' | 'deploy' | 'start';

export const COMMAND_NAMES: readonly CommandName[] = ['setup', 'dev', 'typecheck', 'lint', 'build', 'test', 'migrate', 'deploy', 'start'];

/** The commands the checks gate cares about, in the order they should run. */
const CHECK_COMMANDS: readonly CommandName[] = ['typecheck', 'lint', 'build', 'test'];
const CHECK_WEIGHT: Record<string, number> = { typecheck: 1, lint: 2, build: 3, test: 4 };

export interface ProfileCommand {
  command: string;
  source: ProfileSource;
  /** ISO time the fact was recorded. */
  at: string;
  /** For `dev`: the port it was seen listening on. Never rendered into the prompt. */
  port?: number;
}

export interface ProjectProfile {
  version: 1;
  /** A short label: "Next.js 15 + node:sqlite", "Hono API", "Python / FastAPI". */
  stack?: { value: string; source: ProfileSource; at: string };
  packageManager?: { value: string; source: ProfileSource; at: string };
  commands: Partial<Record<CommandName, ProfileCommand>>;
}

/** A partial profile: what one observation or one edit knows. */
export interface ProfilePatch {
  stack?: { value: string; source: ProfileSource };
  packageManager?: { value: string; source: ProfileSource };
  commands?: Partial<Record<CommandName, { command: string; source: ProfileSource; port?: number }>>;
}

export const PROFILE_FILE = path.join('.aico', 'profile.json');
/** The most the rendered prefix section may be. */
export const PROFILE_RENDER_MAX = 1_600;

export function profilePath(root: string): string {
  return path.join(root, PROFILE_FILE);
}

export function emptyProfile(): ProjectProfile {
  return { version: 1, commands: {} };
}

/** The profile on disk, or an empty one. A malformed file is treated as absent, not fatal. */
export function loadProfile(root: string): ProjectProfile {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath(root), 'utf8')) as Partial<ProjectProfile>;
    if (!raw || typeof raw !== 'object') return emptyProfile();
    const commands: ProjectProfile['commands'] = {};
    for (const [name, entry] of Object.entries(raw.commands ?? {})) {
      if (!COMMAND_NAMES.includes(name as CommandName) || !entry || typeof entry.command !== 'string') continue;
      commands[name as CommandName] = {
        command: entry.command,
        source: RANK[entry.source as ProfileSource] ? entry.source : 'detected',
        at: typeof entry.at === 'string' ? entry.at : new Date(0).toISOString(),
        ...(typeof entry.port === 'number' ? { port: entry.port } : {}),
      };
    }
    return {
      version: 1,
      ...(raw.stack?.value ? { stack: raw.stack } : {}),
      ...(raw.packageManager?.value ? { packageManager: raw.packageManager } : {}),
      commands,
    };
  } catch {
    return emptyProfile();
  }
}

/**
 * Apply a patch without ever downgrading provenance.
 *
 * A fact of equal or higher rank replaces; a lower-ranked one is dropped. Equal
 * rank replaces so a second observation of the same command updates its
 * timestamp and port. Returns the merged profile and whether anything changed.
 */
export function mergeProfile(
  existing: ProjectProfile,
  patch: ProfilePatch,
  now = new Date(),
): { profile: ProjectProfile; changed: boolean } {
  const at = now.toISOString();
  const profile: ProjectProfile = { ...existing, commands: { ...existing.commands } };
  let changed = false;

  const takeScalar = (key: 'stack' | 'packageManager'): void => {
    const next = patch[key];
    if (!next?.value) return;
    const current = profile[key];
    if (current && RANK[current.source] > RANK[next.source]) return;
    if (current && current.value === next.value && current.source === next.source) return;
    profile[key] = { value: next.value, source: next.source, at };
    changed = true;
  };
  takeScalar('stack');
  takeScalar('packageManager');

  for (const [name, next] of Object.entries(patch.commands ?? {}) as Array<[CommandName, NonNullable<ProfilePatch['commands']>[CommandName]]>) {
    if (!next?.command?.trim()) continue;
    const current = profile.commands[name];
    if (current && RANK[current.source] > RANK[next.source]) continue;
    if (current && current.command === next.command && current.source === next.source
        && (next.port === undefined || current.port === next.port)) continue;
    profile.commands[name] = {
      command: next.command.trim(),
      source: next.source,
      at,
      ...(next.port !== undefined ? { port: next.port } : current?.port !== undefined && next.source === current.source ? { port: current.port } : {}),
    };
    changed = true;
  }
  return { profile, changed };
}

/** Remove one command, whatever its source. A person's decision, made in Settings. */
export function forgetCommand(profile: ProjectProfile, name: CommandName): ProjectProfile {
  const commands = { ...profile.commands };
  delete commands[name];
  return { ...profile, commands };
}

/*
  Writes are serialised per file.

  Two observations landing 150ms apart — an install finishing and a dev server
  printing its port — both read the file, both write it, and the second write
  drops the first's fact. The same race the context-window store had; the same
  fix.
*/
const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier operation on this profile file has finished. */
function withProfileLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const file = profilePath(root);
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(file, next.catch(() => undefined));
  return next;
}

async function writeProfile(root: string, profile: ProjectProfile): Promise<void> {
  const file = profilePath(root);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}

export function saveProfile(root: string, profile: ProjectProfile): Promise<void> {
  return withProfileLock(root, () => writeProfile(root, profile));
}

/**
 * Load, merge, save — the one-call form the observer and the settings route use.
 *
 * The read is inside the lock as well as the write: two observations that
 * both read the file before either wrote it would each save a profile missing
 * the other's fact.
 */
export function updateProfile(root: string, patch: ProfilePatch): Promise<ProjectProfile> {
  return withProfileLock(root, async () => {
    const { profile, changed } = mergeProfile(loadProfile(root), patch);
    if (changed) await writeProfile(root, profile);
    return profile;
  });
}

/**
 * The checks this project must pass: the profile first, the manifest second.
 *
 * When the profile names none, the detected checks are written back as
 * `detected`, so the second turn reads the file rather than sniffing the
 * manifest again — and so a person can see, in Settings, what the agent is
 * being held to and correct it.
 */
export function checksFor(root: string): Check[] {
  const profile = loadProfile(root);
  const fromProfile = CHECK_COMMANDS
    .filter(name => profile.commands[name])
    .map(name => ({ name, command: profile.commands[name]!.command, weight: CHECK_WEIGHT[name]! }));
  if (fromProfile.length > 0) return fromProfile;

  const detected = detectChecks(root);
  if (detected.length > 0) {
    const commands: ProfilePatch['commands'] = {};
    for (const check of detected) commands[check.name as CommandName] = { command: check.command, source: 'detected' };
    // Fire and forget: the gate must not wait on a disk write, and a failed
    // write only means the manifest is read again next turn.
    void updateProfile(root, { commands, ...detectStack(root) }).catch(() => undefined);
  }
  return detected;
}

/**
 * A one-line stack label and the package manager, from the manifest.
 *
 * Deliberately coarse: this is the label a sub-agent reads instead of opening
 * four manifests, not a dependency audit.
 */
export function detectStack(root: string): Pick<ProfilePatch, 'stack' | 'packageManager'> {
  const out: Pick<ProfilePatch, 'stack' | 'packageManager'> = {};
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { /* label from lockfiles only */ }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const parts: string[] = [];
    if (deps.next) parts.push('Next.js');
    else if (deps.nuxt) parts.push('Nuxt');
    else if (deps['@sveltejs/kit']) parts.push('SvelteKit');
    else if (deps.astro) parts.push('Astro');
    else if (deps.vite) parts.push('Vite');
    if (deps.react && !deps.next) parts.push('React');
    if (deps.vue && !deps.nuxt) parts.push('Vue');
    if (deps.hono) parts.push('Hono');
    if (deps.express) parts.push('Express');
    if (deps.fastify) parts.push('Fastify');
    if (deps.typescript) parts.push('TypeScript');
    if (deps.tailwindcss) parts.push('Tailwind');
    if (deps.prisma || deps['@prisma/client']) parts.push('Prisma');
    if (deps['drizzle-orm']) parts.push('Drizzle');
    if (deps.vitest) parts.push('vitest');
    else if (deps.jest) parts.push('jest');
    out.stack = { value: parts.length ? parts.join(' + ') : 'Node', source: 'detected' };
    const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn'
      : fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock')) ? 'bun'
      : 'npm';
    out.packageManager = { value: pm, source: 'detected' };
  } else if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    out.stack = { value: 'Rust (cargo)', source: 'detected' };
    out.packageManager = { value: 'cargo', source: 'detected' };
  } else if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'setup.py'))) {
    out.stack = { value: 'Python', source: 'detected' };
    out.packageManager = { value: fs.existsSync(path.join(root, 'poetry.lock')) ? 'poetry' : fs.existsSync(path.join(root, 'uv.lock')) ? 'uv' : 'pip', source: 'detected' };
  } else if (fs.existsSync(path.join(root, 'go.mod'))) {
    out.stack = { value: 'Go', source: 'detected' };
    out.packageManager = { value: 'go', source: 'detected' };
  }
  return out;
}

/**
 * Seed a new app's profile from its template.
 *
 * Called by the Apps create path, so a templated app is born knowing its
 * commands at `template` rank — above anything the manifest would be guessed
 * to say, below anything the person later decides.
 */
export async function profileFromTemplate(
  dir: string,
  run: RunProfile | undefined,
  stack?: string,
): Promise<ProjectProfile> {
  const commands: ProfilePatch['commands'] = {};
  if (run?.install) commands.setup = { command: run.install, source: 'template' };
  if (run?.dev) commands.dev = { command: run.dev, source: 'template' };
  if (run?.typecheck) commands.typecheck = { command: run.typecheck, source: 'template' };
  if (run?.lint) commands.lint = { command: run.lint, source: 'template' };
  if (run?.build) commands.build = { command: run.build, source: 'template' };
  if (run?.test) commands.test = { command: run.test, source: 'template' };
  if (run?.start) commands.start = { command: run.start, source: 'template' };
  const detected = detectStack(dir);
  return updateProfile(dir, {
    commands,
    ...(stack ? { stack: { value: stack, source: 'template' } } : detected.stack ? { stack: detected.stack } : {}),
    ...(detected.packageManager ? { packageManager: detected.packageManager } : {}),
  });
}

/**
 * The profile as the prompt carries it: a stack line and the commands, each
 * with its provenance, capped so it stays a few hundred cached tokens.
 *
 * Ports are left out on purpose. A dev server that comes up on a different
 * port next time would otherwise move the prefix for no reason the model needs.
 */
export function renderProfile(profile: ProjectProfile): string {
  const lines: string[] = [];
  if (profile.stack) lines.push(`Stack: ${profile.stack.value}${profile.packageManager ? ` (${profile.packageManager.value})` : ''}`);
  const names = COMMAND_NAMES.filter(n => profile.commands[n]);
  if (names.length) {
    lines.push('Commands (trust these; do not re-read the manifest to find them):');
    for (const name of names) {
      const c = profile.commands[name]!;
      lines.push(`  ${name.padEnd(9)} ${c.command}   [${c.source}]`);
    }
  }
  if (!lines.length) return '';
  lines.push('RunChecks runs typecheck, lint, build and test from this list. A person can correct any of these in the System screen; correct one yourself only by running the right command, which is then recorded.');
  let out = lines.join('\n');
  if (out.length > PROFILE_RENDER_MAX) out = `${out.slice(0, PROFILE_RENDER_MAX - 1)}…`;
  return out;
}
