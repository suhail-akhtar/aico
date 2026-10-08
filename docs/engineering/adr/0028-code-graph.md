# 0028 — Build a native, accurate code graph: resolved imports, symbol references, co-change; one engine for the agent and the Code map view

- **Status:** Accepted (2026-10-05)
- **Date:** 2026-10-05
- **Deciders:** owner (asked for "the graph view, more advanced and powerful, extremely useful for users and for AICO agents and the entire product")
- **Supersedes / related:** reopens the decision recorded in `src/codemap/extract.ts` (no per-language parsers) only as far as this ADR says — it still adds no parser;
  the Phase 0 graph benchmark (eng-bench graph tasks, 2026-10-05: external graph tools *not exceptional*);
  [0013](0013-refactor-tools-ast-grep.md) (TypeScript language service, deferred groups); [0018](0018-recall-and-about-you.md) (store under `aicoHome()`)

## Context

AICO has a symbol list (`src/codemap`) and exact on-demand TS/JS references
(`Refactor findReferences`), but no dependency graph: "what uses this", "what
breaks if I change it", "how does A reach B", "what is the architecture" cost
the model a Grep/Read loop every time, and users have no picture of their
project at all.

The Phase 0 benchmark (75 runs, two external graph tools as MCP servers)
measured what goes wrong with graph tools, and this decision is shaped by it:

1. **Wrong answers are worse than no answers.** buruj-code-lens returned 7
   callers of `formatAmount`, all decoys, because it did not resolve the `@/`
   alias; it found 7 of 58 Python callers; it resolved no Go package. graphify
   answered a Go path question through `context.Context` and "Ambiguous:
   'Insert' matches 39 nodes".
2. **A tool the model must remember to call is mostly not called** (5/25 and
   10/25 runs, with schemas always loaded), and extra schemas cost tokens on
   every request (×1.55 tokens, p=.04, on the one significant result).
3. **The one real win was a signal grep cannot see:** co-change edges from git
   history found the hidden partner file in every run that asked.

Constraints: no new runtime dependency (AGENTS.md §6; `typescript` is a build
tool here, not a runtime dependency — ADR 0013); every client including the
desktop bundle; Windows paths and case; store under `aicoHome()`, never in the
user's repository; bounded, queried-never-injected answers (`codemap` header).

## Decision

1. **An engine module, `src/codegraph/`**, that builds a project graph with no
   model and no new dependency:
   - **Lexing, not parsing.** One masking lexer per language family blanks
     comments and string bodies (keeping literal values by offset), so the
     import/export/usage rules run on code only (`lex.ts`, `parse/*.ts`). It
     reads declaration and import syntax, which is regular; it does not
     type-check.
   - **Imports resolved to real files** (`resolve/*.ts`): TS/JS with
     `tsconfig`/`jsconfig` `extends`, `baseUrl`, `paths` (incl. `@/*`),
     `index` files, `.js`→`.ts` swaps, `package.json` `exports`/`main` of
     workspace packages, CommonJS `require`; Python absolute/relative imports,
     packages and `__init__`, `src/` layouts; Go `go.mod` module path →
     package directory (the package clause, not the folder name, is the local
     name); Java/Kotlin package + type; C# namespaces → declaring files;
     PHP PSR-4 from `composer.json`; Ruby `require`/`require_relative`; Rust
     `mod`/`use crate::`.
   - **Symbol references by binding, not by name.** Each import binding is
     followed through re-export chains (`export *`, `export { a as b }`,
     Python package re-exports) to the file that declares the symbol, and the
     importer's uses of its *local* name (or `ns.member`) are counted. A
     same-named function elsewhere resolves to its own file, so decoys never
     merge. Languages with implicit visibility (Go same package, Java/Kotlin
     same package, C# namespaces) add **inferred** edges only for a name that
     is unique in scope; ambiguity leaves no edge, and builtins are filtered
     (buruj-code-lens's rule, ported).
   - **Re-resolution instead of edge re-attachment.** Parses are cached per
     file by content hash; resolution is recomputed from the cached parses on
     every refresh (it is in-memory and measured in tens of milliseconds), so a
     new file's symbols immediately attract edges that were unresolved before —
     the gap buruj-code-lens's incremental update left.
   - **Co-change from git** (`git.ts`): the last 400 non-merge commits,
     commits touching more than 40 files skipped, paths relative to the project
     (works in a monorepo subfolder), pair support and confidence; per-file
     churn and commit authors (the "owners" summary) from the same pass,
     recomputed only when `HEAD` moves.
   - **Analyses** (`analyze.ts`): impact (reverse closure by depth, tests that
     reach the target), dependents/dependencies, directed shortest path (never
     undirected), cycles (Tarjan), orphans, hotspots (churn × fan-in × size),
     communities (Louvain with aggregation, seeded by folder), entry points,
     external-package usage, configured layering rules, and the impact of the
     uncommitted diff.
   - **Storage**: one JSON per project under `aicoHome()/codegraph/`, keyed by a
     hash of the resolved root; caps of 20,000 files and 1 MB per file; paths
     stored as typed (forward slashes), compared case-insensitively only on
     case-insensitive file systems (the Windows lower-casing bug in
     buruj-code-lens is the reason).
2. **The agent gets it three ways, each enforced in code:**
   - `CodeGraph`, a **deferred** tool (group `graph`) with bounded answers
     (~6,000 characters by default), loaded outright by a request that asks
     about impact, callers, usages, dependencies, paths or architecture
     (`REQUEST_LOADS`). The always-sent schema budget is unchanged.
   - **The edit note.** When `Edit`/`Write` changes an *exported* symbol's
     declaration (removed, renamed or a different signature), the tool result
     gains a short note listing the files that use that symbol and have not
     been changed in this run. This is the benchmark's failure mode (missed
     alias callers) caught in the loop, at the moment it matters, without the
     model having to ask. Once per symbol signature per run; silent when there
     are no untouched users or no graph within a short budget.
   - Read-only sub-agents (`explore`, `plan`, `review`, `architect`, …) and plan
     mode get `CodeGraph` beside `CodebaseMap`.
3. **The Code map view** (`web/src/components/codegraph/`, used by the desktop
   page and the web workspace page) draws the same graph: canvas renderer, a
   Barnes-Hut force layout in a Web Worker, architecture / files / symbol /
   impact / path / cycles / hotspots / co-change / uncommitted-change modes,
   and "Ask AICO about this", which sends the selected nodes and their
   neighbourhood as precise context to a chat. The engine serves it over
   `/api/codegraph/*`, only for registered projects.
4. **Product hooks:** `CodeGraph diagram` returns a Mermaid architecture
   diagram from the real structure for documents and decks.

## Alternatives considered

| Option | Why not |
|---|---|
| Ship buruj-code-lens or graphify | Python runtime and native wheels, Windows defects, and — measured — wrong caller lists and no gain (Phase 0). |
| tree-sitter (web-tree-sitter WASM grammars) | 0.5–3 MB per grammar, a new dependency and an ADR of its own; imports, exports and bindings are regular syntax a masking lexer reads correctly, and the accuracy suite is the arbiter. Revisit if a language needs real parsing. |
| The TypeScript compiler API for resolution | Not a runtime dependency (ADR 0013); a packaged install may not have it; building a program per refresh is seconds per hundred files. It stays the *exact* path for TS/JS references (`Refactor findReferences`), which the tool points to. |
| Precomputed name-matched call graph | The decoy problem by construction. Bindings are followed instead; inferred edges only where the name is unique in scope. |
| Inject a graph summary into the prompt | Pays on every request what it saves once; violates "queried, never injected". |
| ECharts graph series for the view | Already a dependency, but its force layout on the main thread stalls past ~2k nodes and offers no level-of-detail control; a purpose-built canvas renderer with a worker layout is a few hundred lines and has no dependency. |

## Consequences

- **Good:** accurate caller sets on the benchmark's traps (aliases, barrels, a
  renaming re-export, same-named decoys, Python import styles, Go package
  clauses), measured by an accuracy suite in `npm test`; a co-change signal; an
  architecture picture users can act on; an edit-time check for missed callers.
- **Bad / costs:** a second extractor beside `codemap` (kept separate: codemap's
  contract is a cheap symbol list, this one's is resolution); index files in
  the store (a 5,000-file project is a few MB); a refresh stats every indexed
  file.
- **Honest limits:** *(revised by the addendum below — method calls on typed
  receivers and interfaces are now linked)* a receiver whose type the code does
  not state (an untyped parameter, a container element, a value assigned two
  different types) stays unlinked by the lexical rules; dynamic imports with
  computed specifiers, reflection, dependency injection by string, and
  generated code are invisible; Python `import *` is followed only into the
  package's own modules; C#/Java edges for same-namespace types are *inferred*,
  and labelled so.
- **Migration:** none — a new store directory, built on first use.

## Addendum (2026-10-05): method calls by receiver type, exact interfaces, structural alerts

The first version left `obj.method()` unlinked. This addendum closes that and
the other limits the owner asked to be finished.

**Receiver types, only where the code states them** (`src/codegraph/parse/members.ts`,
`src/codegraph/members.ts`). Each file records its classes/interfaces/structs/
traits with methods (exported as `Type.method`), fields and supertypes, the
declared return types of its functions, the types of its module-level
variables, and every `recv.method(…)` whose receiver type its own text
states: a constructor (`new T()`, `T()`, `T{}`, `T::new()`, `T.new`), a typed
parameter/local/field/property, a dataclass field, a Go receiver or struct
field, `self.x = T()` in a method, a declared return type of the function or
method called, chained. Shadowing is respected (loop variables, `catch`,
comprehensions, lambda parameters), and a name assigned two different types —
or once from an expression the rules do not read — is unknown. Resolution
names the type through the same machinery as imports (aliases, barrels,
packages, namespaces, PSR-4, `use`), walks base classes (and Go embedding, PHP
trait `use`), and links the call to the declaration that runs (`via: 'call'`,
edge kind `call`). An unresolvable receiver stays unlinked: a same-named
method on an unrelated class never collects these calls (accuracy suite
`scripts/codegraph-members-test.mjs`, decoys in every language).

**TS/JS through the TypeScript checker** (`src/codegraph/ts-check.ts`). When
`typescript` is loadable (the project's, then AICO's — ADR 0013) and the
project is within 2,500 TS/JS files and 6 MB, a worker thread builds a program
per nearest tsconfig (module resolution limited to the project's own files),
resolves every call whose method name a project type declares, and finds
implementations — declared and structural (`isTypeAssignableTo`). Its answers
replace the lexical ones per file whose content is unchanged since it ran; the
graph is built first without it and rebuilt (new version) when it finishes;
`getCodeGraph({ exact })` waits for it (the agent's tool does, up to 20 s).
This reverses, *for this job only*, the "TS compiler API not used for
resolution" row below: measured cost (this repository: ~12 s program, ~15 s
walk, ~1.7 GB; a 110-file app: 0.6 s, ~95 MB) is why it runs in a worker,
debounced, size-capped, with a heap ceiling and a deadline; the graph's
`stats.methods` says which rules produced the calls and why.

**Projects over the full pass's limits: one symbol, exactly, on demand**
(`src/codegraph/ts-ondemand.ts`). Above the caps the whole-project pass stays
skipped, but a question about one TS/JS symbol — `CodeGraph impact`/`dependents`
on `file#name`, the Code map's symbol view, the edit check after an exported
signature change — is answered by a long-lived TypeScript LanguageService in a
worker: candidates are the reverse import closure of the declaring file
(complete for exports; for methods, plus a cached text scan for `.method`),
the program is built lazily (`skipLibCheck`, project references honoured,
module resolution kept to the project) and updated incrementally (script
versions = modification times), `findReferences` (and
`getImplementationAtPosition`) are classified per related symbol — this
declaration and its aliases are users ("exact (on demand)"), the interface
member it implements gives callers "via interface", sibling implementations are
not users, a re-export is not a use. Results are cached by a hash of every
TS/JS file's content hash; a query is time-boxed (8 s, then the lexical answer
marked `partial` while the worker finishes and caches); the service is
disposed above ~1 GB of heap and rebuilt on the next query (worker heap capped
at 2 GB). Measured on this repository (`scripts/codegraph-ondemand-probe.mjs`):
`aicoHome` — 56 caller files, equal to `findReferences` on the full program;
4.0 s and a 368 MB worker heap (605 files in the program) against 14.5 s and
1.6 GB for the full program; the second ask from the cache. A method
(`DecisionGate.checkHuman`): equal, 6.2 s, 570 MB.

**Interfaces.** Calls on an interface, trait, protocol/ABC or abstract method
link to the declaration (`call`) and to each implementation's method
(`via: 'interface'`, edges `inferred` + `viaInterface`), at most 12 per call.
Implementations are nominal where the language declares them and, for Go,
**exact method sets**: every interface method present with identical
parameter and result types (compared by package, names ignored), on `T` or —
when some have pointer receivers — only `*T` (recorded as `pointer`);
embedded interfaces expanded, embedded structs promote their methods; an
interface embedding one from outside the project is not checked. The old
heuristic (method names + type keys, ≤ 6 types) is gone. The view, the file and
symbol details and `CodeGraph implementations` show each implementation with
*why* (the methods, where, pointer receivers); **Exact only** (view filter,
`exact: true` on the tool) removes everything that rests on an interface or a
unique name.

**Edit check without a graph.** When no graph is ready within the 4 s budget,
the check is queued, appended to the next tool result once the graph is ready,
and — if the model stops first — given to it before the turn may end
(`agent.ts`, `flushQueuedEditNotes`, once per turn). Method signature changes
count (`Type.method` is an export).

**Structural alerts** (`src/codegraph/alerts.ts`). The morning brief compares
each *already indexed* project's graph with its last snapshot and lists new
import cycles, newly broken layering rules, sudden hotspot growth and files
that lost their last importer, ranked, each with "Show in Code map" and "Ask
AICO to fix" (prefilled, never sent); a per-project `codeGraph` monitor does
the same after every re-index (`onGraphBuilt`) and on its polls. No model.

**Rules add up** (`src/codegraph/rules.ts`): user `codeGraph.rules`, user
`codeGraph.projects[<path>].rules`, the project's `.aico/settings*.json`, and a
committed, read-only `.aico/codegraph.json`; `codeGraph` is now `tighten`
in `PROJECT_POLICY` — a project can add rules, never remove the person's.

Still not linked, and why: receivers typed only by flow (`if (x instanceof T)`
narrowing), container element types and generics' type arguments (lexical
rules; the checker handles them for TS/JS), return types nobody declared
outside TS/JS, Python structural Protocol conformance without a declared base.
TypeScript projects above the checker's caps get the lexical rules for the
*whole graph* (edges, the canvas) and exact answers for the symbol asked about.

## Addendum (2026-10-08): a layered Architecture and a Focus view

The force map (Barnes-Hut in a worker) answers "what clusters with what" but
was hard to read and impossible to navigate: no direction, no order, every file
a dot. The default view is now two **layered** drawings, written in-house like
the force layout (no new dependency): `web/src/components/codegraph/layered.ts`
(Sugiyama: cycle breaking by weight then DFS feedback edges, longest-path
layers, dummy nodes, barycentre sweeps with a Fenwick-counted crossing check,
least-squares coordinate packing; deterministic; 5,000 nodes / 15,000 edges in
well under a second in the unit test, dummies dropped past 60,000), `modules.ts`
(folders as boxes, about half a √files of them, opened one at a time) and
`flow.ts` (the two scenes). **Architecture** boxes are *folders*, not the
engine's communities: label-propagation clusters were named after their biggest
folder ("src" with a third of the files) and told a person nothing about where
to look. Dependencies already implied by a longer chain are left out by default
(a "Key links" switch brings them back) because on a folder graph they were
most of the ink. **Focus** puts a file in the middle with its users on the left
and its dependencies on the right, two hops out; the column *is* the hop count,
which a layered layout of the neighbourhood could not promise. The force map
stays as **Overview**; the file-level modes are unchanged. The layered layout
runs on the main thread (it measures in milliseconds at the sizes a screen can
show); only the force layout needs the worker.

## Threat model

Reads project files and runs `git log` / `git diff --name-only` with argument
arrays (no shell) in a project the person registered. The HTTP routes accept
only registered projects (`isKnownProject`) and return paths relative to the
project; the store lives under `aicoHome()`. File contents never leave the
engine except as file paths, symbol names and line numbers. No network.

## Verification

- `scripts/codegraph-test.mjs` (in `npm test`): resolver fixtures per language,
  exact caller sets on the benchmark's traps (and on the eng-bench generators'
  own fixtures when present), incremental update, co-change, analyses, the edit
  note, deferred-group loading, the API's project check.
- `scripts/codegraph-perf.mjs`: a generated 5,000-file project — full index,
  memory, incremental update.
- Web unit tests for the view's pure logic (layout, filters, impact layers).
- Live: the desktop Code map on this repository and on a generated project;
  eng-bench graph tasks, native arm vs the Phase 0 baseline.

### Measured at acceptance (2026-10-05)

- Accuracy on the Phase 0 fixtures: `formatAmount` 92/92 callers, 0 decoys
  (aliases, barrels, `money` re-export, namespace); Python billing `process`
  58/58, audit users kept separate; Go handler → service → store path through
  two interfaces, never through the legacy package; `rates.js` ⇄
  `partitions.js` the top co-change pair (8 commits, 100%, no import).
- 5,000-file generated project: full index ~0.4–1.1 s, one-file refresh
  ~0.1–0.25 s (1 file re-parsed), restart from the store 0 re-parsed, ~3 MB
  store, ~1 MB view payload. This repository (1,316 files): ~2–4 s cold.
- eng-bench graph tasks, deepseek-flash, n = 3 per task: 15/15 pass (as
  baseline). Tokens vs the Phase 0 baseline means: next-alias ×1.50,
  py-same-name ×0.81, go-request-path ×0.60, ts-py-impact ×0.98, cochange-fix
  ×0.95 (×0.74 after the read-time warm-up made the co-change note fire);
  none significant at this n. The edit note fired in every run that changed
  `formatAmount`/`process`; `CodeGraph` was called in 4/6 runs of those tasks.
