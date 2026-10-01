/**
 * What a test run said, read out of its output: counts and the failures.
 *
 * `RunChecks` used to hand back the last 4K of a failing suite. That tail is
 * where a compiler explains itself, but not where a test runner does: Jest
 * prints its failures *above* the coverage table, pytest above twenty lines of
 * warnings, cargo above the doc-test run. The model got the summary line and
 * the noise, scrolled for the assertion, and paid tokens for both. And the gate
 * read only the exit code, so a runner that swallowed a failure (a wrapper
 * script ending in `|| true`, a watch-mode flag) looked green.
 *
 * So the common runners' own summary formats are parsed — node:test (TAP and
 * spec), Jest and Vitest (JSON and text), Mocha, pytest, go test, cargo test,
 * dotnet test, and JUnit XML — into one shape: `{ passed, failed, skipped,
 * failures }`. The report leads with that; the raw tail is kept only when the
 * output could not be read, or when the exit code and the counts disagree
 * (a coverage threshold failing a green suite), because then the tail is
 * where the reason is.
 *
 * **Fails closed.** A parser only claims output that carries its runner's
 * summary signature. Anything else — tsc, a build, a linter, a runner not
 * listed here — returns `undefined` and is reported exactly as before. A
 * wrong count is worse than no count.
 *
 * **Deliberately not done:** running the tests a second time with a
 * machine-readable reporter. The project's own command is what the gate holds
 * the work to; changing its flags would be checking something else.
 *
 * @module test-results
 */

export interface TestFailure {
  /** The test, as its runner names it (`suite › case`, `tests/x.py::test_y`). */
  name: string;
  /** Where it lives, when the output says. */
  file?: string;
  /** The first line or two of why — the assertion, not the stack. */
  message: string;
}

export interface TestSummary {
  /** Which format was recognised: `node:test`, `jest`, `pytest`, … */
  runner: string;
  passed: number;
  failed: number;
  skipped: number;
  failures: TestFailure[];
  /**
   * What the counts count. `go test` without `-v` reports packages, not tests;
   * saying "3 passed" of three packages would overstate it.
   */
  unit?: 'tests' | 'packages';
}

/** How many failures a summary keeps; the rest are counted, not listed. */
export const MAX_FAILURES = 8;
/** How long one failure's message may be. The assertion fits; the stack does not. */
const MAX_MESSAGE = 300;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strip colour codes and carriage returns: every format below is matched on plain text. */
function plain(text: string): string {
  return text.replace(ANSI, '').replace(/\r\n?/g, '\n');
}

/**
 * The first meaningful lines of a failure message, trimmed to fit: everything
 * before the first stack frame, which is where every runner here puts the
 * assertion. The frames, and the property dump some runners print after them,
 * are the part nobody reads first.
 */
function shortMessage(lines: string[] | string): string {
  const all = (Array.isArray(lines) ? lines : lines.split('\n')).map(l => l.trim());
  const frame = all.findIndex(l => /^at\s/.test(l));
  const list = (frame >= 0 ? all.slice(0, frame) : all)
    .filter(l => l && !/^\^+$|^-{3,}$|^~+$|^[{}[\]],?$/.test(l));
  const text = list.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

const num = (s: string | undefined): number => (s ? Number(s.replace(/,/g, '')) || 0 : 0);

// ─── JSON: Jest / Vitest ─────────────────────────────────────────────────

interface JestAssertion { fullName?: string; title?: string; status?: string; failureMessages?: string[] }
interface JestFile { name?: string; message?: string; assertionResults?: JestAssertion[] }
interface JestJson {
  numPassedTests?: number; numFailedTests?: number; numPendingTests?: number; numTodoTests?: number;
  testResults?: JestFile[];
}

/** The first JSON object in the output that looks like a Jest/Vitest `--json` report. */
function parseJestJson(text: string): TestSummary | undefined {
  const start = text.indexOf('{');
  if (start < 0 || !/"numFailedTests"/.test(text)) return undefined;
  let json: JestJson | undefined;
  // The report may sit between log lines; the widest object is the report.
  try { json = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as JestJson; } catch { return undefined; }
  if (!json || typeof json.numFailedTests !== 'number') return undefined;
  const failures: TestFailure[] = [];
  for (const file of json.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      if (a.status !== 'failed') continue;
      failures.push({
        name: a.fullName ?? a.title ?? '(unnamed)',
        ...(file.name ? { file: file.name } : {}),
        message: shortMessage(plain((a.failureMessages ?? []).join('\n'))),
      });
    }
    // A file that failed to load has no assertions, only a message.
    if ((file.assertionResults ?? []).length === 0 && file.message) {
      failures.push({ name: '(test file failed to run)', ...(file.name ? { file: file.name } : {}), message: shortMessage(plain(file.message)) });
    }
  }
  return {
    runner: 'jest/vitest (json)',
    passed: json.numPassedTests ?? 0,
    failed: json.numFailedTests,
    skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0),
    failures,
  };
}

// ─── JUnit XML ───────────────────────────────────────────────────────────

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : undefined;
};

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
}

/**
 * A JUnit XML report — what Maven, Gradle, pytest `--junitxml`, Jest and
 * Vitest reporters, and most CI tooling write. Counted from the `<testcase>`
 * elements rather than the suite attributes, which nest and double-count.
 */
export function parseJUnitXml(xml: string): TestSummary | undefined {
  if (!/<testsuites?\b/.test(xml) || !/<testcase\b/.test(xml)) return undefined;
  let passed = 0; let failed = 0; let skipped = 0;
  const failures: TestFailure[] = [];
  const CASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = CASE.exec(xml); m; m = CASE.exec(xml)) {
    const head = m[1] ?? '';
    const body = m[2] ?? '';
    const bad = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (bad) {
      failed++;
      const name = [attr(head, 'classname'), attr(head, 'name')].filter(Boolean).join(' › ') || '(unnamed)';
      const file = attr(head, 'file');
      const message = attr(bad[2] ?? '', 'message') || decodeXml((bad[3] ?? '').replace(/<!\[CDATA\[|\]\]>/g, ''));
      failures.push({ name, ...(file ? { file } : {}), message: shortMessage(message) });
    } else if (/<skipped\b/.test(body)) skipped++;
    else passed++;
  }
  return { runner: 'junit-xml', passed, failed, skipped, failures };
}

// ─── node:test / TAP ─────────────────────────────────────────────────────

/**
 * Node's built-in runner, in either reporter, and generic TAP (tape, tap).
 * The counts come from the trailing `# pass N` / `ℹ pass N` block, which the
 * runner prints once for the whole run.
 */
function parseNodeTest(text: string): TestSummary | undefined {
  const count = (key: string) => {
    const re = new RegExp(`^(?:#|ℹ)\\s*${key}\\s+(\\d+)(?:\\.\\d+)?\\s*$`, 'gm');
    let last: string | undefined;
    for (let m = re.exec(text); m; m = re.exec(text)) last = m[1];
    return last;
  };
  const pass = count('pass');
  const fail = count('fail');
  // tape prints no `# fail` line when nothing failed; `# tests` still marks the summary.
  if (pass === undefined || (fail === undefined && count('tests') === undefined)) return undefined;
  const failures: TestFailure[] = [];
  const lines = text.split('\n');

  // TAP: `not ok 2 - name` followed by an indented YAML block. A parent whose
  // only fault is a failing subtest says so (`subtestsFailed`) and is skipped:
  // the child is the failure, the parent is bookkeeping.
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.+?)(?:\s+#\s*(?:SKIP|TODO).*)?$/.exec(lines[i]!);
    if (!m) continue;
    if (/#\s*(SKIP|TODO)/i.test(lines[i]!)) continue;
    const yaml: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\s*\.\.\.\s*$/.test(l)) break;
      if (/^\s*(not )?ok \d+/.test(l)) break;
      yaml.push(l);
    }
    const block = yaml.join('\n');
    if (/failureType:\s*'?subtestsFailed/.test(block)) continue;
    // YAML single-quoted: Windows paths arrive with their backslashes doubled.
    const location = /location:\s*'([^']+)'/.exec(block)?.[1]?.replace(/\\\\/g, '\\');
    let message = '';
    const err = /^([ \t]*)error:[ \t]*(\|-?|>-?)?[ \t]*(.*)$/m.exec(block);
    if (err) {
      if (err[2]) {
        const after = block.slice(block.indexOf(err[0]) + err[0].length).split('\n').slice(1);
        const indent = (err[1] ?? '').length;
        const body: string[] = [];
        for (const l of after) {
          if (l.trim() && l.length - l.trimStart().length <= indent) break;
          body.push(l);
        }
        message = shortMessage(body);
      } else {
        message = shortMessage(err[3]!.replace(/^'|'$/g, ''));
      }
    }
    failures.push({ name: m[2]!.trim(), ...(location ? { file: location } : {}), message: message || '(no message)' });
  }

  // Spec reporter: a `✖ failing tests:` section, each entry `test at file:line`
  // then `✖ name (1.2ms)` then the indented error.
  if (failures.length === 0) {
    const at = lines.findIndex(l => /^✖ failing tests:/.test(l.trim()));
    if (at >= 0) {
      let file: string | undefined;
      for (let i = at + 1; i < lines.length; i++) {
        const l = lines[i]!;
        const loc = /^test at (.+)$/.exec(l.trim());
        if (loc) { file = loc[1]; continue; }
        const head = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(l.trim());
        if (head && l.length - l.trimStart().length === 0) {
          const body: string[] = [];
          // The error is indented under its test and may contain blank lines.
          for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]!) || !lines[j]!.trim()); j++) body.push(lines[j]!);
          // A suite whose children failed is reported with no error of its own.
          if (body.length === 0 || /subtests? failed/i.test(body.join(' '))) { file = undefined; continue; }
          failures.push({ name: head[1]!, ...(file ? { file } : {}), message: shortMessage(body) });
          file = undefined;
        }
      }
    }
  }

  return {
    runner: count('duration_ms') !== undefined ? 'node:test' : 'tap',
    passed: num(pass),
    failed: num(fail),
    skipped: num(count('skipped') ?? count('skip')) + num(count('todo')),
    failures,
  };
}

// ─── Jest / Vitest / Mocha text ──────────────────────────────────────────

function parseJestText(text: string): TestSummary | undefined {
  // `Tests:       1 failed, 1 skipped, 4 passed, 6 total`
  const line = /^Tests:\s+(.*\d+ total.*)$/m.exec(text)?.[1];
  if (!line) return undefined;
  const pick = (k: string) => num(new RegExp(`(\\d+) ${k}`).exec(line)?.[1]);
  const failures: TestFailure[] = [];
  const lines = text.split('\n');
  let file: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const f = /^FAIL\s+(\S+)/.exec(l.trim());
    if (f) { file = f[1]; continue; }
    const head = /^\s*● (.+)$/.exec(l);
    if (!head || /^Console$/.test(head[1]!.trim()) || /Test suite failed to run/.test(head[1]!)) {
      if (head && /Test suite failed to run/.test(head[1]!)) {
        const body: string[] = [];
        for (let j = i + 1; j < lines.length && !/^\s*● /.test(lines[j]!) && body.length < 8; j++) body.push(lines[j]!);
        failures.push({ name: '(test suite failed to run)', ...(file ? { file } : {}), message: shortMessage(body) });
      }
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^\s*● /.test(lines[j]!) && body.length < 12; j++) body.push(lines[j]!);
    // Jest prints the source excerpt (`> 12 |`) after the message; stop there.
    const cut = body.findIndex(b => /^\s*>?\s*\d+ \|/.test(b));
    failures.push({ name: head[1]!.trim(), ...(file ? { file } : {}), message: shortMessage(cut >= 0 ? body.slice(0, cut) : body) });
  }
  return {
    runner: 'jest',
    passed: pick('passed'),
    failed: pick('failed'),
    skipped: pick('skipped') + pick('todo'),
    failures,
  };
}

function parseVitestText(text: string): TestSummary | undefined {
  // `      Tests  1 failed | 10 passed | 2 skipped (13)`
  const line = /^\s*Tests\s{2,}(.*\(\d+\))\s*$/m.exec(text)?.[1];
  if (!line) return undefined;
  const pick = (k: string) => num(new RegExp(`(\\d+) ${k}`).exec(line)?.[1]);
  const failures: TestFailure[] = [];
  const lines = text.split('\n');
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    // ` FAIL  src/a.test.ts > suite > adds` — listed again in the failure detail.
    const m = /^\s*(?:FAIL|×|✗)\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+?)(?:\s+\d+m?s)?\s*$/.exec(lines[i]!);
    if (!m) continue;
    const key = `${m[1]} > ${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && body.length < 6; j++) {
      const l = lines[j]!;
      if (/^\s*(FAIL|×|✗)\s/.test(l) || /⎯{3,}/.test(l)) break;
      // The message ends at the first blank line; the diff and source excerpt follow it.
      if (/^\s*❯/.test(l) || (!l.trim() && body.some(b => b.trim()))) break;
      body.push(l);
    }
    failures.push({ name: m[2]!.trim(), file: m[1]!, message: shortMessage(body) || '(see output)' });
  }
  return { runner: 'vitest', passed: pick('passed'), failed: pick('failed'), skipped: pick('skipped') + pick('todo'), failures };
}

function parseMocha(text: string): TestSummary | undefined {
  const passing = /^\s*(\d+) passing\b/m.exec(text)?.[1];
  if (!passing) return undefined;
  const failing = /^\s*(\d+) failing\b/m.exec(text)?.[1];
  const pending = /^\s*(\d+) pending\b/m.exec(text)?.[1];
  const failures: TestFailure[] = [];
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^\s*\d+ failing\b/.test(l));
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const head = /^\s*(\d+)\) (.+)$/.exec(lines[i]!);
      if (!head) continue;
      const name: string[] = [head[2]!.replace(/:$/, '')];
      let j = i + 1;
      // The title continues on following lines, each deeper, ending with `:`.
      while (j < lines.length && /^\s+\S.*:$/.test(lines[j]!) && !/Error/.test(lines[j]!)) { name.push(lines[j]!.trim().replace(/:$/, '')); j++; }
      const body: string[] = [];
      for (; j < lines.length && !/^\s*\d+\) /.test(lines[j]!) && body.length < 6; j++) body.push(lines[j]!);
      failures.push({ name: name.join(' › '), message: shortMessage(body) });
      i = j - 1;
    }
  }
  return { runner: 'mocha', passed: num(passing), failed: num(failing), skipped: num(pending), failures };
}

// ─── pytest ──────────────────────────────────────────────────────────────

function parsePytest(text: string): TestSummary | undefined {
  // `===== 1 failed, 3 passed, 1 skipped in 0.12s =====` or, with -q, the bare line.
  const lines = text.split('\n');
  let summary: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.replace(/=+/g, ' ').trim();
    if (/^(\d+ \w+(, )?)+.* in [\d.]+s\b/.test(l) && /\b(passed|failed|error|errors|skipped|no tests ran)\b/.test(l)) { summary = l; break; }
    if (/^no tests ran in [\d.]+s/.test(l)) { summary = l; break; }
  }
  if (!summary) return undefined;
  const pick = (k: string) => num(new RegExp(`(\\d+) ${k}\\b`).exec(summary!)?.[1]);
  const failures: TestFailure[] = [];
  // The short test summary (`-rfE`, pytest's default): one line per failure.
  for (const l of lines) {
    const m = /^(FAILED|ERROR) (\S+?)(?: - (.*))?$/.exec(l.trim());
    if (!m) continue;
    const id = m[2]!;
    failures.push({ name: id, file: id.split('::')[0]!, message: shortMessage(m[3] ?? (m[1] === 'ERROR' ? 'error during collection or setup' : '(see output)')) });
  }
  return {
    runner: 'pytest',
    passed: pick('passed') + pick('xpassed'),
    failed: pick('failed') + pick('errors?'),
    skipped: pick('skipped') + pick('xfailed') + pick('deselected'),
    failures,
  };
}

// ─── go test ─────────────────────────────────────────────────────────────

function parseGoTest(text: string): TestSummary | undefined {
  const lines = text.split('\n');
  const pkgOk = lines.filter(l => /^ok\s+\S+\s+(\(cached\)|[\d.]+s)/.test(l)).length;
  const pkgFail = lines.filter(l => /^FAIL\s+\S+\s+([\d.]+s|\[build failed\]|\[setup failed\])/.test(l));
  const runs = { pass: 0, fail: 0, skip: 0 };
  const failures: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(lines[i]!);
    if (!m) continue;
    if (m[1] === 'PASS') { runs.pass++; continue; }
    if (m[1] === 'SKIP') { runs.skip++; continue; }
    runs.fail++;
    const body: string[] = [];
    const indent = lines[i]!.length - lines[i]!.trimStart().length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^\s*--- (PASS|FAIL|SKIP)/.test(l) || /^(FAIL|ok|PASS)\b/.test(l)) break;
      if (l.trim() && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    const loc = /(\S+_test\.go:\d+)/.exec(body.join('\n'))?.[1];
    // A parent test whose subtest failed carries no message of its own.
    if (body.every(b => /^\s*--- /.test(b) || !b.trim()) && failures.some(f => f.name.startsWith(`${m[2]}/`))) continue;
    failures.push({ name: m[2]!, ...(loc ? { file: loc } : {}), message: shortMessage(body.map(b => b.replace(/^\s*\S+_test\.go:\d+:\s*/, ''))) || '(see output)' });
  }
  for (const l of pkgFail) {
    const m = /^FAIL\s+(\S+)\s+\[(build|setup) failed\]/.exec(l);
    if (m) failures.push({ name: m[1]!, message: `${m[2]} failed — see the compiler output above` });
  }
  if (pkgOk === 0 && pkgFail.length === 0 && runs.pass + runs.fail === 0) return undefined;
  // A parent whose subtest failed is printed first, with no message of its
  // own: the subtest is the failure, so the parent is neither listed nor counted.
  const parents = failures.filter(f => failures.some(o => o.name.startsWith(`${f.name}/`)));
  const listed = failures.filter(f => !parents.includes(f));
  // Without -v a passing test prints nothing; then the honest unit is the package.
  if (runs.pass === 0) {
    return { runner: 'go test', unit: 'packages', passed: pkgOk, failed: pkgFail.length, skipped: 0, failures: listed };
  }
  const buildFailed = pkgFail.filter(l => /\[(build|setup) failed\]/.test(l)).length;
  return { runner: 'go test', passed: runs.pass, failed: runs.fail - parents.length + buildFailed, skipped: runs.skip, failures: listed };
}

// ─── cargo test ──────────────────────────────────────────────────────────

function parseCargo(text: string): TestSummary | undefined {
  const RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm;
  let passed = 0; let failed = 0; let skipped = 0; let any = false;
  for (let m = RESULT.exec(text); m; m = RESULT.exec(text)) {
    any = true; passed += num(m[1]); failed += num(m[2]); skipped += num(m[3]);
  }
  if (!any) return undefined;
  const failures: TestFailure[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^---- (\S+) stdout ----$/.exec(lines[i]!.trim());
    if (!head) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^---- \S+ stdout ----$/.test(lines[j]!.trim()) && !/^failures:\s*$/.test(lines[j]!.trim()); j++) body.push(lines[j]!);
    // `thread 'x' panicked at src/lib.rs:10:9:` (new) or `… panicked at 'msg', src/lib.rs:10:9` (old).
    const panic = body.find(b => /panicked at/.test(b)) ?? '';
    const loc = /panicked at (?:'.*', )?([^\s:']+:\d+:\d+)/.exec(panic)?.[1];
    const rest = body.filter(b => b !== panic && !/^note: run with `RUST_BACKTRACE/.test(b.trim()));
    const old = /panicked at '(.*)', /.exec(panic)?.[1];
    failures.push({ name: head[1]!, ...(loc ? { file: loc } : {}), message: shortMessage(old ? [old, ...rest] : rest) || '(see output)' });
  }
  return { runner: 'cargo test', passed, failed, skipped, failures };
}

// ─── dotnet test ─────────────────────────────────────────────────────────

function parseDotnet(text: string): TestSummary | undefined {
  // `Failed!  - Failed:     1, Passed:     5, Skipped:     0, Total:     6, Duration: 30 ms - X.dll (net8.0)`
  const SUMMARY = /^\s*(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+)/gm;
  let passed = 0; let failed = 0; let skipped = 0; let any = false;
  for (let m = SUMMARY.exec(text); m; m = SUMMARY.exec(text)) {
    any = true; failed += num(m[1]); passed += num(m[2]); skipped += num(m[3]);
  }
  if (!any) {
    // Older SDKs: `Total tests: 6` then `Passed: 5` / `Failed: 1` lines.
    const total = /^Total tests:\s*(\d+)/m.exec(text);
    if (!total) return undefined;
    any = true;
    passed = num(/^\s+Passed:\s*(\d+)/m.exec(text)?.[1]);
    failed = num(/^\s+Failed:\s*(\d+)/m.exec(text)?.[1]);
    skipped = num(/^\s+Skipped:\s*(\d+)/m.exec(text)?.[1]);
  }
  const failures: TestFailure[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*Failed (\S+) \[[^\]]*\]\s*$/.exec(lines[i]!);
    if (!head) continue;
    const body: string[] = [];
    let stack = '';
    let inStack = false;
    for (let j = i + 1; j < lines.length && !/^\s*(Failed|Passed|Skipped) \S+ \[/.test(lines[j]!) && !/^\s*(Passed|Failed)!/.test(lines[j]!); j++) {
      const l = lines[j]!;
      if (/^\s*Error Message:/.test(l)) continue;
      if (/^\s*Stack Trace:/.test(l)) { inStack = true; continue; }
      if (inStack) { if (!stack && / in (.+):line (\d+)/.test(l)) stack = l; continue; }
      body.push(l);
    }
    const loc = / in (.+):line (\d+)/.exec(stack);
    failures.push({ name: head[1]!, ...(loc ? { file: `${loc[1]}:${loc[2]}` } : {}), message: shortMessage(body) || '(see output)' });
  }
  return { runner: 'dotnet test', passed, failed, skipped, failures };
}

/**
 * Read a test run's output. Undefined when no known runner's summary is in it.
 *
 * Order matters only where formats could overlap: JSON first (it is exact),
 * then the formats with the most distinctive summary lines.
 */
export function parseTestOutput(raw: string): TestSummary | undefined {
  const text = plain(raw);
  for (const parse of [parseJestJson, parseNodeTest, parseJestText, parseVitestText, parsePytest, parseCargo, parseDotnet, parseGoTest, parseMocha, parseJUnitXml]) {
    const found = parse(text);
    if (found) return found;
  }
  return undefined;
}

/**
 * The summary as the model and the reader see it: counts, then each failure
 * on two lines, capped. Failures past the cap are counted, not listed — the
 * fifth failure of the same kind tells nobody anything the first did not.
 */
export function formatTestSummary(s: TestSummary, opts: { max?: number; root?: string } = {}): string {
  const max = opts.max ?? MAX_FAILURES;
  const unit = s.unit === 'packages' ? ' packages' : '';
  const lines = [`${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped${unit} (${s.runner})`];
  for (const f of s.failures.slice(0, max)) {
    lines.push(`✗ ${f.name}${f.file ? `  [${relativeTo(f.file, opts.root)}]` : ''}`);
    lines.push(`    ${f.message}`);
  }
  if (s.failures.length > max) lines.push(`… and ${s.failures.length - max} more failure(s) not listed.`);
  if (s.failed > 0 && s.failures.length === 0) lines.push('(the runner reported failures but not where; see the raw output below)');
  return lines.join('\n');
}

/** A runner's absolute path, shown relative to the project: the prefix is the same on every line. */
export function relativeTo(file: string, root: string | undefined): string {
  let f = file;
  if (/^file:\/\//.test(f)) {
    f = f.replace(/^file:\/\//, '').replace(/^\/(?=[A-Za-z]:)/, '');
    try { f = decodeURIComponent(f); } catch { /* not URI-encoded after all */ }
  }
  if (!root) return f;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:)/, '');
  const r = norm(root).replace(/\/$/, '');
  const n = norm(f);
  return n.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? n.slice(r.length + 1) : f;
}
