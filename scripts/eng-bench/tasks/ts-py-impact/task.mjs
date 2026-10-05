/**
 * Code-graph task 4 — ts-py-impact: rename the Order resource's JSON field
 * `customer_name` to `full_name` across a Python API and a TypeScript web
 * client (~140 files), on both the response and the request side, while the
 * Invoice and Customer resources and the Order *database column* keep
 * `customer_name`.
 *
 * Why it exists: Phase 0 of the code-graph study. "What breaks across the
 * language boundary if this field changes?" is an impact question neither the
 * TypeScript compiler (Python side, untyped legacy cells) nor a call graph
 * (field reads on dicts are not calls) answers alone; it measures whether
 * graph tools help or just add steps where the dependency is data, not code.
 *
 * Graders, none reading the agent's report: both visible suites pass; hidden
 * Python tests check the serializer, the request parser and every dict
 * consumer; hidden TypeScript tests (compiled by the grader) check the request
 * builder, every order component and legacy cell, and that invoice components
 * still read `customer_name`; models, DB SQL, invoice/customer code and
 * unrelated files are byte-identical.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sh } from '../../lib/util.mjs';
import { PY_ENV, changedFrom, checkTsHidden, failureDetail, gitInitFixed, linkTypeScript, pythonCommand, readRel, runPyHidden, runTsHidden, writeTree } from '../../lib/generated.mjs';
import { generate } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_HIDDEN = ['order_resource_uses_full_name', 'python_order_consumers_read_full_name', 'invoice_resource_and_its_consumers_keep_customer_name'];
const TS_HIDDEN = ['the create-order request sends full_name', 'every order component reads full_name', 'invoice components keep customer_name'];

const edit = (project, rel, from, to) => {
  const text = readRel(project, rel);
  if (!text?.includes(from)) throw new Error(`mutation does not apply to ${rel}`);
  fs.writeFileSync(path.join(project, rel), text.replace(from, () => to));
};

export default {
  id: 'ts-py-impact',
  title: 'Rename an API field across a Python API and a TS client (~140 files)',
  soft: false,

  setup(project) {
    fs.mkdirSync(project, { recursive: true });
    writeTree(project, generate('fixture').files);
    gitInitFixed(project);
    linkTypeScript(project, 'web');
  },

  applyReference(project) {
    writeTree(project, generate('reference').files);
  },

  prompt: [
    'Rename the Order resource\'s JSON field `customer_name` to `full_name` everywhere it is part of the API contract:',
    'the Python API in api/ (the order responses and the create-order request body) and the TypeScript web client in',
    'web/ (its types and every place that reads or sends the field), plus any code that consumes the serialized order.',
    '',
    '- Only the Order resource changes. The Invoice and Customer resources keep `customer_name`.',
    '- The database column and the `OrderRow.customer_name` attribute stay as they are (do not touch api/shop_api/db/',
    '  or api/shop_api/models/).',
    '- Do not change files that do not need to change.',
    '- `python -m unittest discover -s api/tests -t api` and, in web/, `npm run typecheck` and `npm test` must pass.',
  ].join('\n'),

  async grade({ project, check }) {
    const fixture = generate('fixture');
    const { meta } = fixture;
    const web = path.join(project, 'web');

    const py = sh(`${pythonCommand()} -m unittest discover -s api/tests -t api`, { cwd: project, timeoutMs: 180_000, env: PY_ENV });
    const ran = Number((`${py.out}\n${py.err}`.match(/Ran (\d+) test/) ?? [])[1] ?? 0);
    check('python visible tests pass', py.code === 0 && ran >= 4, `exit ${py.code}, ran ${ran}`);
    const tsc = sh('node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json', { cwd: web, timeoutMs: 180_000 });
    check('web typecheck passes', tsc.code === 0, (tsc.out + tsc.err).trim().split('\n').slice(0, 4).join(' | '));
    const visible = sh('npm test', { cwd: web, timeoutMs: 300_000 });
    const pass = Number((visible.out.match(/# pass (\d+)/) ?? [])[1] ?? 0);
    check('web visible tests pass', visible.code === 0 && pass >= 3, `exit ${visible.code}, pass ${pass}`);

    const { results, text } = runPyHidden(project, path.join(here, 'hidden', 'test_hidden_contract.py'), meta, { pythonPath: 'api' });
    for (const name of PY_HIDDEN) {
      const ok = results[`test_hidden_${name}`];
      check(`hidden py: ${name.replace(/_/g, ' ')}`, ok === true, ok === undefined ? 'not reported' : ok ? '' : failureDetail(text, `test_hidden_${name}`));
    }
    checkTsHidden(check, runTsHidden(web, path.join(here, 'hidden', 'contract.hidden.test.mjs'), meta), TS_HIDDEN);

    const keep = changedFrom(project, fixture.files, meta.keep);
    check(`models, DB, invoice and customer code are byte-identical (${meta.keep.length})`, keep.length === 0, keep.slice(0, 5).join(', '));
    const others = changedFrom(project, fixture.files, meta.unrelated);
    check(`unrelated modules are byte-identical (${meta.unrelated.length})`, others.length === 0, others.slice(0, 5).join(', '));
    return {};
  },

  selfTest: {
    fixtureMustFail: ['hidden py: order resource uses full name', 'hidden: every order component reads full_name'],
    mutants: [
      {
        label: 'tsc-driven rename only: untyped legacy cells and Python dict consumers missed',
        apply(project) {
          const { files, meta } = generate('fixture');
          for (const c of [...meta.webLegacyOrder, ...meta.pyOrder]) fs.writeFileSync(path.join(project, c.file), files.get(c.file));
        },
        mustFail: ['hidden py: python order consumers read full name', 'hidden: every order component reads full_name'],
      },
      {
        label: 'global replace: invoices renamed too',
        apply(project) {
          edit(project, 'api/shop_api/serializers/invoice.py', '"customer_name": row.customer_name', '"full_name": row.customer_name');
          edit(project, 'web/src/legacy/grid/invoiceCell03.ts', "row['customer_name']", "row['full_name']");
        },
        mustFail: ['hidden py: invoice resource and its consumers keep customer name', 'hidden: invoice components keep customer_name', 'models, DB, invoice and customer code are byte-identical'],
      },
      {
        label: 'request side forgotten (parser still reads customer_name)',
        apply(project) {
          edit(project, 'api/shop_api/parsers/order.py', 'body.get("full_name")', 'body.get("customer_name")');
        },
        mustFail: ['hidden py: order resource uses full name', 'python visible tests pass'],
      },
      {
        label: 'acceptable: the TS create request built with a spread',
        apply(project) {
          edit(project, 'web/src/api/orders.ts', 'return { full_name: form.name.trim(), email: form.email, total_cents: form.totalCents };', 'const full_name = form.name.trim();\n  return { full_name, email: form.email, total_cents: form.totalCents };');
        },
        mustPass: true,
      },
    ],
  },
};
