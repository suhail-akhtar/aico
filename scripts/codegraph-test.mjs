/**
 * The code graph (src/codegraph, ADR 0028), offline: accuracy first.
 *
 * What each block proves:
 *   - the masking lexer keeps code and string values, blanks comments and
 *     string bodies, keeps template/f-string interpolations as code;
 *   - TS/JS resolution: tsconfig `extends` + `paths` (`@/*`), barrels,
 *     `export *`, a renaming re-export, namespace imports, `.js`→`.ts`,
 *     index files, CommonJS, a workspace package through `exports` to its
 *     source — and EXACT caller sets with same-named decoys excluded;
 *   - Python: package re-exports, relative levels, `from pkg import module`,
 *     `import a.b as x`, nested source roots — exact caller sets for two
 *     same-named functions;
 *   - Go: go.mod module path, a package clause unlike its folder, aliases,
 *     same-package edges, interface implementations, a directed request path;
 *   - Java/Kotlin, C#, PHP (PSR-4), Ruby, Rust: their scope rules, and
 *     ambiguity giving no edge;
 *   - incremental refresh (only changed files re-parsed; new files attract
 *     edges; deleted ones drop), the store under AICO_HOME and not in the repo;
 *   - git co-change (mega-commits skipped), churn, hotspots;
 *   - analyses: impact layers, path, cycles, orphans, layering rules, Mermaid;
 *   - the CodeGraph tool's answers, ambiguity listed not merged, the deferred
 *     group and its request rule, the schema budget;
 *   - the edit note on a real Edit through the dispatcher (signature change,
 *     rename, once per signature, untouched-only) and the co-change hint;
 *   - the HTTP route refuses an unregistered project;
 *   - when the eng-bench graph-task generators are present: exact caller sets
 *     on their fixtures (the Phase 0 traps).
 *
 * Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(process.env.AICO_TEST_EXPORTS ?? path.join(here, '..', 'dist-test', 'test-exports.js')).href);

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 1200)}` : ''}`); }
}
async function block(name, fn) {
  console.log(`\n${name}`);
  try { await fn(); } catch (err) { failed++; failures.push(`${name}: threw`); console.log(`  FAIL  threw: ${err.stack ?? err}`); }
}
const tmp = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `aico-cg-${tag}-`)));
function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const graphOf = async (dir) => { T.resetCodeGraphCache(); return T.getCodeGraph(dir, { force: true }); };
const id = (g, p) => { const r = T.cgFindFile(g, p); if (r.id === undefined) throw new Error(`no file ${p}`); return r.id; };
const usersOf = (g, file, name, { reexports = false } = {}) => new Set(T.cgSymbolUsers(g, id(g, file), name).filter(u => reexports || u.via !== 'reexport').map(u => g.files[u.file].path));
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const diff = (got, want) => ({ missing: [...want].filter(x => !got.has(x)), extra: [...got].filter(x => !want.has(x)) });
const hasEdge = (g, a, b) => g.edges.some(e => g.files[e.from].path === a && g.files[e.to].path === b);

// ── Lexer ────────────────────────────────────────────────────────────────────
await block('Lexer: code kept, comments and string bodies blanked, interpolations kept', () => {
  const js = T.cgMask("// import x from 'nope'\nconst a = 'import y from \"z\"'; /* import q */\nconst t = `${fmt(a)} done`;\nconst r = /['\"]/g; const d = a / 2;\nconst j = <p>Don't</p>;\nimport k from './k';\n", 'js');
  assert(!js.code.includes('nope') && !js.code.includes('import q'), 'comments are blanked');
  assert(js.code.includes('fmt(a)'), 'a template interpolation stays code');
  assert(js.strings.some(s => s.value === './k'), 'a JSX apostrophe does not swallow the next line\'s import');
  assert(js.lineStarts.length === 7, 'line structure is preserved', js.lineStarts.length);
  const py = T.cgMask('x = f"{format_amount(1)} and {{literal}}"\n# from a import b\ns = """\nfrom c import d\n"""\n', 'py');
  assert(py.code.includes('format_amount(1)') && !py.code.includes('from a import b') && !py.code.includes('from c import d'), 'Python: f-string expressions kept, comments and docstrings blanked');
  const go = T.cgMask('s := `import "x"`\n// import "y"\nimport "z"\n', 'go');
  assert(go.strings.some(s => s.value === 'z') && !go.code.includes('import "y"'), 'Go: raw strings and comments are not code');
  const rs = T.cgMask("fn f<'a>(x: &'a str) -> char { 'c' }\n", 'rs');
  assert(rs.code.includes("<'a>") && rs.strings.some(s => s.value === 'c'), 'Rust: a lifetime is not a char literal');
});

// ── TS/JS ────────────────────────────────────────────────────────────────────
const TS_FIXTURE = {
  'tsconfig.base.json': '{ // comments and trailing commas are allowed\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "#legacy/*": ["src/legacy/*"], }, }, }\n',
  'tsconfig.json': '{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true } }\n',
  'package.json': '{ "name": "store", "private": true, "workspaces": ["packages/*"], "bin": { "store": "./bin/cli.js" } }\n',
  'bin/cli.js': "#!/usr/bin/env node\nconst { formatAmount } = require('../src/lib/format/currency.js');\nconsole.log(formatAmount(1));\n",
  'src/lib/format/currency.ts': '/** Money. */\nexport function formatAmount(cents: number): string {\n  return "$" + (cents / 100).toFixed(2);\n}\nexport function plainAmount(cents: number): string { return String(cents); }\n',
  'src/lib/format/index.ts': "export * from './currency';\nexport * from './dates';\n",
  'src/lib/format/dates.ts': 'export const formatDate = (iso: string): string => iso;\n',
  'src/lib/index.ts': "export { formatAmount, plainAmount } from './format';\nexport type { Money } from './types';\n",
  'src/lib/types.ts': 'export interface Money { cents: number }\n',
  'src/components/ui/index.ts': "export { formatAmount as money } from '@/lib/format';\nexport { default as Button } from './Button';\n",
  'src/components/ui/Button.tsx': "export default function Button(): string { return \"Don't click\"; }\n",
  'src/legacy/pos/formatAmount.ts': "export function formatAmount(cents: number): string { return 'USD ' + cents; }\n",
  'src/legacy/pos/receipt.ts': "import { formatAmount } from '#legacy/pos/formatAmount';\nexport const line = (c: number): string => formatAmount(c);\n",
  'src/reports/formatAmount.ts': 'export const formatAmount = (n: number): string => n.toLocaleString();\n',
  'src/reports/row.ts': "import { formatAmount } from './formatAmount';\nexport const row = (n: number): string => formatAmount(n);\n",
  'src/features/a.ts': "import { formatAmount } from '@/lib/format/currency';\nexport const a = (c: number): string => `${formatAmount(c)}!`;\n",
  'src/features/b.ts': "import { formatAmount } from '@/lib';\n// formatAmount(0) in a comment is not a use\nexport const b = (c: number): string => formatAmount(c);\n",
  'src/features/c.tsx': "import { money } from '@/components/ui';\nexport function C(p: { c: number }) { return <span title=\"Don't\">{money(p.c)}</span>; }\n",
  'src/features/d.ts': "import * as fmt from '@/lib/format';\nexport const d = (c: number): string => fmt.formatAmount(c) + fmt.formatDate('x');\n",
  'src/features/e.ts': "import { formatAmount as fa } from '../lib/format/currency.js';\nexport const e = (c: number): string => fa(c);\n",
  'src/features/f.ts': "export async function f(c: number): Promise<string> { const m = await import('@/lib/format/currency'); return m.formatAmount(c); }\n",
  'src/features/g.ts': "import Button from '@/components/ui/Button';\nimport { Button as B2 } from '@/components/ui';\nexport const g = (): string => Button() + B2();\n",
  'src/features/only-types.ts': "import type { Money } from '@/lib';\nexport const h = (m: Money): number => m.cents;\n",
  'src/features/unrelated.ts': "const formatAmount = (x: number) => x; export const u = formatAmount(1);\n",
  'packages/shared/package.json': '{ "name": "@acme/shared", "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }, "./money": "./dist/money.js" } }\n',
  'packages/shared/src/index.ts': "export const shared = 1;\n",
  'packages/shared/src/money.ts': "export const cents = (n: number): number => n * 100;\n",
  'src/features/ws.ts': "import { shared } from '@acme/shared';\nimport { cents } from '@acme/shared/money';\nimport React from 'react';\nexport const ws = shared + cents(1) + String(React);\n",
  'src/app/(shop)/cart/page.tsx': "import { a } from '@/features/a';\nexport default function Page() { return a(1); }\n",
  'src/orphan.ts': 'export const nobodyImportsMe = 1;\n',
  'test/currency.test.ts': "import { formatAmount } from '../src/lib/format/currency';\nformatAmount(1);\n",
};

await block('TS/JS: aliases, barrels, renaming re-exports, namespaces — exact callers, decoys excluded', async () => {
  const dir = writeTree(tmp('ts'), TS_FIXTURE);
  const g = await graphOf(dir);
  const got = usersOf(g, 'src/lib/format/currency.ts', 'formatAmount');
  const want = new Set(['bin/cli.js', 'src/features/a.ts', 'src/features/b.ts', 'src/features/c.tsx', 'src/features/d.ts', 'src/features/e.ts', 'src/features/f.ts', 'test/currency.test.ts']);
  assert(sameSet(got, want), 'formatAmount: exactly its 8 users (alias, barrel, money re-export, namespace, .js→.ts, dynamic import, require, test)', diff(got, want));
  const re = usersOf(g, 'src/lib/format/currency.ts', 'formatAmount', { reexports: true });
  assert(re.has('src/components/ui/index.ts') && re.has('src/lib/index.ts'), 'the renaming and named re-exports are known as re-exporters');
  assert(sameSet(usersOf(g, 'src/legacy/pos/formatAmount.ts', 'formatAmount'), new Set(['src/legacy/pos/receipt.ts'])), 'the legacy decoy has only its own caller (resolved through a second paths alias)');
  assert(sameSet(usersOf(g, 'src/reports/formatAmount.ts', 'formatAmount'), new Set(['src/reports/row.ts'])), 'the reports decoy has only its own caller');
  const c = T.cgSymbolUsers(g, id(g, 'src/lib/format/currency.ts'), 'formatAmount').find(u => g.files[u.file].path === 'src/features/c.tsx');
  assert(c?.local === 'money' && c.lines[0] === 2, 'the alias user is reported under its local name, with its line', c);
  const b = T.cgSymbolUsers(g, id(g, 'src/lib/format/currency.ts'), 'formatAmount').find(u => g.files[u.file].path === 'src/features/b.ts');
  assert(b && !b.lines.includes(2) && b.lines.includes(3), 'a mention in a comment is not a use', b);
  assert(sameSet(usersOf(g, 'src/components/ui/Button.tsx', 'default'), new Set(['src/features/g.ts'])), 'a default export, imported directly and through `export { default as Button }`');
  assert(hasEdge(g, 'src/features/ws.ts', 'packages/shared/src/index.ts') && hasEdge(g, 'src/features/ws.ts', 'packages/shared/src/money.ts'), 'a workspace package resolves through `exports` (and its subpath) to source, not dist');
  assert(g.external.get('react')?.length === 1, 'a bare package is external');
  const bEdge = g.edges.find(e => g.files[e.from].path === 'src/features/b.ts' && g.files[e.to].path === 'src/lib/index.ts');
  assert(bEdge?.passThrough === true && hasEdge(g, 'src/features/b.ts', 'src/lib/format/currency.ts'), 'an import through a barrel is a pass-through to the barrel and a real edge to the declaring file');
  assert(g.files[id(g, 'bin/cli.js')].entry === 'cli' && g.files[id(g, 'src/app/(shop)/cart/page.tsx')].entry === 'page', 'entry points: package bin and a Next.js page');
  const orph = T.cgOrphans(g).map(i => g.files[i].path);
  assert(orph.includes('src/orphan.ts') && !orph.includes('bin/cli.js') && !orph.includes('test/currency.test.ts'), 'orphans exclude entry points and tests', orph);
  assert(g.unresolved.length === 0, 'no local import left unresolved', g.unresolved);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert(T.cgFindFile(g, 'SRC/Components/UI/button.tsx').id === id(g, 'src/components/ui/Button.tsx'), 'lookups fold case on a case-insensitive file system, stored paths keep theirs');
  }
  assert(g.files[id(g, 'src/components/ui/Button.tsx')].path === 'src/components/ui/Button.tsx', 'stored paths keep their case (PascalCase components)');
  // The store lives in AICO_HOME, never in the project.
  assert(!fs.existsSync(path.join(dir, '.buruj-lens')) && fs.readdirSync(dir).every(n => !/codegraph/i.test(n)), 'nothing is written into the project');
  await new Promise(r => setTimeout(r, 300));
  const store = path.join(process.env.AICO_HOME, 'codegraph');
  assert(fs.existsSync(store) && fs.readdirSync(store).some(n => n.endsWith('.json')), 'the index is stored under AICO_HOME/codegraph');
});

await block('TS/JS: impact, path, cycles, layering rules, communities, Mermaid', async () => {
  const dir = writeTree(tmp('ts2'), {
    ...TS_FIXTURE,
    'src/cyc/x.ts': "import { y } from './y';\nexport const x = (): number => y() + 1;\n",
    'src/cyc/y.ts': "import { z } from './z';\nexport const y = (): number => z();\n",
    'src/cyc/z.ts': "import { x } from './x';\nexport const z = (): number => 0 && x();\n",
  });
  const g = await graphOf(dir);
  const layers = T.cgImpactLayers(g, [id(g, 'src/features/a.ts')], 3);
  assert(layers[0]?.files.map(i => g.files[i].path).includes('src/app/(shop)/cart/page.tsx'), 'impact: the page that imports a feature is at depth 1');
  const p = T.cgShortestPath(g, id(g, 'src/app/(shop)/cart/page.tsx'), id(g, 'src/lib/format/currency.ts'));
  assert(p && p.map(i => g.files[i].path).join(' > ') === 'src/app/(shop)/cart/page.tsx > src/features/a.ts > src/lib/format/currency.ts', 'path: page → feature → util, directed', p?.map(i => g.files[i].path));
  assert(T.cgShortestPath(g, id(g, 'src/lib/format/currency.ts'), id(g, 'src/features/a.ts')) === undefined, 'no path against the direction of dependency');
  const cyc = T.cgCycles(g).map(c => c.map(i => g.files[i].path).sort().join(','));
  assert(cyc.includes('src/cyc/x.ts,src/cyc/y.ts,src/cyc/z.ts'), 'a three-file import cycle is found', cyc);
  const v = T.cgLayerViolations(g, [{ from: 'src/features/**', to: 'src/lib/format/**' }]);
  assert(v.length >= 3 && v.every(x => g.files[x.from].path.startsWith('src/features/')), 'layering rule: features importing format/** are violations', v.length);
  assert(T.cgGlobToRegExp('src/**/*.ts').test('src/a/b/c.ts') && !T.cgGlobToRegExp('src/*.ts').test('src/a/b.ts'), 'globs: ** crosses folders, * does not');
  assert(g.communities.length >= 2 && g.communities.every(c => c.label), 'communities are found and labelled');
  const mer = T.cgMermaid(g);
  assert(mer.startsWith('flowchart LR') && /c\d+\["/.test(mer), 'the architecture exports as Mermaid');
  const ctx = T.cgSelectionContext(g, [id(g, 'src/lib/format/currency.ts')]);
  assert(ctx.includes('formatAmount (8 users)') && ctx.includes('Used by:'), 'selection context names exports with user counts and users', ctx.slice(0, 300));
  const payload = T.cgViewPayload(g);
  assert(payload.files.length === g.files.length && payload.edges.every(e => e.length === 7) && payload.cycles.length >= 1, 'the view payload is compact tuples with cycles');
});

// ── Python ───────────────────────────────────────────────────────────────────
await block('Python: same-named functions, every import style — exact callers', async () => {
  const dir = writeTree(tmp('py'), {
    'app/__init__.py': '',
    'app/billing/__init__.py': '"""Billing."""\nfrom .processor import process\n\n__all__ = ["process"]\n',
    'app/billing/processor.py': 'def process(invoice, *, idempotency_key=None):\n    return invoice\n',
    'app/audit/__init__.py': 'from .processor import process\n',
    'app/audit/processor.py': 'def process(event):\n    return event\n',
    'app/jobs/a.py': 'from app.billing import process\n\ndef run(inv):\n    return process(inv)\n',
    'app/jobs/b.py': 'from app.billing.processor import process as charge_invoice\n\ndef run(inv):\n    return charge_invoice(inv)\n',
    'app/jobs/c.py': 'from app import billing\nfrom app import audit\n\ndef run(inv):\n    audit.process(inv)\n    return billing.process(inv)\n',
    'app/jobs/d.py': 'import app.billing.processor as bp\n\ndef run(inv):\n    return bp.process(inv)\n',
    'app/jobs/e.py': 'from ..billing import process as bill\n\ndef run(inv):\n    return bill(inv)\n',
    'app/jobs/f.py': 'import app.billing.processor\n\ndef run(inv):\n    return app.billing.processor.process(inv)\n',
    'app/jobs/g.py': 'from app.audit import process\n\ndef run(e):\n    return process(e)\n',
    'app/pipeline/stage.py': 'class Stage:\n    def process(self, item):\n        return item\n',
    'app/pipeline/run.py': 'from .stage import Stage\n\ndef go(x):\n    return Stage().process(x)\n',
    'app/main.py': 'import os\nimport requests\nfrom app.jobs.a import run\n\nif __name__ == "__main__":\n    run(1)\n',
    'api/shop_api/__init__.py': '',
    'api/shop_api/models.py': 'class Order:\n    pass\n',
    'api/shop_api/views.py': 'from shop_api.models import Order\n\ndef view():\n    return Order()\n',
    'tests/test_jobs.py': 'from app.jobs.a import run\n\ndef test_run():\n    assert run(1) == 1\n',
  });
  const g = await graphOf(dir);
  const billing = usersOf(g, 'app/billing/processor.py', 'process');
  const wantBilling = new Set(['app/jobs/a.py', 'app/jobs/b.py', 'app/jobs/c.py', 'app/jobs/d.py', 'app/jobs/e.py', 'app/jobs/f.py']);
  assert(sameSet(billing, wantBilling), 'billing process: exactly the six callers (package, alias, `from app import billing`, `import … as`, relative, dotted)', diff(billing, wantBilling));
  const audit = usersOf(g, 'app/audit/processor.py', 'process');
  assert(sameSet(audit, new Set(['app/jobs/c.py', 'app/jobs/g.py'])), 'audit process: only its own two callers, never merged with billing', [...audit]);
  assert(usersOf(g, 'app/billing/processor.py', 'process', { reexports: true }).has('app/billing/__init__.py'), 'the package __init__ is a re-exporter, not a caller');
  assert(hasEdge(g, 'api/shop_api/views.py', 'api/shop_api/models.py'), 'a nested source root (api/shop_api imported as shop_api) resolves');
  assert(g.external.has('requests') && !g.external.has('os'), 'third-party packages are external; the standard library is not');
  assert(g.files[id(g, 'app/main.py')].entry === 'main', '`if __name__ == "__main__"` is an entry point');
  assert(g.files[id(g, 'tests/test_jobs.py')].isTest, 'tests/ files are tests');
});

// ── Go ───────────────────────────────────────────────────────────────────────
await block('Go: module paths, package clauses unlike folders, same package, interfaces, request path', async () => {
  const dir = writeTree(tmp('go'), {
    'go.mod': 'module github.com/acme/shop\n\ngo 1.22\n',
    'cmd/api/main.go': 'package main\n\nimport "github.com/acme/shop/internal/httpapi"\n\nfunc main() { httpapi.NewRouter() }\n',
    'internal/httpapi/router.go': 'package httpapi\n\nfunc NewRouter() { orderRoutes(nil) }\n',
    'internal/httpapi/routes.go': 'package httpapi\n\nfunc orderRoutes(p OrderPlacer) { handleCreate(p) }\n',
    'internal/httpapi/handlers.go': 'package httpapi\n\nimport ord "github.com/acme/shop/internal/service/orders"\n\nfunc handleCreate(p OrderPlacer) { p.PlaceOrder(ord.Input{}) }\n',
    'internal/httpapi/ports.go': 'package httpapi\n\nimport "github.com/acme/shop/internal/service/orders"\n\n// OrderPlacer is what handlers need.\ntype OrderPlacer interface {\n\tPlaceOrder(in ordering.Input) (ordering.Order, error)\n\tGetOrder(id string) (ordering.Order, error)\n}\n',
    'internal/service/orders/service.go': 'package ordering\n\ntype Service struct{ store Store }\n\nfunc (s *Service) PlaceOrder(in Input) (Order, error) { return Order{}, s.store.Insert(nil) }\nfunc (s *Service) GetOrder(id string) (Order, error) { return Order{}, nil }\n',
    'internal/service/orders/types.go': 'package ordering\n\ntype Input struct{ SKU string }\ntype Order struct{ ID string }\n',
    'internal/service/orders/ports.go': 'package ordering\n\n// Store persists orders.\ntype Store interface {\n\tInsert(o *Order) error\n\tByID(id string) (Order, error)\n}\n',
    'internal/service/legacy/service.go': 'package orders\n\ntype Service struct{}\n\nfunc (s *Service) Create() error { return nil }\n',
    'internal/store/order_store.go': 'package store\n\nimport "github.com/acme/shop/internal/service/orders"\n\ntype OrderStore struct{}\n\nfunc (s *OrderStore) Insert(o *ordering.Order) error { return nil }\nfunc (s *OrderStore) ByID(id string) (ordering.Order, error) { return ordering.Order{}, nil }\n',
    'internal/store/customer_store.go': 'package store\n\ntype Customer struct{}\ntype CustomerStore struct{}\n\nfunc (s *CustomerStore) Insert(c *Customer) error { return nil }\nfunc (s *CustomerStore) ByID(id string) (Customer, error) { return Customer{}, nil }\n',
  });
  const g = await graphOf(dir);
  assert(hasEdge(g, 'internal/httpapi/handlers.go', 'internal/service/orders/types.go'), 'an aliased import resolves to the file declaring the used type');
  assert(hasEdge(g, 'internal/httpapi/ports.go', 'internal/service/orders/types.go'), 'the package clause `ordering` (folder `orders`) is how importers name it');
  assert(!hasEdge(g, 'internal/httpapi/ports.go', 'internal/service/legacy/service.go'), 'the legacy package named `orders` is not confused with it');
  assert(hasEdge(g, 'internal/httpapi/routes.go', 'internal/httpapi/handlers.go') && hasEdge(g, 'internal/httpapi/router.go', 'internal/httpapi/routes.go'), 'same-package calls are edges');
  assert(hasEdge(g, 'internal/httpapi/ports.go', 'internal/service/orders/service.go'), 'an interface links to the type implementing it (method set)');
  assert(hasEdge(g, 'internal/service/orders/ports.go', 'internal/store/order_store.go') && !hasEdge(g, 'internal/service/orders/ports.go', 'internal/store/customer_store.go'), 'shared method names are told apart by the types in their signatures');
  const p = T.cgShortestPath(g, id(g, 'cmd/api/main.go'), id(g, 'internal/store/order_store.go'))?.map(i => g.files[i].path);
  assert(p && p[0] === 'cmd/api/main.go' && p.at(-1) === 'internal/store/order_store.go' && p.includes('internal/service/orders/service.go'), 'a directed path from main to the store, through the service', p);
  assert(g.files[id(g, 'cmd/api/main.go')].entry === 'main', '`package main` + `func main` is an entry point');
  const users = usersOf(g, 'internal/service/orders/types.go', 'Input');
  assert(users.has('internal/httpapi/handlers.go') && users.has('internal/httpapi/ports.go'), 'symbol users of a Go type, through alias and clause', [...users]);
});

// ── Other languages ─────────────────────────────────────────────────────────
await block('Java/Kotlin, C#, PHP, Ruby, Rust: scope rules, ambiguity gives no edge', async () => {
  const dir = writeTree(tmp('poly'), {
    'java/src/main/java/com/acme/billing/Invoice.java': 'package com.acme.billing;\n\npublic class Invoice { }\n',
    'java/src/main/java/com/acme/billing/InvoiceService.java': 'package com.acme.billing;\n\npublic class InvoiceService { Invoice make() { return new Invoice(); } }\n',
    'java/src/main/java/com/acme/api/Api.java': 'package com.acme.api;\n\nimport com.acme.billing.InvoiceService;\n\npublic class Api { public static void main(String[] a) { new InvoiceService(); } }\n',
    'kt/src/main/kotlin/com/acme/util/Strings.kt': 'package com.acme.util\n\nfun slugify(s: String): String = s\n',
    'kt/src/main/kotlin/com/acme/web/Page.kt': 'package com.acme.web\n\nimport com.acme.util.slugify\n\nclass Page { val s = slugify("x") }\n',
    'cs/Billing/Invoice.cs': 'namespace Acme.Billing;\n\npublic class Invoice { }\n',
    'cs/Billing/Tax.cs': 'namespace Acme.Billing\n{\n    public class Tax { public Invoice For() => new Invoice(); }\n}\n',
    'cs/Api/Controller.cs': 'using Acme.Billing;\nusing Newtonsoft.Json;\n\nnamespace Acme.Api;\n\npublic class Controller { Tax t; Report r; }\n',
    'cs/Reports/A/Report.cs': 'namespace Acme.Reports.A;\npublic class Report { }\n',
    'cs/Reports/B/Report.cs': 'namespace Acme.Reports.B;\npublic class Report { }\n',
    'cs/Reports/Uses.cs': 'using Acme.Reports.A;\nusing Acme.Reports.B;\nnamespace Acme.Reports;\npublic class Uses { Report r; }\n',
    'php/composer.json': '{ "autoload": { "psr-4": { "App\\\\": "src/" } } }\n',
    'php/src/Models/User.php': '<?php\nnamespace App\\Models;\n\nclass User { }\n',
    'php/src/Models/Team.php': '<?php\nnamespace App\\Models;\n\nclass Team { public function owner(): User { return new User(); } }\n',
    'php/src/Http/UserController.php': '<?php\nnamespace App\\Http;\n\nuse App\\Models\\User;\n\nclass UserController { public function show(): User { return new User(); } }\n',
    'rb/lib/billing.rb': 'require_relative "billing/invoice"\n\nmodule Billing\nend\n',
    'rb/lib/billing/invoice.rb': 'class Invoice\n  def total; 0; end\nend\n',
    'rb/app/report.rb': 'class Report\n  def run; Invoice.new.total + Shared.new.x; end\nend\n',
    'rb/app/shared_a.rb': 'class Shared; end\n',
    'rb/app/shared_b.rb': 'class Shared; end\n',
    'rs/Cargo.toml': '[package]\nname = "shop-core"\nversion = "0.1.0"\n',
    'rs/src/lib.rs': 'pub mod money;\nmod orders;\n',
    'rs/src/money.rs': 'pub struct Cents(pub i64);\npub fn add(a: Cents, b: Cents) -> Cents { Cents(a.0 + b.0) }\n',
    'rs/src/orders/mod.rs': 'pub mod place;\n',
    'rs/src/orders/place.rs': "use crate::money::{add, Cents};\nuse super::super::money::Cents as C2;\npub fn place<'a>(x: &'a str) -> Cents { add(Cents(1), C2(2)) }\n",
  });
  const g = await graphOf(dir);
  assert(hasEdge(g, 'java/src/main/java/com/acme/api/Api.java', 'java/src/main/java/com/acme/billing/InvoiceService.java'), 'Java: an import resolves by package + type');
  assert(hasEdge(g, 'java/src/main/java/com/acme/billing/InvoiceService.java', 'java/src/main/java/com/acme/billing/Invoice.java'), 'Java: the same package needs no import');
  assert(g.files[id(g, 'java/src/main/java/com/acme/api/Api.java')].entry === 'main', 'Java: static void main is an entry point');
  assert(hasEdge(g, 'kt/src/main/kotlin/com/acme/web/Page.kt', 'kt/src/main/kotlin/com/acme/util/Strings.kt'), 'Kotlin: a top-level function import');
  assert(hasEdge(g, 'cs/Api/Controller.cs', 'cs/Billing/Tax.cs') && hasEdge(g, 'cs/Billing/Tax.cs', 'cs/Billing/Invoice.cs'), 'C#: using + namespace scope (block and file-scoped)');
  assert(!g.edges.some(e => g.files[e.from].path === 'cs/Reports/Uses.cs' && /Report\.cs$/.test(g.files[e.to].path)), 'C#: a type name in two visible namespaces is ambiguous — no edge');
  assert(g.external.has('Newtonsoft'), 'C#: a namespace from outside the project is an external package');
  assert(hasEdge(g, 'php/src/Http/UserController.php', 'php/src/Models/User.php') && hasEdge(g, 'php/src/Models/Team.php', 'php/src/Models/User.php'), 'PHP: PSR-4 `use` and same-namespace class');
  assert(hasEdge(g, 'rb/lib/billing.rb', 'rb/lib/billing/invoice.rb') && hasEdge(g, 'rb/app/report.rb', 'rb/lib/billing/invoice.rb'), 'Ruby: require_relative and a unique constant (inferred)');
  assert(!g.edges.some(e => g.files[e.from].path === 'rb/app/report.rb' && /shared_/.test(g.files[e.to].path)), 'Ruby: a constant declared twice is ambiguous — no edge');
  assert(g.edges.find(e => g.files[e.from].path === 'rb/app/report.rb')?.confidence === 'inferred', 'Ruby constant edges are labelled inferred');
  assert(hasEdge(g, 'rs/src/lib.rs', 'rs/src/money.rs') && hasEdge(g, 'rs/src/orders/mod.rs', 'rs/src/orders/place.rs'), 'Rust: `mod x;` from lib.rs and from mod.rs');
  assert(usersOf(g, 'rs/src/money.rs', 'add').has('rs/src/orders/place.rs') && usersOf(g, 'rs/src/money.rs', 'Cents').has('rs/src/orders/place.rs'), 'Rust: `use crate::…::{a, B}` and `super::` paths resolve to items');
});

// ── Incremental ──────────────────────────────────────────────────────────────
await block('Incremental: only changed files re-parse; new files attract edges; deletions drop', async () => {
  const dir = writeTree(tmp('inc'), {
    'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    'src/b.ts': 'export const b = 1;\n',
    'src/c.ts': "import { later } from './later';\nexport const c = later;\n",
  });
  T.resetCodeGraphCache();
  const g1 = await T.getCodeGraph(dir, { force: true });
  assert(g1.stats.parsed === 3 && g1.unresolved.some(u => u.spec === './later'), 'first build parses everything; a missing local import is reported unresolved');
  fs.writeFileSync(path.join(dir, 'src/later.ts'), 'export const later = 2;\n');
  const g2 = await T.getCodeGraph(dir, { force: true });
  assert(g2.stats.parsed === 1 && hasEdge(g2, 'src/c.ts', 'src/later.ts'), 'a new file is parsed alone and the previously unresolved import now links to it');
  fs.rmSync(path.join(dir, 'src/b.ts'));
  const g3 = await T.getCodeGraph(dir, { force: true });
  assert(g3.files.every(f => f.path !== 'src/b.ts') && !g3.edges.some(e => g3.files[e.to].path === 'src/b.ts'), 'a deleted file and its edges are gone');
  const g4 = await T.getCodeGraph(dir, { force: true });
  assert(g4.stats.parsed === 0 && g4.version === g3.version, 'nothing changed: nothing parsed, same version');
  // A fresh process (cache cleared) reuses the stored parses.
  T.resetCodeGraphCache();
  await new Promise(r => setTimeout(r, 200));
  const g5 = await T.getCodeGraph(dir, { force: true });
  assert(g5.stats.parsed === 0 && g5.files.length === g4.files.length, 'a restart reloads parses from the store instead of re-parsing');
});

// ── Git ──────────────────────────────────────────────────────────────────────
await block('Git: co-change, churn, mega-commits skipped, hotspots', async () => {
  const log = '\x1eaaa\x1fAnn\x1f1700000000\x1fone\n\nsrc/a.js\nsrc/b.js\n\x1ebbb\x1fBob\x1f1700000100\x1ftwo\n\nsrc/a.js\nsrc/b.js\nsrc/c.js\n';
  const parsed = T.cgParseLog(log, 2);
  assert(parsed.commits === 2 && parsed.skippedLarge === 1 && parsed.pairs.get('src/a.js\0src/b.js') === 1, 'a commit over the per-commit cap is skipped for pairs');
  const hasGit = spawnSync('git', ['--version']).status === 0;
  if (!hasGit) { assert(true, 'git not installed: the live part is skipped'); return; }
  const dir = writeTree(tmp('git'), { 'src/rates.js': 'export const R = { ON: 1 };\n', 'src/parts.js': 'export const P = { ON: 0 };\n', 'src/other.js': 'export const O = 1;\n' });
  const git = (...a) => spawnSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  for (let k = 0; k < 4; k++) {
    fs.appendFileSync(path.join(dir, 'src/rates.js'), `// ${k}\n`); fs.appendFileSync(path.join(dir, 'src/parts.js'), `// ${k}\n`);
    git('add', '-A'); git('commit', '-q', '-m', `region ${k}`);
  }
  fs.appendFileSync(path.join(dir, 'src/other.js'), '// x\n'); git('add', '-A'); git('commit', '-q', '-m', 'other');
  const g = await graphOf(dir);
  const r = id(g, 'src/rates.js');
  const pair = g.cochange.find(c => (c.a === r || c.b === r));
  assert(g.git.available && pair && g.files[pair.a === r ? pair.b : pair.a].path === 'src/parts.js' && pair.count === 5 && pair.confidence === 1, 'two files with no import between them are found to change together', pair);
  assert(g.files[r].churn === 5 && g.files[r].authors[0]?.[0] === 'T', 'churn and authors per file');
  assert(g.files.some(f => f.hotspot > 0), 'hotspots are scored from churn');
  const out = await T.runInContext({ cwd: dir, sessionId: 'cg-git' }, () => T.codeGraphTool({ action: 'cochange', target: 'src/rates.js' }));
  assert(out.includes('src/parts.js') && out.includes('no import between them'), 'CodeGraph cochange says so', out);
});

// ── Tool ─────────────────────────────────────────────────────────────────────
await block('CodeGraph tool: answers, ambiguity listed not merged, deferred group, request rule, budget', async () => {
  const dir = writeTree(tmp('tool'), TS_FIXTURE);
  T.resetCodeGraphCache();
  const run = (input) => T.runInContext({ cwd: dir, sessionId: 'cg-tool' }, () => T.codeGraphTool(input));
  const impact = await run({ action: 'impact', target: 'src/lib/format/currency.ts#formatAmount' });
  assert(impact.includes('Used directly in 8 file(s)') && impact.includes('c.tsx:2 as money') && impact.includes('Re-exported by'), 'impact on a symbol lists every user with line and alias', impact);
  assert(!impact.includes('receipt.ts') && !impact.includes('row.ts'), 'decoy callers are not in it');
  const ambiguous = await run({ action: 'impact', target: 'formatAmount' });
  assert(/declared in 3 files/.test(ambiguous) && ambiguous.includes('src/legacy/pos/formatAmount.ts#formatAmount'), 'a bare ambiguous name lists its declarations instead of merging them', ambiguous);
  const fileImpact = await run({ action: 'impact', target: 'src/features/a.ts', depth: 2 });
  assert(fileImpact.includes('Depth 1') && fileImpact.includes('page.tsx'), 'file impact by depth');
  const deps = await run({ action: 'dependencies', target: 'src/features/ws.ts' });
  assert(deps.includes('packages/shared/src/ — index.ts [shared], money.ts [cents]') && deps.includes('External: react'), 'dependencies include project files and external packages', deps);
  const pathOut = await run({ action: 'path', target: 'src/app/(shop)/cart/page.tsx', to: 'src/lib/format/currency.ts' });
  assert(pathOut.includes('→ src/features/a.ts') && pathOut.includes('via formatAmount'), 'path answer names the hops and the symbols on them', pathOut);
  const overview = await run({ action: 'overview' });
  assert(overview.includes('source files') && overview.includes('Modules'), 'overview');
  const diagram = await run({ action: 'diagram' });
  assert(diagram.startsWith('```mermaid\nflowchart LR'), 'diagram is a Mermaid block for documents');
  const none = await run({ action: 'impact', target: 'src/nope.ts' });
  assert(none.includes('No indexed file'), 'an unknown target says so and names the fallback');
  assert(T.groupOf('CodeGraph') === 'graph' && T.isDeferred('CodeGraph', new Set()) && !T.isDeferred('CodeGraph', new Set(['graph'])), 'CodeGraph is in the deferred `graph` group');
  for (const text of ['Update every caller of formatAmount', 'what uses parseConfig?', 'Where is AuthService used?', 'How does a POST /api/orders request reach the database?', 'explain the architecture', 'rename the field', 'find circular imports']) {
    assert(T.groupsForRequest(text).includes('graph'), `request rule loads the graph group: "${text}"`);
  }
  assert(!T.groupsForRequest('what is the weather in Paris').includes('graph'), 'an unrelated request does not');
  const schema = JSON.stringify(T.codeGraphDefinition);
  assert(schema.length < 2600, `the CodeGraph schema is small (${schema.length} chars, sent only once loaded)`);
});

// ── Edit note ────────────────────────────────────────────────────────────────
await block('Edit note: a changed exported signature names the untouched users, through a real Edit', async () => {
  const dir = writeTree(tmp('edit'), TS_FIXTURE);
  T.resetCodeGraphCache();
  await T.getCodeGraph(dir, { force: true });
  const ctx = { cwd: dir, sessionId: 'cg-edit' };
  const result = await T.runInContext(ctx, async () => {
    T.cgResetEditNotes();
    // Touch one caller first, through the normal path: it must not be listed.
    await T.executeTool('Read', { file_path: path.join(dir, 'src/features/a.ts') });
    await T.executeTool('Edit', { file_path: path.join(dir, 'src/features/a.ts'), old_str: 'formatAmount(c)', new_str: "formatAmount(c, 'USD')" });
    await T.executeTool('Read', { file_path: path.join(dir, 'src/lib/format/currency.ts') });
    return T.executeTool('Edit', { file_path: path.join(dir, 'src/lib/format/currency.ts'), old_str: 'export function formatAmount(cents: number): string {', new_str: 'export function formatAmount(cents: number, currency: string): string {' });
  });
  assert(typeof result === 'string' && result.includes('Code graph check') && result.includes('`formatAmount` changed its signature'), 'the Edit result carries the note', result);
  assert(result.includes('8 file(s) use it and 7 have not been changed') && result.includes('src/features/c.tsx:2 as money'), 'the note counts users, excludes the one already edited, names the alias user', result);
  assert(!result.includes('src/features/a.ts') && !result.includes('receipt.ts'), 'neither the edited caller nor a decoy is listed');
  const again = await T.runInContext(ctx, async () => {
    await T.executeTool('Read', { file_path: path.join(dir, 'src/lib/format/currency.ts') });
    return T.executeTool('Edit', { file_path: path.join(dir, 'src/lib/format/currency.ts'), old_str: 'return "$"', new_str: 'return "$" ' });
  });
  assert(!String(again).includes('Code graph check'), 'a body-only edit (same signature) adds nothing');
  const renamed = await T.runInContext(ctx, async () => {
    await T.executeTool('Read', { file_path: path.join(dir, 'src/lib/format/currency.ts') });
    return T.executeTool('Edit', { file_path: path.join(dir, 'src/lib/format/currency.ts'), old_str: 'export function plainAmount(', new_str: 'export function rawAmount(' });
  });
  // plainAmount is imported nowhere but re-exported by src/lib/index.ts by name.
  assert(String(renamed).includes('`plainAmount` was removed or renamed') && String(renamed).includes('src/lib/index.ts'), 'a rename names the named re-export that now points at nothing', renamed);
  assert(T.cgChangedSymbols([{ name: 'f', kind: 'function', line: 1, sig: 'export function f(a)' }], [{ name: 'f', kind: 'function', line: 1, sig: 'export function f(a, b)' }])[0]?.change === 'signature', 'changedSymbols: a different header is a signature change');
});

await block('Edit note: a co-change partner with no import is named once', async () => {
  const hasGit = spawnSync('git', ['--version']).status === 0;
  if (!hasGit) { assert(true, 'git not installed: skipped'); return; }
  const dir = writeTree(tmp('editco'), { 'src/rates.js': 'export const R = { ON: 1 };\n', 'src/edi/partitions.js': 'export const P = { ON: 0 };\n' });
  const git = (...a) => spawnSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  for (let k = 0; k < 3; k++) {
    fs.appendFileSync(path.join(dir, 'src/rates.js'), `// ${k}\n`); fs.appendFileSync(path.join(dir, 'src/edi/partitions.js'), `// ${k}\n`);
    git('add', '-A'); git('commit', '-q', '-m', `region ${k}`);
  }
  T.resetCodeGraphCache();
  await T.getCodeGraph(dir, { force: true });
  const out = await T.runInContext({ cwd: dir, sessionId: 'cg-editco' }, async () => {
    T.cgResetEditNotes();
    await T.executeTool('Read', { file_path: path.join(dir, 'src/rates.js') });
    const first = await T.executeTool('Edit', { file_path: path.join(dir, 'src/rates.js'), old_str: 'ON: 1', new_str: 'ON: 1, NU: 0.05' });
    await T.executeTool('Read', { file_path: path.join(dir, 'src/rates.js') });
    const second = await T.executeTool('Edit', { file_path: path.join(dir, 'src/rates.js'), old_str: 'NU: 0.05', new_str: 'NU: 0.05 ' });
    return { first, second };
  });
  assert(String(out.first).includes('Git history: src/edi/partitions.js changed in 4 of the commits') && String(out.first).includes('no import links them'), 'the partner file is named with its history', out.first);
  assert(!String(out.second).includes('Git history'), 'only once per file per turn');
});

await block('Edit note: no graph within the budget — the check is queued and delivered, never dropped', async () => {
  T.cgSetEditNoteBudget(0);
  try {
    // 1. Delivered with the next tool result.
    const dir = writeTree(tmp('editq'), TS_FIXTURE);
    T.resetCodeGraphCache();
    const ctx = { cwd: dir, sessionId: 'cg-editq' };
    const out = await T.runInContext(ctx, async () => {
      T.cgResetEditNotes();
      await T.executeTool('Read', { file_path: path.join(dir, 'src/lib/format/currency.ts') });
      const edit = await T.executeTool('Edit', { file_path: path.join(dir, 'src/lib/format/currency.ts'), old_str: 'export function formatAmount(cents: number): string {', new_str: 'export function formatAmount(cents: number, currency: string): string {' });
      await T.getCodeGraph(dir); // the indexing the edit started
      // The note is computed after the graph is ready, so under load it can
      // ride on a later result than the very next one: the promise is that it
      // is delivered once, not on which call. Read until it arrives (bounded).
      let next = '';
      for (let i = 0; i < 20 && !String(next).includes('Code graph check'); i++) {
        next = await T.executeTool('Read', { file_path: path.join(dir, 'src/features/a.ts') });
        if (!String(next).includes('Code graph check')) await new Promise(r => setTimeout(r, 100));
      }
      const after = await T.executeTool('Read', { file_path: path.join(dir, 'src/features/b.ts') });
      return { edit, next, after };
    });
    assert(String(out.edit).includes('still being indexed') && String(out.edit).includes('`formatAmount`'), 'the edit says its check is pending, not that there is nothing to check', out.edit);
    assert(String(out.next).includes('`formatAmount` changed its signature') && String(out.next).includes('src/features/c.tsx:2 as money'), 'a following tool result carries the callers', String(out.next).slice(-600));
    assert(!String(out.after).includes('Code graph check'), 'once delivered, not repeated');

    // 2. The end-of-turn path: nothing else ran, the loop asks for it.
    const dir2 = writeTree(tmp('editq2'), TS_FIXTURE);
    T.resetCodeGraphCache();
    const flushed = await T.runInContext({ cwd: dir2, sessionId: 'cg-editq2' }, async () => {
      T.cgResetEditNotes();
      await T.executeTool('Read', { file_path: path.join(dir2, 'src/lib/format/currency.ts') });
      await T.executeTool('Edit', { file_path: path.join(dir2, 'src/lib/format/currency.ts'), old_str: 'export function plainAmount(', new_str: 'export function rawAmount(' });
      return T.cgFlushQueuedEditNotes(20_000);
    });
    assert(String(flushed).includes('`plainAmount` was removed or renamed') && String(flushed).includes('src/lib/index.ts'), 'flushing waits for the graph and answers the queued check', flushed);

    // 3. In the loop: a model that edits and stops is handed the callers before the turn ends.
    const dir3 = writeTree(tmp('editq3'), TS_FIXTURE);
    T.resetCodeGraphCache();
    const file = path.join(dir3, 'src/lib/format/currency.ts');
    let step = 0;
    const seen = [];
    const provider = {
      id: 'mock', displayName: 'Mock',
      async *chat(o) {
        seen.push(o.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        const steps = [
          [{ type: 'tool_call', id: 'r1', name: 'Read', input: { file_path: file } }, { type: 'finish', reason: 'tool_calls' }],
          [{ type: 'tool_call', id: 'e1', name: 'Edit', input: { file_path: file, old_str: 'export function formatAmount(cents: number): string {', new_str: 'export function formatAmount(cents: number, currency: string): string {' } }, { type: 'finish', reason: 'tool_calls' }],
          [{ type: 'text', content: 'Done.' }, { type: 'finish', reason: 'stop' }],
          [{ type: 'text', content: 'Updating the callers next.' }, { type: 'finish', reason: 'stop' }],
        ];
        for (const ev of steps[Math.min(step++, steps.length - 1)]) yield ev;
      },
    };
    const session = new T.Session({ id: 'cg-editq3', cwd: dir3, startedAt: Date.now() });
    await T.runAgent({
      task: 'add a currency parameter', model: 'mock', showPlan: false, autoApprove: true, verbose: false, silent: true,
      conversationHistory: [], sessionId: session.header.id, session, provider, cwd: dir3,
      settings: { completionGate: { enabled: false }, cron: { enabled: false } },
    });
    const note = session.events.find(e => e.type === 'user/message' && e.data.source?.plugin === 'codegraph-edit-note');
    assert(note && /`formatAmount` changed its signature/.test(note.data.content) && step === 4, 'the loop gives the queued check to the model before the turn may end', note?.data?.content ?? seen.at(-1)?.slice(-400));
  } finally {
    T.cgSetEditNoteBudget(4_000);
  }
});

// ── HTTP route ───────────────────────────────────────────────────────────────
await block('Route: registered projects only; payload, file, symbol, context', async () => {
  const dir = writeTree(tmp('route'), TS_FIXTURE);
  T.resetCodeGraphCache();
  const deny = await T.codeGraphAnswer('codegraph/graph', new URLSearchParams({ path: dir }), { isKnownProject: async () => false });
  assert(deny.status === 403, 'an unregistered folder is refused');
  const allow = { isKnownProject: async () => true };
  const graph = await T.codeGraphAnswer('codegraph/graph', new URLSearchParams({ path: dir }), allow);
  assert(graph.status === 200 && graph.body.files.length > 20 && Array.isArray(graph.body.edges[0]), 'the graph payload');
  const file = await T.codeGraphAnswer('codegraph/file', new URLSearchParams({ path: dir, file: 'src/lib/format/currency.ts' }), allow);
  assert(file.status === 200 && file.body.exports.find(e => e.name === 'formatAmount')?.users === 8, 'file detail with user counts per export', file.body.exports);
  const sym = await T.codeGraphAnswer('codegraph/symbol', new URLSearchParams({ path: dir, file: 'src/lib/format/currency.ts', name: 'formatAmount' }), allow);
  assert(sym.status === 200 && sym.body.users.length >= 8, 'symbol users');
  const ctx = await T.codeGraphAnswer('codegraph/context', new URLSearchParams({ path: dir, ids: String(file.body.id) }), allow);
  assert(ctx.status === 200 && ctx.body.text.includes('### src/lib/format/currency.ts'), 'selection context for "Ask AICO about this"');
  const bad = await T.codeGraphAnswer('codegraph/graph', new URLSearchParams({}), allow);
  assert(bad.status === 400, 'a missing path is a 400');
  fs.mkdirSync(path.join(dir, '.aico'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.aico', 'settings.json'), JSON.stringify({ codeGraph: { rules: [{ from: 'src/features/**', to: 'src/lib/format/**', reason: 'go through @/lib' }] } }));
  const rules = await T.projectLayerRules(dir);
  assert(rules.length === 1 && rules[0].reason === 'go through @/lib', 'layering rules are read from the project settings');
});

// ── Eng-bench fixtures (the Phase 0 traps), when present ─────────────────────
const tasksDir = path.join(here, 'eng-bench', 'tasks');
const benchTask = (name) => fs.existsSync(path.join(tasksDir, name, 'generate.mjs'));
async function benchFixture(name) {
  const { generate } = await import(pathToFileURL(path.join(tasksDir, name, 'generate.mjs')).href);
  const { files, meta } = generate('fixture');
  const dir = tmp(name);
  for (const [rel, text] of files) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return { dir, meta, g: await graphOf(dir) };
}

await block('Bench traps: next-alias-impact — every real caller, no decoy', async () => {
  if (!benchTask('next-alias-impact')) { assert(true, 'generator absent: skipped'); return; }
  const { g, meta } = await benchFixture('next-alias-impact');
  const got = new Set([...usersOf(g, 'src/lib/format/currency.ts', 'formatAmount')].filter(p => !g.files[id(g, p)].isTest));
  const want = new Set(meta.callers.map(c => c.file));
  assert(sameSet(got, want), `formatAmount: ${got.size}/${want.size} callers exact (aliases, barrels, money re-export, namespace, relative)`, diff(got, want));
  const decoys = new Set(meta.decoyCallers.map(d => d.file));
  assert([...got].every(p => !decoys.has(p)), 'no decoy caller is reported');
});

await block('Bench traps: py-same-name — billing callers exact, audit separate', async () => {
  if (!benchTask('py-same-name')) { assert(true, 'generator absent: skipped'); return; }
  const { g, meta } = await benchFixture('py-same-name');
  const got = new Set([...usersOf(g, 'app/billing/processor.py', 'process')].filter(p => !g.files[id(g, p)].isTest));
  const want = new Set(meta.billing.map(c => c.file));
  assert(sameSet(got, want), `billing process: ${got.size}/${want.size} callers exact`, diff(got, want));
  const audit = usersOf(g, 'app/audit/processor.py', 'process');
  assert(meta.audit.every(a => audit.has(a.file)), 'every audit caller is an audit user');
  assert([...audit].every(p => !meta.billing.some(b => b.file === p) || meta.billing.find(b => b.file === p)?.mixed), 'an audit user that is a billing caller imports both (mixed)');
});

await block('Bench traps: go-request-path — the directed path through interfaces', async () => {
  if (!benchTask('go-request-path')) { assert(true, 'generator absent: skipped'); return; }
  const { g } = await benchFixture('go-request-path');
  const p = T.cgShortestPath(g, id(g, 'internal/httpapi/handlers_orders.go'), id(g, 'internal/store/pg/order_store.go'))?.map(i => g.files[i].path);
  assert(p && p.includes('internal/service/orders/service.go') && p.at(-1) === 'internal/store/pg/order_store.go' && !p.some(x => /legacy/.test(x)), 'handler → service → store, never through the legacy package', p);
});

await block('Bench traps: cochange-fix — the history-only partner, found from git', async () => {
  if (!benchTask('cochange-fix') || spawnSync('git', ['--version']).status !== 0) { assert(true, 'generator or git absent: skipped'); return; }
  const task = (await import(pathToFileURL(path.join(tasksDir, 'cochange-fix', 'task.mjs')).href)).default;
  const dir = tmp('cochange');
  task.setup(dir);
  const g = await graphOf(dir);
  const r = id(g, 'src/tax/rates.js');
  const top = g.cochange.filter(c => c.a === r || c.b === r).sort((a, b) => b.count - a.count)[0];
  assert(top && g.files[top.a === r ? top.b : top.a].path === 'src/edi/partitions.js' && top.confidence === 1, 'rates.js → partitions.js is its strongest co-change partner, with no import between them', top);
  assert(!hasEdge(g, 'src/tax/rates.js', 'src/edi/partitions.js') && !hasEdge(g, 'src/edi/partitions.js', 'src/tax/rates.js'), 'and indeed no import links them');
});

console.log(`\ncodegraph: ${passed} passed, ${failed} failed`);
if (failed) { console.log(`Failures:\n  ${failures.join('\n  ')}`); process.exit(1); }
process.exit(0);
