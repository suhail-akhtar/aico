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
 * **Bounded output.** A failing test suite can produce megabytes; what the
 * reader and the model both need is the end, where it says what went wrong.
 *
 * @module tools/run-checks
 */

import { bash } from './bash.js';
import { currentCwd } from '../run-context.js';
import {
  detectChecks, recordCheck, newestSourceChange,
  type Check, type CheckResult,
} from '../checks.js';

/** How much of a failing command's output to keep. The tail is the useful half. */
const OUTPUT_TAIL = 4000;

export interface RunChecksInput {
  /** Run only these, by name. Omit to run all of them. */
  only?: string[];
  /** Seconds any single check may take. */
  timeout?: number;
}

/** Keep the end of the output, where a failure explains itself. */
function tail(text: string): string {
  const clean = text.replace(/\r\n/g, '\n').trimEnd();
  return clean.length <= OUTPUT_TAIL ? clean : `…\n${clean.slice(-OUTPUT_TAIL)}`;
}

export async function runChecks(input: RunChecksInput = {}): Promise<string> {
  const root = currentCwd();
  const all = detectChecks(root);

  if (all.length === 0) {
    return 'This project defines no checks — no package.json scripts, Cargo, pytest or Go '
      + 'targets were found. Nothing to run, and nothing will be required of you.';
  }

  const wanted = input.only?.length
    ? all.filter(c => input.only!.includes(c.name))
    : all;

  if (wanted.length === 0) {
    return `No check matches ${input.only?.join(', ')}. This project has: ${all.map(c => c.name).join(', ')}.`;
  }

  // Captured before the first command, so a check is credited with the code it
  // actually saw. Reading it afterwards would let a write that landed mid-run
  // look as though it had been checked.
  const sourceMtimeMs = newestSourceChange();

  const lines: string[] = [];
  const results: CheckResult[] = [];
  let failedAt: Check | undefined;

  for (const check of wanted) {
    const started = Date.now();
    const result = await bash({
      command: check.command,
      timeout: input.timeout ?? 600,
    });
    const ms = Date.now() - started;
    const passed = result.exit_code === 0;
    const output = tail([result.stdout, result.stderr].filter(Boolean).join('\n'));

    const record: CheckResult = {
      name: check.name, command: check.command, passed, ms, output, at: Date.now(), sourceMtimeMs,
    };
    recordCheck(record);
    results.push(record);

    lines.push(`${passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(10)} ${check.command}  (${(ms / 1000).toFixed(1)}s)`);

    if (!passed) { failedAt = check; break; }
  }

  const skipped = wanted.slice(wanted.indexOf(failedAt ?? wanted[wanted.length - 1]!) + 1);
  const report: string[] = [];

  report.push(failedAt
    ? `FAILED — ${failedAt.name} did not pass. The project is not in a working state.`
    : `PASSED — ${results.length} check${results.length === 1 ? '' : 's'}, all green.`);
  report.push('');
  report.push(...lines);

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

  return report.join('\n');
}

export const runChecksDefinition = {
  name: 'RunChecks',
  description:
    "Run this project's own checks — typecheck, build, test, lint — as detected from its "
    + 'manifest, and report which passed. Use it after changing source and again after every '
    + 'fix. Code that has not been compiled or tested since it was written is not finished '
    + 'work, however carefully it was written. Stops at the first failure.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      only: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Run only these checks by name (typecheck, build, test, lint). Omit to run all. '
          + 'Useful for a quick typecheck mid-edit, but the gate wants all of them before the '
          + 'turn ends.',
      },
      timeout: {
        type: 'number',
        description: 'Seconds any single check may take. Default 600.',
      },
    },
  },
};
