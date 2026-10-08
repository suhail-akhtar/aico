/**
 * Flaky tests: what a failing test run does when it is run once more, and the
 * memory of which tests have done it before (ADR 0034).
 *
 * The failure this exists for. `RunChecks` reported a test that failed once for
 * timing reasons as a failure, and the model went looking for a bug that was
 * not there; or the model re-ran "until green" and reported a pass, and the
 * flake vanished from the person's sight. Both are the same defect: the run did
 * not say what happened.
 *
 * So a failing *test* check is re-run once, narrowed to the failing tests when
 * the runner's output named them (`test-results.ts`) and in whole only when it
 * did not and the first run was quick. A test that failed and then passed is
 * **flaky**: reported as such, with its name, and not counted as green. One that
 * failed twice is a real failure. Each flaky observation is appended to a
 * per-project JSONL under `aicoHome()`, so the next run can say "known flaky".
 *
 * **Deliberately not done:** skipping, quarantining or retrying-until-green
 * (that edits what the project's own checks hold the work to, and is the thing
 * the test-tamper guard exists to refuse), and any rewrite of a test file. The
 * report *suggests* quarantine; the person decides.
 *
 * **Honest limit:** one passing retry shows non-determinism, not why, and a test
 * failing on both runs can still be flaky at a lower rate. Narrowing relies on
 * the project's command accepting extra arguments; a narrowed run that reads
 * back no tests is reported as unclassified, never as a pass.
 *
 * @module flaky
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { aicoHome } from './home.js';
import type { TestSummary } from './test-results.js';

/** A whole-check re-run is only worth its cost when the first run was quick. */
export const WHOLE_RERUN_MAX_MS = 120_000;

/** What to run instead of the failed command, and what it covers. */
export interface RerunPlan {
  basis: 'tests' | 'whole-check';
  command: string;
  /** The test names the narrowed run targets (empty for a whole-check re-run). */
  tests: string[];
}

/** The last segment of a runner's `suite > case` name: what `-t` / `--grep` should match. */
function leafName(name: string): string {
  const parts = name.split(/\s+[>›»]\s+|\s+›\s+/);
  return (parts[parts.length - 1] ?? name).trim();
}

/** A string as a regular-expression literal. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One shell argument, safe for bash and cmd alike. Test names come out of
 * program output, so anything that could end a quoted string or start a
 * substitution is removed rather than escaped: a narrower match only reruns a
 * few more tests, a smuggled command runs.
 */
export function shellArg(s: string): string {
  if (/^[\w./:#=@+,-]+$/.test(s)) return s;
  return `"${s.replace(/["$`\\%!\r\n\0]/g, '.')}"`;
}

/** Strip a `:line:col` suffix from a location, leaving a path a runner accepts. */
function fileOf(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const bare = location.replace(/:\d+(?::\d+)?$/, '');
  return /^(?:[A-Za-z]:)?[\w@./\\ -]+$/.test(bare) ? bare.replace(/\\/g, '/') : undefined;
}

/** `cmd -- args` for an npm-style script runner; plain append for a direct runner invocation. */
function withArgs(command: string, args: string[]): string {
  const tail = args.join(' ');
  if (/^(?:npm|pnpm|yarn)\b/.test(command.trim())) {
    // `npm test` and `npm run x` need `--` to forward flags; pnpm/yarn pass them through.
    const forwarded = /^npm\b/.test(command.trim()) && !/\s--(\s|$)/.test(command) ? ' --' : '';
    return `${command}${forwarded} ${tail}`;
  }
  return `${command} ${tail}`;
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * How to re-run only what failed, for the runners `test-results.ts` reads.
 * Undefined when the failing tests cannot be named and the first run was not
 * quick enough to repeat whole.
 */
export function planRerun(command: string, tests: TestSummary | undefined, firstRunMs: number): RerunPlan | undefined {
  const failures = tests?.failures ?? [];
  const names = unique(failures.map(f => f.name).filter(n => n && !/^\(.*\)$/.test(n))).slice(0, 20);
  const runner = tests?.runner ?? '';

  const whole = (): RerunPlan | undefined => (firstRunMs < WHOLE_RERUN_MAX_MS ? { basis: 'whole-check', command, tests: [] } : undefined);
  if (!tests || names.length === 0 || tests.failed === 0) return whole();
  const narrowed = (cmd: string): RerunPlan => ({ basis: 'tests', command: cmd, tests: names });

  const files = unique(failures.map(f => fileOf(f.file)).filter((f): f is string => !!f)).slice(0, 10);
  const pattern = (): string => shellArg(names.map(n => escapeRegex(leafName(n))).join('|'));

  if (/^(?:jest|vitest)|jest\/vitest/.test(runner)) {
    return narrowed(withArgs(command, [...files.map(shellArg), '-t', pattern()]));
  }
  if (runner === 'mocha') return narrowed(withArgs(command, ['--grep', pattern()]));
  if (runner === 'node:test' || runner === 'tap') {
    // Files only: node's runner filters by name with a flag the project's script may not forward.
    return files.length > 0 ? narrowed(withArgs(command, files.map(shellArg))) : whole();
  }
  if (runner === 'pytest') {
    const ids = names.filter(n => /::/.test(n) || /\.py/.test(n));
    return ids.length > 0 ? narrowed(`${command} ${ids.map(shellArg).join(' ')}`) : whole();
  }
  if (runner === 'go test') {
    const top = unique(names.map(n => n.split('/')[0]!).filter(n => /^[\w]+$/.test(n)));
    return top.length > 0 ? narrowed(`${command} -count=1 -run ${shellArg(`^(${top.join('|')})`)}`) : whole();
  }
  if (runner === 'cargo test') {
    return narrowed(`${command} ${names.slice(0, 10).map(shellArg).join(' ')}`);
  }
  if (runner === 'dotnet test') {
    const filter = names.map(n => `FullyQualifiedName~${leafName(n).replace(/\(.*$/, '')}`).join('|');
    return narrowed(`${command} --filter ${shellArg(filter)}`);
  }
  if (runner === 'junit-xml' || runner === '') {
    // Names are `Class › method`. Maven, Gradle and PHPUnit each filter differently.
    const classes = unique(names.map(n => n.split(/\s+›\s+/)[0]!.split('.').pop()!).filter(c => /^\w+$/.test(c)));
    const methods = unique(names.map(n => leafName(n).replace(/\(.*$/, '')).filter(m => /^\w+$/.test(m)));
    if (/\b(?:mvn|mvnw|maven)\b/.test(command) && classes.length > 0 && methods.length > 0) {
      return narrowed(`${command} -Dtest=${shellArg(classes.map(c => `${c}#${methods.join('+')}`).join(','))} -Dsurefire.failIfNoSpecifiedTests=false`);
    }
    if (/\bgradlew?\b/.test(command) && classes.length > 0) {
      return narrowed(`${command} ${classes.map(c => `--tests ${shellArg(`*${c}`)}`).join(' ')}`);
    }
    if (/\b(?:phpunit|pest)\b/.test(command) && methods.length > 0) {
      return narrowed(`${command} --filter ${shellArg(methods.join('|'))}`);
    }
  }
  return whole();
}

/** What the re-run showed. */
export interface FlakyVerdict {
  outcome: 'flaky' | 'failed' | 'unclassified';
  /** Tests that failed first and passed on the re-run. */
  flaky: string[];
  /** Tests that failed both times. */
  stillFailing: string[];
}

/**
 * Compare the first run with its re-run.
 *
 * `rerunPassed` is the re-run's own verdict (exit code and counts together). A
 * narrowed re-run that read back no tests at all proves nothing — the runner
 * may have rejected the extra arguments — and is `unclassified`, which is
 * reported as the original failure, never as a pass.
 */
export function classifyRerun(plan: RerunPlan, firstNames: string[], rerun: { passed: boolean; tests: TestSummary | undefined }): FlakyVerdict {
  const ran = rerun.tests ? rerun.tests.passed + rerun.tests.failed : 0;
  if (plan.basis === 'tests' && (!rerun.tests || ran === 0)) return { outcome: 'unclassified', flaky: [], stillFailing: [] };
  if (rerun.passed) return { outcome: 'flaky', flaky: firstNames, stillFailing: [] };
  const still = new Set((rerun.tests?.failures ?? []).map(f => f.name));
  const stillFailing = firstNames.filter(n => still.has(n));
  // Failed again but not by the tests that failed first: something else broke; not a flake of those.
  if (rerun.tests && rerun.tests.failures.length > 0 && stillFailing.length < firstNames.length) {
    return { outcome: 'failed', flaky: firstNames.filter(n => !still.has(n)), stillFailing: stillFailing.length > 0 ? stillFailing : [...still] };
  }
  return { outcome: 'failed', flaky: [], stillFailing: stillFailing.length > 0 ? stillFailing : firstNames };
}

// ── History ──────────────────────────────────────────────────────────────

/** One observation of a test that failed and then passed. */
export interface FlakyRecord {
  at: number;
  test: string;
  check: string;
  runner?: string;
  file?: string;
}

/** `<aicoHome>/flaky/<hash of the project path>.jsonl` */
export function flakyFile(root: string): string {
  const key = path.resolve(root).replace(/\\/g, '/').toLowerCase();
  return path.join(aicoHome(), 'flaky', `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}.jsonl`);
}

/** Append observations. Never throws: a lost line is a lost hint, not a failure. */
export function recordFlaky(root: string, records: FlakyRecord[]): void {
  if (records.length === 0) return;
  try {
    const file = flakyFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
  } catch { /* best effort: the history is a hint and its loss changes no verdict */ }
}

/** How many past lines are read: enough to know a project, bounded for a long-lived one. */
const HISTORY_LINES = 2000;

/** Tests seen flaky before in this project: name → how often and when last. */
export function knownFlaky(root: string): Map<string, { count: number; last: number }> {
  const out = new Map<string, { count: number; last: number }>();
  let text: string;
  try { text = fs.readFileSync(flakyFile(root), 'utf8'); } catch { return out; }
  for (const line of text.split('\n').slice(-HISTORY_LINES)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<FlakyRecord>;
      if (typeof r.test !== 'string' || typeof r.at !== 'number') continue;
      const seen = out.get(r.test);
      out.set(r.test, { count: (seen?.count ?? 0) + 1, last: Math.max(seen?.last ?? 0, r.at) });
    } catch { /* a torn line from a crashed append */ }
  }
  return out;
}

/** The report lines for a flaky finding: what it is, what it is not, what to do. */
export function flakyReport(checkName: string, verdict: FlakyVerdict, plan: RerunPlan, history: Map<string, { count: number; last: number }>): string[] {
  const names = verdict.flaky.length > 0 ? verdict.flaky : [`(the ${checkName} check, unnamed)`];
  const lines = [`FLAKY  ${checkName}: ${names.length} test${names.length === 1 ? '' : 's'} failed, then passed on a ${plan.basis === 'tests' ? 'targeted ' : 'full '}re-run. This is not a pass.`];
  for (const n of names.slice(0, 8)) {
    const seen = history.get(n);
    lines.push(`  ✗ ${n}${seen ? `  (known flaky: seen ${seen.count} time${seen.count === 1 ? '' : 's'} before)` : ''}`);
  }
  if (names.length > 8) lines.push(`  … and ${names.length - 8} more.`);
  lines.push('A non-deterministic failure is not fixed by running it again. Do not retry until green. If the test is in code you changed, find the race or the shared state; otherwise tell the person which test is flaky and suggest they quarantine it (skip it with a tracked issue) — do not skip or edit it yourself.');
  return lines;
}
