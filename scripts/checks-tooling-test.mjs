/**
 * Engineering tooling, tested offline: test-runner output read into counts
 * and failures (src/test-results.ts), the project's own formatter and linter
 * found from its config (src/style-tools.ts) and run through RunChecks, and
 * DependencyAudit's parsers and licence scan (src/tools/dependency-audit.ts).
 *
 * Why a script of its own: the runner fixtures are real captured output
 * (scripts/fixtures/checks — node:test, Vitest, pytest, npm audit, pip-audit,
 * paths rewritten to /work), and a parser is only as good as the bytes it was
 * shown. Formats that could not be captured on this machine (Jest, Mocha, go,
 * cargo, dotnet, govulncheck, cargo audit) are written from their documented
 * shapes and say so.
 *
 * Part of `npm test`. No model, no network: RunChecks runs local node scripts,
 * and DependencyAudit is exercised through its parsers, its licence scan and
 * an auditor that is not installed.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTestOutput, parseJUnitXml, formatTestSummary, detectStyleTools, styleChecks,
  parseNpmAudit, parsePipAudit, parseCargoAudit, parseDotnetVulnerable, parseGovulncheck,
  classifyLicense, scanNodeLicenses, scanPythonLicenses, findSitePackages, formatAudit, dependencyAudit,
  DEFAULT_ALLOWED_LICENSES, executeTool, runInContext, resetChecks, noteSourceChanged, checkProjectGate, buildToolDefs,
} from '../dist-test/test-exports.js';
import { gateChecks } from '../dist-test/test-exports.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', 'checks', name), 'utf8');

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ''}`); }
}
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aico-${tag}-`));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const names = (s) => s.failures.map(f => f.name);

console.log('\n── Test output: real captures ──');
{
  const tap = parseTestOutput(fixture('node-tap.txt'));
  ok(tap && tap.runner === 'node:test' && tap.passed === 2 && tap.failed === 2 && tap.skipped === 1, 'node:test TAP: counts from the # summary block', tap);
  ok(tap && names(tap).join() === 'subtracts,inner bad', 'node:test TAP: the failing leaves, not the suite whose child failed', tap && names(tap));
  ok(tap && /Expected values to be strictly equal: 2 !== 3/.test(tap.failures[0].message) && !/at TestContext/.test(tap.failures[0].message), 'node:test TAP: the assertion, not the stack', tap?.failures[0]);
  ok(tap && /math\.test\.mjs:4:1$/.test(tap.failures[0].file) && !/\\\\/.test(tap.failures[0].file), 'node:test TAP: location with YAML-doubled backslashes undone', tap?.failures[0].file);

  const spec = parseTestOutput(fixture('node-spec.txt'));
  ok(spec && spec.runner === 'node:test' && spec.passed === 2 && spec.failed === 2 && spec.skipped === 1, 'node:test spec: counts from the ℹ block', spec);
  ok(spec && names(spec).join() === 'subtracts,inner bad' && spec.failures[0].file === 'math.test.mjs:4:1', 'node:test spec: failures and their test-at location', spec?.failures);
  ok(spec && !/generatedMessage|at Test/.test(spec.failures.map(f => f.message).join()), 'node:test spec: the property dump and frames are dropped', spec?.failures.map(f => f.message));

  const vt = parseTestOutput(fixture('vitest-text.txt'));
  ok(vt && vt.runner === 'vitest' && vt.passed === 1 && vt.failed === 2 && vt.skipped === 1, 'vitest text: counts from the Tests line (ANSI stripped)', vt);
  ok(vt && names(vt).join() === 'cart > discount,top level fails' && vt.failures[0].file === 'a.test.js', 'vitest text: each failure once, with its file', vt?.failures);
  ok(vt && vt.failures[0].message === 'AssertionError: expected 9 to be 8 // Object.is equality', 'vitest text: the message stops before the diff', vt?.failures[0].message);

  const vj = parseTestOutput(fixture('vitest.json'));
  ok(vj && vj.runner === 'jest/vitest (json)' && vj.passed === 1 && vj.failed === 2 && vj.skipped === 1, 'vitest --reporter=json: exact counts', vj);
  ok(vj && vj.failures[0].file === '/work/vt/a.test.js' && /expected 9 to be 8/.test(vj.failures[0].message), 'vitest json: file and assertion', vj?.failures[0]);

  const junit = parseJUnitXml(fixture('vitest-junit.xml'));
  ok(junit && junit.passed === 1 && junit.failed === 2 && junit.skipped === 1, 'JUnit XML: counted from testcases', junit);
  ok(junit && /expected 9 to be 8/.test(junit.failures[0].message), 'JUnit XML: the failure message attribute', junit?.failures[0]);

  for (const f of ['pytest.txt', 'pytest-q.txt']) {
    const py = parseTestOutput(fixture(f));
    ok(py && py.runner === 'pytest' && py.passed === 1 && py.failed === 2 && py.skipped === 1, `${f}: counts from the summary line`, py);
    ok(py && names(py).join() === 'tests/test_calc.py::test_sub,tests/test_calc.py::test_err' && py.failures[1].message === 'ValueError: bad value', `${f}: the short test summary`, py?.failures);
  }
}

console.log('\n── Test output: documented formats ──');
{
  const jest = parseTestOutput([
    'FAIL src/cart.test.js',
    '  cart',
    '    ✓ totals (2 ms)',
    '    ✕ applies discount (3 ms)',
    '',
    '  ● cart › applies discount',
    '',
    '    expect(received).toBe(expected) // Object.is equality',
    '',
    '    Expected: 8',
    '    Received: 9',
    '',
    '      10 |   test("applies discount", () => {',
    '    > 11 |     expect(total(10, 0.1)).toBe(8);',
    '         |                            ^',
    '',
    '      at Object.toBe (src/cart.test.js:11:28)',
    '',
    'Test Suites: 1 failed, 1 total',
    'Tests:       1 failed, 1 skipped, 4 passed, 6 total',
    'Snapshots:   0 total',
    'Time:        0.512 s',
  ].join('\n'));
  ok(jest && jest.runner === 'jest' && jest.passed === 4 && jest.failed === 1 && jest.skipped === 1, 'Jest text: counts', jest);
  ok(jest && jest.failures[0].name === 'cart › applies discount' && jest.failures[0].file === 'src/cart.test.js'
    && /toBe\(expected\).*Expected: 8 Received: 9/.test(jest.failures[0].message) && !/11 \|/.test(jest.failures[0].message), 'Jest text: name, file, assertion, no source excerpt', jest?.failures[0]);

  const mocha = parseTestOutput([
    '  cart', '    ✔ totals', '    1) applies discount', '', '', '  4 passing (12ms)', '  2 pending', '  1 failing', '',
    '  1) cart', '       applies discount:', '     AssertionError [ERR_ASSERTION]: 9 == 8', '      at Context.<anonymous> (test/cart.js:9:12)', '',
  ].join('\n'));
  ok(mocha && mocha.runner === 'mocha' && mocha.passed === 4 && mocha.failed === 1 && mocha.skipped === 2, 'Mocha: passing/failing/pending', mocha);
  ok(mocha && mocha.failures[0].name === 'cart › applies discount' && /9 == 8/.test(mocha.failures[0].message), 'Mocha: the nested title and the assertion', mocha?.failures);

  const goV = parseTestOutput([
    '=== RUN   TestAdd', '--- PASS: TestAdd (0.00s)', '=== RUN   TestSplit', '=== RUN   TestSplit/empty',
    '--- FAIL: TestSplit (0.00s)', '    --- FAIL: TestSplit/empty (0.00s)', '        split_test.go:21: got 1 parts, want 0',
    '=== RUN   TestSkip', '--- SKIP: TestSkip (0.00s)', 'FAIL', 'FAIL\texample.com/strs\t0.004s',
    'ok  \texample.com/other\t0.002s', 'FAIL',
  ].join('\n'));
  ok(goV && goV.runner === 'go test' && !goV.unit && goV.passed === 1 && goV.failed === 1 && goV.skipped === 1, 'go test -v: a parent of a failing subtest is not a second failure', goV);
  ok(goV && goV.failures.length === 1 && goV.failures[0].name === 'TestSplit/empty' && goV.failures[0].file === 'split_test.go:21' && goV.failures[0].message === 'got 1 parts, want 0', 'go test -v: the subtest, its line, its message', goV?.failures);

  const go = parseTestOutput(['--- FAIL: TestAdd (0.00s)', '    add_test.go:9: 1+2 = 4, want 3', 'FAIL', 'FAIL\texample.com/m\t0.003s', 'ok  \texample.com/n\t(cached)', '# example.com/broken', 'broken/x.go:3:1: syntax error', 'FAIL\texample.com/broken [build failed]'].join('\n'));
  ok(go && go.unit === 'packages' && go.passed === 1 && go.failed === 2, 'go test without -v: counted in packages, said so', go);
  ok(go && names(go).join() === 'TestAdd,example.com/broken' && /build failed/.test(go.failures[1].message), 'go test without -v: the failing test and the package that did not build', go?.failures);
  ok(/1 passed, 2 failed, 0 skipped packages \(go test\)/.test(formatTestSummary(go)), 'and the summary names the unit', formatTestSummary(go));

  const cargo = parseTestOutput([
    'running 3 tests', 'test tests::adds ... ok', 'test tests::fails ... FAILED', 'test tests::later ... ignored', '',
    'failures:', '', '---- tests::fails stdout ----', "thread 'tests::fails' panicked at src/lib.rs:10:9:",
    'assertion `left == right` failed', '  left: 3', ' right: 4', 'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace', '',
    'failures:', '    tests::fails', '', 'test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s', '',
    '   Doc-tests x', 'running 2 tests', 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s',
  ].join('\n'));
  ok(cargo && cargo.passed === 3 && cargo.failed === 1 && cargo.skipped === 1, 'cargo test: unit and doc-test results summed', cargo);
  ok(cargo && cargo.failures[0].name === 'tests::fails' && cargo.failures[0].file === 'src/lib.rs:10:9' && /left == right.*left: 3 right: 4/.test(cargo.failures[0].message), 'cargo test: the panic location and assertion', cargo?.failures);

  const dotnet = parseTestOutput([
    '  Determining projects to restore...', '  Failed Calc.Tests.CalcTests.Adds [12 ms]', '  Error Message:', '   Assert.Equal() Failure: Values differ',
    'Expected: 4', 'Actual:   3', '  Stack Trace:', '     at Calc.Tests.CalcTests.Adds() in C:\\src\\Calc.Tests\\CalcTests.cs:line 12',
    '', 'Failed!  - Failed:     1, Passed:     5, Skipped:     1, Total:     7, Duration: 30 ms - Calc.Tests.dll (net8.0)',
    'Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: 3 ms - Other.Tests.dll (net8.0)',
  ].join('\n'));
  ok(dotnet && dotnet.passed === 7 && dotnet.failed === 1 && dotnet.skipped === 1, 'dotnet test: per-assembly lines summed', dotnet);
  ok(dotnet && dotnet.failures[0].name === 'Calc.Tests.CalcTests.Adds' && dotnet.failures[0].file === 'C:\\src\\Calc.Tests\\CalcTests.cs:12'
    && /Values differ Expected: 4 Actual: 3/.test(dotnet.failures[0].message), 'dotnet test: the assertion and the file:line from the stack', dotnet?.failures);

  const tape = parseTestOutput(['TAP version 13', '# adds', 'ok 1 should be equal', '', '1..1', '# tests 1', '# pass  1', '', '# ok'].join('\n'));
  ok(tape && tape.runner === 'tap' && tape.passed === 1 && tape.failed === 0, 'tape: a green run with no "# fail" line is still read', tape);

  ok(parseTestOutput("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.") === undefined, 'tsc output is not a test run (fails closed)');
  ok(parseTestOutput('/src/a.js\n  3:7  error  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)') === undefined, 'nor is eslint output');
  ok(parseTestOutput('vite v5 building for production...\n✓ 42 modules transformed.\nbuilt in 1.2s') === undefined, 'nor a build');

  const many = { runner: 'pytest', passed: 0, failed: 20, skipped: 0, failures: Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, message: 'boom' })) };
  const text = formatTestSummary(many);
  ok(text.split('\n').length === 1 + 8 * 2 + 1 && /12 more failure/.test(text), 'the summary lists at most 8 failures and counts the rest', text);
}

console.log('\n── Formatter and linter detection ──');
{
  const kinds = (dir) => detectStyleTools(dir).map(t => `${t.kind}:${t.tool}`).join(',');

  const empty = tmp('style-empty');
  ok(kinds(empty) === '', 'a folder with no config offers nothing');
  write(empty, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'node t.mjs' } }));
  ok(kinds(empty) === '', 'a package.json without formatter or linter config offers nothing — no tool is introduced');

  const js = tmp('style-js');
  write(js, 'package.json', JSON.stringify({ name: 'x', devDependencies: { prettier: '^3' } }));
  write(js, 'eslint.config.js', 'export default [];');
  const jsTools = detectStyleTools(js);
  ok(kinds(js) === 'format:prettier,lint:eslint', 'prettier (devDependency) and eslint (flat config) are found', kinds(js));
  ok(jsTools[0].check === 'npx --no prettier --check .' && jsTools[0].fix === 'npx --no prettier --write .', 'check mode by default; npx --no never downloads a missing tool', jsTools[0]);
  ok(jsTools[1].check === 'npx --no eslint .' && jsTools[1].fix === 'npx --no eslint . --fix', 'eslint check and fix', jsTools[1]);

  write(js, 'package.json', JSON.stringify({ name: 'x', scripts: { lint: 'eslint src', 'format:check': 'prettier -c .', format: 'prettier -w .' }, devDependencies: { prettier: '^3' } }));
  const scripted = detectStyleTools(js);
  ok(scripted[0].tool === 'script format:check' && scripted[0].check === 'npm run format:check' && scripted[0].fix === 'npm run format', "the project's own scripts outrank a guess at the tool's flags", scripted[0]);
  const gate = [{ name: 'lint', command: 'npm run lint', weight: 2 }];
  ok(styleChecks(js, gate, 'check').map(c => c.name).join() === 'format', 'a lint the gate already runs is not offered twice', styleChecks(js, gate, 'check'));
  ok(styleChecks(js, gate, 'fix').map(c => c.command).join(' | ') === 'npm run format | npx --no eslint . --fix', 'fix mode still offers the linter fix', styleChecks(js, gate, 'fix'));

  const biome = tmp('style-biome');
  write(biome, 'package.json', '{"name":"b"}');
  write(biome, 'biome.json', '{}');
  ok(kinds(biome) === 'format:biome,lint:biome', 'biome.json: biome formats and lints', kinds(biome));

  const py = tmp('style-py');
  write(py, 'pyproject.toml', '[project]\nname="x"\n\n[tool.ruff]\nline-length = 100\n');
  ok(kinds(py) === 'lint:ruff', 'ruff configured for linting is not evidence it formats', kinds(py));
  write(py, 'pyproject.toml', '[tool.ruff]\nline-length = 100\n\n[tool.ruff.format]\nquote-style = "double"\n');
  ok(kinds(py) === 'format:ruff format,lint:ruff', '[tool.ruff.format] is', kinds(py));
  write(py, 'pyproject.toml', '[tool.black]\nline-length = 88\n');
  const black = detectStyleTools(py)[0];
  ok(black.tool === 'black' && black.check === 'black --check .' && black.fix === 'black .', '[tool.black]: black, --check by default', black);
  fs.rmSync(path.join(py, 'pyproject.toml'));
  write(py, '.pre-commit-config.yaml', 'repos:\n  - repo: https://github.com/astral-sh/ruff-pre-commit\n    hooks:\n      - id: ruff\n      - id: ruff-format\n');
  ok(kinds(py) === 'format:ruff format,lint:ruff', 'a pre-commit hook is evidence too', kinds(py));

  const go = tmp('style-go');
  write(go, 'go.mod', 'module x\n');
  const gofmt = styleChecks(go, [], 'check')[0];
  ok(gofmt.name === 'format' && gofmt.command === 'gofmt -l .' && gofmt.failOnOutput === true, 'go.mod: gofmt -l, where any listed file is a failure', gofmt);
  ok(styleChecks(go, [], 'fix')[0].command === 'gofmt -w .' && !styleChecks(go, [], 'fix')[0].failOnOutput, 'and gofmt -w to fix', styleChecks(go, [], 'fix'));

  const rust = tmp('style-rust');
  write(rust, 'Cargo.toml', '[package]\nname = "x"\n');
  ok(detectStyleTools(rust)[0].check === 'cargo fmt --check', 'Cargo.toml: cargo fmt --check');

  const net = tmp('style-net');
  write(net, 'App.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
  ok(kinds(net) === '', 'a .NET project without .editorconfig has no house style to hold, so no dotnet format');
  write(net, '.editorconfig', 'root = true\n');
  ok(detectStyleTools(net)[0]?.check === 'dotnet format --verify-no-changes', 'with one, dotnet format --verify-no-changes');

  const mixed = tmp('style-mixed');
  write(mixed, 'package.json', '{"name":"m","prettier":{}}');
  write(mixed, 'pyproject.toml', '[tool.black]\n');
  ok(styleChecks(mixed, [], 'check').map(c => c.name).join() === 'format:prettier,format:black', 'two formatters in one repo are both offered, named apart', styleChecks(mixed, [], 'check'));
  for (const d of [empty, js, biome, py, go, rust, net, mixed]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n── RunChecks: structured results, the gate, format and fix ──');
{
  const proj = tmp('runchecks-struct');
  write(proj, 'index.ts', 'export const a = 1;\n');
  write(proj, 'math.test.mjs', [
    "import { test } from 'node:test';", "import assert from 'node:assert/strict';",
    "test('adds', () => { assert.equal(1 + 2, 3); });", "test('subtracts', () => { assert.equal(5 - 3, 3); });",
  ].join('\n'));
  // A runner that hides its failure behind exit 0, like a script ending in `|| true`.
  write(proj, 'swallow.mjs', "console.log('# tests 3\\n# pass 2\\n# fail 1\\nnot ok 3 - hidden\\n  ---\\n  error: \\'the hidden one\\'\\n  ...');");
  write(proj, 'none.mjs', "console.log('# tests 0\\n# pass 0\\n# fail 0');");
  write(proj, 'junit.mjs', [
    "import fs from 'node:fs';",
    "fs.writeFileSync('junit.xml', '<testsuites><testsuite name=\"s\"><testcase classname=\"Cart\" name=\"totals\"/><testcase classname=\"Cart\" name=\"tax\"><failure message=\"expected 7 got 5\"/></testcase></testsuite></testsuites>');",
    'process.exit(1);',
  ].join('\n'));
  write(proj, 'fmt-check.mjs', "import fs from 'node:fs'; if (!fs.existsSync('formatted.txt')) { console.log('index.ts needs formatting'); process.exit(1); }");
  write(proj, 'fmt-write.mjs', "import fs from 'node:fs'; fs.writeFileSync('formatted.txt', 'yes');");
  const setScripts = (scripts) => write(proj, 'package.json', JSON.stringify({ name: 'struct', type: 'module', scripts }));
  const run = (args) => executeTool('RunChecks', args);
  // The profile remembers detected commands; each scenario below wants a fresh read of package.json.
  const fresh = () => fs.rmSync(path.join(proj, '.aico'), { recursive: true, force: true });

  await runInContext({ cwd: proj, sessionId: 'checks-tooling' }, async () => {
    resetChecks();
    setScripts({ test: 'node --test math.test.mjs', 'format:check': 'node fmt-check.mjs', format: 'node fmt-write.mjs' }); fresh();
    noteSourceChanged(path.join(proj, 'index.ts'));
    const red = await run({});
    ok(/^FAILED — test did not pass/.test(red) && /0 passed|1 passed, 1 failed/.test(red), 'a failing node:test suite fails, with counts', red);
    ok(/✗ subtracts/.test(red) && /2 !== 3/.test(red) && !/at TestContext|node:internal/.test(red), 'the report leads with the failure and its assertion, no stack', red);
    ok(!/Raw output/.test(red), 'and no raw tail when the output was understood', red);
    ok(/Also configured, not gated: format \(npm run format:check\)/.test(red), 'the formatter the project configures is mentioned', red);
    const again = await run({ force: true });
    ok(!/Also configured/.test(again), 'once — not on every run', again);
    const gate = checkProjectGate(gateChecks());
    ok(!gate.ok && /✗ subtracts/.test(gate.message) && /\(1 passed, 1 failed, 0 skipped \(node:test\)\)/.test(gate.message), 'the gate quotes the failure and puts the counts last', gate.message);
    ok(gateChecks().every(c => c.name !== 'format'), 'format is not one of the gate\'s checks');

    setScripts({ test: 'node swallow.mjs' }); fresh();
    const swallowed = await run({ force: true });
    ok(/^FAILED/.test(swallowed) && /exited 0 but its runner reported 1 failure/.test(swallowed) && /✗ hidden/.test(swallowed), 'exit 0 with a reported failure is a failure — the counts decide', swallowed);

    write(proj, 'lintish.mjs', "console.log('1 failed, 2 passed in 0.10s');");
    setScripts({ typecheck: 'node lintish.mjs' }); fresh();
    const notTests = await run({ force: true });
    ok(/^PASSED/.test(notTests) && !/passed, 1 failed/.test(notTests), 'a non-test check is never read as a test run, whatever it prints', notTests);

    setScripts({ test: 'node none.mjs' }); fresh();
    const none = await run({ force: true });
    ok(/^PASSED/.test(none) && /ran no tests/.test(none), 'a green run that ran nothing passes, and says so', none);

    setScripts({ test: 'node --test --test-name-pattern=adds math.test.mjs' }); fresh();
    const green = await run({ force: true });
    ok(/^PASSED/.test(green) && /\n {6}1 passed, 0 failed/.test(green), 'a green run carries its counts under the PASS line', green);
    ok(green.split('\n').filter(l => /^(PASS|FAIL)\s/.test(l)).length === 1, 'and the PASS/FAIL line format the web panel parses is unchanged', green);

    setScripts({ test: 'node junit.mjs' }); fresh();
    const junit = await run({ force: true });
    ok(/^FAILED/.test(junit) && /1 passed, 1 failed, 0 skipped \(junit-xml\)/.test(junit) && /✗ Cart › tax/.test(junit) && /expected 7 got 5/.test(junit), 'a silent runner\'s fresh JUnit report is read', junit);

    setScripts({ test: 'node --test --test-name-pattern=adds math.test.mjs', 'format:check': 'node fmt-check.mjs', format: 'node fmt-write.mjs' }); fresh();
    const fmt = await run({ only: ['format'] });
    ok(/^FAILED — format did not pass/.test(fmt) && /needs formatting/.test(fmt) && !/PASS\s+test/.test(fmt), 'only: ["format"] runs the formatter in check mode, alone', fmt);
    ok(!fs.existsSync(path.join(proj, 'formatted.txt')), 'check mode changed nothing');
    const fixed = await run({ fix: true, only: ['format'] });
    ok(/^FIXED — ran 1 tool/.test(fixed) && fs.existsSync(path.join(proj, 'formatted.txt')), 'fix: true runs the fix form', fixed);
    const after = await run({ only: ['format'] });
    ok(/^PASSED/.test(after), 'and the check then passes', after);
    const nothing = await run({ only: ['nope'] });
    ok(/No check matches nope/.test(nothing) && /format/.test(nothing), 'an unknown name lists what exists, formatter included', nothing);
  });
  fs.rmSync(proj, { recursive: true, force: true });

  const bare = tmp('runchecks-bare');
  await runInContext({ cwd: bare, sessionId: 'checks-tooling-bare' }, async () => {
    const out = await executeTool('RunChecks', { fix: true });
    ok(/No formatter or linter with a fix mode is configured here/.test(out), 'fix in a project with no formatter changes nothing and says why', out);
  });
  fs.rmSync(bare, { recursive: true, force: true });
}

console.log('\n── DependencyAudit: auditor output ──');
{
  const npm = parseNpmAudit(JSON.parse(fixture('npm-audit.json')));
  ok(npm.counts.critical === 2 && npm.counts.high === 1 && !npm.counts.low, 'npm audit (real capture): severity counts from metadata', npm.counts);
  const lodash = npm.advisories.find(a => a.id === 'GHSA-35jh-r3h4-6jhm');
  ok(lodash && lodash.pkg === 'lodash' && lodash.severity === 'high' && lodash.fix === '>=4.17.21', 'an advisory with the version that fixes it', lodash);
  ok(!npm.advisories.some(a => a.pkg === 'mkdirp'), 'a package vulnerable only through another is not listed as its own advisory', npm.advisories.map(a => a.pkg));
  const minimist = npm.advisories.filter(a => a.pkg === 'minimist');
  ok(minimist.length === 2 && minimist.some(a => a.severity === 'critical'), 'every minimist advisory once, with its own severity', minimist);
  ok(minimist.find(a => a.id === 'GHSA-xvch-5gv4-984h')?.fix.startsWith('>=1.2.6'), 'an advisory npm split by OR-range branch keeps the newest fix (clears every branch)', minimist);
  ok(npm.advisories.find(a => a.id === 'GHSA-r5fr-rjxr-66jc')?.fix === '>4.17.23 (upgrade lodash@4.18.1)' || npm.advisories.find(a => a.id === 'GHSA-r5fr-rjxr-66jc')?.fix === '>4.17.23', 'a <= range is fixed by anything above it', npm.advisories.find(a => a.id === 'GHSA-r5fr-rjxr-66jc'));
  ok(parseNpmAudit({ error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.' } }).error === 'This command requires an existing lockfile.', 'npm\'s own error is surfaced');
  const v6 = parseNpmAudit({ advisories: { 1: { module_name: 'minimist', severity: 'critical', title: 'Prototype Pollution', github_advisory_id: 'GHSA-xvch-5gv4-984h', patched_versions: '>=1.2.6', findings: [{ version: '1.2.5' }] } }, metadata: { vulnerabilities: { critical: 1 } } });
  ok(v6.advisories[0].fix === '>=1.2.6' && v6.advisories[0].version === '1.2.5' && v6.counts.critical === 1, 'the npm v6 / pnpm advisories form', v6);

  const pip = parsePipAudit(JSON.parse(fixture('pip-audit.json')));
  const jinja = pip.advisories.filter(a => a.pkg === 'jinja2');
  ok(pip.counts.unknown === 2 && jinja.length > 3, 'pip-audit (real capture): vulnerable packages counted; pip-audit gives no severity, so none is invented', pip.counts);
  ok(new Set(pip.advisories.map(a => `${a.pkg}|${a.id}`)).size === pip.advisories.length, 'duplicate advisories (pip-audit repeats some) are listed once');
  ok(jinja.some(a => a.id === 'CVE-2019-10906' && a.fix === '>=2.10.1'), 'the CVE alias and the first fixed version', jinja);

  const cargo = parseCargoAudit({ vulnerabilities: { found: true, count: 1, list: [{ advisory: { id: 'RUSTSEC-2020-0071', package: 'time', title: 'Potential segfault in the time crate' }, versions: { patched: ['>=0.2.23'] }, package: { name: 'time', version: '0.1.45' } }] } });
  ok(cargo.advisories[0].id === 'RUSTSEC-2020-0071' && cargo.advisories[0].fix === '>=0.2.23' && cargo.advisories[0].version === '0.1.45', 'cargo audit --json (documented shape)', cargo);

  const dotnet = parseDotnetVulnerable({ version: 1, projects: [{ path: 'App.csproj', frameworks: [{ framework: 'net8.0', topLevelPackages: [{ id: 'Newtonsoft.Json', requestedVersion: '12.0.1', resolvedVersion: '12.0.1', vulnerabilities: [{ severity: 'High', advisoryurl: 'https://github.com/advisories/GHSA-5crp-9r3c-p9vr' }] }], transitivePackages: [{ id: 'System.Text.Encodings.Web', resolvedVersion: '4.5.0', vulnerabilities: [{ severity: 'Critical', advisoryurl: 'https://github.com/advisories/GHSA-ghhp-997w-qr28' }] }] }] }] });
  ok(dotnet.counts.high === 1 && dotnet.counts.critical === 1 && dotnet.advisories.some(a => a.id === 'GHSA-5crp-9r3c-p9vr'), 'dotnet list package --vulnerable --format json, transitive included', dotnet);

  const stream = [
    '{\n  "config": {\n    "protocol_version": "v1.0.0",\n    "scanner_name": "govulncheck"\n  }\n}',
    '{\n  "osv": {\n    "id": "GO-2022-1059",\n    "summary": "Denial of service via crafted Accept-Language header in golang.org/x/text/language",\n    "details": "braces { in a string } must not split"\n  }\n}',
    '{\n  "osv": {\n    "id": "GO-2023-1571",\n    "summary": "Denial of service in net/http"\n  }\n}',
    '{\n  "finding": {\n    "osv": "GO-2022-1059",\n    "fixed_version": "v0.3.8",\n    "trace": [\n      {\n        "module": "golang.org/x/text",\n        "version": "v0.3.7",\n        "package": "golang.org/x/text/language",\n        "function": "Parse"\n      }\n    ]\n  }\n}',
    '{\n  "finding": {\n    "osv": "GO-2023-1571",\n    "fixed_version": "v0.7.0",\n    "trace": [\n      {\n        "module": "golang.org/x/net",\n        "version": "v0.1.0"\n      }\n    ]\n  }\n}',
  ].join('\n');
  const gv = parseGovulncheck(stream);
  ok(gv.advisories.length === 2 && gv.advisories[0].id === 'GO-2022-1059' && gv.advisories[0].fix === 'v0.3.8' && gv.counts.unknown === 1, 'govulncheck -json: a stream of pretty-printed objects; called code first', gv);
  ok(/^\(imported, not called\)/.test(gv.advisories[1].title), 'an imported-but-unreached vulnerability is marked as such', gv.advisories[1]);
}

console.log('\n── DependencyAudit: licences ──');
{
  const allow = DEFAULT_ALLOWED_LICENSES;
  ok(classifyLicense('MIT', allow) === undefined && classifyLicense('Apache-2.0', allow) === undefined, 'permissive licences pass');
  ok(classifyLicense('(MIT OR GPL-3.0-only)', allow) === undefined, 'an OR with an allowed branch passes — the user may choose it');
  ok(classifyLicense('MIT AND GPL-3.0-only', allow) === 'copyleft', 'an AND with a copyleft part is copyleft');
  ok(classifyLicense('GPL-2.0-only WITH Classpath-exception-2.0', allow) === 'copyleft', 'a WITH exception is judged by its licence');
  ok(classifyLicense('LGPL-3.0-or-later', allow) === 'copyleft' && classifyLicense('MPL-2.0', allow) === 'copyleft', 'weak copyleft is listed for review too');
  ok(classifyLicense('UNKNOWN', allow) === 'unknown' && classifyLicense('SEE LICENSE IN LICENSE.txt', allow) === 'unknown' && classifyLicense('UNLICENSED', allow) === 'unknown', 'undeclared and private licences are unknown');
  ok(classifyLicense('Artistic-2.0', allow) === 'not on allowlist', 'anything else is simply not on the allowlist');
  ok(classifyLicense('Apache License 2.0', allow) === undefined && classifyLicense('MIT License', allow) === undefined, 'free-text spellings are mapped to SPDX');
  ok(classifyLicense('LGPL-3.0-only', ['MIT', 'LGPL-3.0-only']) === undefined, 'a configured allowlist replaces the default');

  const root = tmp('licences');
  const pkg = (rel, json) => write(root, path.join(rel, 'package.json'), JSON.stringify(json));
  pkg('node_modules/left-pad', { name: 'left-pad', version: '1.3.0', license: 'WTFPL' });
  pkg('node_modules/gpl-thing', { name: 'gpl-thing', version: '2.0.0', license: 'GPL-3.0-only' });
  pkg('node_modules/@scope/old', { name: '@scope/old', version: '0.1.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] });
  pkg('node_modules/@scope/obj', { name: '@scope/obj', version: '0.2.0', license: { type: 'ISC' } });
  pkg('node_modules/gpl-thing/node_modules/nolicense', { name: 'nolicense', version: '0.0.1' });
  pkg('node_modules/.pnpm/stored@1.0.0/node_modules/stored', { name: 'stored', version: '1.0.0', license: 'BSD-3-Clause' });
  write(root, 'node_modules/.bin/tool', '#!/bin/sh');
  const node = scanNodeLicenses(root);
  const byName = Object.fromEntries(node.map(p => [p.pkg, p.license]));
  ok(node.length === 6, 'node_modules: nested, scoped and pnpm-store packages are all read', node);
  ok(byName['@scope/old'] === 'MIT OR Apache-2.0' && byName['@scope/obj'] === 'ISC' && byName.nolicense === 'UNKNOWN', 'licenses arrays, license objects and missing licences', byName);

  const site = path.join(root, '.venv', 'Lib', 'site-packages');
  write(site, 'requests-2.31.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: requests\nVersion: 2.31.0\nLicense: Apache 2.0\nClassifier: License :: OSI Approved :: Apache Software License\n\nlong description');
  write(site, 'psycopg2-2.9.9.dist-info/METADATA', 'Metadata-Version: 2.1\nName: psycopg2\nVersion: 2.9.9\nLicense: LGPL with exceptions\nClassifier: License :: OSI Approved :: GNU Library or Lesser General Public License (LGPL)\n\n');
  write(site, 'modern-1.0.dist-info/METADATA', 'Metadata-Version: 2.4\nName: modern\nVersion: 1.0\nLicense-Expression: MIT\n\n');
  write(site, 'fulltext-1.0.dist-info/METADATA', `Metadata-Version: 2.1\nName: fulltext\nVersion: 1.0\nLicense: ${'Permission is hereby granted, free of charge, '.repeat(4)}\nClassifier: License :: OSI Approved :: MIT License\n\n`);
  write(site, 'bare-0.1.dist-info/METADATA', 'Metadata-Version: 2.1\nName: bare\nVersion: 0.1\n\n');
  ok(findSitePackages(root) === site, 'the project virtualenv is found (Windows layout)');
  const py = Object.fromEntries(scanPythonLicenses(site).map(p => [p.pkg, p.license]));
  ok(py.requests === 'Apache-2.0' && py.modern === 'MIT' && py.fulltext === 'MIT' && py.bare === 'UNKNOWN' && /LGPL/.test(py.psycopg2), 'dist-info: License-Expression, short License, classifiers when License is full text', py);

  const report = await dependencyAudit({ ecosystems: ['nonexistent'] }, { root });
  ok(/nonexistent \(nonexistent\): skipped — unknown ecosystem/.test(report), 'an unknown ecosystem is reported, not run', report);
  ok(/Licences: 11 installed packages \(node_modules 6, python 5\); 4 for review/.test(report), 'the licence scan covers node_modules and the venv', report);
  ok(/GPL-3\.0-only\s+gpl-thing@2\.0\.0\s+copyleft/.test(report) && /UNKNOWN\s+nolicense@0\.0\.1\s+unknown/.test(report) && /psycopg2@2\.9\.9\s+copyleft/.test(report), 'copyleft and unknown licences are listed, copyleft first', report);
  ok(/Allowlist: default/.test(report) && /Nothing is blocked/.test(report), 'it says where the allowlist came from, and that nothing is blocked', report);
  const configured = await dependencyAudit({ ecosystems: ['nonexistent'] }, { root, allowLicenses: [...allow, 'GPL-3.0-only', 'LGPL'] });
  ok(!/gpl-thing/.test(configured) && /from settings dependencyAudit\.allowLicenses/.test(configured), 'a configured allowlist is honoured', configured);
  const perCall = await dependencyAudit({ ecosystems: ['nonexistent'], allow: ['MIT'] }, { root });
  ok(/left-pad@1\.3\.0\s+not on allowlist/.test(perCall) && /as given for this run/.test(perCall), 'allow per call replaces both', perCall);

  const missing = await dependencyAudit({ ecosystems: ['cargo'], licenses: false }, { root });
  ok(/cargo \(cargo audit\): (missing — cargo audit is not installed; `cargo install cargo-audit`|error)/.test(missing), 'an auditor that is not installed is reported with how to install it, never installed', missing);
  fs.rmSync(root, { recursive: true, force: true });

  const text = formatAudit([{ ecosystem: 'npm', tool: 'npm audit', status: 'ok', counts: { critical: 1 }, advisories: Array.from({ length: 14 }, (_, i) => ({ pkg: `p${i}`, severity: i === 13 ? 'critical' : 'low', id: `GHSA-${i}`, title: 't', fix: '>=1' })) }], undefined);
  ok(/critical\s+p13/.test(text.split('\n')[3]) && /4 more; run npm audit/.test(text), 'advisories are sorted worst first and capped at 10', text);
}

console.log('\n── DependencyAudit is deferred ──');
{
  const lean = buildToolDefs({ settings: {}, loadedGroups: new Set() });
  ok(!lean.some(d => d.name === 'DependencyAudit'), 'its schema is not sent by default');
  ok(/- audit: dependency vulnerabilities and licences — DependencyAudit/.test(lean.find(d => d.name === 'LoadTools').description), 'LoadTools names it in the audit group');
  ok(buildToolDefs({ settings: {}, loadedGroups: new Set(['audit']) }).some(d => d.name === 'DependencyAudit'), 'loading the group offers it');
}

console.log(`\n  CHECKS TOOLING: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
