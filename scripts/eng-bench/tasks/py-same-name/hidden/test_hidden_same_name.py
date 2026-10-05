# Hidden tests for py-same-name, run by the grader (never shown to the agent).
# BENCH_META names a JSON file with the generator's caller lists.
import importlib
import inspect
import json
import os
import unittest

from app.billing import gateway
from app.models.invoice import Invoice

META = json.load(open(os.environ["BENCH_META"], encoding="utf-8"))


class Repo:
    def __init__(self, invoice):
        self.invoice = invoice

    def get(self, invoice_id):
        return self.invoice if invoice_id == self.invoice.id else None


def call(entry, shape, invoice):
    if shape == "single":
        return entry(invoice)
    if shape == "batch":
        return entry([invoice])
    return entry({"invoice_id": invoice.id}, Repo(invoice))


class HiddenSameName(unittest.TestCase):
    def test_hidden_billing_process_requires_an_idempotency_key(self):
        from app.billing import processor
        params = inspect.signature(processor.process).parameters
        self.assertIn("idempotency_key", params)
        p = params["idempotency_key"]
        self.assertEqual(p.kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertIs(p.default, inspect.Parameter.empty, "idempotency_key must have no default")
        gateway.reset()
        inv = Invoice("hid-direct", "cust-direct", 900)
        first = processor.process(inv, idempotency_key=inv.id)
        again = processor.process(inv, idempotency_key=inv.id)
        self.assertEqual(first, again)
        self.assertEqual(len([c for c in gateway.CHARGES if c[0] == "cust-direct"]), 1)

    def test_hidden_every_billing_caller_passes_the_invoice_id(self):
        wrong = []
        for b in META["billing"]:
            gateway.reset()
            try:
                entry = getattr(importlib.import_module(b["module"]), b["func"])
                one = Invoice(f"inv-{b['module']}", f"cust-{b['module']}", 1200)
                two = Invoice(f"inv2-{b['module']}", f"cust-{b['module']}", 1200)
                call(entry, b["shape"], one)
                call(entry, b["shape"], one)  # a retry: must not charge again
                call(entry, b["shape"], two)  # another invoice: must charge
                n = len([c for c in gateway.CHARGES if c[0] == f"cust-{b['module']}"])
                if n != 2:
                    wrong.append(f"{b['file']}: {n} charges for 2 distinct invoices")
            except Exception as e:  # noqa: BLE001 — any failure is a finding
                wrong.append(f"{b['file']}: {type(e).__name__}: {e}")
        self.assertEqual(wrong, [], " | ".join(wrong[:5]))

    def test_hidden_audit_process_and_its_callers_are_unchanged(self):
        from app.audit import processor
        self.assertEqual(list(inspect.signature(processor.process).parameters), ["event"])
        wrong = []
        for a in META["audit"]:
            try:
                entry = getattr(importlib.import_module(a["module"]), a["func"])
                before = len(processor.LOG)
                seq = entry("ada", {"k": 1})
                if len(processor.LOG) != before + 1 or seq != len(processor.LOG):
                    wrong.append(f"{a['file']}: did not record exactly one event")
            except Exception as e:  # noqa: BLE001
                wrong.append(f"{a['file']}: {type(e).__name__}: {e}")
        self.assertEqual(wrong, [], " | ".join(wrong[:5]))


if __name__ == "__main__":
    unittest.main()
