/**
 * Did this change make a test weaker? The pure half of the test-tamper guard
 * (ADR 0033).
 *
 * WHY. A red suite is the strongest pressure on a model to edit the test rather
 * than the code: delete the file, add `.skip`, drop the assertion, change the
 * expected number to whatever the code now returns. `RunChecks` then reports
 * green and the completion gate lets the turn end — the evidence was changed to
 * match the claim. Nothing compared a test before and after.
 *
 * What it reports, per test file, from the text before and after:
 *   - `test-file-deleted`: the file is gone;
 *   - `assertions-removed`: fewer assertions than before (counted per language,
 *     comments excluded);
 *   - `skip-marker-added`: more `.skip` / `.only` / `xit` / `@Disabled` /
 *     `[Fact(Skip=…)]` / `pytest.mark.skip` / `t.Skip` / `markTestSkipped`…;
 *   - `weak-matcher-added`: `toBeTruthy` / `assertTrue(true)` / `assert True`
 *     where strong assertions disappeared at the same time;
 *   - `expected-value-changed`: an assertion line identical but for its
 *     literals — reported only when a test check had already failed this turn
 *     (otherwise it is an ordinary edit), see {@link compareTest}.
 *
 * Honest about being heuristics: a legitimate refactor to a table-driven test
 * removes assertion *lines*. So the in-loop response is a nudge to restore the
 * test or say why to the person, and only the unambiguous cases (a deleted test,
 * a new skip) need a person, and only when nobody is watching
 * (`tools/test-tamper-guard.ts`). It does not parse code: a test weakened by
 * moving its logic into a helper looks like fewer assertions, and one weakened
 * through a file the write path never saw is not seen at all.
 *
 * @module security/test-tamper
 */

import fs from 'node:fs';
import path from 'node:path';
import { splitCommands, tokenize } from '../tools/package-parse.js';

export type TestLang = 'js' | 'py' | 'go' | 'java' | 'cs' | 'php';

export type TamperKind = 'test-file-deleted' | 'assertions-removed' | 'skip-marker-added' | 'weak-matcher-added' | 'expected-value-changed';

export interface TamperFinding {
  kind: TamperKind;
  /** Project-relative, forward slashes. */
  file: string;
  detail: string;
  line?: number;
}

const norm = (f: string): string => f.replace(/\\/g, '/');

/** The language of a test file by extension, or undefined when it is not one of the covered kinds. */
export function testLangOf(file: string): TestLang | undefined {
  const f = norm(file).toLowerCase();
  if (/\.(?:[cm]?[jt]sx?)$/.test(f)) return 'js';
  if (/\.pyw?$/.test(f)) return 'py';
  if (/\.go$/.test(f)) return 'go';
  if (/\.(?:java|kt|kts)$/.test(f)) return 'java';
  if (/\.cs$/.test(f)) return 'cs';
  if (/\.php\d?$/.test(f)) return 'php';
  return undefined;
}

/** Whether a path is a test file, by the conventions of the covered languages. */
export function isTestFile(file: string): boolean {
  const f = norm(file);
  const lang = testLangOf(f);
  if (!lang) return false;
  const base = f.slice(f.lastIndexOf('/') + 1);
  switch (lang) {
    case 'js': return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base) || /[-_.]test\.[cm]?[jt]sx?$/i.test(base) || /(?:^|\/)(?:__tests__|tests?|spec|e2e)\//i.test(f);
    case 'py': return /^test_.*\.py$|_test\.py$/i.test(base) || /(?:^|\/)tests?\/[^/]+\.py$/i.test(f);
    case 'go': return /_test\.go$/.test(base);
    case 'java': return /(?:^|\/)src\/test\//.test(f) || /(?:Test|Tests|IT|Spec)\.(?:java|kt)$/.test(base) || /^Test[A-Z]\w*\.(?:java|kt)$/.test(base);
    case 'cs': return /(?:Tests?|Spec)\.cs$/.test(base) || /(?:^|\/)[\w.]*\.?Tests?\//.test(f);
    case 'php': return /Test\.php$/.test(base) || /(?:^|\/)tests?\//i.test(f);
  }
}

/** Code lines only, with their 1-based line numbers: comment lines dropped, trailing `//` comments removed (assertions never live in those). */
function codeEntries(text: string, lang: TestLang): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (lang === 'py') { if (!t.startsWith('#')) out.push({ n: i + 1, text: raw }); return; }
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    if (t.startsWith('//') || t.startsWith('*') || (lang === 'php' && t.startsWith('#') && !t.startsWith('#['))) return;
    out.push({ n: i + 1, text: raw.replace(/\s\/\/\s.*$/, '') });
  });
  return out;
}

const codeLines = (text: string, lang: TestLang): string[] => codeEntries(text, lang).map(e => e.text);

const count = (lines: string[], res: RegExp[]): number => {
  let n = 0;
  for (const l of lines) for (const re of res) { const m = l.match(re); if (m) n += m.length; }
  return n;
};

const ASSERTIONS: Record<TestLang, RegExp[]> = {
  js: [/\b(?:expect|assert)\s*\(/g, /\bassert\.\w+\s*\(/g, /\bt\.(?:is|not|true|false|truthy|falsy|deepEqual|equal|notEqual|throws|rejects|snapshot|ok|same|notSame|match|regex|pass)\s*\(/g, /\bshould\.\w+\s*\(|\.should\b/g],
  py: [/^\s*assert\b/g, /\bself\.assert\w*\s*\(/g, /\bpytest\.raises\s*\(/g],
  go: [/\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g, /\b(?:assert|require)\.\w+\s*\(/g],
  java: [/\b(?:assert[A-Z]\w*|fail|verify)\s*\(/g, /\bAssert\.\w+\s*\(/g],
  cs: [/\bAssert\.\w+\s*\(/g, /\.Should\(\)/g],
  php: [/\$this->(?:assert\w*|expectException\w*)\s*\(/g, /\bexpect\s*\(/g, /->to[A-Z]\w*\s*\(/g],
};

const SKIPS: Record<TestLang, RegExp[]> = {
  js: [/\b(?:it|test|describe|context|suite)(?:\.concurrent)?\.(?:skip|only|fixme)\b/g, /\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe|ftest)\s*\(/g, /\b(?:t|this)\.skip\s*\(/g, /\{\s*skip\s*:\s*(?:true|['"`])/g],
  py: [/@pytest\.mark\.(?:skip|xfail|skipif)\b/g, /\bpytest\.(?:skip|xfail)\s*\(/g, /@unittest\.(?:skip|expectedFailure|skipIf|skipUnless)\b/g, /\bself\.skipTest\s*\(/g],
  go: [/\b[tb]\.(?:Skip|Skipf|SkipNow)\s*\(/g],
  java: [/@(?:Disabled|Ignore|Ignored)\b/g, /\bAssumptions?\.assume\w*\s*\(\s*false\b/g],
  cs: [/\[(?:Fact|Theory)\s*\([^)]*Skip\s*=/g, /\[(?:Ignore|Skip)\b/g, /\bAssert\.(?:Ignore|Inconclusive)\s*\(/g],
  php: [/\bmarkTest(?:Skipped|Incomplete)\s*\(/g, /->skip\s*\(/g],
};

const WEAK: Record<TestLang, RegExp[]> = {
  js: [/\.(?:toBeTruthy|toBeDefined|toBeFalsy|toBeUndefined)\s*\(\s*\)/g, /\bexpect\.(?:anything|any)\s*\(/g, /\bassert(?:\.ok)?\s*\(\s*true\s*[,)]/g, /\bexpect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/g],
  py: [/^\s*assert\s+(?:True|1)\s*(?:$|,|#)/g, /\bassertTrue\s*\(\s*True\s*\)/g],
  go: [/\bassert\.True\s*\(\s*t\s*,\s*true\s*\)/g],
  java: [/\bassertTrue\s*\(\s*true\s*\)/g, /\bassertNotNull\s*\(/g],
  cs: [/\bAssert\.(?:True|IsTrue)\s*\(\s*true\s*\)/g, /\bAssert\.(?:NotNull|IsNotNull)\s*\(/g],
  php: [/\bassertTrue\s*\(\s*true\s*\)/g, /\bassertNotNull\s*\(/g],
};

/** How many assertions a test file holds. */
export function assertionCount(text: string, lang: TestLang): number { return count(codeLines(text, lang), ASSERTIONS[lang]); }

/** Skip / focus markers in a test file, with the line of each. */
export function skipMarkers(text: string, lang: TestLang): Array<{ marker: string; line: number }> {
  const out: Array<{ marker: string; line: number }> = [];
  for (const e of codeEntries(text, lang)) {
    for (const re of SKIPS[lang]) for (const m of e.text.matchAll(re)) out.push({ marker: m[0].replace(/\s*\($/, '').trim(), line: e.n });
  }
  return out;
}

/** The number of skip markers `after` has beyond `before`'s. */
export function skipMarkerIncrease(before: string | null, after: string, lang: TestLang): number {
  return skipMarkers(after, lang).length - (before === null ? 0 : skipMarkers(before, lang).length);
}

/** Replace literals so two assertions that differ only in what they expect compare equal. */
const shape = (line: string): string => line.trim()
  .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, 'S')
  .replace(/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, 'N')
  .replace(/\s+/g, ' ');

const isAssertionLine = (line: string, lang: TestLang): boolean => count([line], ASSERTIONS[lang]) > 0;

/** Lines in `a` that `b` does not account for (multiset difference), in order. */
function missingFrom(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const l of b) left.set(l.trim(), (left.get(l.trim()) ?? 0) + 1);
  const out: string[] = [];
  for (const l of a) {
    const k = l.trim();
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1); else out.push(l);
  }
  return out;
}

const clip = (s: string, n = 90): string => { const t = s.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Compare one test file before and after.
 *
 * @param before  the text before the change, or `null` when the file did not exist
 * @param after   the text after, or `null` when it was deleted
 * @param opts.testFailedEarlier  a `test` check had already failed this turn; only then is a changed expected value suspicious
 */
export function compareTest(file: string, before: string | null, after: string | null, opts: { testFailedEarlier?: boolean } = {}): TamperFinding[] {
  const rel = norm(file);
  const lang = testLangOf(rel);
  if (!lang || !isTestFile(rel)) return [];
  if (after === null) {
    return before === null ? [] : [{ kind: 'test-file-deleted', file: rel, detail: `${rel} was deleted${before ? ` (it held ${assertionCount(before, lang)} assertion(s))` : ''}` }];
  }
  const findings: TamperFinding[] = [];
  const markers = skipMarkers(after, lang);
  const beforeMarkers = before === null ? [] : skipMarkers(before, lang);
  if (markers.length > beforeMarkers.length) {
    const added = markers[markers.length - 1]!;
    findings.push({ kind: 'skip-marker-added', file: rel, line: added.line, detail: `${markers.length - beforeMarkers.length} skip/focus marker(s) added (${added.marker}) in ${rel}` });
  }
  if (before === null) return findings;

  const b = codeLines(before, lang); const a = codeLines(after, lang);
  const nBefore = count(b, ASSERTIONS[lang]); const nAfter = count(a, ASSERTIONS[lang]);
  if (nAfter < nBefore) findings.push({ kind: 'assertions-removed', file: rel, detail: `${rel} has ${nBefore - nAfter} fewer assertion(s) (${nBefore} before, ${nAfter} now)` });

  const weakBefore = count(b, WEAK[lang]); const weakAfter = count(a, WEAK[lang]);
  if (weakAfter > weakBefore && nAfter - weakAfter < nBefore - weakBefore) {
    findings.push({ kind: 'weak-matcher-added', file: rel, detail: `${rel}: ${weakAfter - weakBefore} weaker check(s) (truthy / not-null / always-true) replace stronger assertions` });
  }

  if (opts.testFailedEarlier) {
    const removed = missingFrom(b, a).filter(l => isAssertionLine(l, lang));
    const added = missingFrom(a, b).filter(l => isAssertionLine(l, lang));
    const used = new Set<number>();
    for (const r of removed) {
      const i = added.findIndex((x, idx) => !used.has(idx) && shape(x) === shape(r) && x.trim() !== r.trim());
      if (i < 0) continue;
      used.add(i);
      findings.push({ kind: 'expected-value-changed', file: rel, detail: `${rel}: an assertion's expected value changed while a check was failing: \`${clip(r)}\` -> \`${clip(added[i]!)}\`` });
      if (findings.filter(f => f.kind === 'expected-value-changed').length >= 3) break;
    }
  }
  return findings;
}

// ── Shell deletions ──────────────────────────────────────────────────

const DELETERS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'unlink', 'trash', 'trash-put']);
const TEST_DIR = /^(?:__tests__|tests?|spec|e2e)$/i;

/**
 * Test files (or whole test folders) a shell command deletes, as paths relative to `cwd`.
 * Only paths that exist are reported. Understands `rm`, `del`, `rd`, `Remove-Item`, `git rm`.
 */
export function deletedTestPaths(command: string, cwd: string): string[] {
  const hits = new Set<string>();
  for (const seg of splitCommands(command)) {
    const words = tokenize(seg);
    while (words.length && /^(?:sudo|call|time|command|env)$/i.test(words[0]!)) words.shift();
    if (!words.length) continue;
    const head = path.basename(words[0]!).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
    let args = words.slice(1);
    if (head === 'git') {
      const i = args.findIndex(a => !a.startsWith('-'));
      if (i < 0 || args[i]!.toLowerCase() !== 'rm') continue;
      args = args.slice(i + 1);
    } else if (!DELETERS.has(head)) continue;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      let target = a;
      if (/^-(?:path|literalpath)$/i.test(a)) { if (args[i + 1] === undefined) continue; target = args[++i]!; }
      else if (a.startsWith('-') || (head !== 'rm' && head !== 'git' && /^\/[a-z]$/i.test(a))) continue;
      // `del tests\a.test.js` names the same file on every OS, but on POSIX a
      // backslash is part of the file name, so the stat missed it there.
      target = target.replace(/\\/g, '/');
      const abs = path.resolve(cwd, target);
      let stat: fs.Stats | undefined;
      try { stat = fs.statSync(abs); } catch { stat = undefined; }
      if (!stat) {
        // A glob (`rm tests/*.test.ts`): judged by its pattern, if some file matches the convention.
        if (/[*?]/.test(target) && isTestFile(target.replace(/[*?]+/g, 'x'))) hits.add(norm(path.relative(cwd, abs)));
        continue;
      }
      if (stat.isDirectory()) { if (TEST_DIR.test(path.basename(abs))) hits.add(norm(path.relative(cwd, abs)) + '/'); continue; }
      if (isTestFile(norm(path.relative(cwd, abs)) || norm(abs))) hits.add(norm(path.relative(cwd, abs)));
    }
  }
  return [...hits];
}
