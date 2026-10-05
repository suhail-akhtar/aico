/**
 * Code-graph task 1 — next-alias-impact: change a shared util's signature in
 * a ~170-file Next.js-shaped TypeScript app and update every real caller,
 * reached through `@/` path aliases, barrels, a renaming re-export and
 * relative paths, while two same-named `formatAmount` functions elsewhere
 * (and their callers, which have a `currency` in scope too) stay untouched.
 *
 * Why it exists: Phase 0 of the code-graph study (scratchpad
 * graphify-analysis.md / code-lens-analysis.md) asks whether a precomputed
 * import/call graph saves an agent tokens and round trips on "who calls this
 * and what breaks if I change it". A text search here returns ~120 hits for
 * `formatAmount(`, a third of them decoys, and misses the `money(...)` alias;
 * the TypeScript compiler finds exactly the real callers once the signature
 * changes. So the honest baseline is strong, and the task measures whether a
 * graph beats grep + tsc, not whether it beats grep alone.
 *
 * Graders, none reading the agent's report: tsc and the visible tests pass;
 * hidden tests (compiled by the grader, never shown) check the required
 * parameter by arity, every component and route module rendering in its own
 * currency, and the decoys' behaviour; decoys and unrelated files are
 * byte-identical.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sh } from '../../lib/util.mjs';
import { changedFrom, checkTsHidden, gitInitFixed, linkTypeScript, readRel, runTsHidden, writeTree } from '../../lib/generated.mjs';
import { generate } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HIDDEN = [
  'formatAmount takes a required currency and formats USD, EUR and GBP',
  'every component prices in its own currency',
  'every route module prices in its own currency',
  'the same-named formatAmount in legacy POS and in reports is unchanged',
];

const edit = (project, rel, from, to) => {
  const text = readRel(project, rel);
  if (!text?.includes(from)) throw new Error(`mutation does not apply to ${rel}`);
  fs.writeFileSync(path.join(project, rel), text.replace(from, () => to));
};

export default {
  id: 'next-alias-impact',
  title: 'Signature change through aliases and barrels, with same-named decoys (TS, ~170 files)',
  soft: false,

  setup(project) {
    fs.mkdirSync(project, { recursive: true });
    writeTree(project, generate('fixture').files);
    gitInitFixed(project);
    linkTypeScript(project);
  },

  applyReference(project) {
    writeTree(project, generate('reference').files);
  },

  prompt: [
    'Customers in the EU and the UK see prices with a dollar sign. In this Next.js storefront (TypeScript; `@/` is an alias',
    'for `src/`), change `formatAmount` in src/lib/format/currency.ts to take a second, required parameter',
    '`currency: CurrencyCode` (the type in src/lib/money/types.ts; no default value) that picks the symbol:',
    'USD → "$", EUR → "€", GBP → "£", always two decimals, e.g. formatAmount(1234, \'EUR\') === "€12.34".',
    '',
    '- Update every caller of this function to pass the currency of the thing it is formatting (each caller already has',
    '  it in scope). Callers may import it under another name or through re-exports.',
    '- Other modules define their own, unrelated functions also named `formatAmount` (legacy POS receipts, finance',
    '  reports). Those functions and their callers must not change.',
    '- Do not change files that do not need to change. `npm run typecheck` and `npm test` must pass.',
  ].join('\n'),

  async grade({ project, check }) {
    const fixture = generate('fixture');
    const { meta } = fixture;

    const tsc = sh('node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json', { cwd: project, timeoutMs: 180_000 });
    check('typecheck passes', tsc.code === 0, (tsc.out + tsc.err).trim().split('\n').slice(0, 4).join(' | '));
    const visible = sh('npm test', { cwd: project, timeoutMs: 300_000 });
    const pass = Number((visible.out.match(/# pass (\d+)/) ?? [])[1] ?? 0);
    check('visible tests pass', visible.code === 0 && pass >= 3, `exit ${visible.code}, pass ${pass}`);

    checkTsHidden(check, runTsHidden(project, path.join(here, 'hidden', 'alias.hidden.test.mjs'), meta), HIDDEN);

    const decoyFiles = [...meta.decoys, ...meta.decoyCallers.map((d) => d.file)];
    const decoyChanged = changedFrom(project, fixture.files, decoyFiles);
    check(`same-named decoys and their callers are byte-identical (${decoyFiles.length})`, decoyChanged.length === 0, decoyChanged.slice(0, 5).join(', '));
    const others = changedFrom(project, fixture.files, meta.unrelated);
    check(`unrelated modules are byte-identical (${meta.unrelated.length})`, others.length === 0, others.slice(0, 5).join(', '));

    const changed = sh('git status --porcelain --untracked-files=all', { cwd: project }).out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
    return { changedFiles: changed.length, callerFiles: meta.callers.length };
  },

  /** For test-graders.mjs: wrong solutions that must lose named checks, and acceptable variations that must not. */
  selfTest: {
    fixtureMustFail: ['hidden: formatAmount takes a required currency', 'hidden: every component prices in its own currency'],
    mutants: [
      {
        label: 'currency given a USD default and the `money` alias callers missed',
        apply(project) {
          edit(project, 'src/lib/format/currency.ts', 'currency: CurrencyCode)', "currency: CurrencyCode = 'USD')");
          const { files, meta } = generate('fixture');
          for (const c of meta.callers.filter((x) => x.style === 'ui-money')) fs.writeFileSync(path.join(project, c.file), files.get(c.file));
        },
        mustFail: ['hidden: formatAmount takes a required currency', 'hidden: every component prices in its own currency'],
      },
      {
        label: 'the legacy POS formatAmount "fixed" too (decoy touched)',
        apply(project) {
          edit(project, 'src/legacy/pos/formatAmount.ts', "return 'USD ' + (cents / 100).toFixed(2);", "return '$' + (cents / 100).toFixed(2);");
        },
        mustFail: ['hidden: the same-named formatAmount in legacy POS and in reports is unchanged', 'same-named decoys and their callers are byte-identical'],
      },
      {
        label: 'acceptable: a caller destructures the currency instead',
        apply(project) {
          const c = generate('reference').meta.callers.find((x) => x.kind === 'component' && x.style === 'alias-direct');
          edit(project, c.file, 'const net = props.cents - props.discountCents;', 'const { currency } = props;\n  const net = props.cents - props.discountCents;');
          const text = readRel(project, c.file).replaceAll(', props.currency)', ', currency)');
          fs.writeFileSync(path.join(project, c.file), text);
        },
        mustPass: true,
      },
    ],
  },
};
