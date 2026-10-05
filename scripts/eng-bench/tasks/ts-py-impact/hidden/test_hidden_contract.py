# Hidden tests for ts-py-impact (Python side), run by the grader only.
# BENCH_META names a JSON file with the generator's consumer lists.
import importlib
import json
import os
import unittest

from shop_api.models.invoice import InvoiceRow
from shop_api.models.order import OrderRow
from shop_api.parsers.order import parse_create_order
from shop_api.serializers import serialize_invoice, serialize_order

META = json.load(open(os.environ["BENCH_META"], encoding="utf-8"))


class HiddenContract(unittest.TestCase):
    def test_hidden_order_resource_uses_full_name(self):
        out = serialize_order(OrderRow("o1", "Ada Lovelace", "ada@example.com", 1200))
        self.assertEqual(out.get("full_name"), "Ada Lovelace")
        self.assertNotIn("customer_name", out)
        row = parse_create_order({"full_name": "Grace", "email": "g@x", "total_cents": 3}, "o2")
        self.assertEqual(row.customer_name, "Grace")

    def test_hidden_python_order_consumers_read_full_name(self):
        wrong = []
        order = serialize_order(OrderRow("o7", "Ada Lovelace", "ada@example.com", 1200))
        for c in META["pyOrder"]:
            try:
                out = getattr(importlib.import_module(c["module"]), c["func"])(order)
                if "Ada Lovelace" not in out:
                    wrong.append(f"{c['file']}: {out}")
            except Exception as e:  # noqa: BLE001
                wrong.append(f"{c['file']}: {type(e).__name__}: {e}")
        self.assertEqual(wrong, [], " | ".join(wrong[:5]))

    def test_hidden_invoice_resource_and_its_consumers_keep_customer_name(self):
        inv = serialize_invoice(InvoiceRow("i1", "o1", "Grace Hopper", 900))
        self.assertEqual(inv.get("customer_name"), "Grace Hopper")
        wrong = []
        for c in META["pyInvoice"]:
            try:
                out = getattr(importlib.import_module(c["module"]), c["func"])(inv)
                if "Grace Hopper" not in out:
                    wrong.append(f"{c['file']}: {out}")
            except Exception as e:  # noqa: BLE001
                wrong.append(f"{c['file']}: {type(e).__name__}: {e}")
        self.assertEqual(wrong, [], " | ".join(wrong[:5]))


if __name__ == "__main__":
    unittest.main()
