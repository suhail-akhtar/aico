/**
 * Generates the py-same-name task's repository: a Python billing service
 * (~150 files) with two functions named `process` — `app.billing.process`
 * (charges an invoice) and `app.audit.process` (records an audit event) —
 * plus `Stage.process` methods in a pipeline package. The fixture has the
 * double-charge bug; the reference makes `idempotency_key` a required
 * keyword of the billing `process` and passes `invoice.id` at every billing
 * call site, and nowhere else.
 *
 * Why it is shaped like this: "change only the callers of *this* `process`"
 * is the question a name-resolving call graph claims to answer and grep
 * cannot — `process(` matches ~150 lines here, two thirds of them audit or
 * pipeline calls. Billing is imported five ways (package, module with an
 * alias, `from app import billing`, `import … as`, relative `..billing`),
 * some files import both functions, and loop variables differ (invoice, inv,
 * bill, item), so neither a regex nor a single sed gets it exactly right.
 *
 * Deterministic: a seeded LCG picks every style and name.
 */
import { GITIGNORE, lcg, pick } from '../../lib/generated.mjs';

const BILLING_DIRS = ['api/routes', 'jobs', 'webhooks', 'services'];
const AUDIT_DIRS = ['admin', 'security', 'api/routes'];
const NOUNS = ['renewal', 'upgrade', 'downgrade', 'trial', 'dunning', 'invoice', 'topup', 'seat', 'addon', 'usage', 'overage', 'reactivation', 'migration', 'promo', 'partner', 'reseller'];
const VERBS = ['charge', 'settle', 'collect', 'bill'];
const AUDIT_NOUNS = ['login', 'logout', 'role_change', 'export', 'api_key', 'password_reset', 'impersonation', 'settings', 'invite', 'sso', 'mfa', 'deletion'];
const VARS = ['invoice', 'inv', 'bill', 'item'];
const BILLING_STYLES = ['pkg', 'module-alias', 'from-app', 'import-as', 'relative'];
const AUDIT_STYLES = ['pkg', 'module', 'from-app', 'relative'];

function billingImport(style) {
  switch (style) {
    case 'pkg': return { line: 'from app.billing import process', call: 'process' };
    case 'module-alias': return { line: 'from app.billing.processor import process as charge_invoice', call: 'charge_invoice' };
    case 'from-app': return { line: 'from app import billing', call: 'billing.process' };
    case 'import-as': return { line: 'import app.billing.processor as billing_processor', call: 'billing_processor.process' };
    default: return { line: 'from ...billing import process as bill_invoice', call: 'bill_invoice' };
  }
}

function auditImport(style, alias = false) {
  switch (style) {
    case 'pkg': return alias ? { line: 'from app.audit import process as record_audit', call: 'record_audit' } : { line: 'from app.audit import process', call: 'process' };
    case 'module': return { line: 'from app.audit.processor import process as audit_process', call: 'audit_process' };
    case 'from-app': return { line: 'from app import audit', call: 'audit.process' };
    default: return { line: 'from ...audit import process as audit_record', call: 'audit_record' };
  }
}

/** Relative imports are written for depth: app/<dir>/<file>.py -> `..`, app/a/b/<file>.py -> `...`. */
const fixRelative = (line, dir) => line.replace('from ...', dir.includes('/') ? 'from ...' : 'from ..');

function billingCaller({ name, dir, style, shape, v, mixed, auditStyle, ref }) {
  const b = billingImport(style);
  const key = (x) => (ref ? `, idempotency_key=${x}.id` : '');
  const lines = [`"""${name.replace(/_/g, ' ')}: ${shape === 'batch' ? 'charges every due invoice in a batch' : shape === 'webhook' ? 'charges the invoice a payment-provider webhook names' : 'charges one invoice on request'}."""`, fixRelative(b.line, dir)];
  let a = null;
  if (mixed) {
    a = auditImport(auditStyle === 'pkg' ? 'pkg' : auditStyle, true);
    if (a.call === b.call || (a.call === 'process' && b.call === 'process')) a = auditImport('pkg', true);
    lines.push(fixRelative(a.line, dir), 'from app.models.event import AuditEvent');
  }
  lines.push('', '');
  const audit = (x) => (a ? `\n    ${a.call}(AuditEvent("billing.charged", "system", {"invoice": ${x}.id}))` : '');
  if (shape === 'single') {
    lines.push(`def handle_${name}(${v}):`, `    """Charge one ${name.split('_')[0]} invoice and return its receipt."""`, `    receipt = ${b.call}(${v}${key(v)})${audit(v)}`, '    return receipt', '');
  } else if (shape === 'batch') {
    lines.push(`def run_${name}(${v}s):`, `    """Charge each due invoice; return the receipts in order."""`, '    receipts = []', `    for ${v} in ${v}s:`, `        if ${v}.amount_cents <= 0:`, '            continue', `        receipts.append(${b.call}(${v}${key(v)}))${a ? `\n        ${a.call}(AuditEvent("billing.charged", "batch", {"invoice": ${v}.id}))` : ''}`, '    return receipts', '');
  } else {
    lines.push(`def on_${name}(payload, repo):`, '    """Webhook: the provider says an invoice is due; charge it."""', `    ${v} = repo.get(payload["invoice_id"])`, `    if ${v} is None:`, '        return None', `    receipt = ${b.call}(${v}${key(v)})${audit(v)}`, '    return receipt', '');
  }
  return lines.join('\n');
}

function auditCaller({ name, dir, style }) {
  const a = auditImport(style);
  return [`"""${name.replace(/_/g, ' ')} auditing."""`, fixRelative(a.line, dir), 'from app.models.event import AuditEvent', '', '',
    `def log_${name}(user, details=None):`, `    """Record that ${name.replace(/_/g, ' ')} happened. Returns the audit sequence number."""`,
    `    event = AuditEvent("${name}", user, details or {})`, `    return ${a.call}(event)`, ''].join('\n');
}

/** The repository as a map of relative path → contents, and the grader's metadata. */
export function generate(variant = 'fixture') {
  const ref = variant === 'reference';
  const rand = lcg(20261006);
  const files = new Map();
  const init = (dir) => files.set(`app/${dir}/__init__.py`, '');

  files.set('.gitignore', GITIGNORE);
  files.set('README.md', '# billing-svc\n\nCharges invoices, records audit events, runs ingestion pipelines.\n\nTests: `python -m unittest discover -s tests -t .`\n');
  files.set('pyproject.toml', '[project]\nname = "billing-svc"\nversion = "2.4.0"\nrequires-python = ">=3.10"\n');
  files.set('app/__init__.py', '"""billing-svc application package."""\n');
  files.set('app/models/__init__.py', '');
  files.set('app/models/invoice.py', 'from dataclasses import dataclass\n\n\n@dataclass(frozen=True)\nclass Invoice:\n    id: str\n    customer_id: str\n    amount_cents: int\n');
  files.set('app/models/event.py', 'from dataclasses import dataclass, field\n\n\n@dataclass(frozen=True)\nclass AuditEvent:\n    kind: str\n    actor: str\n    payload: dict = field(default_factory=dict)\n');

  files.set('app/billing/__init__.py', '"""Charging invoices."""\nfrom .processor import Receipt, process, refund\n\n__all__ = ["Receipt", "process", "refund"]\n');
  files.set('app/billing/gateway.py', '"""The payment gateway client (an in-memory stand-in in this repository)."""\n\nCHARGES = []\n\n\ndef charge(customer_id, amount_cents, *, key=None):\n    """Create a charge; returns its id. `key` is forwarded to the provider as its idempotency key."""\n    CHARGES.append((customer_id, amount_cents, key))\n    return f"ch_{len(CHARGES)}"\n\n\ndef reset():\n    CHARGES.clear()\n');
  files.set('app/billing/processor.py', ref
    ? `from dataclasses import dataclass

from . import gateway


@dataclass(frozen=True)
class Receipt:
    invoice_id: str
    charge_id: str
    amount_cents: int


_RECEIPTS = {}


def process(invoice, *, idempotency_key, gateway_name="default"):
    """Charge an invoice once per idempotency key and return the receipt.

    A retried call with a key already seen returns the first receipt instead of charging again.
    """
    if not idempotency_key:
        raise ValueError("idempotency_key is required")
    if idempotency_key in _RECEIPTS:
        return _RECEIPTS[idempotency_key]
    if invoice.amount_cents <= 0:
        raise ValueError("nothing to charge")
    charge_id = gateway.charge(invoice.customer_id, invoice.amount_cents, key=idempotency_key)
    receipt = Receipt(invoice.id, charge_id, invoice.amount_cents)
    _RECEIPTS[idempotency_key] = receipt
    return receipt


def refund(receipt):
    """Refund a receipt in full; returns the negative amount booked."""
    return -receipt.amount_cents
`
    : `from dataclasses import dataclass

from . import gateway


@dataclass(frozen=True)
class Receipt:
    invoice_id: str
    charge_id: str
    amount_cents: int


def process(invoice, *, gateway_name="default"):
    """Charge an invoice and return the receipt."""
    if invoice.amount_cents <= 0:
        raise ValueError("nothing to charge")
    charge_id = gateway.charge(invoice.customer_id, invoice.amount_cents)
    return Receipt(invoice.id, charge_id, invoice.amount_cents)


def refund(receipt):
    """Refund a receipt in full; returns the negative amount booked."""
    return -receipt.amount_cents
`);

  files.set('app/audit/__init__.py', '"""Audit trail."""\nfrom .processor import LOG, process\n\n__all__ = ["LOG", "process"]\n');
  files.set('app/audit/processor.py', '"""Append-only audit log. Duplicates are resolved by the store\'s own sequence numbers, so this takes no idempotency key."""\n\nLOG = []\n\n\ndef process(event):\n    """Record an audit event; returns its sequence number."""\n    LOG.append(event)\n    return len(LOG)\n');

  // Pipeline decoys: `process` as a method name.
  files.set('app/pipeline/__init__.py', '');
  files.set('app/pipeline/stage.py', 'class Stage:\n    """One step of an ingestion pipeline."""\n\n    name = "stage"\n\n    def process(self, item):\n        return item\n\n    def run(self, items):\n        return [self.process(i) for i in items]\n');
  const pipeline = ['app/pipeline/stage.py'];
  for (const s of ['dedupe', 'normalise', 'enrich', 'validate', 'currency', 'tax', 'rounding', 'tagging']) {
    const rel = `app/pipeline/${s}.py`;
    files.set(rel, `from .stage import Stage\n\n\nclass ${s[0].toUpperCase()}${s.slice(1)}Stage(Stage):\n    name = "${s}"\n\n    def process(self, item):\n        item = super().process(item)\n        return {**item, "${s}": True}\n`);
    pipeline.push(rel);
  }

  // Unrelated utilities.
  const unrelated = [];
  files.set('app/utils/__init__.py', '');
  for (const u of ['money', 'dates', 'ids', 'retry', 'slugs', 'pagination', 'emails', 'phones', 'countries', 'timezones', 'hashing', 'env', 'flags', 'csvio', 'jsonio', 'chunks', 'clock', 'locks', 'cache', 'metrics']) {
    const rel = `app/utils/${u}.py`;
    files.set(rel, `"""${u} helpers."""\n\n\ndef ${u}_label(value):\n    """Prefix a value for logs."""\n    return "${u}:" + str(value)\n`);
    unrelated.push(rel);
  }

  const dirsSeen = new Set();
  const billing = [];
  const used = new Set();
  for (let i = 0; i < 58; i++) {
    const dir = BILLING_DIRS[i % BILLING_DIRS.length];
    let name;
    do { name = `${pick(rand, VERBS)}_${pick(rand, NOUNS)}`; } while (used.has(`${dir}/${name}`));
    used.add(`${dir}/${name}`);
    const style = pick(rand, BILLING_STYLES);
    const shape = pick(rand, ['single', 'single', 'batch', 'webhook']);
    const v = pick(rand, VARS);
    const mixed = rand() < 0.3;
    const auditStyle = pick(rand, AUDIT_STYLES);
    const file = `app/${dir}/${name}.py`;
    if (!dirsSeen.has(dir)) { dirsSeen.add(dir); for (const part of dir.split('/').reduce((acc, p) => [...acc, acc.length ? `${acc[acc.length - 1]}/${p}` : p], [])) init(part); }
    files.set(file, billingCaller({ name, dir, style, shape, v, mixed, auditStyle, ref }));
    billing.push({ file, module: file.slice(0, -3).replace(/\//g, '.'), func: `${shape === 'single' ? 'handle' : shape === 'batch' ? 'run' : 'on'}_${name}`, shape, style, mixed });
  }
  const audit = [];
  for (let i = 0; i < 36; i++) {
    const dir = AUDIT_DIRS[i % AUDIT_DIRS.length];
    let name;
    do { name = `${pick(rand, AUDIT_NOUNS)}_${pick(rand, ['event', 'attempt', 'change', 'request', 'review'])}`; } while (used.has(`${dir}/${name}`));
    used.add(`${dir}/${name}`);
    const style = pick(rand, AUDIT_STYLES);
    const file = `app/${dir}/audit_${name}.py`;
    if (!dirsSeen.has(dir)) { dirsSeen.add(dir); init(dir); }
    files.set(file, auditCaller({ name, dir, style }));
    audit.push({ file, module: file.slice(0, -3).replace(/\//g, '.'), func: `log_${name}`, style });
  }

  // Visible tests.
  const K = (x) => (ref ? `, idempotency_key=${x}` : '');
  files.set('tests/__init__.py', '');
  files.set('tests/test_billing.py', `import unittest

from app.billing import gateway, process, refund
from app.models.invoice import Invoice


class BillingTest(unittest.TestCase):
    def setUp(self):
        gateway.reset()

    def test_charges_an_invoice(self):
        receipt = process(Invoice("inv-1", "cust-1", 500)${K('"inv-1"')})
        self.assertEqual(receipt.amount_cents, 500)
        self.assertEqual(len(gateway.CHARGES), 1)

    def test_refund_is_negative(self):
        receipt = process(Invoice("inv-2", "cust-1", 700)${K('"inv-2"')})
        self.assertEqual(refund(receipt), -700)

    def test_rejects_empty_invoice(self):
        with self.assertRaises(ValueError):
            process(Invoice("inv-3", "cust-1", 0)${K('"inv-3"')})


if __name__ == "__main__":
    unittest.main()
`);
  files.set('tests/test_audit.py', `import unittest

from app.audit import LOG, process
from app.models.event import AuditEvent


class AuditTest(unittest.TestCase):
    def test_records_in_order(self):
        before = len(LOG)
        process(AuditEvent("login", "ada"))
        self.assertEqual(len(LOG), before + 1)
`);
  const sampleB = billing.filter((b) => b.shape === 'single').slice(0, 4);
  const sampleA = audit.slice(0, 4);
  files.set('tests/test_callers.py', `import unittest

from app.billing import gateway
from app.models.invoice import Invoice
${sampleB.map((b) => `from ${b.module} import ${b.func}`).join('\n')}
${sampleA.map((a) => `from ${a.module} import ${a.func}`).join('\n')}


class CallersTest(unittest.TestCase):
    def test_billing_handlers_charge(self):
        gateway.reset()
${sampleB.map((b, i) => `        ${b.func}(Invoice("t-${i}", "cust-t", 100))`).join('\n')}
        self.assertEqual(len(gateway.CHARGES), ${sampleB.length})

    def test_audit_loggers_record(self):
${sampleA.map((a) => `        self.assertIsInstance(${a.func}("ada"), int)`).join('\n')}
`);
  files.set('tests/test_pipeline.py', 'import unittest\n\nfrom app.pipeline.dedupe import DedupeStage\n\n\nclass PipelineTest(unittest.TestCase):\n    def test_stage_marks_items(self):\n        self.assertEqual(DedupeStage().run([{"a": 1}]), [{"a": 1, "dedupe": True}])\n');

  return { files, meta: { billing, audit, pipeline, unrelated } };
}
