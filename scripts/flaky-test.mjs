/**
 * Flaky-test detection, tested offline (ADR 0034, src/flaky.ts and RunChecks).
 *
 * Why a script of its own: the behaviour is a loop of real processes. A test
 * that fails the first time it runs and passes the second has to be a real test
 * file run by a real runner, or the classification (flaky vs failed twice) is
 * only ever asserted against a mock of itself. The narrowing per runner is pure
 * and checked as strings; the integration runs `node --test` for real.
 *
 * Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  planRerun, classifyRerun, shellArg, recordFlaky, knownFlaky, flakyFile,
  executeTool, runInContext, resetChecks, noteSourceChanged, checkProjectGate, gateChecks, parseTestOutput,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ''}`); }
}
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aico-${tag}-`));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const summary = (runner, failures, extra = {}) => ({ runner, passed: 3, failed: failures.length, skipped: 0, failures, ...extra });
const f = (name, file) => ({ name, ...(file ? { file } : {}), message: 'x' });

console.log('\n── Narrowing a failed run, per runner ──');
{
  const vt = planRerun('npx vitest run', summary('vitest', [f('cart > totals tax', 'src/cart.test.ts'), f('cart > rounds', 'src/cart.test.ts')]), 4000);
  ok(vt?.basis === 'tests' && /^npx vitest run src\/cart\.test\.ts -t /.test(vt.command) && /totals tax\|rounds/.test(vt.command), 'vitest: the file and a -t pattern of the leaf names', vt);
  const jestNpm = planRerun('npm run test:unit', summary('jest', [f('adds', 'a.test.js')]), 4000);
  ok(/^npm run test:unit -- a\.test\.js -t adds$/.test(jestNpm?.command ?? ''), 'jest through an npm script: flags go after --', jestNpm);
  const dashed = planRerun('npm test -- --coverage', summary('jest', [f('adds', 'a.test.js')]), 4000);
  ok(!/ -- .* -- /.test(dashed?.command ?? ''), 'an existing -- is not doubled', dashed);
  const py = planRerun('pytest -q', summary('pytest', [f('tests/test_x.py::test_y', 'tests/test_x.py')]), 4000);
  ok(py?.command === 'pytest -q tests/test_x.py::test_y' && py.basis === 'tests', 'pytest: the node id', py);
  const go = planRerun('go test ./...', summary('go test', [f('TestA/sub'), f('TestB')]), 4000);
  ok(go?.command === 'go test ./... -count=1 -run "^(TestA|TestB)"', 'go: -run with the top-level names, cache bypassed', go);
  const net = planRerun('dotnet test', summary('dotnet test', [f('Shop.CartTests.Totals')]), 4000);
  ok(/--filter "FullyQualifiedName~Shop\.CartTests\.Totals"/.test(net?.command ?? ''), 'dotnet: a FullyQualifiedName filter', net);
  const mvn = planRerun('mvn test', summary('junit-xml', [f('com.shop.CartTest › totals')]), 4000);
  ok(/^mvn test -Dtest=CartTest#totals -Dsurefire\.failIfNoSpecifiedTests=false$/.test(mvn?.command ?? ''), 'maven: -Dtest=Class#method', mvn);
  const gradle = planRerun('./gradlew test', summary('junit-xml', [f('com.shop.CartTest › totals')]), 4000);
  ok(/--tests "\*CartTest"|--tests \*CartTest/.test(gradle?.command ?? ''), 'gradle: --tests', gradle);
  const php = planRerun('vendor/bin/phpunit', summary('junit-xml', [f('CartTest › testTotals')]), 4000);
  ok(/--filter testTotals$/.test(php?.command ?? ''), 'phpunit: --filter', php);
  const nodeT = planRerun('node --test', summary('node:test', [f('adds', 'tests/a.test.mjs:4:1')]), 4000);
  ok(nodeT?.command === 'node --test tests/a.test.mjs', 'node:test: the file, location suffix stripped', nodeT);
  const cargo = planRerun('cargo test', summary('cargo test', [f('cart::tests::totals')]), 4000);
  ok(cargo?.command === 'cargo test cart::tests::totals', 'cargo: the test path', cargo);
  const mocha = planRerun('npm test', summary('mocha', [f('Cart totals')]), 4000);
  ok(/ -- --grep "Cart totals"$/.test(mocha?.command ?? ''), 'mocha: --grep', mocha);

  const unnamed = planRerun('make test', undefined, 4000);
  ok(unnamed?.basis === 'whole-check' && unnamed.command === 'make test', 'no failing tests named, quick first run: the whole check once', unnamed);
  ok(planRerun('make test', undefined, 130_000) === undefined, 'no failing tests named, slow first run: not repeated', planRerun('make test', undefined, 130_000));
  ok(planRerun('npm test', summary('jest', [], { failed: 0 }), 4000)?.basis === 'whole-check', 'counts without a failure list fall back to the whole check', null);

  const evil = shellArg('x"; rm -rf / #`$(id)');
  ok(!/["`$]/.test(evil.slice(1, -1)) && evil.startsWith('"') && evil.endsWith('"'), 'a test name cannot end its quoting or start a substitution', evil);
  ok(shellArg('tests/a.py::t') === 'tests/a.py::t', 'a plain id is left alone', null);
}

console.log('\n── Classification ──');
{
  const plan = { basis: 'tests', command: 'x', tests: ['a', 'b'] };
  const passedAll = classifyRerun(plan, ['a', 'b'], { passed: true, tests: { runner: 'x', passed: 2, failed: 0, skipped: 0, failures: [] } });
  ok(passedAll.outcome === 'flaky' && passedAll.flaky.join() === 'a,b', 'failed then passed: flaky, with the names', passedAll);
  const still = classifyRerun(plan, ['a', 'b'], { passed: false, tests: { runner: 'x', passed: 0, failed: 2, skipped: 0, failures: [f('a'), f('b')] } });
  ok(still.outcome === 'failed' && still.flaky.length === 0 && still.stillFailing.length === 2, 'failed twice: a real failure', still);
  const mixed = classifyRerun(plan, ['a', 'b'], { passed: false, tests: { runner: 'x', passed: 1, failed: 1, skipped: 0, failures: [f('b')] } });
  ok(mixed.outcome === 'failed' && mixed.flaky.join() === 'a' && mixed.stillFailing.join() === 'b', 'one passed, one failed again: the first is flaky, the second real', mixed);
  const blind = classifyRerun(plan, ['a'], { passed: true, tests: undefined });
  ok(blind.outcome === 'unclassified', 'a narrowed re-run that read back no tests proves nothing — never a pass', blind);
  const ranNone = classifyRerun(plan, ['a'], { passed: true, tests: { runner: 'x', passed: 0, failed: 0, skipped: 0, failures: [] } });
  ok(ranNone.outcome === 'unclassified', 'a narrowed re-run that ran zero tests (the filter matched nothing) is unclassified', ranNone);
  const whole = classifyRerun({ basis: 'whole-check', command: 'x', tests: [] }, [], { passed: true, tests: undefined });
  ok(whole.outcome === 'flaky', 'a whole-check re-run that passes is flaky even with nothing to name', whole);
}

console.log('\n── History: append-only, per project, tolerant ──');
{
  const proj = tmp('flaky-history');
  ok(knownFlaky(proj).size === 0, 'a project with no history knows no flaky tests', null);
  recordFlaky(proj, [{ at: 1, test: 'cart totals', check: 'test' }]);
  recordFlaky(proj, [{ at: 2, test: 'cart totals', check: 'test' }, { at: 2, test: 'login', check: 'test' }]);
  const known = knownFlaky(proj);
  ok(known.get('cart totals')?.count === 2 && known.get('login')?.count === 1 && known.get('cart totals').last === 2, 'observations accumulate per test', [...known]);
  const file = flakyFile(proj);
  ok(file.startsWith(process.env.AICO_HOME) && fs.readFileSync(file, 'utf8').trim().split('\n').length === 3, 'one JSONL line per observation, under the isolated store', file);
  fs.appendFileSync(file, '{"torn": \n');
  ok(knownFlaky(proj).get('login')?.count === 1, 'a torn line from a crashed append does not lose the rest', null);
  ok(flakyFile(proj) !== flakyFile(tmp('flaky-other')), 'another project has its own file', null);
  recordFlaky(proj, []);
  ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length === 4, 'recording nothing writes nothing', null);
}

console.log('\n── RunChecks: a real flaky test, a real failure, a pass ──');
{
  const proj = tmp('flaky-run');
  // Fails the first time it ever runs in this directory, passes after: a flake by construction.
  const flakyTest = [
    "import { test } from 'node:test';",
    "import fs from 'node:fs';",
    "fs.appendFileSync('runs.txt', 'x');",
    "test('sometimes', () => {",
    "  const n = fs.existsSync('count.txt') ? Number(fs.readFileSync('count.txt', 'utf8')) : 0;",
    "  fs.writeFileSync('count.txt', String(n + 1));",
    "  if (n === 0) throw new Error('timing-dependent boom');",
    '});',
    "test('always fine', () => {});",
  ].join('\n');
  const alwaysFails = "import fs from 'node:fs'; fs.appendFileSync('runs.txt', 'x'); import { test } from 'node:test'; test('broken', () => { throw new Error('really broken'); }); test('fine', () => {});";
  const alwaysPasses = "import fs from 'node:fs'; fs.appendFileSync('runs.txt', 'x'); import { test } from 'node:test'; test('fine', () => {});";
  // Every test file appends to runs.txt when loaded, to prove how many times the runner ran it.
  const setup = (testFile) => {
    write(proj, 'flaky.test.mjs', testFile);
    write(proj, 'package.json', JSON.stringify({ name: 'flaky', type: 'module', scripts: { test: 'node --test' } }));
    write(proj, 'index.ts', 'export const a = 1;\n');
    for (const gone of ['count.txt', 'runs.txt']) fs.rmSync(path.join(proj, gone), { force: true });
    fs.rmSync(path.join(proj, '.aico'), { recursive: true, force: true });
  };
  const runs = () => (fs.existsSync(path.join(proj, 'runs.txt')) ? fs.readFileSync(path.join(proj, 'runs.txt'), 'utf8').length : 0);
  const events = [];
  const sessionLog = { events: () => events, record: (type, data) => events.push({ seq: events.length + 1, type, timestamp: Date.now(), data }) };
  const ctx = { cwd: proj, sessionId: 'flaky-run', sessionLog, settings: { completionGate: { security: false } } };
  const run = (args = {}) => executeTool('RunChecks', { force: true, ...args });

  await runInContext(ctx, async () => {
    resetChecks();
    setup(flakyTest);
    noteSourceChanged(path.join(proj, 'index.ts'));
    const flaky = await run();
    ok(/^FLAKY — test failed and then passed on a re-run/.test(flaky), 'a test that fails once and passes on the re-run: the verdict says FLAKY', flaky);
    ok(!/^PASSED/m.test(flaky) && /FLAKY\s+test\s/.test(flaky), 'it is not reported as a pass, and the check line says FLAKY', flaky);
    ok(/sometimes/.test(flaky) && /Do not retry until green/.test(flaky) && /quarantine/.test(flaky), 'the flaky test is named, with what to do and what not to', flaky);
    ok(runs() === 2, 'the runner ran twice: once, and once more', runs());
    const gate = checkProjectGate(gateChecks());
    ok(!gate.ok && /FLAKY: sometimes failed, then passed on a re-run/.test(gate.message), 'the gate does not treat it as green, and says why', gate);
    const rec = events.filter(e => e.type === 'check/run').pop()?.data;
    ok(rec?.outcome === 'flaky' && rec.exitCode === 1 && rec.retry?.basis === 'tests' && rec.retry.passed === true && rec.retry.flaky?.join() === 'sometimes', 'the log records outcome flaky, the first exit code and the retry', rec);
    ok(rec?.tests?.failed === 1 && rec.tests.runner === 'tap' || rec?.tests?.runner === 'node:test', 'with the counts of the first run', rec?.tests);
    ok([...knownFlaky(proj)].some(([n]) => n === 'sometimes'), 'and remembers it for next time', [...knownFlaky(proj)]);

    // Same project, flaky again: the history makes it a known flake.
    fs.rmSync(path.join(proj, 'count.txt'), { force: true });
    const again = await run();
    ok(/known flaky: seen 1 time before/.test(again), 'the second time, it is flagged as known flaky', again);

    setup(alwaysFails);
    const real = await run();
    ok(/^FAILED — test did not pass/.test(real) && /✗ broken/.test(real) && /failed again, so this is a real failure/.test(real), 'a test that fails twice is a real failure, reported as before', real);
    ok(runs() === 2, 'and was re-run exactly once', runs());
    const realRec = events.filter(e => e.type === 'check/run').pop()?.data;
    ok(realRec?.outcome === 'failed' && realRec.retry?.passed === false, 'the log says failed, with the retry that did not help', realRec);

    setup(alwaysPasses);
    const green = await run();
    ok(/^PASSED/.test(green) && runs() === 1, 'a pass is run once and is a pass', { green, runs: runs() });
    const greenRec = events.filter(e => e.type === 'check/run').pop()?.data;
    ok(greenRec?.outcome === 'passed' && greenRec.exitCode === 0 && !greenRec.retry && greenRec.command === 'npm run test', 'its record carries the exit code and no retry', greenRec);

    setup(flakyTest);
    const off = await run({ retryFlaky: false });
    ok(/^FAILED — test did not pass/.test(off) && runs() === 1, 'retryFlaky: false gives the single raw run', { off, runs: runs() });
  });
  fs.rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
