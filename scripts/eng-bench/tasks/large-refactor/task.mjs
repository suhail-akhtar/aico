/**
 * Task 7 — a large mechanical refactor: rename an exported API used ~150
 * times across a generated ~200-file TypeScript repository, add a defaulted
 * parameter, and pass a new argument at one directory's call sites.
 *
 * What it measures: whether the agent can make a wide change exactly — every
 * site, and nothing else — and what it costs to get there. It is the task the
 * `refactor` tool group (CodeSearch / CodeRewrite / Refactor) was built for,
 * so it is run with those tools hidden (`--disable-tools`) and available, on
 * the same prompt, for a before/after comparison.
 *
 * Graders, none reading the agent's report:
 * - `tsc` passes and the visible tests pass (the project's own scripts);
 * - hidden tests: the new behaviour (USD/EUR/GBP), the barrel exports the new
 *   name and not the old, EU features price in euros and others in dollars,
 *   `formatPriceRange` unchanged;
 * - no `formatPrice` identifier remains (the analytics wire string excepted);
 * - every file that never mentioned the API is byte-identical;
 * - every source call-site file equals the reference rename exactly (no
 *   drive-by reformatting, no aliasing back to the old name); test files may
 *   gain tests.
 *
 * The project gets `typescript` the way a real one has it — in its own
 * node_modules (a link to AICO's copy, so no network) — and nothing else.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { gitInit, runNodeTests, sh, sha256 } from '../../lib/util.mjs';
import { generate } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OLD = /\bformatPrice\b/;
const WIRE = "export const PRICE_FORMATTED_EVENT = 'formatPrice';";

/** Link AICO's own `typescript` into the project, as a real project would have it installed. */
function linkTypeScript(project) {
  const ts = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  fs.symlinkSync(ts, path.join(project, 'node_modules', 'typescript'), 'junction');
}

function writeTree(project, files) {
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
  }
}

const read = (project, rel) => { try { return fs.readFileSync(path.join(project, rel), 'utf8'); } catch { return null; } };

export default {
  id: 'large-refactor',
  title: 'Large mechanical refactor (rename + signature, ~200 files)',
  soft: false,

  setup(project) {
    fs.mkdirSync(project, { recursive: true });
    writeTree(project, generate('fixture').files);
    linkTypeScript(project);
    gitInit(project);
  },

  /** For the grader self-test: what a correct solution leaves on disk. */
  applyReference(project) {
    writeTree(project, generate('reference').files);
  },

  prompt: [
    'In this TypeScript repository, rename the exported function `formatPrice` (src/core/money.ts) to `formatMoney`,',
    'and give it a second parameter `currency: string = \'USD\'` that picks the symbol: USD → "$", EUR → "€", GBP → "£"',
    '(any other code is shown as the code followed by a space). Existing behaviour for USD must not change.',
    '',
    '- Every caller must use the new name: no `formatPrice` identifier may remain anywhere in src/ or test/. The',
    '  analytics wire event name, the string \'formatPrice\' in src/analytics/events.ts, must stay exactly as it is.',
    '- Every call in src/features/eu/ must pass \'EUR\' as the second argument; no other call site passes a currency.',
    '- `formatPriceRange` keeps its name and behaviour. Do not change anything else: files that do not use',
    '  `formatPrice` must not change, and changed lines must change only as this requires (no reformatting).',
    '- `npm run typecheck` and `npm test` must pass.',
  ].join('\n'),

  async grade({ project, check }) {
    const fixture = generate('fixture');
    const reference = generate('reference');

    const tsc = sh('node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json', { cwd: project, timeoutMs: 180_000 });
    check('typecheck passes', tsc.code === 0, (tsc.out + tsc.err).trim().split('\n').slice(0, 5).join(' | '));

    const visible = sh('npm test', { cwd: project, timeoutMs: 300_000 });
    const tap = (visible.out.match(/# pass (\d+)/) ?? [])[1];
    check('visible tests pass', visible.code === 0 && Number(tap) >= 11, `exit ${visible.code}, pass ${tap ?? '?'}`);

    // Hidden behaviour: compiled to a directory of the grader's own.
    const out = path.join(project, '.bench-build');
    fs.rmSync(out, { recursive: true, force: true });
    const built = sh(`node node_modules/typescript/bin/tsc -p tsconfig.json --outDir .bench-build`, { cwd: project, timeoutMs: 180_000 });
    const hiddenDir = path.join(project, '.bench-hidden');
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.copyFileSync(path.join(here, 'hidden', 'refactor.hidden.test.mjs'), path.join(hiddenDir, 'refactor.hidden.test.mjs'));
    const hidden = built.code === 0
      ? runNodeTests(['.bench-hidden/refactor.hidden.test.mjs'], { cwd: project, timeoutMs: 90_000, env: { BENCH_META: JSON.stringify(reference.meta) } })
      : { tests: [], raw: built.out };
    const expected = [
      'formatMoney formats USD by default, EUR, GBP and other codes',
      'the barrel exports formatMoney and not formatPrice',
      'EU features price in euros, the others in dollars',
      'formatPriceRange is unchanged',
    ];
    for (const name of expected) {
      const t = hidden.tests.find((x) => x.name === `hidden: ${name}`);
      check(`hidden: ${name}`, t?.ok === true, t ? '' : (built.code !== 0 ? 'project does not compile' : 'not reported'));
    }
    fs.rmSync(hiddenDir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });

    // Static checks against the generated fixture and reference. The wire
    // string is the one allowed mention of the old name.
    const oldLines = (text) => text.split('\n').filter((l) => l.trim() !== WIRE && OLD.test(l));
    const leftovers = [];
    for (const rel of reference.files.keys()) {
      if (!/^(src|test)\//.test(rel)) continue;
      const text = read(project, rel);
      const lines = text === null ? [] : oldLines(text);
      if (lines.length) leftovers.push(`${rel}: ${lines[0].trim().slice(0, 80)}`);
    }
    check('no formatPrice identifier remains', leftovers.length === 0, leftovers.slice(0, 4).join(' | ') + (leftovers.length > 4 ? ` (+${leftovers.length - 4})` : ''));
    check('the analytics wire name is unchanged', read(project, 'src/analytics/events.ts') === fixture.files.get('src/analytics/events.ts'));

    const untouched = [...fixture.files].filter(([, text]) => oldLines(text).length === 0);
    const touched = untouched.filter(([rel, text]) => read(project, rel) === null || sha256(read(project, rel)) !== sha256(text)).map(([rel]) => rel);
    check(`files that never used formatPrice are byte-identical (${untouched.length})`, touched.length === 0, touched.slice(0, 5).join(', '));

    const untouchedSet = new Set(untouched.map(([rel]) => rel));
    // Source call sites only: a test file that gained a test for the new
    // parameter is better work, not a reformat (the 2026-10-03 run added one).
    const callSites = [...reference.files].filter(([rel]) => rel.startsWith('src/') && rel !== 'src/core/money.ts' && !untouchedSet.has(rel));
    const differ = callSites.filter(([rel, text]) => read(project, rel) !== text).map(([rel]) => rel);
    check(`source call-site files match the exact rename (${callSites.length})`, differ.length === 0, `${differ.length} differ: ${differ.slice(0, 5).join(', ')}`);

    const extra = sh('git status --porcelain --untracked-files=all', { cwd: project }).out.split('\n').filter(Boolean)
      .map((l) => l.slice(3).trim()).filter((f) => !reference.files.has(f) && !/^(build|node_modules|\.bench)/.test(f));
    return { changedOutsideReference: extra };
  },
};
