/**
 * Code-graph task 5 — cochange-fix: add a tax region (Nunavut) to a ~115-file
 * JavaScript invoicing service whose git history (~110 commits) shows the
 * tax-rates table and the e-invoice ledger-partition table always changing
 * together, with no import, call or shared vocabulary between them.
 *
 * Why it exists: Phase 0 of the code-graph study. Co-change edges are the
 * one signal buruj-code-lens has that neither graphify nor AICO has; this is
 * the task where that signal is the shortest route to the second file. The
 * visible tests pass with the rates table alone; the hidden test renders an
 * NU e-invoice, which needs the partition table.
 *
 * Graders, none reading the agent's report: visible tests pass; hidden tests
 * (NU tax and checkout, the NU e-invoice under the next partition number,
 * existing regions unchanged, NU not shippable); region-list decoys and
 * unrelated modules byte-identical.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runNodeTests, sh } from '../../lib/util.mjs';
import { changedFrom, git, gitInitFixed, readRel, writeTree } from '../../lib/generated.mjs';
import { generate } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HIDDEN = [
  'NU is taxed at 5% and offered at checkout',
  'an NU invoice renders a CRA e-invoice under the next ledger partition',
  'existing regions keep their rates and partitions',
  'NU is not added to shipping zones',
];

const edit = (project, rel, from, to) => {
  const text = readRel(project, rel);
  if (!text?.includes(from)) throw new Error(`mutation does not apply to ${rel}`);
  fs.writeFileSync(path.join(project, rel), text.replace(from, () => to));
};

export default {
  id: 'cochange-fix',
  title: 'Add a tax region where the second file is related only by git history (JS, ~115 files)',
  soft: false,

  setup(project) {
    fs.mkdirSync(project, { recursive: true });
    const { files, history } = generate('fixture');
    const [first, ...rest] = history;
    writeTree(project, first.files);
    gitInitFixed(project, first.message, '2026-01-05T09:00:00Z');
    const start = Date.parse('2026-01-06T10:00:00Z');
    rest.forEach((c, i) => {
      writeTree(project, c.files);
      git(project, ['add', '-A']);
      git(project, ['commit', '-q', '-m', c.message], { date: new Date(start + i * 86_400_000 * 1.7).toISOString().replace(/\.\d+Z$/, 'Z') });
    });
    // The history must end exactly at the fixture.
    const drift = [...files.keys()].filter((rel) => readRel(project, rel) !== files.get(rel));
    if (drift.length) throw new Error(`cochange-fix history does not end at the fixture: ${drift.join(', ')}`);
  },

  applyReference(project) {
    writeTree(project, generate('reference').files);
  },

  prompt: [
    'Add Nunavut (region code `NU`, 5% GST) as a supported tax region in this invoicing service. Customers in Nunavut',
    'must be able to get a checkout quote and be invoiced end to end, like customers in any other supported region —',
    'everything that must know about a supported tax region must know about NU.',
    '',
    '- We do not ship physical goods to Nunavut yet: do not add it to shipping zones. Holiday calendars, marketing copy',
    '  and phone hints are out of scope too.',
    '- Do not change existing regions, and do not change files that do not need to change. `npm test` must pass.',
  ].join('\n'),

  async grade({ project, check }) {
    const fixture = generate('fixture');
    const { meta } = fixture;

    const visible = sh('npm test', { cwd: project, timeoutMs: 180_000 });
    const pass = Number((visible.out.match(/# pass (\d+)/) ?? [])[1] ?? 0);
    check('visible tests pass', visible.code === 0 && pass >= 4, `exit ${visible.code}, pass ${pass}`);

    const hid = path.join(project, '.bench-hidden');
    fs.rmSync(hid, { recursive: true, force: true });
    fs.mkdirSync(hid, { recursive: true });
    fs.copyFileSync(path.join(here, 'hidden', 'cochange.hidden.test.mjs'), path.join(hid, 'cochange.hidden.test.mjs'));
    const r = runNodeTests(['.bench-hidden/cochange.hidden.test.mjs'], { cwd: project, timeoutMs: 120_000 });
    fs.rmSync(hid, { recursive: true, force: true });
    for (const name of HIDDEN) {
      const t = r.tests.find((x) => x.name === `hidden: ${name}`);
      check(`hidden: ${name}`, t?.ok === true, t ? (t.ok ? '' : ((r.raw.split(`hidden: ${name}`)[1] ?? '').match(/error: '([^']*)'/)?.[1] ?? '')) : 'not reported');
    }

    const decoys = changedFrom(project, fixture.files, meta.decoys);
    check(`shipping zones, holidays, copy and phone hints are byte-identical (${meta.decoys.length})`, decoys.length === 0, decoys.join(', '));
    const others = changedFrom(project, fixture.files, meta.unrelated);
    check(`unrelated modules (incl. the e-invoice writer) are byte-identical (${meta.unrelated.length})`, others.length === 0, others.slice(0, 5).join(', '));
    return {};
  },

  selfTest: {
    fixtureMustFail: ['hidden: NU is taxed at 5%', 'hidden: an NU invoice renders'],
    mutants: [
      {
        label: 'rates table only (the obvious file): visible tests pass, e-invoice does not',
        apply(project) {
          fs.writeFileSync(path.join(project, 'src/edi/partitions.js'), generate('fixture').files.get('src/edi/partitions.js'));
        },
        mustFail: ['hidden: an NU invoice renders a CRA e-invoice under the next ledger partition'],
      },
      {
        label: 'NU added to every region list (shipping zones included)',
        apply(project) {
          edit(project, 'src/shipping/zones.js', '  NT: 9,', '  NT: 9,\n  NU: 9,');
          edit(project, 'src/marketing/regionCopy.js', "  NT: 'Fast invoicing for NT businesses',", "  NT: 'Fast invoicing for NT businesses',\n  NU: 'Fast invoicing for NU businesses',");
        },
        mustFail: ['hidden: NU is not added to shipping zones', 'shipping zones, holidays, copy and phone hints are byte-identical'],
      },
      {
        label: 'partition renumbered instead of appended',
        apply(project) {
          edit(project, 'src/edi/partitions.js', "  ['NU', 'LP-13'],", '');
          edit(project, 'src/edi/partitions.js', "const TABLE = [\n", "const TABLE = [\n  ['NU', 'LP-01'],\n");
        },
        mustFail: ['hidden: an NU invoice renders a CRA e-invoice under the next ledger partition'],
      },
      {
        label: 'acceptable: a test added for NU',
        apply(project) {
          fs.writeFileSync(path.join(project, 'test/nu.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { computeTax } from '../src/tax/rates.js';\n\ntest('NU', () => assert.equal(computeTax('NU', 200), 10));\n");
        },
        mustPass: true,
      },
    ],
  },
};
