/**
 * Getting a task's fresh worktree ready to run the project's checks, for any stack,
 * and keeping an install from reaching through to the person's own checkout.
 *
 * A git worktree has the tracked files and nothing else: no `node_modules`, no virtualenv,
 * no `vendor`. Without dependencies the agent cannot run the checks and every task
 * would start by reinstalling the world. What each stack needs differs:
 *
 *  - **Node, Python, PHP** keep dependencies in a folder inside the project. The worktree
 *    gets a *link* to the project's (`node_modules`, `.venv`/`venv`, `vendor`) — instant,
 *    and the same versions the project itself runs on. A Python project with no venv, or
 *    an AICO app whose `app.json` declares `run.install`, runs that install once in the
 *    worktree instead (the app's own stack manifest, `apps/stack`).
 *  - **.NET, Go, Java, Rust, Ruby** resolve packages from a user-wide cache (NuGet, the Go
 *    module cache, ~/.m2 and Gradle, ~/.cargo, installed gems): nothing to do, and the
 *    note says so rather than leaving a gap that looks like an oversight.
 *  - **Anything else** is `delivery.worktreeSetup`, a command (`config.ts`: from the
 *    person's settings or a project file a person approved) that runs in the worktree.
 *
 * THE LINK'S ONE DANGER, AND THE CHOICE MADE. A link is shared, so `npm install foo`
 * run by a task's agent would write `foo` into the person's real `node_modules` — and
 * into every other task's. Copy-on-write would avoid it, but only some filesystems clone
 * (APFS, btrfs, XFS, ReFS); on NTFS and ext4 a copy of `node_modules` is hundreds of
 * megabytes and seconds to minutes, for every task, including the many that never install
 * anything. So: link by default, REFUSE the install while the folder is still a link
 * (`paths.deliveryRunDenial`, a guard in the loop, with the fix named), and give the run
 * one engine-owned way out — `localise` — that replaces the link with a private copy
 * (cloned where the filesystem can, copied where not) for Node, or removes the link and
 * tells the run to create its own environment for Python and PHP, whose environments
 * cannot be copied (a venv holds absolute paths). The cost is paid only by a task that
 * really changes its dependencies. Rejected: install-time detection after the fact (the
 * write has happened), and linking per package (npm replaces links by copying through).
 *
 * @module delivery/env
 */

import fs from 'node:fs';
import path from 'node:path';
import * as G from './git.js';
import { runCommand } from './exec.js';
import { DEP_DIRS, isLink, linkedDeps } from './paths.js';

export type StackId = 'node' | 'python' | 'php' | 'dotnet' | 'go' | 'java' | 'rust' | 'ruby';

const MANIFESTS: Array<{ id: StackId; files: RegExp }> = [
  { id: 'node', files: /^package\.json$/ },
  { id: 'python', files: /^(?:pyproject\.toml|requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile)$/ },
  { id: 'php', files: /^composer\.json$/ },
  { id: 'dotnet', files: /\.(?:csproj|fsproj|vbproj|sln)$/ },
  { id: 'go', files: /^go\.mod$/ },
  { id: 'java', files: /^(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/ },
  { id: 'rust', files: /^Cargo\.toml$/ },
  { id: 'ruby', files: /^Gemfile$/ },
];

/** The stacks a folder declares by its manifest files (directly in it). */
export function detectStacks(dir: string): StackId[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return MANIFESTS.filter(m => names.some(n => m.files.test(n))).map(m => m.id);
}

const GLOBAL_CACHE: Partial<Record<StackId, string>> = {
  dotnet: '.NET restores packages from the user-wide NuGet cache; nothing to prepare.',
  go: 'Go uses the module cache; nothing to prepare.',
  java: 'Java builds resolve from ~/.m2 and the Gradle cache; nothing to prepare.',
  rust: 'Rust fetches from the shared cargo registry; the worktree builds its own target folder.',
  ruby: 'Ruby uses the installed gems; nothing to prepare.',
};

/** The app manifest an AICO app carries (`app.json`), when the project is one. */
function appInstall(dir: string): { install?: string; marker?: string } | undefined {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8')) as { run?: { install?: unknown; installedMarker?: unknown } };
    const install = typeof app.run?.install === 'string' && app.run.install.trim() ? app.run.install.trim() : undefined;
    const marker = typeof app.run?.installedMarker === 'string' ? app.run.installedMarker : undefined;
    return install || marker ? { ...(install ? { install } : {}), ...(marker ? { marker } : {}) } : undefined;
  } catch { return undefined; }
}

function link(from: string, to: string): boolean {
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    // A junction needs no privilege on Windows; elsewhere a symlink does the same.
    fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch { return false; }   // best effort: the checks will say so if they need it
}

export interface PrepareResult {
  /** One line per thing done or deliberately left alone, for the task's thread. */
  notes: string[];
  /** A setup command that failed: the run still starts, and the thread says why it may struggle. */
  setupFailure?: string;
}

/**
 * Prepare a new worktree. `repo` is the repository root, `projectDir` the registered project
 * (the repository, or a folder in it), `wt` the worktree root, `workdir` the project's folder
 * inside it. Links are made for the project's folder and, in a monorepo, the repository root.
 */
export async function prepareWorktree(o: {
  repo: string; projectDir: string; wt: string; workdir: string; setup?: string | undefined; timeoutMs?: number;
}): Promise<PrepareResult> {
  const notes: string[] = [];
  const pairs: Array<{ from: string; to: string }> = [{ from: o.repo, to: o.wt }];
  if (path.resolve(o.projectDir) !== path.resolve(o.repo)) pairs.push({ from: o.projectDir, to: o.workdir });
  const stacks = new Set<StackId>();
  for (const p of pairs) for (const s of detectStacks(p.from)) stacks.add(s);

  for (const { from, to } of pairs) {
    for (const d of DEP_DIRS) {
      if (!stacks.has(d.stack)) continue;
      // Only the first of a stack's folders that exists (a project has `.venv` or `venv`, not both).
      if (d.dir === 'venv' && fs.existsSync(path.join(from, '.venv'))) continue;
      if (isLink(path.join(from, d.dir))) continue;   // already a link in the project itself: not ours to extend
      if (link(path.join(from, d.dir), path.join(to, d.dir))) {
        await G.excludeLocally(o.repo, `/${path.relative(o.repo, path.join(to === o.wt ? o.repo : o.projectDir, d.dir)).replace(/\\/g, '/')}`);
        notes.push(`${d.dir} is linked to the project's own, so the checks run at once. Installing a package there is refused until the run calls Delivery "localise" (it would change your checkout).`);
      }
    }
  }
  for (const s of stacks) if (GLOBAL_CACHE[s]) notes.push(GLOBAL_CACHE[s]!);

  // An AICO app declares its own install (`app.json` run.install, with a marker saying it already ran).
  // When linking did not provide it, the worktree runs that install once.
  const app = appInstall(o.projectDir);
  const marker = app?.marker ?? (stacks.has('node') ? 'node_modules' : stacks.has('python') ? '.venv' : stacks.has('php') ? 'vendor' : undefined);
  if (app?.install && !(marker && fs.existsSync(path.join(o.workdir, marker)))) {
    const r = await runCommand({ command: app.install, cwd: o.workdir, timeoutMs: o.timeoutMs ?? 10 * 60_000 });
    notes.push(r.ok ? `Ran the app's install (${app.install}) in the worktree.` : `The app's install (${app.install}) failed: ${r.tail.slice(-300)}`);
    if (!r.ok) return { notes, setupFailure: `the app's install failed: ${r.tail.slice(-300)}` };
  } else if (stacks.has('python') && !fs.existsSync(path.join(o.workdir, '.venv')) && !fs.existsSync(path.join(o.workdir, 'venv'))) {
    notes.push('Python: the project has no virtualenv to link; create one in the worktree if the checks need it.');
  }

  if (o.setup) {
    const r = await runCommand({ command: o.setup, cwd: o.workdir, timeoutMs: o.timeoutMs ?? 10 * 60_000 });
    notes.push(r.ok ? `Ran the project's worktree setup (${o.setup}).` : `The project's worktree setup (${o.setup}) failed${r.denied ? ' (refused)' : ''}: ${r.tail.slice(-300)}`);
    if (!r.ok) return { notes, setupFailure: `worktree setup failed: ${r.tail.slice(-300)}` };
  }
  return { notes };
}

/** Take the dependency links out before git touches the worktree, so nothing can ever follow one into the project's real folder. */
export function unlinkDeps(wt: string, workdir?: string): void {
  for (const dir of new Set([wt, workdir].filter((x): x is string => Boolean(x)))) {
    for (const l of linkedDeps(dir)) {
      try { fs.unlinkSync(l.path); } catch { try { fs.rmdirSync(l.path); } catch { /* the sweep tries again */ } }   // a Windows junction is removed as a directory
    }
  }
}

export interface LocaliseResult { changed: string[]; message: string }

/**
 * Give a worktree private dependency folders in place of the links. Node: a copy (a clone
 * where the filesystem supports it). Python and PHP: the link is removed and the run is
 * told what to run, because a venv cannot be copied. Only ever touches `wt` and `workdir`.
 */
export function localiseDeps(wt: string, workdir: string): LocaliseResult {
  const changed: string[] = [];
  const todo: string[] = [];
  for (const dir of new Set([wt, workdir])) {
    for (const l of linkedDeps(dir)) {
      let target: string;
      try { target = fs.realpathSync.native(l.path); } catch { target = ''; }
      try { fs.unlinkSync(l.path); } catch { try { fs.rmdirSync(l.path); } catch { continue; } }
      if (l.stack === 'node' && target && fs.existsSync(target)) {
        try {
          fs.cpSync(target, l.path, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
          changed.push(`${l.dir} (copied; now private to this task)`);
        } catch (e) {
          try { fs.rmSync(l.path, { recursive: true, force: true }); } catch { /* partial copy: the run installs afresh */ }
          todo.push(`${l.dir}: the copy failed (${(e as Error).message.slice(0, 120)}); run the install to create it`);
        }
      } else {
        changed.push(`${l.dir} (link removed)`);
        todo.push(l.stack === 'python' ? `${l.dir}: create your own environment (python -m venv ${l.dir}) and install the requirements into it`
          : l.stack === 'php' ? `${l.dir}: run composer install to create your own vendor folder` : `${l.dir}: install again to recreate it`);
      }
    }
  }
  if (changed.length === 0 && todo.length === 0) return { changed, message: 'Nothing to localise: this worktree has no linked dependency folders.' };
  return { changed, message: `Localised: ${changed.join(', ') || 'nothing'}. ${todo.length ? `Next: ${todo.join('; ')}.` : 'You can install packages now; they stay in this worktree.'}` };
}
