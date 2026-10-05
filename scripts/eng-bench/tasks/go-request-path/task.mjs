/**
 * Code-graph task 3 — go-request-path: in a ~120-file Go HTTP service, write
 * down how POST /api/orders reaches the database (TRACE.md, one hop per
 * line), then add order validation in the layer that both the HTTP handler
 * and the queue consumer go through.
 *
 * Why it exists: Phase 0 of the code-graph study. "How does A reach B" is the
 * path query graphs are sold on (`shortest_path`, `get_dependency_chain`).
 * The names mislead on purpose: internal/service/orders is `package ordering`,
 * internal/service/orderlegacy is `package orders` with a `Create` method and
 * a store of its own, and the handler reaches the service through an
 * interface wired in internal/app.
 *
 * Graded without a Go toolchain when none is installed (the case on the
 * bench machine): the trace is parsed hop by hop; the validation function's
 * package, signature, rule and call position are checked statically; every
 * file outside the service layer must be byte-identical (so the check cannot
 * live in the handler or the store). When `go` is on PATH the grader also
 * (with BENCH_GO=1) runs `go vet` and a hidden test (hidden/validate_hidden_test.go) — those
 * checks are added, not substituted, so scores are comparable only within one
 * machine's runs.
 *
 * The prompt forbids installing software because the first baseline run
 * (2026-10-05) did exactly that: RunChecks failed on `go build`, and the agent
 * downloaded a Go toolchain and began writing shims into the user's ~/bin
 * before the run was cancelled — which would also have changed what this
 * grader measures (it switches to `go vet`/`go test` when `go` is on PATH).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listFiles, sh } from '../../lib/util.mjs';
import { bodyOf, changedFrom, gitInitFixed, goCommand, readRel, writeTree } from '../../lib/generated.mjs';
import { generate } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOPS = [
  ['internal/httpapi/router.go', 'NewRouter'],
  ['internal/httpapi/orders_routes.go', 'orderRoutes'],
  ['internal/httpapi/handlers_orders.go', 'handleCreateOrder'],
  ['internal/service/orders/service.go', 'PlaceOrder'],
  ['internal/store/pg/order_store.go', 'Insert'],
];
const LEGACY = /orderlegacy|legacy_order_store|admin_orders|WriteLegacy|handleAdminImportOrder/;

/** The numbered hop lines of TRACE.md: `N. path/file.go: Func` (backticks and ` — notes` tolerated). */
export function parseTrace(text) {
  const hops = [];
  for (const line of text.split('\n')) {
    const m = line.replace(/`/g, '').match(/^\s*\d+[.)]\s+(?:\*\*)?([\w./-]+\.go)(?:\*\*)?\s*[:—–-]+\s*(?:\*\*)?(?:\([^)]*\)\s*)?([\w.()*]+)/);
    if (m) hops.push({ file: m[1].replace(/^\.\//, ''), func: m[2].replace(/^.*\./, '').replace(/[()*]/g, ''), line: line.trim() });
  }
  return hops;
}

/** Crude syntax sanity for Go edited without a compiler: balanced braces and parens outside strings and comments. */
function balanced(text) {
  const stripped = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/`[^`]*`/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])'/g, "''");
  let b = 0, p = 0;
  for (const ch of stripped) {
    if (ch === '{') b++; else if (ch === '}') b--; else if (ch === '(') p++; else if (ch === ')') p--;
    if (b < 0 || p < 0) return false;
  }
  return b === 0 && p === 0;
}

const edit = (project, rel, from, to) => {
  const text = readRel(project, rel);
  if (!text?.includes(from)) throw new Error(`mutation does not apply to ${rel}`);
  fs.writeFileSync(path.join(project, rel), text.replace(from, () => to));
};

export default {
  id: 'go-request-path',
  title: 'Trace POST /api/orders to the DB and validate in the right layer (Go, ~120 files)',
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
    'This is a Go HTTP service. Two things:',
    '',
    '1. Write TRACE.md at the repository root explaining how a `POST /api/orders` request reaches the database. Start it',
    '   with the path as a numbered list, one function per line, in call order, from route registration to the function',
    '   that executes the SQL, formatted exactly as `N. path/to/file.go: FunctionName`. You may add notes after the list.',
    '2. Orders whose quantity is outside 1..100, or whose SKU does not match `^[A-Z]{3}-[0-9]{4}$`, must be rejected',
    '   with the existing `ErrInvalidOrder` before anything is stored — whether the order arrives over HTTP or from the',
    '   queue consumer. Implement the rule as `func validateOrderInput(in CreateOrderInput) error` in the right package',
    '   and call it from the right place. Do not change the HTTP handlers, the stores, the consumer, or anything else',
    '   that does not need to change.',
    '',
    'The Go toolchain is not installed on this machine, so `go build`/`go test` cannot be run here (a RunChecks build',
    'failure for that reason is expected). Do not download or install Go or any other software: review your Go',
    'carefully by reading it.',
  ].join('\n'),

  async grade({ project, check }) {
    const fixture = generate('fixture');
    const { meta } = fixture;

    const trace = readRel(project, 'TRACE.md') ?? '';
    const hops = parseTrace(trace);
    check('TRACE.md has a numbered hop list', hops.length >= 3, `${hops.length} hop line(s) parsed`);
    const at = HOPS.map(([file, func]) => hops.findIndex((h) => h.file === file && h.func === func));
    HOPS.forEach(([file, func], i) => check(`trace names ${file}: ${func}`, at[i] >= 0, hops.map((h) => `${h.file}:${h.func}`).join(' > ').slice(0, 300)));
    check('trace hops are in call order', at.every((x) => x >= 0) && at.every((x, i) => i === 0 || x > at[i - 1]), at.join(','));
    const legacyHops = hops.filter((h) => LEGACY.test(h.file) || LEGACY.test(h.func));
    check('trace does not route through the legacy orders package', legacyHops.length === 0, legacyHops.map((h) => h.line).join(' | '));

    // The validation: where it lives, what it says, and where it is called.
    const goFiles = listFiles(project).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
    const defRe = /func\s+validateOrderInput\s*\(\s*\w+\s+CreateOrderInput\s*\)\s*error\s*\{/;
    const defs = goFiles.filter((f) => defRe.test(readRel(project, f) ?? ''));
    const inService = defs.filter((f) => f.startsWith('internal/service/orders/') && /^package ordering\b/m.test(readRel(project, f)));
    check('validateOrderInput is defined once, in the orders service package (ordering)', defs.length === 1 && inService.length === 1, defs.join(', ') || 'not defined');
    const defText = inService.length ? readRel(project, inService[0]) : '';
    const body = bodyOf(defText, /func\s+validateOrderInput\s*\([^)]*\)\s*error\s*/) ?? '';
    const ruleOk = /Quantity\s*(<\s*1\b|<=\s*0\b)/.test(body) && /Quantity\s*(>\s*100\b|>=\s*101\b)/.test(body)
      && /\^\[A-Z\]\{3\}-(\[0-9\]|\\\\?d)\{4\}\$/.test(defText) && /regexp\.(MustCompile|MatchString|Compile)/.test(defText)
      && /ErrInvalidOrder/.test(body) && /"regexp"/.test(defText);
    check('validateOrderInput checks 1..100, the SKU pattern, and returns ErrInvalidOrder', ruleOk, body.replace(/\s+/g, ' ').slice(0, 300));
    const svc = readRel(project, 'internal/service/orders/service.go') ?? '';
    const place = bodyOf(svc, /func\s+\(\s*s\s+\*Service\s*\)\s+PlaceOrder\s*\([^)]*\)\s*\([^)]*\)\s*/) ?? '';
    const vAt = place.search(/validateOrderInput\s*\(\s*in\s*\)/);
    const iAt = place.search(/s\.store\.Insert\s*\(/);
    check('PlaceOrder calls validateOrderInput(in) before storing', vAt >= 0 && iAt > vAt, `validate at ${vAt}, insert at ${iAt}`);

    const stay = changedFrom(project, fixture.files, meta.mustStay);
    check(`handlers, routes, stores, consumer, wiring and the legacy package are byte-identical (${meta.mustStay.length})`, stay.length === 0, stay.join(', '));
    const others = changedFrom(project, fixture.files, meta.unrelated);
    check(`other domains are byte-identical (${meta.unrelated.length})`, others.length === 0, others.slice(0, 5).join(', '));
    const edited = goFiles.filter((f) => f.startsWith('internal/service/orders/'));
    const broken = edited.filter((f) => !balanced(readRel(project, f) ?? ''));
    check('edited service files are syntactically balanced', broken.length === 0, broken.join(', '));

    // Opt-in, so a toolchain an agent installs mid-run cannot change what is graded.
    const go = process.env.BENCH_GO === '1' ? goCommand() : null;
    if (go) {
      const vet = sh(`${go} vet ./...`, { cwd: project, timeoutMs: 300_000 });
      check('go vet passes', vet.code === 0, (vet.out + vet.err).slice(0, 300));
      const dst = path.join(project, 'internal/service/orders/zz_hidden_test.go');
      fs.copyFileSync(path.join(here, 'hidden', 'validate_hidden_test.go'), dst);
      const t = sh(`${go} test ./internal/service/orders/ -run TestHidden`, { cwd: project, timeoutMs: 300_000 });
      fs.rmSync(dst, { force: true });
      check('hidden go test: PlaceOrder validates', t.code === 0, (t.out + t.err).slice(-300));
    }
    return { goToolchain: Boolean(go), hops: hops.map((h) => `${h.file}:${h.func}`) };
  },

  selfTest: {
    fixtureMustFail: ['TRACE.md has a numbered hop list', 'validateOrderInput is defined once', 'PlaceOrder calls validateOrderInput(in) before storing'],
    mutants: [
      {
        label: 'validation put in the HTTP handler',
        apply(project) {
          fs.rmSync(path.join(project, 'internal/service/orders/validate.go'));
          edit(project, 'internal/service/orders/service.go', '	if err := validateOrderInput(in); err != nil {\n		return Order{}, err\n	}\n', '');
          edit(project, 'internal/httpapi/handlers_orders.go', '		o, err := svc.PlaceOrder(r.Context(), in)', '		if in.Quantity < 1 || in.Quantity > 100 {\n			writeError(w, http.StatusBadRequest, "invalid order")\n			return\n		}\n		o, err := svc.PlaceOrder(r.Context(), in)');
        },
        mustFail: ['validateOrderInput is defined once', 'PlaceOrder calls validateOrderInput(in) before storing', 'handlers, routes, stores'],
      },
      {
        label: 'validation added to the legacy `package orders` Create',
        apply(project) {
          const v = readRel(project, 'internal/service/orders/validate.go').replace('package ordering', 'package orders').replace(/CreateOrderInput/g, 'CreateOrderInput');
          fs.rmSync(path.join(project, 'internal/service/orders/validate.go'));
          fs.writeFileSync(path.join(project, 'internal/service/orderlegacy/validate.go'), v.replace('func validateOrderInput(in CreateOrderInput)', 'type CreateOrderInput = Input\n\nvar ErrInvalidOrder = ErrInvalid\n\nfunc validateOrderInput(in CreateOrderInput)'));
          edit(project, 'internal/service/orders/service.go', '	if err := validateOrderInput(in); err != nil {\n		return Order{}, err\n	}\n', '');
        },
        mustFail: ['validateOrderInput is defined once', 'PlaceOrder calls validateOrderInput(in) before storing'],
      },
      {
        label: 'trace followed the legacy package',
        apply(project) {
          edit(project, 'TRACE.md', '4. internal/service/orders/service.go: PlaceOrder\n5. internal/store/pg/order_store.go: Insert', '4. internal/service/orderlegacy/service.go: Create\n5. internal/store/pg/legacy_order_store.go: WriteLegacy');
        },
        mustFail: ['trace names internal/service/orders/service.go: PlaceOrder', 'trace does not route through the legacy orders package'],
      },
      {
        label: 'validated after the insert',
        apply(project) {
          edit(project, 'internal/service/orders/service.go', '	if err := validateOrderInput(in); err != nil {\n		return Order{}, err\n	}\n', '');
          edit(project, 'internal/service/orders/service.go', '	_ = s.events.Publish', '	if err := validateOrderInput(in); err != nil {\n		return Order{}, err\n	}\n	_ = s.events.Publish');
        },
        mustFail: ['PlaceOrder calls validateOrderInput(in) before storing'],
      },
      {
        label: 'acceptable: \\d{4}, <= 0, MatchString, backticked trace with notes',
        apply(project) {
          edit(project, 'internal/service/orders/validate.go', 'in.Quantity < 1 ||', 'in.Quantity <= 0 ||');
          edit(project, 'internal/service/orders/validate.go', '`^[A-Z]{3}-[0-9]{4}$`', '`^[A-Z]{3}-\\d{4}$`');
          edit(project, 'TRACE.md', '1. internal/httpapi/router.go: NewRouter', '1. `internal/httpapi/router.go`: `NewRouter` — mounts /api/orders');
        },
        mustPass: true,
      },
    ],
  },
};
