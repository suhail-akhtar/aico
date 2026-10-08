/**
 * Run the project's own definition of working, and report it.
 *
 * The counterpart to `VerifyApp`. That one opens a page; this one runs whatever
 * the project says must pass — typecheck, build, test, lint — and hands back a
 * verdict the completion gate reads. Between them, "it works" stops being a
 * claim the model makes and becomes a fact something checked.
 *
 * **Stops at the first failure.** The second failure is usually the first one
 * wearing a different hat: a type error fails the typecheck, then the build,
 * then every test. Running the rest costs minutes to learn nothing.
 *
 * **Bounded output.** A failing test suite can produce megabytes. A test run
 * whose runner is recognised (`test-results.ts`) is reported as counts and its
 * failures — name, file, the assertion — and the raw tail is kept only when
 * the output could not be read or the exit code disagrees with the counts. A
 * typecheck or build keeps the tail, which is where a compiler says why.
 *
 * **Counts decide, not only exit codes.** A runner that reported failures
 * fails the check even when the command exited 0: a wrapper ending in
 * `|| true` must not turn a red suite green for the gate.
 *
 * **A failing test is run once more** (`flaky.ts`, ADR 0034). The failing tests
 * are re-run alone when the runner named them; a test that failed and then
 * passed is reported FLAKY — not green, not retried until it is — and
 * remembered per project. Two failures in a row are a real failure.
 *
 * **Every check that runs leaves a `check/run` record** in the session log
 * (exit code, counts, retry), which is what the change packet reports; a check
 * that did not run leaves nothing, so "not run" can be said and be true.
 *
 * **Format and lint on request.** The project's own formatter and linter
 * (`style-tools.ts`) run when named in `only`, in check form; `fix: true`
 * runs their fix form. They are not part of the gate — that module says why.
 *
 * @module tools/run-checks
 */

import fs from 'fs';
import path from 'path';
import { bash } from './bash.js';
import { projectRoot } from '../run-context.js';
import { commandsRun, noteCommandRun } from '../checks.js';
import {
  detectChecksFor, recordCheck, newestSourceChange, touchedFiles,
  type Check, type CheckResult,
} from '../checks.js';
import { checksFor } from '../project/profile.js';
import { formatTestSummary, parseJUnitXml, parseTestOutput, relativeTo, type TestSummary } from '../test-results.js';
import { selects, styleChecks } from '../style-tools.js';
import { writtenFiles } from '../checks.js';
import { currentRunContext } from '../run-context.js';
import { securityCheck } from '../security/project-scan.js';
import { classifyRerun, flakyReport, knownFlaky, planRerun, recordFlaky, type FlakyVerdict, type RerunPlan } from '../flaky.js';
import type { SessionEventMap } from '../session/events.js';

/**
 * Every check this turn is held to: the project's own (profile first, manifest
 * second), plus those of any sub-project the turn touched — a generated app in
 * a subdirectory has its own manifest and its checks run from there.
 */
export function gateChecks(root = projectRoot()): Check[] {
  const own = checksFor(root);
  const extra = detectChecksFor(touchedFiles(), root)
    .filter(group => group.root !== path.resolve(root))
    .flatMap(group => group.checks.map(c => ({ ...c, name: `${path.relative(root, group.root).replace(/\\/g, '/')}:${c.name}` })));
  const checks = [...own, ...extra];
  // The built-in security check rides with a project's own checks (ADR 0026):
  // where the project defines what "working" means, "safe to hand over" is
  // part of it. A project with no checks gets none — the gate stays silent
  // there by design (checks.ts), and this does not change that.
  if (checks.length > 0 && currentRunContext()?.settings?.completionGate?.security !== false) {
    checks.push(SECURITY_CHECK);
  }
  return checks;
}

/** The in-process security check (security/project-scan.ts), last: cheapest to read once the build is green. */
export const SECURITY_CHECK: Check = {
  name: 'security',
  command: 'built-in: secrets, code rules, dependency audit',
  weight: 5,
  builtin: 'security',
};

/** How much of a failing command's output to keep. The tail is the useful half. */
const OUTPUT_TAIL = 4000;

export interface RunChecksInput {
  /** Run only these, by name. Omit to run all of them. */
  only?: string[];
  /** Seconds any single check may take. */
  timeout?: number;
  /** Run even when nothing changed since the last green run. */
  force?: boolean;
  /** Run the project's own formatter/linter in fix mode instead of the checks. */
  fix?: boolean;
  /**
   * Re-run a failing test check's failing tests once to tell a flake from a
   * failure (default true). Not in the tool's schema: it would grow every
   * request for a switch only a caller in code wants.
   */
  retryFlaky?: boolean;
}

/**
 * The last run in which every check passed, per project root.
 *
 * A build takes twenty to sixty seconds and an agent asks for it again after
 * editing a Markdown file, or before a final report with nothing edited since
 * the last green run. Nothing about the code has changed, so nothing about the
 * answer can have — the answer is repeated and the minute is not spent. Keyed
 * on the newest source modification time the run saw, which is also what the
 * gate credits a check with.
 */
const lastGreen = new Map<string, { sourceMtimeMs: number; commands: number; names: string[]; at: number }>();

/** Keep the end of the output, where a failure explains itself. */
function tail(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').trimEnd();
  return clean.length <= OUTPUT_TAIL ? clean : `…\n${clean.slice(-OUTPUT_TAIL)}`;
}

/** Where JUnit XML reports conventionally land, relative to the project. */
const JUNIT_DIRS = ['.', 'reports', 'test-results', 'test-reports', 'target/surefire-reports', 'build/test-results/test'];

/**
 * JUnit XML written by this run, when the console output said nothing readable.
 *
 * Maven, Gradle and many CI-configured runners print little and write a report;
 * the report is only trusted when it was written after the check started — an
 * old one describes an old run.
 */
function freshJUnit(dir: string, since: number): TestSummary | undefined {
  const merged: TestSummary = { runner: 'junit-xml', passed: 0, failed: 0, skipped: 0, failures: [] };
  let found = 0;
  for (const sub of JUNIT_DIRS) {
    let names: string[];
    try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
    for (const name of names.filter(n => /\.xml$/i.test(n)).slice(0, 50)) {
      const file = path.join(dir, sub, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < since || stat.size > 20_000_000) continue;
        const one = parseJUnitXml(fs.readFileSync(file, 'utf8'));
        if (!one) continue;
        found++;
        merged.passed += one.passed; merged.failed += one.failed; merged.skipped += one.skipped;
        merged.failures.push(...one.failures);
      } catch { /* an unreadable report: the console output stands */ }
    }
  }
  return found > 0 ? merged : undefined;
}

/** Whether a check runs tests: a linter's "0 errors in 1.2s" is not a pytest summary. */
function isTestRun(check: Check): boolean {
  return /test|jest|vitest|mocha|pytest|\btap\b|\bspec\b/i.test(`${check.name} ${check.command}`);
}

/** The counts a `check/run` record keeps: names only, so the log stays small. */
function testCounts(t: TestSummary | undefined): SessionEventMap['check/run']['tests'] | undefined {
  return t ? {
    runner: t.runner, passed: t.passed, failed: t.failed, skipped: t.skipped,
    ...(t.unit ? { unit: t.unit } : {}),
    failures: t.failures.slice(0, 8).map(f => f.name),
  } : undefined;
}

/**
 * Re-run a failing test check once and say what that showed (ADR 0034).
 *
 * Only for a failure the runner attributed to tests (`failed > 0`), or one it
 * could not read at all while the check is quick: a non-zero exit with all-green
 * counts is a coverage threshold or a crash, and running that again proves
 * nothing. Changes nothing but the run's own arguments.
 */
async function retryFailing(
  check: Check, cwd: string, tests: TestSummary | undefined, firstMs: number, timeout: number,
): Promise<{ plan: RerunPlan; verdict: FlakyVerdict } | undefined> {
  if (tests && tests.failed === 0) return undefined;
  const plan = planRerun(check.command, tests, firstMs);
  if (!plan) return undefined;
  const started = Date.now();
  const result = await bash({ command: plan.command, timeout, cwd });
  const raw = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const rerun = readTests(raw, cwd, started, check);
  const passed = result.exit_code === 0 && !(rerun && rerun.failed > 0);
  const firstNames = tests?.failures.map(f => f.name) ?? [];
  return { plan, verdict: classifyRerun(plan, firstNames, { passed, tests: rerun }) };
}

/**
 * A test summary for a test check's output: the console first, then a JUnit
 * report this run wrote — an old one lying in the tree is not this run's result.
 */
function readTests(raw: string, cwd: string, started: number, check: Check): TestSummary | undefined {
  // Only a test run is read as one: a linter's "0 errors in 1.2s" is not a
  // pytest summary, and a typecheck that "ran no tests" is not news.
  if (!isTestRun(check)) return undefined;
  // Coarse filesystem timestamps (1–2 s) must not make this run's report look old.
  const tests = parseTestOutput(raw) ?? freshJUnit(cwd, started - 2000);
  if (!tests) return undefined;
  tests.failures = tests.failures.map(f => (f.file ? { ...f, file: relativeTo(f.file, cwd) } : f));
  return tests;
}

/** Projects whose unrun formatter/linter has been mentioned, so it is said once, not every run. */
const styleMentioned = new Set<string>();

export async function runChecks(input: RunChecksInput = {}): Promise<string> {
  const root = projectRoot();
  const all = gateChecks(root);
  const style = styleChecks(root, all, input.fix ? 'fix' : 'check');

  if (input.fix) return runFix(root, style, input);

  if (all.length === 0 && !input.only?.length) {
    return 'This project defines no checks — no package.json scripts, Cargo, pytest or Go '
      + 'targets were found, and .aico/profile.json names none. Nothing to run, and nothing will be required of you.'
      + (style.length ? ` It does configure ${style.map(c => `${c.name} (${c.command})`).join(', ')}; run them with only.` : '');
  }

  const wanted = input.only?.length
    ? [...all, ...style].filter(c => input.only!.some(o => o === c.name || (style.includes(c) && selects(o, c.name))))
    : all;

  if (wanted.length === 0) {
    return `No check matches ${input.only?.join(', ')}. This project has: ${[...all, ...style].map(c => c.name).join(', ') || 'none'}.`;
  }

  // Captured before the first command, so a check is credited with the code it
  // actually saw. Reading it afterwards would let a write that landed mid-run
  // look as though it had been checked.
  const sourceMtimeMs = newestSourceChange();

  const green = lastGreen.get(root);
  const commands = commandsRun();
  if (!input.force && green && green.sourceMtimeMs === sourceMtimeMs && green.commands === commands
    && wanted.every(c => green.names.includes(c.name))) {
    const when = new Date(green.at).toTimeString().slice(0, 8);
    return `PASSED — unchanged since the last green run at ${when}: ${wanted.map(c => c.name).join(', ')} still green. `
      + 'No source file changed since, so the checks were not re-run. Pass force: true to run them anyway.';
  }

  const lines: string[] = [];
  const results: CheckResult[] = [];
  const notes: string[] = [];
  let failedAt: Check | undefined;
  /** Checks whose failing tests passed on the one re-run: not green, but not a failure to fix. */
  const flakyChecks: string[] = [];
  const log = currentRunContext()?.sessionLog;
  const logRun = (check: Check, run: Omit<SessionEventMap['check/run'], 'name' | 'command'>): void => {
    log?.record('check/run', { name: check.name, command: check.command, ...(check.cwd ? { cwd: path.relative(root, check.cwd).replace(/\\/g, '/') || '.' } : {}), ...run });
  };

  for (const check of wanted) {
    const started = Date.now();
    const cwd = check.cwd ?? root;
    if (check.builtin === 'security') {
      const sec = await securityCheck(root, writtenFiles().filter(f => !path.relative(root, f).startsWith('..')));
      const ms = Date.now() - started;
      const record: CheckResult = { name: check.name, command: check.command, passed: sec.passed, ms, output: sec.output, at: Date.now(), sourceMtimeMs };
      recordCheck(record);
      results.push(record);
      logRun(check, { outcome: sec.passed ? 'passed' : 'failed', exitCode: null, ms, builtin: 'security', findings: sec.counts });
      lines.push(`${sec.passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(10)} ${check.command}  (${(ms / 1000).toFixed(1)}s)`);
      if (sec.passed && sec.counts.medium > 0) notes.push(sec.output);
      if (!sec.passed) { failedAt = check; break; }
      continue;
    }
    const result = await bash({
      command: check.command,
      timeout: input.timeout ?? 600,
      // A sub-project's check runs where its manifest is; the root's runs at the root.
      cwd,
    });
    const ms = Date.now() - started;
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const tests = readTests(raw, cwd, started, check);
    const listed = check.failOnOutput === true && result.stdout.trim().length > 0;
    // The runner's count outranks its exit code when they disagree towards red.
    const passed = result.exit_code === 0 && !listed && !(tests && tests.failed > 0);

    let output: string;
    if (tests) {
      const summary = formatTestSummary(tests);
      // All-green counts say nothing about why the command failed (a coverage
      // threshold, a crash after the run); then the tail is where the reason is.
      const unexplained = (result.exit_code !== 0 && tests.failed === 0) || (tests.failed > 0 && tests.failures.length === 0);
      output = unexplained ? `${summary}\n\nRaw output (end):\n${tail(raw).slice(-1500)}` : summary;
      if (result.exit_code === 0 && tests.failed > 0) {
        notes.push(`${check.name} exited 0 but its runner reported ${tests.failed} failure(s), so it is counted as failed.`);
      }
      if (passed && tests.passed + tests.failed === 0) {
        notes.push(`${check.name} ran no tests — check that its command finds the test files.`);
      }
    } else {
      output = listed ? `Needs formatting:\n${tail(result.stdout)}` : tail(raw);
    }

    // One more run of what failed, to tell a flake from a failure (ADR 0034).
    let flaky: string[] | undefined;
    let retry: SessionEventMap['check/run']['retry'];
    if (!passed && input.retryFlaky !== false && isTestRun(check) && !check.failOnOutput) {
      const again = await retryFailing(check, cwd, tests, ms, input.timeout ?? 600);
      if (again) {
        const { plan, verdict } = again;
        retry = { basis: plan.basis, tests: plan.tests, passed: verdict.outcome === 'flaky', ...(verdict.flaky.length > 0 ? { flaky: verdict.flaky } : {}) };
        const history = knownFlaky(root);
        if (verdict.outcome === 'flaky') {
          flaky = verdict.flaky;
          recordFlaky(root, (verdict.flaky.length > 0 ? verdict.flaky : [`(check: ${check.name})`])
            .map(test => ({ at: Date.now(), test, check: check.name, ...(tests ? { runner: tests.runner } : {}) })));
          notes.push(...flakyReport(check.name, verdict, plan, history));
        } else if (verdict.outcome === 'failed') {
          if (verdict.flaky.length > 0) {
            recordFlaky(root, verdict.flaky.map(test => ({ at: Date.now(), test, check: check.name, ...(tests ? { runner: tests.runner } : {}) })));
            notes.push(`Re-run: ${verdict.flaky.length} of the failing test(s) passed the second time (flaky: ${verdict.flaky.slice(0, 5).join(', ')}); ${verdict.stillFailing.length} failed again and are real failures.`);
          } else {
            notes.push(`Re-run: the failing test(s) failed again, so this is a real failure, not a flake.`);
          }
        } else {
          notes.push(`The failing tests were re-run (${plan.basis === 'tests' ? 'targeted' : 'whole check'}) but the re-run's output could not be read, so the failure is reported as it first appeared.`);
        }
      }
    }
    if (!flaky && tests && !passed) {
      // A failure the project has failed on before for no reason: say so, so it is not chased as new.
      const history = knownFlaky(root);
      const known = tests.failures.map(f => f.name).filter(n => history.has(n));
      if (known.length > 0) notes.push(`Known flaky in this project: ${known.slice(0, 5).join(', ')} — seen failing and passing before.`);
    }

    const record: CheckResult = {
      name: check.name, command: check.command, passed, ms, output, at: Date.now(), sourceMtimeMs,
      ...(tests ? { tests } : {}),
      ...(flaky ? { flaky } : {}),
    };
    recordCheck(record);
    results.push(record);
    logRun(check, {
      outcome: flaky ? 'flaky' : passed ? 'passed' : 'failed', exitCode: result.exit_code, ms,
      ...(tests ? { tests: testCounts(tests)! } : {}),
      ...(retry ? { retry } : {}),
    });

    lines.push(`${flaky ? 'FLAKY' : passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(10)} ${check.command}  (${(ms / 1000).toFixed(1)}s)`);
    if (tests && passed) lines.push(`      ${output.split('\n')[0]}`);

    if (flaky) { flakyChecks.push(check.name); continue; }
    if (!passed) { failedAt = check; break; }
  }

  if (!failedAt && flakyChecks.length === 0) {
    // Everything asked for passed on this code. A later partial run is covered
    // only for the names it asked about; a full run covers all of them.
    const names = new Set([...(green?.sourceMtimeMs === sourceMtimeMs && green.commands === commands ? green.names : []), ...wanted.map(c => c.name)]);
    lastGreen.set(root, { sourceMtimeMs, commands, names: [...names], at: Date.now() });
  } else {
    lastGreen.delete(root);
  }

  const skipped = wanted.slice(wanted.indexOf(failedAt ?? wanted[wanted.length - 1]!) + 1);
  const report: string[] = [];

  report.push(failedAt
    ? `FAILED — ${failedAt.name} did not pass. The project is not in a working state.`
    : flakyChecks.length > 0
      ? `FLAKY — ${flakyChecks.join(', ')} failed and then passed on a re-run. That is not green: a non-deterministic failure was seen.`
      : `PASSED — ${results.length} check${results.length === 1 ? '' : 's'}, all green.`);
  report.push('');
  report.push(...lines);
  if (notes.length > 0) report.push('', ...notes);

  if (failedAt) {
    const failure = results[results.length - 1]!;
    report.push('');
    report.push(`Output from ${failedAt.name}:`);
    report.push(failure.output || '(no output)');
    if (skipped.length > 0) {
      // Said plainly rather than silently: a reader who sees three checks and
      // one result should be told why, not left to infer it.
      report.push('');
      report.push(`Not run: ${skipped.map(c => c.name).join(', ')} — stopped at the first `
        + `failure, because the later ones usually fail for the same reason.`);
    }
    report.push('');
    report.push('Fix this and run RunChecks again.');
  }

  // A formatter or linter the model has never heard of is one it never runs;
  // said once per project, not on every run.
  const unrun = style.filter(c => !wanted.includes(c));
  if (unrun.length > 0 && !styleMentioned.has(root)) {
    styleMentioned.add(root);
    report.push('');
    report.push(`Also configured, not gated: ${unrun.map(c => `${c.name} (${c.command})`).join(', ')}. Run with only, or fix: true to apply.`);
  }

  return report.join('\n');
}

/**
 * Apply the project's formatter and linter.
 *
 * Every tool runs — one formatter failing says nothing about the next — and
 * the shell-command count is bumped, because files changed outside the write
 * path and a green run from before no longer describes them.
 */
async function runFix(root: string, style: Check[], input: RunChecksInput): Promise<string> {
  const wanted = input.only?.length ? style.filter(c => input.only!.some(o => selects(o, c.name))) : style;
  if (wanted.length === 0) {
    return 'No formatter or linter with a fix mode is configured here'
      + (input.only?.length ? ` matching ${input.only.join(', ')}` : '')
      + ', so nothing was changed. Only tools the project already uses are run.';
  }
  const lines: string[] = [];
  const failures: string[] = [];
  for (const check of wanted) {
    const started = Date.now();
    const result = await bash({ command: check.command, timeout: input.timeout ?? 600, cwd: root });
    const ms = Date.now() - started;
    const ok = result.exit_code === 0;
    lines.push(`${ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(10)} ${check.command}  (${(ms / 1000).toFixed(1)}s)`);
    if (!ok) failures.push(`Output from ${check.name}:\n${tail([result.stdout, result.stderr].filter(Boolean).join('\n')).slice(-1500)}`);
  }
  noteCommandRun();
  lastGreen.delete(root);
  return [
    failures.length > 0
      ? `FIXED WITH PROBLEMS — ${failures.length} tool(s) could not fix everything.`
      : `FIXED — ran ${wanted.length} tool(s) in fix mode.`,
    '',
    ...lines,
    ...(failures.length > 0 ? ['', ...failures] : []),
    '',
    'Files may have changed: review them with Git diff, then run RunChecks.',
  ].join('\n');
}

export const runChecksDefinition = {
  name: 'RunChecks',
  // Trimmed when `fix` was added, so the always-sent schema did not grow: the
  // "untested code is not finished" point is the system prompt's and the gate's.
  description:
    "Run this project's own checks (typecheck, build, test, lint, from its manifest) and report "
    + 'which passed, test failures summarised. Use after changing source and after every fix. '
    + 'Stops at the first failure.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      only: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Run only these by name. Omit for all; the gate wants all. "format" runs the '
          + "project's own formatter (and \"lint\" its linter when unscripted), not gated.",
      },
      fix: { type: 'boolean', description: "Apply the project's formatter/linter in fix mode instead." },
      timeout: { type: 'number', description: 'Seconds per check. Default 600.' },
      force: { type: 'boolean', description: 'Re-run even if no source changed since the last green run.' },
    },
  },
};
