/**
 * Generates the ts-py-impact task's repository: a Python API (`api/`) and a
 * TypeScript web client (`web/`) that share one JSON resource, Order, whose
 * field `customer_name` is renamed to `full_name` — as the fixture, or as the
 * reference rename.
 *
 * Why it is shaped like this: a cross-language field rename is the impact
 * question no compiler answers end to end. The same key `customer_name` also
 * belongs to the Invoice resource, the Customer profile and the Order *database
 * column*, all of which must stay; on the Python side the field is read from
 * plain dicts by exporters, e-mails and the search indexer (no types to
 * follow), and on the web side some legacy table cells read it from untyped
 * records, so `tsc` finds only part of it. A text search returns every
 * `customer_name`, two thirds of which must not change.
 *
 * Deterministic: fixed lists and a seeded LCG, no clock.
 */
import { ALIAS_LOADER, ALIAS_REGISTER, GITIGNORE, lcg, pick } from '../../lib/generated.mjs';

const ORDER_COMPONENTS = ['OrderRow', 'OrderCard', 'OrderHeader', 'OrderSummary', 'OrderBadge', 'OrderTimeline', 'OrderTooltip', 'OrderReceipt', 'OrderSearchHit', 'OrderPrintout',
  'OrderShippingLabel', 'OrderConfirmation', 'OrderListItem', 'OrderDetailsPanel', 'OrderStatusBanner', 'OrderCustomerChip', 'OrderAuditEntry', 'OrderInvoiceLink', 'OrderRefundDialog', 'OrderNotesPanel',
  'OrderExportPreview', 'OrderKanbanCard', 'OrderMiniCard', 'OrderPickList'];
const INVOICE_COMPONENTS = ['InvoiceRow', 'InvoiceCard', 'InvoiceHeader', 'InvoiceSummary', 'InvoicePdfTitle', 'InvoiceReminder', 'InvoiceListItem', 'InvoiceDunningBanner', 'InvoiceSearchHit', 'InvoicePrintout', 'InvoiceMiniCard', 'InvoiceLedgerLine'];
const PY_ORDER_CONSUMERS = [['exports', 'orders_csv'], ['notifications', 'order_confirmation_email'], ['notifications', 'order_shipped_sms'], ['search', 'order_index'], ['webhooks', 'order_created_payload'],
  ['reports', 'daily_orders'], ['fulfilment', 'pick_slip'], ['support', 'order_ticket_title'], ['analytics', 'order_event'], ['exports', 'orders_xml']];
const PY_INVOICE_CONSUMERS = [['exports', 'invoices_csv'], ['notifications', 'invoice_reminder_email'], ['search', 'invoice_index'], ['reports', 'monthly_invoices'], ['webhooks', 'invoice_paid_payload'], ['support', 'invoice_ticket_title']];

function orderComponent(name, field, rand) {
  const extra = pick(rand, ['order.email', 'order.status', '(order.total_cents / 100).toFixed(2)']);
  return `import type { OrderDto } from '@/api/types';

/** ${name.replace(/([a-z])([A-Z])/g, '$1 $2')} for one order. */
export function ${name}(order: OrderDto): string {
  return [order.id, order.${field}, ${extra}].join(' · ');
}
`;
}

function invoiceComponent(name) {
  return `import type { InvoiceDto } from '@/api/types';

/** ${name.replace(/([a-z])([A-Z])/g, '$1 $2')} for one invoice. */
export function ${name}(invoice: InvoiceDto): string {
  return [invoice.id, invoice.customer_name, (invoice.amount_cents / 100).toFixed(2)].join(' · ');
}
`;
}

function pyConsumer(fn, field, resource) {
  return `"""${fn.replace(/_/g, ' ')}: built from the serialized ${resource} (the API's JSON shape)."""


def ${fn}(${resource}):
    """Return the text for one serialized ${resource} dict."""
    name = ${resource}["${field}"]
    return f"{${resource}['id']}: {name}"
`;
}

/** The repository as a map of relative path → contents, and the grader's metadata. */
export function generate(variant = 'fixture') {
  const ref = variant === 'reference';
  const F = ref ? 'full_name' : 'customer_name';
  const rand = lcg(20261007);
  const files = new Map();
  const set = (rel, text) => files.set(rel, text);

  set('.gitignore', GITIGNORE);
  set('README.md', '# shop\n\n- `api/`: the Python JSON API (`python -m unittest discover -s api/tests -t api`).\n- `web/`: the TypeScript web client (`cd web && npm test`).\n\nThe JSON contract lives in `api/shop_api/serializers` and `web/src/api/types.ts`.\n');

  // ---- Python API
  set('api/shop_api/__init__.py', '"""The shop JSON API."""\n');
  set('api/shop_api/models/__init__.py', '');
  set('api/shop_api/models/order.py', 'from dataclasses import dataclass\n\n\n@dataclass\nclass OrderRow:\n    """An `orders` table row. `customer_name` is the column name and stays as it is."""\n\n    id: str\n    customer_name: str\n    email: str\n    total_cents: int\n    status: str = "open"\n');
  set('api/shop_api/models/invoice.py', 'from dataclasses import dataclass\n\n\n@dataclass\nclass InvoiceRow:\n    id: str\n    order_id: str\n    customer_name: str\n    amount_cents: int\n');
  set('api/shop_api/models/customer.py', 'from dataclasses import dataclass\n\n\n@dataclass\nclass Customer:\n    id: str\n    customer_name: str\n    tier: str = "standard"\n');
  set('api/shop_api/db/__init__.py', '');
  set('api/shop_api/db/orders_table.py', '"""SQL for the orders table (column names are the database\'s, not the API\'s)."""\n\nSELECT_ORDER = "SELECT id, customer_name, email, total_cents, status FROM orders WHERE id = ?"\nINSERT_ORDER = "INSERT INTO orders (id, customer_name, email, total_cents, status) VALUES (?, ?, ?, ?, ?)"\n\n\ndef row_to_order(row):\n    from ..models.order import OrderRow\n    return OrderRow(id=row[0], customer_name=row[1], email=row[2], total_cents=row[3], status=row[4])\n');
  set('api/shop_api/db/invoices_table.py', '"""SQL for the invoices table."""\n\nSELECT_INVOICE = "SELECT id, order_id, customer_name, amount_cents FROM invoices WHERE id = ?"\n');
  set('api/shop_api/serializers/__init__.py', 'from .invoice import serialize_invoice\nfrom .order import serialize_order\n\n__all__ = ["serialize_invoice", "serialize_order"]\n');
  set('api/shop_api/serializers/order.py', `def serialize_order(row):
    """The Order resource as the API returns it."""
    return {
        "id": row.id,
        "${F}": row.customer_name,
        "email": row.email,
        "total_cents": row.total_cents,
        "status": row.status,
    }
`);
  set('api/shop_api/serializers/invoice.py', 'def serialize_invoice(row):\n    """The Invoice resource as the API returns it."""\n    return {"id": row.id, "order_id": row.order_id, "customer_name": row.customer_name, "amount_cents": row.amount_cents}\n');
  set('api/shop_api/serializers/customer.py', 'def serialize_customer(c):\n    return {"id": c.id, "customer_name": c.customer_name, "tier": c.tier}\n');
  set('api/shop_api/parsers/__init__.py', '');
  set('api/shop_api/parsers/order.py', `from ..models.order import OrderRow


class BadRequest(ValueError):
    pass


def parse_create_order(body, new_id):
    """Validate a create-order request body and build the row to insert."""
    name = (body.get("${F}") or "").strip()
    if not name:
        raise BadRequest("${F} is required")
    return OrderRow(id=new_id, customer_name=name, email=body.get("email", ""), total_cents=int(body.get("total_cents", 0)))
`);
  set('api/shop_api/routes/__init__.py', '');
  set('api/shop_api/routes/orders.py', 'from ..parsers.order import parse_create_order\nfrom ..serializers import serialize_order\n\n\ndef list_orders(repo):\n    return [serialize_order(r) for r in repo.all()]\n\n\ndef create_order(repo, body):\n    row = parse_create_order(body, repo.next_id())\n    repo.add(row)\n    return 201, serialize_order(row)\n');
  set('api/shop_api/routes/invoices.py', 'from ..serializers import serialize_invoice\n\n\ndef list_invoices(repo):\n    return [serialize_invoice(r) for r in repo.all()]\n');
  const pyOrder = [], pyInvoice = [], pyKeep = ['api/shop_api/models/order.py', 'api/shop_api/models/invoice.py', 'api/shop_api/models/customer.py', 'api/shop_api/db/orders_table.py', 'api/shop_api/db/invoices_table.py',
    'api/shop_api/serializers/invoice.py', 'api/shop_api/serializers/customer.py', 'api/shop_api/routes/invoices.py'];
  const pkgs = new Set();
  for (const [pkg, fn] of PY_ORDER_CONSUMERS) {
    pkgs.add(pkg);
    const rel = `api/shop_api/${pkg}/${fn}.py`;
    set(rel, pyConsumer(fn, F, 'order'));
    pyOrder.push({ file: rel, module: `shop_api.${pkg}.${fn}`, func: fn });
  }
  for (const [pkg, fn] of PY_INVOICE_CONSUMERS) {
    pkgs.add(pkg);
    const rel = `api/shop_api/${pkg}/${fn}.py`;
    set(rel, pyConsumer(fn, 'customer_name', 'invoice'));
    pyInvoice.push({ file: rel, module: `shop_api.${pkg}.${fn}`, func: fn });
    pyKeep.push(rel);
  }
  set('api/shop_api/support/customer_greeting.py', '"""Greeting for the customer profile resource (not an order)."""\n\n\ndef customer_greeting(customer):\n    return f"Hello {customer[\'customer_name\']}"\n');
  pyKeep.push('api/shop_api/support/customer_greeting.py');
  for (const p of pkgs) set(`api/shop_api/${p}/__init__.py`, '');
  const unrelated = [];
  set('api/shop_api/util/__init__.py', '');
  for (const u of ['clock', 'ids', 'money', 'paging', 'retry', 'slugs', 'emails', 'phones', 'tz', 'flags', 'hashing', 'chunks']) {
    const rel = `api/shop_api/util/${u}.py`;
    set(rel, `def ${u}_tag(value):\n    """Prefix a value for logs."""\n    return "${u}:" + str(value)\n`);
    unrelated.push(rel);
  }
  set('api/tests/__init__.py', '');
  set('api/tests/test_orders.py', `import unittest

from shop_api.models.order import OrderRow
from shop_api.parsers.order import BadRequest, parse_create_order
from shop_api.serializers import serialize_order


class OrdersTest(unittest.TestCase):
    def test_serializes_an_order(self):
        out = serialize_order(OrderRow("o1", "Ada Lovelace", "ada@example.com", 1200))
        self.assertEqual(out["${F}"], "Ada Lovelace")
        self.assertEqual(out["total_cents"], 1200)

    def test_parses_a_create_request(self):
        row = parse_create_order({"${F}": " Ada ", "email": "a@x", "total_cents": "5"}, "o9")
        self.assertEqual((row.id, row.customer_name, row.total_cents), ("o9", "Ada", 5))

    def test_rejects_a_missing_name(self):
        with self.assertRaises(BadRequest):
            parse_create_order({}, "o1")
`);
  set('api/tests/test_invoices.py', 'import unittest\n\nfrom shop_api.models.invoice import InvoiceRow\nfrom shop_api.serializers import serialize_invoice\n\n\nclass InvoicesTest(unittest.TestCase):\n    def test_serializes_an_invoice(self):\n        out = serialize_invoice(InvoiceRow("i1", "o1", "Grace Hopper", 900))\n        self.assertEqual(out["customer_name"], "Grace Hopper")\n');

  // ---- TypeScript web client
  set('web/package.json', `${JSON.stringify({
    name: 'shop-web', version: '3.2.0', private: true, type: 'module',
    scripts: {
      typecheck: 'node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json',
      test: 'node node_modules/typescript/bin/tsc -p tsconfig.json && node --import ./scripts/register.mjs --test "build/test/*.test.js"',
    },
  }, null, 2)}\n`);
  set('web/tsconfig.json', `${JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, baseUrl: '.', paths: { '@/*': ['src/*'] }, outDir: 'build', rootDir: '.', skipLibCheck: true, types: [] },
    include: ['src', 'test', 'types'],
  }, null, 2)}\n`);
  set('web/scripts/alias-loader.mjs', ALIAS_LOADER);
  set('web/scripts/register.mjs', ALIAS_REGISTER);
  set('web/types/node-test.d.ts', "declare module 'node:test' {\n  export function test(name: string, fn: () => void | Promise<void>): void;\n}\n\ndeclare module 'node:assert/strict' {\n  const assert: {\n    equal(actual: unknown, expected: unknown, message?: string): void;\n    ok(value: unknown, message?: string): void;\n  };\n  export default assert;\n}\n");
  set('web/src/api/types.ts', `export type OrderStatus = 'open' | 'paid' | 'shipped' | 'cancelled';

/** GET /orders/:id — mirrors api/shop_api/serializers/order.py. */
export interface OrderDto {
  id: string;
  ${F}: string;
  email: string;
  total_cents: number;
  status: OrderStatus;
}

/** POST /orders body — read by api/shop_api/parsers/order.py. */
export interface CreateOrderRequest {
  ${F}: string;
  email: string;
  total_cents: number;
}

/** GET /invoices/:id — mirrors api/shop_api/serializers/invoice.py. */
export interface InvoiceDto {
  id: string;
  order_id: string;
  customer_name: string;
  amount_cents: number;
}

/** GET /customers/:id. */
export interface CustomerDto {
  id: string;
  customer_name: string;
  tier: string;
}
`);
  set('web/src/api/orders.ts', `import type { CreateOrderRequest } from './types';

export interface OrderForm {
  name: string;
  email: string;
  totalCents: number;
}

/** The POST /orders body for a checkout form. */
export function buildCreateOrderRequest(form: OrderForm): CreateOrderRequest {
  return { ${F}: form.name.trim(), email: form.email, total_cents: form.totalCents };
}
`);
  set('web/src/api/client.ts', "export function apiUrl(path: string): string {\n  return '/api' + (path.startsWith('/') ? path : '/' + path);\n}\n");
  const webOrder = [], webInvoice = [], webLegacyOrder = [];
  const webKeep = ['web/src/api/client.ts'];
  for (const c of ORDER_COMPONENTS) {
    const rel = `web/src/components/orders/${c}.ts`;
    set(rel, orderComponent(c, F, rand));
    webOrder.push({ file: rel, name: c });
  }
  for (const c of INVOICE_COMPONENTS) {
    const rel = `web/src/components/invoices/${c}.ts`;
    set(rel, invoiceComponent(c));
    webInvoice.push({ file: rel, name: c });
    webKeep.push(rel);
  }
  // Legacy grid cells read untyped records: the compiler cannot see these.
  for (let i = 1; i <= 8; i++) {
    const id = String(i).padStart(2, '0');
    const rel = `web/src/legacy/grid/orderCell${id}.ts`;
    set(rel, `/** Legacy orders grid, column ${i}: rows come straight from JSON, untyped. */\nexport function orderCell${id}(row: Record<string, unknown>): string {\n  return String(row['id']) + ' / ' + String(row['${F}'] ?? '?');\n}\n`);
    webLegacyOrder.push({ file: rel, name: `orderCell${id}` });
    const irel = `web/src/legacy/grid/invoiceCell${id}.ts`;
    set(irel, `/** Legacy invoices grid, column ${i}. */\nexport function invoiceCell${id}(row: Record<string, unknown>): string {\n  return String(row['id']) + ' / ' + String(row['customer_name'] ?? '?');\n}\n`);
    webKeep.push(irel);
  }
  set('web/src/components/customers/CustomerChip.ts', "import type { CustomerDto } from '@/api/types';\n\nexport function CustomerChip(c: CustomerDto): string {\n  return `${c.customer_name} (${c.tier})`;\n}\n");
  webKeep.push('web/src/components/customers/CustomerChip.ts');
  for (const u of ['debounce', 'format', 'dates', 'storage', 'keyboard', 'focus', 'clipboard', 'colors', 'icons', 'routes', 'i18n', 'flags']) {
    const rel = `web/src/lib/${u}.ts`;
    set(rel, `/** ${u} helpers. */\nexport function ${u}Key(value: string): string {\n  return '${u}:' + value;\n}\n`);
    unrelated.push(rel);
  }
  set('web/test/orders.test.ts', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreateOrderRequest } from '@/api/orders';
import { OrderRow } from '@/components/orders/OrderRow';
import { InvoiceRow } from '@/components/invoices/InvoiceRow';

const order = { id: 'o1', ${F}: 'Ada Lovelace', email: 'ada@example.com', total_cents: 1200, status: 'open' as const };

test('order row shows the customer', () => {
  assert.ok(OrderRow(order).includes('Ada Lovelace'));
});

test('create request carries the name', () => {
  assert.equal(buildCreateOrderRequest({ name: ' Ada ', email: 'a@x', totalCents: 5 }).${F}, 'Ada');
});

test('invoice row shows the customer', () => {
  assert.ok(InvoiceRow({ id: 'i1', order_id: 'o1', customer_name: 'Grace', amount_cents: 900 }).includes('Grace'));
});
`);

  return {
    files,
    meta: { pyOrder, pyInvoice, webOrder, webInvoice, webLegacyOrder, keep: [...pyKeep, ...webKeep], unrelated },
  };
}
