/**
 * Code-graph task 2 — py-same-name: fix a double-charge bug in a ~150-file
 * Python service by making `idempotency_key` a required keyword of
 * `app.billing.process` and passing the invoice's id at every billing call
 * site — while `app.audit.process` (same name, different function), its 36
 * callers and the pipeline's `Stage.process` methods stay untouched.
 *
 * Why it exists: Phase 0 of the code-graph study. "Callers of *this*
 * `process`" is what scoped name resolution (buruj-code-lens) and graph
 * neighbours (graphify) claim to answer; Python has no compiler to list the
 * call sites, so the baseline must find them with Grep/Read across five
 * import styles and files that import both functions.
 *
 * Graders, none reading the agent's report: the visible unittest suite
 * passes; hidden tests (never shown) check the signature by introspection,
 * that every billing caller dedupes a retried invoice yet charges a distinct
 * one (so the key really is the invoice id), and that every audit caller still
 * records exactly one event; audit, pipeline and unrelated files are
 * byte-identical.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sh } from '../../lib/util.mjs';
import { PY_ENV, changedFrom, failureDetail, gitInitFixed, pythonCommand, readRel, runPyHidden, writeTree } from '../../lib/generated.mjs';
import { generate } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HIDDEN = [
  'billing_process_requires_an_idempotency_key',
  'every_billing_caller_passes_the_invoice_id',
  'audit_process_and_its_callers_are_unchanged',
];

const edit = (project, rel, from, to) => {
  const text = readRel(project, rel);
  if (!text?.includes(from)) throw new Error(`mutation does not apply to ${rel}`);
  fs.writeFileSync(path.join(project, rel), text.replace(from, () => to));
};

export default {
  id: 'py-same-name',
  title: 'Change only the callers of billing.process, not audit.process (Python, ~150 files)',
  soft: false,

  setup(project) {
    fs.mkdirSync(project, { recursive: true });
    writeTree(project, generate('fixture').files);
    gitInitFixed(project);
  },

  applyReference(project) {
    writeTree(project, generate('reference').files);
  },

  prompt: [
    'Customers are being charged twice when a job or a payment webhook is retried. In this Python service, make',
    '`idempotency_key` a required keyword-only argument of `process` in app/billing/processor.py (no default), and make',
    'that function return the first receipt, without charging again, when it is called again with a key it has already',
    'seen. Then update every caller of this billing `process` to pass the invoice\'s `id` as the key.',
    '',
    '- `app.audit.process` is a different function with the same name (it records audit events and has its own',
    '  deduplication). It and its callers must not change; `Stage.process` methods in app/pipeline are unrelated too.',
    '- Some modules import the billing function under another name, through the package, or relatively.',
    '- Do not change files that do not need to change. `python -m unittest discover -s tests -t .` must pass.',
  ].join('\n'),

  async grade({ project, check }) {
    const fixture = generate('fixture');
    const { meta } = fixture;

    const visible = sh(`${pythonCommand()} -m unittest discover -s tests -t .`, { cwd: project, timeoutMs: 180_000, env: PY_ENV });
    const ran = Number((`${visible.out}\n${visible.err}`.match(/Ran (\d+) test/) ?? [])[1] ?? 0);
    check('visible tests pass', visible.code === 0 && ran >= 6, `exit ${visible.code}, ran ${ran}: ${(visible.err.match(/^(FAIL|ERROR): .*$/m) ?? [''])[0]}`);

    const { results, text } = runPyHidden(project, path.join(here, 'hidden', 'test_hidden_same_name.py'), meta);
    for (const name of HIDDEN) {
      const ok = results[`test_hidden_${name}`];
      check(`hidden: ${name.replace(/_/g, ' ')}`, ok === true, ok === undefined ? 'not reported' : ok ? '' : failureDetail(text, `test_hidden_${name}`));
    }

    const decoys = ['app/audit/__init__.py', 'app/audit/processor.py', ...meta.audit.map((a) => a.file), ...meta.pipeline];
    const decoyChanged = changedFrom(project, fixture.files, decoys);
    check(`audit.process, its callers and the pipeline are byte-identical (${decoys.length})`, decoyChanged.length === 0, decoyChanged.slice(0, 5).join(', '));
    const others = changedFrom(project, fixture.files, meta.unrelated);
    check(`unrelated modules are byte-identical (${meta.unrelated.length})`, others.length === 0, others.slice(0, 5).join(', '));
    return { billingCallers: meta.billing.length, auditCallers: meta.audit.length };
  },

  selfTest: {
    fixtureMustFail: ['hidden: billing process requires an idempotency key', 'hidden: every billing caller passes the invoice id'],
    mutants: [
      {
        label: 'key defaulted to None and the relative-import callers missed',
        apply(project) {
          edit(project, 'app/billing/processor.py', 'def process(invoice, *, idempotency_key, gateway_name="default"):', 'def process(invoice, *, idempotency_key=None, gateway_name="default"):');
          edit(project, 'app/billing/processor.py', '    if not idempotency_key:\n        raise ValueError("idempotency_key is required")\n', '');
          edit(project, 'app/billing/processor.py', '    if idempotency_key in _RECEIPTS:', '    if idempotency_key is not None and idempotency_key in _RECEIPTS:');
          const { files, meta } = generate('fixture');
          for (const b of meta.billing.filter((x) => x.style === 'relative')) fs.writeFileSync(path.join(project, b.file), files.get(b.file));
        },
        mustFail: ['hidden: billing process requires an idempotency key', 'hidden: every billing caller passes the invoice id'],
      },
      {
        label: 'every bare `process(` call got the keyword (an audit caller touched)',
        apply(project) {
          const a = generate('fixture').meta.audit.find((x) => x.style === 'pkg');
          edit(project, a.file, 'return process(event)', 'return process(event, idempotency_key=event.kind)');
        },
        mustFail: ['hidden: audit process and its callers are unchanged', 'audit.process, its callers and the pipeline are byte-identical'],
      },
      {
        label: 'audit.process given the keyword too (decoy definition touched)',
        apply(project) {
          edit(project, 'app/audit/processor.py', 'def process(event):', 'def process(event, *, idempotency_key=None):');
        },
        mustFail: ['hidden: audit process and its callers are unchanged', 'audit.process, its callers and the pipeline are byte-identical'],
      },
      {
        label: 'acceptable: a caller passes str(invoice.id)',
        apply(project) {
          const b = generate('reference').meta.billing.find((x) => x.style === 'pkg' && x.shape === 'single');
          const text = readRel(project, b.file);
          fs.writeFileSync(path.join(project, b.file), text.replace(/idempotency_key=(\w+)\.id/, (_, v) => `idempotency_key=str(${v}.id)`));
        },
        mustPass: true,
      },
    ],
  },
};
