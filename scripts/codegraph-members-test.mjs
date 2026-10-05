/**
 * Method calls linked by receiver type (src/codegraph/members, parse/members,
 * ts-check), offline: exact caller sets per language, with decoys.
 *
 * Every fixture declares the same method name on an unrelated class (the
 * decoy) and calls it; every assertion is an exact set — a decoy caller in a
 * list, or a real caller missing from it, fails. What each block proves:
 *
 *   - Python: `x = Cls()`, `self.attr = Cls()` in `__init__`, parameter hints,
 *     return hints of called functions (through an import), `from m import
 *     Cls`, a module-qualified constructor, dataclass fields, classmethod
 *     return types, base-class methods, a method's return type chained, a
 *     Protocol and its implementation (via interface); an untyped parameter and
 *     a rebound loop variable stay unlinked;
 *   - TypeScript, lexical rules (checker off) and the checker: `new`, typed
 *     params, constructor parameter properties, `this.x.m()`, return types,
 *     statics, namespace imports, a barrel alias, `@/` paths, base classes,
 *     interfaces → implementations (declared; structural only with the
 *     checker), an unannotated factory only the checker sees;
 *   - Go: receivers, struct fields, `x := NewT()` through a package whose
 *     clause differs from its folder, `var x T`, interfaces → implementations by
 *     exact method sets (pointer receivers, embedding, a same-named method with
 *     a different signature is not one);
 *   - Java, Kotlin, C#: declared types of locals, fields, parameters,
 *     properties, `var`/`val` with constructors, base classes, interfaces;
 *   - PHP: `new`, typed and promoted properties, typed parameters, statics;
 *   - Rust: `T::new()` through `-> Self`, `let x: T`, `impl` blocks, a trait
 *     object parameter → `impl Trait for` types;
 *   - Ruby: `x = T.new`, labelled inferred (constants resolve by unique name);
 *   - the agent tool's `implementations` and `exact` answers, and the view's
 *     interface explanation.
 *
 * Part of `npm test`. No model, no network. The TypeScript checker runs in a
 * worker over the fixture (typescript is a dev dependency).
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(process.env.AICO_TEST_EXPORTS ?? path.join(here, '..', 'dist-test', 'test-exports.js')).href);

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 1500)}` : ''}`); }
}
async function block(name, fn) {
  console.log(`\n${name}`);
  try { await fn(); } catch (err) { failed++; failures.push(`${name}: threw`); console.log(`  FAIL  threw: ${err.stack ?? err}`); }
}
const tmp = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `aico-cgm-${tag}-`)));
function writeTree(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
async function graphOf(dir, opts = {}) {
  T.resetCodeGraphCache();
  return T.getCodeGraph(dir, { force: true, ...opts });
}
const id = (g, p) => { const r = T.cgFindFile(g, p); if (r.id === undefined) throw new Error(`no file ${p}`); return r.id; };
/** Files that call `sym` declared in `file`, optionally only through one `via`. */
const callers = (g, file, sym, via) => new Set(T.cgSymbolUsers(g, id(g, file), sym).filter(u => (via ? (Array.isArray(via) ? via.includes(u.via) : u.via === via) : u.via !== 'reexport' && u.via !== 'interface')).map(u => g.files[u.file].path));
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const diff = (got, want) => ({ missing: [...want].filter(x => !got.has(x)), extra: [...got].filter(x => !want.has(x)) });
const set = (...xs) => new Set(xs);
const exactly = (got, want, name) => assert(sameSet(got, want), name, diff(got, want));
const implsOf = (g, file, name) => g.implementations.filter(i => g.files[i.iface.file].path === file && i.iface.name === name);

// ── Python ──────────────────────────────────────────────────────────────────
await block('Python: constructors, self attributes, hints, return hints, dataclasses, bases, Protocols — decoys excluded', async () => {
  const dir = writeTree(tmp('py'), {
    'app/__init__.py': '',
    'app/billing/__init__.py': '',
    'app/billing/base.py': 'class BaseService:\n    def health(self) -> bool:\n        return True\n',
    'app/billing/service.py': 'from app.billing.base import BaseService\n\nclass Receipt:\n    def print(self) -> None:\n        pass\n\nclass BillingService(BaseService):\n    def process(self, amount: int) -> Receipt:\n        return Receipt()\n\n    @classmethod\n    def create(cls) -> "BillingService":\n        return cls()\n',
    'app/billing/factory.py': 'from app.billing.service import BillingService\n\ndef make_billing() -> BillingService:\n    return BillingService()\n',
    'app/audit/__init__.py': '',
    'app/audit/service.py': 'class AuditService:\n    def process(self, amount: int) -> None:\n        pass\n',
    'app/ports.py': 'from typing import Protocol\n\nclass Charger(Protocol):\n    def charge(self, amount: int) -> None: ...\n',
    'app/stripe.py': 'from app.ports import Charger\n\nclass StripeCharger(Charger):\n    def charge(self, amount: int) -> None:\n        pass\n',
    'app/printer.py': 'class Printer:\n    def charge(self, amount: int) -> None:\n        pass\n',
    'app/jobs/__init__.py': '',
    'app/jobs/a.py': 'from app.billing.service import BillingService\n\nsvc = BillingService()\n\ndef run():\n    svc.process(1)\n',
    'app/jobs/b.py': 'from app.billing.service import BillingService\n\ndef run(svc: BillingService) -> None:\n    svc.process(1)\n',
    'app/jobs/c.py': 'from app.billing.service import BillingService\n\nclass Job:\n    def __init__(self):\n        self.billing = BillingService()\n\n    def go(self):\n        self.billing.process(1)\n',
    'app/jobs/d.py': 'from app.billing.factory import make_billing\n\ndef run():\n    make_billing().process(1)\n',
    'app/jobs/e.py': 'from dataclasses import dataclass\nfrom app.billing.service import BillingService\n\n@dataclass\nclass Task:\n    billing: BillingService\n\ndef run(t: Task):\n    t.billing.process(1)\n',
    'app/jobs/f.py': 'from app.billing import service as svc_mod\n\ndef run():\n    svc_mod.BillingService().process(1)\n',
    'app/jobs/g.py': 'from app.billing.service import BillingService\n\ndef run():\n    x = BillingService.create()\n    x.process(1)\n',
    'app/jobs/h.py': 'from app.billing.service import BillingService\n\ndef run():\n    BillingService().health()\n',
    'app/jobs/i.py': 'from app.billing.service import BillingService\n\ndef run():\n    BillingService().process(1).print()\n',
    'app/jobs/j.py': 'from app.ports import Charger\n\ndef pay(c: Charger) -> None:\n    c.charge(1)\n',
    'app/jobs/decoy_audit.py': 'from app.audit.service import AuditService\n\ndef run():\n    a = AuditService()\n    a.process(1)\n',
    'app/jobs/decoy_untyped.py': 'def run(svc, other):\n    svc.process(1)\n    other.charge(2)\n',
    'app/jobs/decoy_rebound.py': 'from app.billing.service import BillingService\n\ns = BillingService()\nfor s in []:\n    s.process(1)\n',
    'app/jobs/decoy_branch.py': 'from app.billing.service import BillingService\nfrom app.audit.service import AuditService\n\ndef run(flag):\n    x = BillingService()\n    if flag:\n        x = AuditService()\n    x.process(1)\n',
  });
  const g = await graphOf(dir);
  exactly(callers(g, 'app/billing/service.py', 'BillingService.process'),
    set('app/jobs/a.py', 'app/jobs/b.py', 'app/jobs/c.py', 'app/jobs/d.py', 'app/jobs/e.py', 'app/jobs/f.py', 'app/jobs/g.py', 'app/jobs/i.py'),
    'BillingService.process: global, hint, self attribute, return hint, dataclass field, module-qualified, classmethod, chained — exactly');
  exactly(callers(g, 'app/audit/service.py', 'AuditService.process'), set('app/jobs/decoy_audit.py'), 'AuditService.process (the same name): only its own caller');
  exactly(callers(g, 'app/billing/base.py', 'BaseService.health'), set('app/jobs/h.py'), 'a base-class method is linked through the subclass');
  exactly(callers(g, 'app/billing/service.py', 'Receipt.print'), set('app/jobs/i.py'), 'a method\'s declared return type carries the chain');
  exactly(callers(g, 'app/ports.py', 'Charger.charge'), set('app/jobs/j.py'), 'a Protocol method call links to the Protocol');
  exactly(callers(g, 'app/stripe.py', 'StripeCharger.charge', 'interface'), set('app/jobs/j.py'), '…and to its implementation, via interface');
  exactly(callers(g, 'app/printer.py', 'Printer.charge', ['call', 'interface', 'inferred']), set(), 'an unrelated class with the same method is not an implementation');
  const impl = implsOf(g, 'app/ports.py', 'Charger');
  assert(impl.length === 1 && g.files[impl[0].impl.file].path === 'app/stripe.py' && impl[0].how === 'declared', 'Charger is implemented by StripeCharger (declared)', impl);
  assert(g.files[id(g, 'app/billing/service.py')].exports.some(e => e.name === 'BillingService.process' && e.kind === 'method'), 'methods are exported as Class.method');
  assert(!g.edges.some(e => g.files[e.from].path === 'app/jobs/decoy_untyped.py'), 'an untyped parameter links nothing');
});

// ── TypeScript ──────────────────────────────────────────────────────────────
const TS = {
  'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, "strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n',
  'src/billing/base.ts': 'export class BaseService {\n  health(): boolean { return true; }\n}\n',
  'src/billing/receipt.ts': 'export class Receipt {\n  print(): void {}\n}\n',
  'src/ports.ts': "import type { Receipt } from './billing/receipt';\nexport interface Processor {\n  process(amount: number): Receipt;\n}\n",
  'src/billing/service.ts': "import { BaseService } from './base';\nimport { Receipt } from './receipt';\nimport type { Processor } from '../ports';\n\nexport class BillingService extends BaseService implements Processor {\n  process(amount: number): Receipt { return new Receipt(); }\n  static create(): BillingService { return new BillingService(); }\n}\n",
  'src/billing/index.ts': "export { BillingService } from './service';\n",
  'src/billing/factory.ts': "import { BillingService } from './service';\nexport function makeBilling(): BillingService { return new BillingService(); }\nexport function pick() { return new BillingService(); }\n",
  'src/legacy.ts': "import type { Processor } from './ports';\nimport { Receipt } from './billing/receipt';\nexport class LegacyProcessor implements Processor {\n  process(amount: number): Receipt { return new Receipt(); }\n}\n",
  'src/duck.ts': "import { Receipt } from './billing/receipt';\nexport class DuckProcessor {\n  process(amount: number): Receipt { return new Receipt(); }\n}\n",
  'src/audit/service.ts': 'export class AuditService {\n  process(amount: number): void {}\n}\n',
  'src/a.ts': "import { BillingService } from '@/billing/service';\nconst s = new BillingService();\ns.process(1);\n",
  'src/b.ts': "import { BillingService } from './billing/service';\nexport function run(s: BillingService) { s.process(1); }\n",
  'src/c.ts': "import { BillingService } from './billing/service';\nexport class Ctl {\n  constructor(private billing: BillingService) {}\n  go() { this.billing.process(1); }\n}\n",
  'src/d.ts': "import { makeBilling } from './billing/factory';\nmakeBilling().process(1);\n",
  'src/e.ts': "import { BillingService } from './billing/service';\nBillingService.create().process(1);\n",
  'src/f.ts': "import * as billing from './billing/service';\nnew billing.BillingService().process(1);\n",
  'src/g.ts': "import { BillingService as B } from './billing';\nnew B().process(1);\n",
  'src/h.ts': "import { BillingService } from './billing/service';\nnew BillingService().health();\n",
  'src/i.ts': "import type { Processor } from './ports';\nexport function pay(p: Processor) { p.process(1).print(); }\n",
  'src/j.ts': "import { pick } from './billing/factory';\nconst s = pick();\ns.process(1);\n",
  'src/decoy-audit.ts': "import { AuditService } from './audit/service';\nnew AuditService().process(1);\n",
  'src/decoy-any.ts': 'export function f(x: any) { x.process(1); }\n',
  'src/decoy-literal.ts': 'const s = { process: (n: number) => n };\ns.process(1);\n',
};

await block('TypeScript, lexical rules (checker off): exact callers, declared implementations, decoys excluded', async () => {
  const dir = writeTree(tmp('tslex'), TS);
  process.env.AICO_CODEGRAPH_TYPECHECK = 'off';
  try {
    const g = await graphOf(dir, { exact: true });
    assert(g.stats.methods?.ts === 'lexical' && /switched off/.test(g.stats.methods.note ?? ''), 'the graph says the lexical rules were used, and why', g.stats.methods);
    exactly(callers(g, 'src/billing/service.ts', 'BillingService.process'),
      set('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'),
      'BillingService.process: new, typed parameter, parameter property, return type, static, namespace, barrel alias, @/ path — exactly');
    exactly(callers(g, 'src/billing/service.ts', 'BillingService.process', 'interface'), set('src/i.ts'), 'a call through Processor reaches BillingService.process via interface');
    exactly(callers(g, 'src/legacy.ts', 'LegacyProcessor.process', 'interface'), set('src/i.ts'), '…and LegacyProcessor.process');
    exactly(callers(g, 'src/duck.ts', 'DuckProcessor.process', ['call', 'interface']), set(), 'a structural-only match is not claimed by the lexical rules');
    exactly(callers(g, 'src/ports.ts', 'Processor.process'), set('src/i.ts'), 'Processor.process: the interface call');
    exactly(callers(g, 'src/billing/base.ts', 'BaseService.health'), set('src/h.ts'), 'a base-class method');
    exactly(callers(g, 'src/billing/receipt.ts', 'Receipt.print'), set('src/i.ts'), 'a return type through an interface method');
    exactly(callers(g, 'src/audit/service.ts', 'AuditService.process'), set('src/decoy-audit.ts'), 'the decoy class keeps its own caller');
    assert(!callers(g, 'src/billing/service.ts', 'BillingService.process').has('src/j.ts'), 'an unannotated factory is beyond the lexical rules (no guess)');
  } finally {
    delete process.env.AICO_CODEGRAPH_TYPECHECK;
  }
});

await block('TypeScript, the checker: inferred types, structural implementations, the same decoys excluded', async () => {
  const dir = writeTree(tmp('tsck'), TS);
  const g = await graphOf(dir, { exact: true });
  assert(g.stats.methods?.ts === 'checker', 'the TypeScript checker resolved the method calls', g.stats.methods);
  exactly(callers(g, 'src/billing/service.ts', 'BillingService.process'),
    set('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/j.ts'),
    'BillingService.process: everything the lexical rules found, plus the unannotated factory — exactly');
  exactly(callers(g, 'src/duck.ts', 'DuckProcessor.process', 'interface'), set('src/i.ts'), 'a class assignable to Processor without `implements` is reached via interface');
  const impl = implsOf(g, 'src/ports.ts', 'Processor').map(i => `${g.files[i.impl.file].path}#${i.impl.name}:${i.how}`).sort();
  assert(JSON.stringify(impl) === JSON.stringify(['src/billing/service.ts#BillingService:declared', 'src/duck.ts#DuckProcessor:structural', 'src/legacy.ts#LegacyProcessor:declared']), 'Processor implementations: two declared, one structural', impl);
  exactly(callers(g, 'src/audit/service.ts', 'AuditService.process'), set('src/decoy-audit.ts'), 'the decoy class keeps its own caller');
  assert(![...callers(g, 'src/billing/service.ts', 'BillingService.process', ['call', 'interface'])].some(p => /decoy/.test(p)), 'no decoy (any, object literal, other class) is a caller');
  // An edit changes one file: the checker's answers for the others still stand, the edited one falls back until the next pass.
  fs.appendFileSync(path.join(dir, 'src/b.ts'), '\n// touched\n');
  const g2 = await T.getCodeGraph(dir, { force: true });
  assert(callers(g2, 'src/billing/service.ts', 'BillingService.process').has('src/b.ts') && callers(g2, 'src/billing/service.ts', 'BillingService.process').has('src/j.ts'), 'between an edit and the next pass, unchanged files keep the checker\'s answers and the edited one the lexical ones');
  const g3 = await T.getCodeGraph(dir, { exact: true });
  assert(g3.stats.methods?.ts === 'checker' && g3.version !== g.version, 'the next pass brings the checker\'s answers back and moves the version');
});

await block('TypeScript over the whole-project limit: one symbol exact on demand (language service), time-boxed, cached, memory-capped', async () => {
  const dir = writeTree(tmp('tsod'), TS);
  process.env.AICO_CODEGRAPH_TS_MAX_FILES = '3';   // the fixture is "too large" for the full pass
  process.env.AICO_CODEGRAPH_ONDEMAND_DISPOSE_MB = '1';   // every answer goes over the cap: rebuild each time
  try {
    await T.cgDisposeOnDemand();
    const g = await graphOf(dir, { exact: true });
    assert(g.stats.methods?.ts === 'lexical' && g.stats.methods.overCap === true && /resolved exactly on demand/.test(g.stats.methods.note ?? ''), 'over the limit: no full pass, and the graph says symbols resolve on demand', g.stats.methods);
    const file = id(g, 'src/billing/service.ts');
    // A 1 ms box: the lexical answer, marked partial — the service keeps working.
    const quick = await T.cgExactUsersOnDemand(g, file, 'BillingService.process', { budgetMs: 1 });
    assert(quick?.status === 'partial' && /did not finish within/.test(quick.note ?? ''), 'time-boxed: partial, with the lexical users, said so', quick?.note);
    const od = await T.cgExactUsersOnDemand(g, file, 'BillingService.process', { budgetMs: 60_000 });
    const got = new Set(od.users.filter(u => u.via === 'ondemand').map(u => g.files[u.file].path));
    // findReferences counts the interface caller (`p.process` through Processor) as a reference of
    // the implemented member, and is exact about it: i.ts calls it through Processor.
    const want = set('src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/j.ts');
    assert(od.status === 'exact' && [...want].every(p => got.has(p)) && ![...got].some(p => /decoy|legacy|duck|audit/.test(p)), 'on demand: every real caller (the unannotated factory too), no decoy', diff(got, want));
    const viaIface = new Set(od.users.filter(u => u.via === 'interface').map(u => g.files[u.file].path));
    assert(sameSet(got, want) && sameSet(viaIface, set('src/i.ts')) && !od.users.some(u => /legacy|ports/.test(g.files[u.file].path)), 'exactly: the 8 direct callers, i.ts through Processor (via interface), never the sibling implementation', { got: [...got], viaIface: [...viaIface] });
    assert(od.disposed === true, 'over the memory cap: the service is disposed after answering');
    const again = await T.cgExactUsersOnDemand(g, file, 'BillingService.process');
    assert(again.status === 'exact' && again.cached === true, 'asked again with nothing changed: from the cache');
    const fn = await T.cgExactUsersOnDemand(g, id(g, 'src/billing/factory.ts'), 'makeBilling');
    assert(fn.status === 'exact' && fn.users.some(u => g.files[u.file].path === 'src/d.ts' && u.via === 'ondemand'), 'after a dispose, the next query rebuilds the service (an exported function)', fn);
    // An edit adds a caller: the content key changes, the service updates incrementally.
    fs.writeFileSync(path.join(dir, 'src/k.ts'), "import { makeBilling } from './billing/factory';\nmakeBilling().process(9);\n");
    const g2 = await T.getCodeGraph(dir, { force: true });
    const after = await T.cgExactUsersOnDemand(g2, id(g2, 'src/billing/service.ts'), 'BillingService.process');
    assert(after.status === 'exact' && !after.cached && after.users.some(u => g2.files[u.file].path === 'src/k.ts'), 'a new caller after an edit: a fresh exact answer that includes it');
    const run = (input) => T.runInContext({ cwd: dir, sessionId: 'cgm-od' }, () => T.codeGraphTool(input));
    const report = await run({ action: 'impact', target: 'src/billing/service.ts#BillingService.process' });
    assert(/Exact \(on demand\)/.test(report) && report.includes('k.ts:2') && !/decoy/.test(report), 'the agent\'s impact answer is marked exact (on demand)', report);
    const detail = await T.codeGraphAnswer('codegraph/symbol', new URLSearchParams({ path: dir, file: 'src/billing/service.ts', name: 'BillingService.process' }), { isKnownProject: async () => true });
    assert(detail.body.exactness?.mode === 'on-demand' && detail.body.users.some(u => u.via === 'ondemand'), 'the Code map\'s symbol view gets the on-demand users and the marker', detail.body.exactness);
  } finally {
    delete process.env.AICO_CODEGRAPH_TS_MAX_FILES;
    delete process.env.AICO_CODEGRAPH_ONDEMAND_DISPOSE_MB;
    await T.cgDisposeOnDemand();
  }
});

// ── Go ──────────────────────────────────────────────────────────────────────
await block('Go: receivers, fields, constructors across a renamed package, exact method sets', async () => {
  const dir = writeTree(tmp('go'), {
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'internal/orders/types.go': 'package ordering\n\ntype Order struct{ ID string }\n',
    'internal/orders/ports.go': 'package ordering\n\n// Store persists orders.\ntype Store interface {\n\tInsert(o *Order) error\n}\n\ntype Pinger interface {\n\tPing() error\n}\n',
    'internal/orders/service.go': 'package ordering\n\ntype Service struct {\n\tstore Store\n}\n\nfunc (s *Service) Place(o *Order) error {\n\treturn s.store.Insert(o)\n}\n',
    'internal/orders/pingers.go': 'package ordering\n\ntype ValPinger struct{}\n\nfunc (ValPinger) Ping() error { return nil }\n\ntype PtrPinger struct{}\n\nfunc (p *PtrPinger) Ping() error { return nil }\n\ntype WrongPinger struct{}\n\nfunc (WrongPinger) Ping() string { return "" }\n\ntype Wrapped struct{ PtrPinger }\n\ntype Wrapped2 struct{ *PtrPinger }\n',
    'internal/store/store.go': 'package store\n\nimport "example.com/shop/internal/orders"\n\ntype OrderStore struct{}\n\nfunc NewOrderStore() *OrderStore { return &OrderStore{} }\n\nfunc (s *OrderStore) Insert(o *ordering.Order) error { return nil }\n\nfunc (s OrderStore) Count() int { return 0 }\n',
    'internal/store/customer.go': 'package store\n\ntype Customer struct{}\n\ntype CustomerStore struct{}\n\nfunc (s *CustomerStore) Insert(c *Customer) error { return nil }\n',
    'cmd/a/main.go': 'package main\n\nimport "example.com/shop/internal/store"\n\nfunc main() {\n\tst := store.NewOrderStore()\n\tst.Insert(nil)\n}\n',
    'cmd/b/main.go': 'package main\n\nimport "example.com/shop/internal/store"\n\nfunc main() {\n\tvar st store.OrderStore\n\tst.Count()\n}\n',
    'cmd/c/main.go': 'package main\n\nimport ord "example.com/shop/internal/orders"\n\nfunc main() {\n\ts := &ord.Service{}\n\ts.Place(nil)\n}\n',
    'cmd/d/main.go': 'package main\n\nimport "example.com/shop/internal/store"\n\nfunc main() {\n\tcs := &store.CustomerStore{}\n\tcs.Insert(nil)\n}\n',
    'cmd/e/main.go': 'package main\n\nfunc run(items []int) {\n\tfor _, v := range items {\n\t\tv.Insert(nil)\n\t}\n}\n',
  });
  const g = await graphOf(dir);
  exactly(callers(g, 'internal/store/store.go', 'OrderStore.Insert'), set('cmd/a/main.go'), 'OrderStore.Insert: `st := store.NewOrderStore()` (return type through the package)');
  exactly(callers(g, 'internal/store/store.go', 'OrderStore.Insert', 'interface'), set('internal/orders/service.go'), '…and via the Store interface field, from the service');
  exactly(callers(g, 'internal/store/customer.go', 'CustomerStore.Insert', ['call', 'interface']), set('cmd/d/main.go'), 'CustomerStore.Insert (same name, other signature): only its own caller — not an implementation of Store');
  exactly(callers(g, 'internal/store/store.go', 'OrderStore.Count'), set('cmd/b/main.go'), '`var st store.OrderStore`');
  exactly(callers(g, 'internal/orders/service.go', 'Service.Place'), set('cmd/c/main.go'), 'an aliased import of a package whose clause differs from its folder');
  exactly(callers(g, 'internal/orders/ports.go', 'Store.Insert'), set('internal/orders/service.go'), 'a struct field typed with an interface');
  const pingers = Object.fromEntries(implsOf(g, 'internal/orders/ports.go', 'Pinger').map(i => [i.impl.name, Boolean(i.pointer)]));
  assert(JSON.stringify(pingers, Object.keys(pingers).sort()) === JSON.stringify({ PtrPinger: true, ValPinger: false, Wrapped: true, Wrapped2: false }),
    'Pinger: value and pointer receivers, embedding by value (only *Wrapped) and by pointer — WrongPinger (other result type) excluded', pingers);
  const store = implsOf(g, 'internal/orders/ports.go', 'Store');
  assert(store.length === 1 && store[0].impl.name === 'OrderStore' && store[0].pointer === true && store[0].how === 'structural', 'Store: only *OrderStore (pointer receiver), by method set', store);
  const view = T.cgSymbolDetail(g, id(g, 'internal/orders/ports.go'), 'Store');
  assert(view.implementations?.[0]?.why.includes('only *OrderStore satisfies it') && view.implementations[0].methods[0].ptr === true, 'the view explains why, with the methods and the pointer receiver', view.implementations);
  const p = T.cgShortestPath(g, id(g, 'cmd/c/main.go'), id(g, 'internal/store/store.go'))?.map(i => g.files[i].path);
  assert(p && p.includes('internal/orders/service.go') && p.at(-1) === 'internal/store/store.go', 'a directed path main → service → store, through the interface', p);
  const exact = T.cgExactOnly(g);
  assert(!T.cgShortestPath(exact, id(g, 'cmd/c/main.go'), id(g, 'internal/store/store.go')), 'with "exact only", the path through the interface is gone');
});

// ── Java, Kotlin, C# ────────────────────────────────────────────────────────
await block('Java, Kotlin, C#: declared types, fields, properties, bases, interfaces — decoys excluded', async () => {
  const dir = writeTree(tmp('jvm'), {
    'java/com/acme/billing/BaseService.java': 'package com.acme.billing;\n\npublic class BaseService {\n  public void health() {}\n}\n',
    'java/com/acme/billing/Receipt.java': 'package com.acme.billing;\n\npublic class Receipt {\n  public void print() {}\n}\n',
    'java/com/acme/billing/Processor.java': 'package com.acme.billing;\n\npublic interface Processor {\n  Receipt process(int amount);\n}\n',
    'java/com/acme/billing/BillingService.java': 'package com.acme.billing;\n\npublic class BillingService extends BaseService implements Processor {\n  public Receipt process(int amount) { return new Receipt(); }\n}\n',
    'java/com/acme/billing/Legacy.java': 'package com.acme.billing;\n\npublic class Legacy implements Processor {\n  public Receipt process(int amount) { return null; }\n}\n',
    'java/com/acme/audit/AuditService.java': 'package com.acme.audit;\n\npublic class AuditService {\n  public void process(int amount) {}\n}\n',
    'java/com/acme/api/A.java': 'package com.acme.api;\n\nimport com.acme.billing.BillingService;\n\npublic class A {\n  void run() {\n    BillingService s = new BillingService();\n    s.process(1);\n  }\n}\n',
    'java/com/acme/api/B.java': 'package com.acme.api;\n\nimport com.acme.billing.BillingService;\n\npublic class B {\n  private final BillingService billing;\n  B(BillingService billing) { this.billing = billing; }\n  void run() { billing.process(1); }\n}\n',
    'java/com/acme/api/C.java': 'package com.acme.api;\n\nimport com.acme.billing.BillingService;\n\npublic class C {\n  void run() {\n    var s = new BillingService();\n    s.process(1).print();\n  }\n}\n',
    'java/com/acme/api/D.java': 'package com.acme.api;\n\nimport com.acme.billing.Processor;\n\npublic class D {\n  void pay(Processor p) { p.process(1); }\n}\n',
    'java/com/acme/api/E.java': 'package com.acme.api;\n\nimport com.acme.billing.BillingService;\n\npublic class E {\n  void run() { new BillingService().health(); }\n}\n',
    'java/com/acme/api/F.java': 'package com.acme.api;\n\nimport com.acme.audit.AuditService;\n\npublic class F {\n  void run() {\n    AuditService a = new AuditService();\n    a.process(1);\n  }\n}\n',
    'kt/com/acme/k/Billing.kt': 'package com.acme.k\n\nclass Billing {\n  fun process(amount: Int): Int = amount\n}\n',
    'kt/com/acme/k/Audit.kt': 'package com.acme.k\n\nclass Audit {\n  fun process(amount: Int): Int = amount\n}\n',
    'kt/com/acme/k/Page.kt': 'package com.acme.k\n\nclass Page(private val billing: Billing) {\n  fun run() {\n    billing.process(1)\n  }\n}\n',
    'kt/com/acme/k/Job.kt': 'package com.acme.k\n\nfun job() {\n  val b = Billing()\n  b.process(1)\n}\n',
    'kt/com/acme/k/Other.kt': 'package com.acme.k\n\nfun other() {\n  Audit().process(1)\n  listOf(1).forEach { it.process(2) }\n}\n',
    'cs/Billing/BillingService.cs': 'namespace Acme.Billing;\n\npublic interface IProcessor { int Process(int amount); }\n\npublic class BillingService : IProcessor\n{\n    public int Process(int amount) => amount;\n}\n',
    'cs/Audit/AuditService.cs': 'namespace Acme.Audit;\n\npublic class AuditService\n{\n    public void Process(int amount) {}\n}\n',
    'cs/Api/Controller.cs': 'using Acme.Billing;\n\nnamespace Acme.Api;\n\npublic class Controller\n{\n    private readonly IProcessor _p;\n    public BillingService Svc { get; set; }\n    public Controller(IProcessor p) { _p = p; }\n    public void Go()\n    {\n        _p.Process(1);\n        Svc.Process(2);\n    }\n}\n',
    'cs/Api/Direct.cs': 'using Acme.Billing;\n\nnamespace Acme.Api;\n\npublic class Direct\n{\n    public void Go()\n    {\n        var s = new BillingService();\n        s.Process(1);\n    }\n}\n',
    'cs/Api/Decoy.cs': 'using Acme.Audit;\n\nnamespace Acme.Api;\n\npublic class Decoy\n{\n    public void Go()\n    {\n        var a = new AuditService();\n        a.Process(1);\n    }\n}\n',
  });
  const g = await graphOf(dir);
  const J = 'java/com/acme/';
  exactly(callers(g, `${J}billing/BillingService.java`, 'BillingService.process'), set(`${J}api/A.java`, `${J}api/B.java`, `${J}api/C.java`), 'Java BillingService.process: local, field, var — exactly');
  exactly(callers(g, `${J}billing/BillingService.java`, 'BillingService.process', 'interface'), set(`${J}api/D.java`), 'Java: a Processor parameter reaches the implementation via interface');
  exactly(callers(g, `${J}billing/Legacy.java`, 'Legacy.process', 'interface'), set(`${J}api/D.java`), '…and the other implementation');
  exactly(callers(g, `${J}billing/Processor.java`, 'Processor.process'), set(`${J}api/D.java`), 'Java: the interface method');
  exactly(callers(g, `${J}billing/BaseService.java`, 'BaseService.health'), set(`${J}api/E.java`), 'Java: a base-class method');
  exactly(callers(g, `${J}billing/Receipt.java`, 'Receipt.print'), set(`${J}api/C.java`), 'Java: a declared return type in a chain');
  exactly(callers(g, `${J}audit/AuditService.java`, 'AuditService.process'), set(`${J}api/F.java`), 'Java: the decoy keeps its own caller');
  exactly(callers(g, 'kt/com/acme/k/Billing.kt', 'Billing.process'), set('kt/com/acme/k/Page.kt', 'kt/com/acme/k/Job.kt'), 'Kotlin Billing.process: constructor property, `val b = Billing()` — exactly');
  exactly(callers(g, 'kt/com/acme/k/Audit.kt', 'Audit.process'), set('kt/com/acme/k/Other.kt'), 'Kotlin: the decoy keeps its own caller; `it` links nothing');
  exactly(callers(g, 'cs/Billing/BillingService.cs', 'BillingService.Process'), set('cs/Api/Controller.cs', 'cs/Api/Direct.cs'), 'C# BillingService.Process: a property and `var s = new` — exactly');
  exactly(callers(g, 'cs/Billing/BillingService.cs', 'IProcessor.Process'), set('cs/Api/Controller.cs'), 'C#: an interface-typed field');
  exactly(callers(g, 'cs/Audit/AuditService.cs', 'AuditService.Process'), set('cs/Api/Decoy.cs'), 'C#: the decoy keeps its own caller');
});

// ── PHP, Rust, Ruby ─────────────────────────────────────────────────────────
await block('PHP, Rust, Ruby: new, typed and promoted properties, impl blocks, traits, Ruby constants — decoys excluded', async () => {
  const dir = writeTree(tmp('prr'), {
    'php/composer.json': '{ "autoload": { "psr-4": { "App\\\\": "src/" } } }\n',
    'php/src/Billing/BillingService.php': '<?php\nnamespace App\\Billing;\n\nclass BillingService\n{\n    public function process(int $amount): Receipt { return new Receipt(); }\n    public static function make(): BillingService { return new BillingService(); }\n}\n',
    'php/src/Billing/Receipt.php': '<?php\nnamespace App\\Billing;\n\nclass Receipt\n{\n    public function print(): void {}\n}\n',
    'php/src/Audit/AuditService.php': '<?php\nnamespace App\\Audit;\n\nclass AuditService\n{\n    public function process(int $amount): void {}\n}\n',
    'php/src/Http/Ctl.php': '<?php\nnamespace App\\Http;\n\nuse App\\Billing\\BillingService;\n\nclass Ctl\n{\n    public function __construct(private BillingService $billing) {}\n    public function go(): void\n    {\n        $this->billing->process(1);\n    }\n}\n',
    'php/src/Http/Direct.php': '<?php\nnamespace App\\Http;\n\nuse App\\Billing\\BillingService;\n\nclass Direct\n{\n    public function go(BillingService $s): void\n    {\n        $s->process(1);\n        $t = BillingService::make();\n        $t->process(2)->print();\n    }\n}\n',
    'php/src/Http/Decoy.php': '<?php\nnamespace App\\Http;\n\nuse App\\Audit\\AuditService;\n\nclass Decoy\n{\n    public function go(): void\n    {\n        $a = new AuditService();\n        $a->process(1);\n    }\n}\n',
    'rs/Cargo.toml': '[package]\nname = "shop"\nversion = "0.1.0"\n',
    'rs/src/main.rs': 'mod billing;\nmod audit;\nmod legacy;\nmod run;\n\nfn main() {}\n',
    'rs/src/billing.rs': 'pub struct Billing;\n\npub trait Processor {\n    fn process(&self) -> i32;\n}\n\nimpl Billing {\n    pub fn new() -> Self { Billing }\n    pub fn total(&self) -> i32 { 0 }\n}\n\nimpl Processor for Billing {\n    fn process(&self) -> i32 { 1 }\n}\n',
    'rs/src/legacy.rs': 'use crate::billing::Processor;\n\npub struct Legacy;\n\nimpl Processor for Legacy {\n    fn process(&self) -> i32 { 2 }\n}\n',
    'rs/src/audit.rs': 'pub struct Audit;\n\nimpl Audit {\n    pub fn new() -> Self { Audit }\n    pub fn total(&self) -> i32 { 0 }\n}\n',
    'rs/src/run.rs': 'use crate::billing::{Billing, Processor};\nuse crate::audit::Audit;\n\npub fn go() {\n    let b = Billing::new();\n    b.total();\n    let c: Billing = Billing::new();\n    c.total();\n    let a = Audit::new();\n    a.total();\n}\n\npub fn pay(p: &dyn Processor) -> i32 {\n    p.process()\n}\n',
    'rb/lib/invoice.rb': 'class Invoice\n  def total\n    0\n  end\nend\n',
    'rb/lib/quote.rb': 'class Quote\n  def total\n    0\n  end\nend\n',
    'rb/app/report.rb': 'class Report\n  def run\n    x = Invoice.new\n    x.total\n  end\nend\n',
    'rb/app/other.rb': 'class Other\n  def run\n    q = Quote.new\n    q.total\n  end\nend\n',
  });
  const g = await graphOf(dir);
  exactly(callers(g, 'php/src/Billing/BillingService.php', 'BillingService.process'), set('php/src/Http/Ctl.php', 'php/src/Http/Direct.php'), 'PHP BillingService.process: promoted property, typed parameter, static factory — exactly');
  exactly(callers(g, 'php/src/Billing/Receipt.php', 'Receipt.print'), set('php/src/Http/Direct.php'), 'PHP: a declared return type in a chain');
  exactly(callers(g, 'php/src/Audit/AuditService.php', 'AuditService.process'), set('php/src/Http/Decoy.php'), 'PHP: the decoy keeps its own caller');
  exactly(callers(g, 'rs/src/billing.rs', 'Billing.total'), set('rs/src/run.rs'), 'Rust Billing.total: `T::new()` → Self and `let x: T`');
  exactly(callers(g, 'rs/src/audit.rs', 'Audit.total'), set('rs/src/run.rs'), 'Rust Audit.total (same name, other type) from its own `let`');
  const runTotalLines = T.cgSymbolUsers(g, id(g, 'rs/src/billing.rs'), 'Billing.total')[0]?.lines;
  assert(JSON.stringify(runTotalLines) === JSON.stringify([6, 8]), 'Rust: the Billing.total lines are the two Billing receivers, not the Audit one', runTotalLines);
  exactly(callers(g, 'rs/src/billing.rs', 'Processor.process'), set('rs/src/run.rs'), 'Rust: a trait object parameter calls the trait method');
  exactly(callers(g, 'rs/src/legacy.rs', 'Legacy.process', 'interface'), set('rs/src/run.rs'), '…and reaches `impl Processor for Legacy` via interface');
  const traitImpls = implsOf(g, 'rs/src/billing.rs', 'Processor').map(i => i.impl.name).sort();
  assert(JSON.stringify(traitImpls) === JSON.stringify(['Billing', 'Legacy']), 'Rust: `impl Trait for T` blocks are implementations', traitImpls);
  exactly(callers(g, 'rb/lib/invoice.rb', 'Invoice.total', 'inferred'), set('rb/app/report.rb'), 'Ruby: `x = Invoice.new` → Invoice#total, labelled inferred');
  exactly(callers(g, 'rb/lib/quote.rb', 'Quote.total', 'inferred'), set('rb/app/other.rb'), 'Ruby: the decoy keeps its own caller');
});

// ── The agent's answers ─────────────────────────────────────────────────────
await block('CodeGraph tool: method impact, `implementations`, `exact`', async () => {
  const dir = writeTree(tmp('tool'), TS);
  T.resetCodeGraphCache();
  const run = (input) => T.runInContext({ cwd: dir, sessionId: 'cgm-tool' }, () => T.codeGraphTool(input));
  const impact = await run({ action: 'impact', target: 'src/billing/service.ts#BillingService.process' });
  assert(/Used directly in 8 file\(s\)/.test(impact) && impact.includes('a.ts:3') && impact.includes('j.ts:3') && !impact.includes('decoy'), 'impact of a method: its callers (the checker\'s, the unannotated factory included), no decoy', impact);
  assert(/through an interface \(via interface\) from 1 file\(s\)[^]*i\.ts:2/.test(impact), 'callers through the interface are listed apart, marked possible', impact);
  const exact = await run({ action: 'impact', target: 'src/billing/service.ts#BillingService.process', exact: true });
  assert(/Used directly in 8 file\(s\)/.test(exact) && !exact.includes('via interface'), 'exact:true leaves the interface callers out', exact);
  const impls = await run({ action: 'implementations', target: 'src/ports.ts#Processor' });
  assert(/Processor is implemented by 3 type/.test(impls) && impls.includes('src/duck.ts#DuckProcessor') && impls.includes('method set matches'), 'implementations lists declared and structural ones with their methods', impls);
  const schema = JSON.stringify(T.codeGraphDefinition);
  assert(schema.length < 2600, `the CodeGraph schema stays small (${schema.length} chars)`);
});

console.log(`\ncodegraph members: ${passed} passed, ${failed} failed`);
if (failed) { console.log(`Failures:\n  ${failures.join('\n  ')}`); process.exit(1); }
process.exit(0);
