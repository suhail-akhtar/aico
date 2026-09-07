/**
 * Deploying an app: run the script it ships with, and show what happened.
 *
 * "Any deployment" means deployable by files the app carries — a Dockerfile,
 * a compose file, a `deploy/*.mjs` — with aico able to run the script and show
 * its output. No cloud SDKs, no credentials held by aico: a target that needs
 * a CLI names it in `requires`, and the check here is that the CLI answers on
 * this machine before anything is started. A missing requirement is a plain
 * answer, not a failing log.
 *
 * The run itself goes through the same runner a dev server uses, under a key
 * of its own (`<slug>#deploy`), so a deploy's states — `working`, `done`,
 * `failed` — and its output show in the Apps screen without disturbing the
 * app's own process record.
 *
 * @module apps/deploy
 */

import { spawnSync } from 'child_process';
import { appState, runAppCommand, type RunningApp } from '../miniapps/process.js';
import type { DeployTarget, MiniApp } from '../miniapps/store.js';

/** The record key a deploy runs under, distinct from the app's own process. */
export function deployKey(slug: string): string {
  return `${slug}#deploy`;
}

/** Whether a command-line tool answers on this machine. */
export function toolAvailable(name: string): boolean {
  const probe = spawnSync(name, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 15_000,
    windowsHide: true,
  });
  return probe.status === 0;
}

/** Which of a target's requirements are missing here. */
export function missingRequirements(target: DeployTarget): string[] {
  return (target.requires ?? []).filter(name => !toolAvailable(name));
}

export type DeployStart =
  | { ok: true; record: RunningApp }
  | { ok: false; reason: 'no-targets' | 'unknown-target' | 'missing' | 'busy'; message: string; missing?: string[] };

/**
 * Start a deploy. Returns immediately; the record's state moves to `done` or
 * `failed` as the script finishes, and the output accumulates on it.
 */
export async function deployApp(app: MiniApp, dir: string, targetId?: string): Promise<DeployStart> {
  const targets = app.deploy ?? [];
  if (targets.length === 0) {
    return { ok: false, reason: 'no-targets', message: `"${app.slug}" declares no deploy targets in app.json.` };
  }
  const target = targetId ? targets.find(t => t.id === targetId) : targets[0];
  if (!target) {
    return {
      ok: false,
      reason: 'unknown-target',
      message: `No deploy target "${targetId}" for "${app.slug}". It has: ${targets.map(t => t.id).join(', ')}.`,
    };
  }
  const missing = missingRequirements(target);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'missing',
      missing,
      message: `Deploying "${app.slug}" with ${target.label} needs ${missing.join(', ')} on this machine, and `
        + `${missing.length === 1 ? 'it is' : 'they are'} not available. Install ${missing.length === 1 ? 'it' : 'them'} and try again; nothing was started.`,
    };
  }
  const current = appState(deployKey(app.slug));
  if (current && current.state === 'working') {
    return { ok: false, reason: 'busy', message: `A deploy of "${app.slug}" is already running.` };
  }
  const record = await runAppCommand(deployKey(app.slug), dir, target.script);
  return { ok: true, record };
}

/** The last deploy's record for an app, if any. */
export function deployState(slug: string): RunningApp | undefined {
  return appState(deployKey(slug));
}
