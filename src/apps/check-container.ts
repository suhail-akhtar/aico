/**
 * Run an app's checks in a container when the machine lacks its toolchain.
 *
 * Why this exists: a Python/Java/.NET/Go/PHP app made on a machine with only
 * Docker used to have checks that could never pass ("mvn: command not found"),
 * so the completion gate blocked every turn. The app's `app.json` already says
 * which toolchain it needs (`stack.toolchain`); when that is missing here and
 * Docker's engine answers, each check command is wrapped in the same
 * constrained `docker run` the dev server uses (`docker-run.ts`: app directory
 * mount only, nothing published, no manifest-supplied flags).
 *
 * Why only then: a machine that *has* the toolchain runs natively (faster, and
 * the person's own editor sees the same `.venv`), and a machine with neither
 * gets the plain "install X" message from the failing command rather than a
 * container that was never asked for. The choice is made per call from live
 * probes (cached 15 seconds), never remembered, so installing Python mid-session
 * switches back to native on the next run.
 *
 * What it does not do: pull or build images ahead of time (the first run pulls,
 * which can take minutes), or wrap a command whose text cannot be quoted safely
 * for both cmd.exe and sh (a double quote inside it) — that one runs natively
 * and fails honestly.
 *
 * @module apps/check-container
 */

import fs from 'fs';
import path from 'path';
import type { Check } from '../checks.js';
import { dockerReady, dockerRunPlan } from './docker-run.js';
import type { AppStack } from './stack.js';
import { checkRequirements, dockerImageFor } from './toolchain.js';

/** `app.json`'s stack (and install command), when `root` is an app directory that declares one. */
function readStack(root: string): { stack: AppStack; install?: string } | undefined {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')) as { stack?: AppStack; run?: { install?: string } };
    return app.stack?.toolchain ? { stack: app.stack, ...(app.run?.install ? { install: app.run.install } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** One argument as a shell word that means the same to cmd.exe and sh. */
function word(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `"${arg}"`;
}

/**
 * The checks, wrapped for a container when the native toolchain is missing and
 * Docker is ready. Otherwise the same checks, untouched.
 */
export function containerizeChecks(root: string, checks: Check[]): Check[] {
  if (checks.length === 0) return checks;
  const declared = readStack(root);
  if (!declared) return checks;
  const { stack } = declared;
  // The container starts empty: it installs first (`docker.setup`, else the declared install).
  const setup = stack.docker?.setup ?? declared.install;
  const image = dockerImageFor(stack);
  if (!image) return checks;
  if (checkRequirements({ toolchain: stack.toolchain! }).ok) return checks;
  if (!dockerReady().ok) return checks;
  return checks.map(check => {
    if (check.builtin || /"/.test(check.command) || (setup && /"/.test(setup))) return check;
    try {
      const dir = check.cwd ?? root;
      const plan = dockerRunPlan({
        slug: path.basename(root), dir, image, command: check.command,
        ...(setup ? { setup } : {}),
        ...(stack.docker?.cache ? { cache: stack.docker.cache } : {}),
      });
      // `--name` is for dev servers; a one-shot check has no use for a fixed name.
      const args = plan.args.filter((a, i, all) => a !== '--name' && all[i - 1] !== '--name');
      // The mount is the directory the check belongs to, so it no longer needs a cwd of its own.
      const { cwd: _cwd, ...rest } = check;
      void _cwd;
      return { ...rest, command: [plan.file, ...args].map(word).join(' ') };
    } catch {
      return check;
    }
  });
}
