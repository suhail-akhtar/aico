/**
 * The `refactor` tool group, tested offline (src/tools/refactor.ts,
 * src/refactor/*): TypeScript rename across files — re-exports, namespace and
 * aliased imports, shorthand properties, and the string and lookalike that
 * must NOT change — the dry run → apply → checks → rollback sequence, a stale
 * plan refused, path scopes and the sandbox holding for a planned apply, and
 * an ast-grep rewrite.
 *
 * Why a script of its own: every case builds a small real project on disk and
 * runs the real language service, the real ast-grep binary and the project's
 * own checks (`npm run test` on a tiny script), which is what the tools do in
 * use. The ast-grep cases are skipped, and say so, where the binary is absent
 * (it is an optional dependency).
 *
 * Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runInContext, executeRefactor, executeCodeRewrite, executeCodeSearch, findAstGrep,
  plannedWriteTargets, isApplyCall, planKey, resetRefactorPlans, resetChecks,
  snapshotFiles, sealSnapshot, restoreCheckpoint, installWritePathsGuard, ToolPipeline,
  groupOf, buildToolDefs, checkProjectGate, gateChecks,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const tmp = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `aico-${tag}-`)));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
let sessionN = 0;
const inProject = (dir, fn) => runInContext({ cwd: dir, sessionId: `refactor-test-${++sessionN}` }, async () => { resetRefactorPlans(); resetChecks(); return fn(); });

/** A small TS project with every shape a rename must handle, and checks that can be turned red. */
function tsProject() {
  const dir = tmp('refactor-ts');
  write(dir, 'package.json', JSON.stringify({ name: 'p', private: true, type: 'module', scripts: { test: 'node check.mjs' } }));
  write(dir, 'check.mjs', "import fs from 'fs';\nif (fs.existsSync('RED')) { console.error('not ok 1 - forced red'); process.exit(1); }\nconsole.log('ok');\n");
  write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true }, include: ['src'] }));
  write(dir, 'src/money.ts', "export function formatPrice(a: number): string {\n  return '$' + a.toFixed(2);\n}\nexport function formatPriceRange(a: number, b: number): string {\n  return formatPrice(a) + '-' + formatPrice(b);\n}\n");
  write(dir, 'src/index.ts', "export { formatPrice } from './money';\nexport { formatPriceRange } from './money';\n");
  write(dir, 'src/a/use-barrel.ts', "import { formatPrice } from '../index';\nexport const x = formatPrice(1);\n// formatPrice is documented here\nexport const event = 'formatPrice';\n");
  write(dir, 'src/a/use-ns.ts', "import * as money from '../money';\nexport const y = money.formatPrice(2);\n");
  write(dir, 'src/b/use-alias.ts', "import { formatPrice as fp } from '../money';\nexport const z = fp(3);\nexport const api = { formatPrice: fp };\n");
  write(dir, 'src/b/use-short.ts', "import { formatPrice } from '../money';\nexport const helpers = { formatPrice };\n");
  write(dir, 'src/b/untouched.ts', "export const formatPriceLabel = 'Price';\n");
  return dir;
}

console.log('\n── Checkpoint: a standalone snapshot for one apply ──');
{
  const dir = tmp('refactor-cp');
  write(dir, 'a.txt', 'one');
  const cp = await snapshotFiles('t', [path.join(dir, 'a.txt'), path.join(dir, 'new.txt')]);
  write(dir, 'a.txt', 'two'); write(dir, 'new.txt', 'created');
  await sealSnapshot(cp);
  const report = await restoreCheckpoint(cp);
  ok(read(dir, 'a.txt') === 'one' && !fs.existsSync(path.join(dir, 'new.txt')), 'restore puts the edited file back and removes the created one', report);
  ok(/-r$/.test(cp.id), 'its id cannot collide with the turn checkpoint\'s', cp.id);
}

console.log('\n── Plan identity and the guard\'s view ──');
{
  ok(isApplyCall('CodeRewrite', { dryRun: false }) && !isApplyCall('CodeRewrite', {}) && !isApplyCall('CodeRewrite', { dryRun: true }), 'CodeRewrite applies only with dryRun:false');
  ok(isApplyCall('Refactor', { action: 'rename', dryRun: false }) && !isApplyCall('Refactor', { action: 'findReferences', dryRun: false }), 'findReferences never counts as a write');
  ok(planKey('Refactor', { action: 'rename', symbol: 'a', dryRun: true }) === planKey('Refactor', { symbol: 'a', action: 'rename', dryRun: false, onFail: 'rollback' }),
    'a plan\'s identity ignores dryRun/onFail and argument order');
  ok(plannedWriteTargets('Write', { file_path: 'x' }) === undefined && plannedWriteTargets('CodeRewrite', { pattern: 'a' }) === undefined, 'not an apply: nothing for the guard to check');
  ok(groupOf('CodeSearch') === 'refactor' && groupOf('CodeRewrite') === 'refactor' && groupOf('Refactor') === 'refactor', 'the three tools are one deferred group');
  const defs = buildToolDefs({ loadedGroups: new Set() });
  const loader = defs.find(d => d.name === 'LoadTools');
  ok(!defs.some(d => ['CodeSearch', 'CodeRewrite', 'Refactor'].includes(d.name)) && /- refactor: .*instead of many Edits.*CodeSearch, CodeRewrite, Refactor/.test(loader?.description ?? ''),
    'unloaded: no schemas sent, one LoadTools line that says when to load it', loader?.description);
  const planDefs = buildToolDefs({ planMode: true });
  ok(planDefs.some(d => d.name === 'CodeSearch') && !planDefs.some(d => d.name === 'CodeRewrite' || d.name === 'Refactor'), 'plan mode offers the search, not the writers');
}

console.log('\n── Refactor rename: TypeScript language service across files ──');
{
  const dir = tsProject();
  const untouched = read(dir, 'src/b/untouched.ts');
  await inProject(dir, async () => {
    const refs = await executeRefactor({ action: 'findReferences', path: 'src/money.ts', symbol: 'formatPrice' });
    ok(/use-ns\.ts:2/.test(refs) && /use-alias\.ts:1/.test(refs) && /index\.ts:1/.test(refs) && !/untouched/.test(refs), 'findReferences follows the barrel, the namespace import and the alias', refs);

    const dry = await executeRefactor({ action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount' });
    ok(/^DRY RUN/.test(dry) && read(dir, 'src/money.ts').includes('function formatPrice('), 'the default is a dry run that writes nothing', dry.slice(0, 300));
    ok(/6 file\(s\)/.test(dry) && /First \d+ hunk/.test(dry), 'the plan lists files and counts and shows the first hunks', dry);

    const applied = await executeRefactor({ action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount', dryRun: false });
    ok(/^APPLIED/.test(applied) && /PASSED/.test(applied), 'apply after the dry run lands and runs the project\'s checks', applied);
    ok(read(dir, 'src/money.ts').includes('function formatAmount(') && read(dir, 'src/money.ts').includes('formatAmount(a) + \'-\' + formatAmount(b)'), 'the declaration and its in-file uses are renamed');
    ok(read(dir, 'src/money.ts').includes('function formatPriceRange('), 'a lookalike name (formatPriceRange) is left alone');
    ok(read(dir, 'src/index.ts').startsWith("export { formatAmount } from './money';"), 're-export renamed, not aliased back to the old public name', read(dir, 'src/index.ts'));
    ok(read(dir, 'src/a/use-barrel.ts').includes("import { formatAmount } from '../index'") && read(dir, 'src/a/use-barrel.ts').includes('formatAmount(1)'), 'importer through the barrel renamed');
    ok(read(dir, 'src/a/use-barrel.ts').includes("event = 'formatPrice'") && read(dir, 'src/a/use-barrel.ts').includes('// formatPrice is documented'), 'string literal and comment NOT renamed');
    ok(read(dir, 'src/a/use-ns.ts').includes('money.formatAmount(2)'), 'namespace-qualified use renamed');
    ok(read(dir, 'src/b/use-alias.ts').includes('{ formatAmount as fp }') && read(dir, 'src/b/use-alias.ts').includes('{ formatPrice: fp }'), 'aliased import renamed at the source side; an unrelated object key is not', read(dir, 'src/b/use-alias.ts'));
    ok(read(dir, 'src/b/use-short.ts').includes('{ formatPrice: formatAmount }'), 'a shorthand property keeps its key', read(dir, 'src/b/use-short.ts'));
    ok(read(dir, 'src/b/untouched.ts') === untouched, 'a file with no reference is byte-identical');
    const gate = checkProjectGate(gateChecks(dir));
    ok(gate.ok, 'the completion gate is satisfied by the checks the apply ran', gate);

    const rolled = await executeRefactor({ action: 'rollback' });
    ok(/^ROLLED BACK/.test(rolled) && read(dir, 'src/money.ts').includes('function formatPrice(') && read(dir, 'src/index.ts').startsWith('export { formatPrice }'), 'rollback restores every file of the apply', rolled);
    const again = await executeRefactor({ action: 'rollback' });
    ok(/Nothing to roll back/.test(again), 'a second rollback has nothing to do');
  });
}

console.log('\n── Apply only what was shown ──');
{
  const dir = tsProject();
  await inProject(dir, async () => {
    const blind = await executeRefactor({ action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount', dryRun: false });
    ok(/^NOT APPLIED — its plan has not been shown/.test(blind) && read(dir, 'src/money.ts').includes('function formatPrice('), 'an apply with no dry run first shows the plan and writes nothing', blind.slice(0, 200));
    // The refusal showed it, so the same apply now lands.
    write(dir, 'src/c/new-user.ts', "import { formatPrice } from '../money';\nexport const w = formatPrice(9);\n");
    const stale = await executeRefactor({ action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount', dryRun: false });
    ok(/^NOT APPLIED — the files changed since/.test(stale) && /new-user\.ts/.test(stale), 'a plan that changed since it was shown is re-shown, not applied', stale.slice(0, 400));
    const now = await executeRefactor({ action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount', dryRun: false });
    ok(/^APPLIED/.test(now) && read(dir, 'src/c/new-user.ts').includes('formatAmount(9)'), 'the re-shown plan then applies, including the new file');
  });
}

console.log('\n── Red checks: report by default, roll back on request ──');
{
  const dir = tsProject();
  write(dir, 'RED', '');
  await inProject(dir, async () => {
    const args = { action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount' };
    await executeRefactor(args);
    const red = await executeRefactor({ ...args, dryRun: false });
    ok(/^APPLIED/.test(red) && /FAILED/.test(red) && /Refactor \{"action":"rollback"\}/.test(red) && read(dir, 'src/money.ts').includes('formatAmount'), 'red checks are reported with the one-call rollback, change kept', red);
    await executeRefactor({ action: 'rollback' });
    await executeRefactor(args);
    const undone = await executeRefactor({ ...args, dryRun: false, onFail: 'rollback' });
    ok(/ROLLED BACK — the checks failed/.test(undone) && read(dir, 'src/money.ts').includes('function formatPrice('), 'onFail:"rollback" undoes the change when the checks are red', undone.slice(-300));
  });
}

console.log('\n── Write scopes and the sandbox hold for a planned apply ──');
{
  const dir = tsProject();
  await inProject(dir, async () => {
    const args = { action: 'rename', path: 'src/money.ts', symbol: 'formatPrice', newName: 'formatAmount' };
    await executeRefactor(args);
    const targets = plannedWriteTargets('Refactor', { ...args, dryRun: false });
    ok(Array.isArray(targets) && targets.length === 6, 'the guard sees every file the apply would write', targets);
    const pipeline = new ToolPipeline();
    installWritePathsGuard(pipeline, { agentId: 'bounded', bounds: [{ label: 'the agent', root: dir, globs: ['src/a/**'] }], cwd: () => dir });
    let ran = false;
    const call = (a) => pipeline.execute({ callId: 'c1', name: 'Refactor', arguments: a, agentId: 'bounded', state: new Map() }, async () => { ran = true; return 'ran'; });
    const denied = await call({ ...args, dryRun: false });
    ok(denied.denied && !ran && /outside this agent's write paths/.test(JSON.stringify(denied.outcome.result)), 'an apply reaching outside paths.write is refused before it runs', denied.outcome);
    const dry = await call({ ...args });
    ok(!dry.denied && ran, 'a dry run is not a write and is not refused');
    const wide = new ToolPipeline();
    installWritePathsGuard(wide, { agentId: 'bounded', bounds: [{ label: 'the agent', root: dir, globs: ['src/**'] }], cwd: () => dir });
    const allowed = await wide.execute({ callId: 'c2', name: 'Refactor', arguments: { ...args, dryRun: false }, agentId: 'bounded', state: new Map() }, async () => 'ran');
    ok(!allowed.denied, 'inside the paths it is allowed');
  });
}

console.log('\n── moveFile and organizeImports ──');
{
  const dir = tsProject();
  await inProject(dir, async () => {
    const args = { action: 'moveFile', path: 'src/money.ts', to: 'src/lib/money.ts' };
    const dry = await executeRefactor(args);
    ok(/src\/money\.ts \(deleted\)/.test(dry) && /src\/lib\/money\.ts \(new\)/.test(dry), 'the move is a create plus a delete in the plan', dry);
    const moved = await executeRefactor({ ...args, dryRun: false, runChecks: false });
    ok(fs.existsSync(path.join(dir, 'src/lib/money.ts')) && !fs.existsSync(path.join(dir, 'src/money.ts')), 'the file moved', moved);
    ok(read(dir, 'src/a/use-ns.ts').includes("from '../lib/money'") && read(dir, 'src/index.ts').includes("from './lib/money'"), 'importers point at the new path', read(dir, 'src/a/use-ns.ts'));
    const back = await executeRefactor({ action: 'rollback' });
    ok(fs.existsSync(path.join(dir, 'src/money.ts')) && !fs.existsSync(path.join(dir, 'src/lib/money.ts')), 'rollback moves it back', back);

    write(dir, 'src/messy.ts', "import { formatPriceRange, formatPrice } from './money';\nimport { x } from './a/use-barrel';\nexport const m = formatPrice(1);\n");
    await executeRefactor({ action: 'organizeImports', path: 'src/messy.ts' });
    await executeRefactor({ action: 'organizeImports', path: 'src/messy.ts', dryRun: false, runChecks: false });
    ok(read(dir, 'src/messy.ts').startsWith("import { formatPrice } from './money';\nexport"), 'unused imports dropped', read(dir, 'src/messy.ts'));
  });
}

console.log('\n── ast-grep: CodeSearch and CodeRewrite ──');
{
  const dir = tmp('refactor-sg');
  const bin = await findAstGrep(dir);
  if (!bin) {
    console.log('  skip  ast-grep is not installed here (optional dependency) — CodeSearch/CodeRewrite cases skipped');
    await inProject(dir, async () => {
      const r = await executeCodeSearch({ pattern: 'a($X)', lang: 'ts' }).catch(e => e.message);
      ok(/ast-grep is not available here/.test(r) && /npm i -D @ast-grep\/cli/.test(r), 'without the binary the tool says how to install it', r);
    });
  } else {
    write(dir, 'package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node -e "process.exit(0)"' } }));
    write(dir, 'src/a.ts', "import { charge } from './pay';\nexport const r = charge(10);\nexport const s = charge(\n  20,\n);\nexport const t = rechargeAll(1); // charge(1) in a comment\n");
    write(dir, 'src/crlf.ts', "import { charge } from './pay';\r\nexport const u = charge(5);\r\n");
    write(dir, 'src/pay.ts', "export function charge(n: number, currency = 'USD') { return n + currency; }\nexport function rechargeAll(n: number) { return n; }\n");
    write(dir, 'src/none.ts', 'export const nothing = 1;\n');
    const none = read(dir, 'src/none.ts');
    await inProject(dir, async () => {
      const found = await executeCodeSearch({ pattern: 'charge($A)', lang: 'ts' });
      ok(/3 match\(es\) in 2 file/.test(found) && !/rechargeAll/.test(found), 'matches syntax: the multi-line call, not the comment or the lookalike', found);
      const scoped = await executeCodeSearch({ pattern: 'charge($A)', lang: 'ts', paths: ['src/crlf.ts'] });
      ok(/1 match/.test(scoped), 'paths narrow the search', scoped);
      const outside = await executeCodeSearch({ pattern: 'x', lang: 'ts', paths: ['../..'] }).catch(e => e.message);
      ok(/inside the project|must stay inside/.test(outside), 'a path outside the project is refused', outside);

      const args = { pattern: 'charge($A)', rewrite: "charge($A, 'EUR')", lang: 'ts' };
      const dry = await executeCodeRewrite(args);
      ok(/^DRY RUN/.test(dry) && /2 file\(s\), 3 edit\(s\)/.test(dry) && !read(dir, 'src/a.ts').includes('EUR'), 'dry run: the plan, nothing written', dry);
      const applied = await executeCodeRewrite({ ...args, dryRun: false });
      ok(/^APPLIED/.test(applied) && /PASSED/.test(applied), 'apply after the plan, then the checks', applied);
      ok(read(dir, 'src/a.ts').includes("charge(10, 'EUR')") && read(dir, 'src/a.ts').includes('// charge(1) in a comment') && read(dir, 'src/a.ts').includes('rechargeAll(1)'), 'rewrote the calls, left the comment and lookalike', read(dir, 'src/a.ts'));
      ok(read(dir, 'src/crlf.ts') === "import { charge } from './pay';\r\nexport const u = charge(5, 'EUR');\r\n", 'CRLF file keeps its line endings', read(dir, 'src/crlf.ts'));
      ok(read(dir, 'src/none.ts') === none, 'a file with no match is byte-identical');
      const rolled = await executeRefactor({ action: 'rollback' });
      ok(/^ROLLED BACK/.test(rolled) && !read(dir, 'src/a.ts').includes('EUR'), 'Refactor rollback undoes a CodeRewrite too', rolled);
      const bad = await executeCodeSearch({ pattern: 'x', lang: 'klingon' }).catch(e => e.message);
      ok(/ast-grep refused the query/.test(bad), 'an unknown language is reported, not swallowed', bad);
    });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
