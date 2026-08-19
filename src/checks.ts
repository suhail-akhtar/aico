/**
 * What "working" means for this project, and whether it currently is.
 *
 * A browser artifact has had an enforced answer since `VerifyApp`: the page is
 * opened, and a turn cannot claim success on one that throws. Everything else —
 * a library, a CLI, a service, most of what anyone actually writes — had a
 * *suggestion*. The system prompt said "run the project's typecheck, lint,
 * build, or tests when they exist", and a suggestion holds until the model is
 * confident, which is exactly when it stops holding.
 *
 * So a project says what done means, in its own terms, and the loop enforces it.
 *
 * **Detected, not demanded.** Nobody configures a tool before it is useful. The
 * commands are read out of `package.json`, `Cargo.toml`, `pyproject.toml` or a
 * `Makefile` — the file that already answers the question — and can be
 * corrected afterwards. A project with nothing detectable gets no checks and no
 * nagging.
 *
 * **Ordered cheapest first.** A typecheck that fails in two seconds should not
 * wait behind a four-minute test suite, and a run stops at the first failure:
 * the second failure is usually the first one wearing a different hat.
 *
 * **Freshness is the whole point.** A green suite from before the last edit
 * describes code that no longer exists. This is the same rule the browser gate
 * learned the hard way, and it is the one that catches the expensive case —
 * fix, don't re-run, ship.
 *
 * @module checks
 */

import fs from 'fs';
import path from 'path';
import { runScoped } from './run-scoped.js';

/** One thing that must pass. */
export interface Check {
  /** Short name, used in the gate's objection and on screen. */
  name: string;
  /** The command, run in the project root. */
  command: string;
  /**
   * Roughly how long this takes, used only for ordering.
   *
   * Cheap things run first so a two-second typecheck failure is not queued
   * behind a four-minute test suite that was going to fail for the same reason.
   */
  weight: number;
}

/** What happened when a check ran. */
export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  /** Milliseconds it took. */
  ms: number;
  /** The tail of its output — where a failing run says why. */
  output: string;
  /** When it ran, and the newest source mtime it therefore describes. */
  at: number;
  sourceMtimeMs: number;
}

/** Ordering weights. Lower runs first. */
const WEIGHT = { typecheck: 1, lint: 2, build: 3, test: 4 } as const;

/**
 * Script names that mean each thing, in the order they should be preferred.
 *
 * `test:unit` before `test` on purpose: where both exist the narrower one is
 * usually the fast one, and a check nobody waits for is a check nobody keeps.
 */
const NPM_SCRIPTS: { kind: keyof typeof WEIGHT; names: string[] }[] = [
  { kind: 'typecheck', names: ['typecheck', 'type-check', 'tsc', 'types'] },
  { kind: 'lint', names: ['lint', 'eslint'] },
  { kind: 'build', names: ['build'] },
  { kind: 'test', names: ['test:unit', 'test'] },
];

/** Read a JSON file, or nothing. A malformed manifest is not an error here. */
function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { return undefined; }
}

/**
 * Work out what this project's checks are, from the file that already knows.
 *
 * Returns an empty list when there is nothing to detect, and that is a normal
 * answer — a folder of notes has no build.
 */
export function detectChecks(root: string): Check[] {
  const found: Check[] = [];

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const runner = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn'
      : 'npm run';
    for (const { kind, names } of NPM_SCRIPTS) {
      const script = names.find(n => typeof scripts[n] === 'string');
      if (script) found.push({ name: kind, command: `${runner} ${script}`, weight: WEIGHT[kind] });
    }
  }

  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    found.push({ name: 'typecheck', command: 'cargo check', weight: WEIGHT.typecheck });
    found.push({ name: 'test', command: 'cargo test', weight: WEIGHT.test });
  }

  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'setup.py'))) {
    if (fs.existsSync(path.join(root, 'pytest.ini'))
      || fs.existsSync(path.join(root, 'tests'))
      || fs.existsSync(path.join(root, 'test'))) {
      found.push({ name: 'test', command: 'pytest -q', weight: WEIGHT.test });
    }
  }

  if (fs.existsSync(path.join(root, 'go.mod'))) {
    found.push({ name: 'build', command: 'go build ./...', weight: WEIGHT.build });
    found.push({ name: 'test', command: 'go test ./...', weight: WEIGHT.test });
  }

  // One per name, cheapest first. A repo with both a package.json and a
  // Cargo.toml should not be asked to run two things called "test".
  const seen = new Set<string>();
  return found
    .filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)))
    .sort((a, b) => a.weight - b.weight);
}

/** File types whose change should invalidate a check result. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.rs', '.py', '.go', '.java', '.kt', '.rb', '.php', '.cs', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.css', '.scss', '.vue', '.svelte',
  '.json', '.toml', '.yaml', '.yml',
]);

/** Whether editing this file could plausibly change whether the project works. */
export function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

interface ChecksState {
  /** Source files this turn changed, and when. */
  touched: Map<string, number>;
  /** The most recent result per check name. */
  results: Map<string, CheckResult>;
}

const state = runScoped<ChecksState>(() => ({ touched: new Map(), results: new Map() }));

/** Start of turn: last turn's green suite says nothing about this turn's code. */
export function resetChecks(): void {
  state.reset();
}

/** Note that a source file changed. Called from the write path. */
export function noteSourceChanged(file: string): void {
  if (!isSourceFile(file)) return;
  const abs = path.resolve(file);
  try { state.get().touched.set(abs, fs.statSync(abs).mtimeMs); }
  catch { /* written and already gone; nothing to gate on */ }
}

/** The newest change this turn made, or 0 when it changed nothing. */
export function newestSourceChange(): number {
  let newest = 0;
  for (const [file, remembered] of state.get().touched) {
    let mtime = remembered;
    try { mtime = fs.statSync(file).mtimeMs; } catch { /* keep what we had */ }
    newest = Math.max(newest, mtime);
  }
  return newest;
}

/** Record what a check did. */
export function recordCheck(result: CheckResult): void {
  state.get().results.set(result.name, result);
}

/** Everything recorded this turn. */
export function checkResults(): CheckResult[] {
  return [...state.get().results.values()];
}

/** Source files this turn changed. Exposed for the gate's message and for tests. */
export function touchedFiles(): string[] {
  return [...state.get().touched.keys()];
}

/**
 * The legitimate way out, offered with every objection.
 *
 * Watched live: told explicitly not to run checks, a model was nudged three
 * times and spent three steps arguing — correctly, but expensively — that a
 * specific human instruction outranks generic automation. It was right. A gate
 * that offers no way to say so turns a reasonable disagreement into a loop, and
 * the completion gate learned this already with "mark it cancelled and explain
 * why".
 */
const ESCAPE = 'If the person running this has deliberately asked for something the checks will reject — a fixture that must not compile, a snapshot being rewritten — say so once and stop. Do not argue the point on every step.';

export interface ChecksGate {
  ok: boolean;
  message?: string;
}

/**
 * May this turn call itself finished, as far as the project's own checks go?
 *
 * Silent unless all three are true: the project defines checks, the turn
 * changed source, and the checks do not currently vouch for that source. A turn
 * that edited a README, or a project with no build, is none of this module's
 * business.
 */
export function checkProjectGate(checks: Check[]): ChecksGate {
  if (checks.length === 0) return { ok: true };

  const changedAt = newestSourceChange();
  if (changedAt === 0) return { ok: true };

  const { results } = state.get();

  const never = checks.filter(c => !results.has(c.name));
  if (never.length === checks.length) {
    const list = checks.map(c => `${c.name} (${c.command})`).join(', ');
    return {
      ok: false,
      message:
        `You changed ${touchedFiles().length} source file(s) and have not run this project's `
        + `checks: ${list}. Run them with RunChecks and fix what they report. Code that has not `
        + `been compiled or tested since it was written is not finished work, however carefully `
        + `it was written.

${ESCAPE}`,
    };
  }

  const failed = checks.map(c => results.get(c.name)).filter((r): r is CheckResult => !!r && !r.passed);
  if (failed.length > 0) {
    const detail = failed.map(r => `  ${r.name} — ${r.command}\n${r.output.split('\n').slice(-6).join('\n')}`)
      .join('\n\n');
    return {
      ok: false,
      message:
        `The project's checks are failing:\n\n${detail}\n\nFix these and run RunChecks again. `
        + `Do not describe the work as done while a check it must pass is red.

${ESCAPE}`,
    };
  }

  // Strictly older, as with the browser gate: a run started in the same
  // millisecond as the write is the one that observed it, and coarse timestamps
  // would otherwise reject every honest run.
  const stale = checks
    .map(c => results.get(c.name))
    .filter((r): r is CheckResult => !!r && r.sourceMtimeMs < changedAt);
  if (stale.length > 0) {
    return {
      ok: false,
      message:
        `${stale.map(r => r.name).join(', ')} passed, but the code changed afterwards, so that `
        + `result describes a version that no longer exists. Run RunChecks again — a fix is not `
        + `finished until the check that would have caught it has seen it.`,
    };
  }

  const missing = never.map(c => c.name);
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} not run against these `
        + `changes. Run RunChecks so every check the project defines has seen the current code.`,
    };
  }

  return { ok: true };
}
