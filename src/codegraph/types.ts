/**
 * What the code graph is made of: per-file parse records (cached by content
 * hash), and the resolved graph built from them.
 *
 * Two layers on purpose. A {@link ParsedFile} depends only on one file's text,
 * so it is cached and reused until that text changes; everything that depends
 * on *other* files — which file an import names, which declaration a binding
 * reaches through a barrel — is recomputed from the cached parses on every
 * refresh. Resolution is cheap and in memory, and recomputing it is what lets a
 * newly added file attract the edges that were unresolved before it existed
 * (the gap an edge-re-attaching incremental update leaves).
 *
 * @module codegraph/types
 */

export type Lang = 'ts' | 'js' | 'py' | 'go' | 'java' | 'kotlin' | 'cs' | 'php' | 'rb' | 'rs';

/** One name an import binds: `imported` in the module, `local` in this file. */
export interface ImportBinding {
  /** The exported name; `default` for a default import. */
  imported: string;
  local: string;
}

/** One import, re-export, require, include or use, as written. */
export interface RawImport {
  /** The specifier as written (module path, Go import path, Java/C#/PHP qualified name, Rust use path). */
  spec: string;
  /** 1-based line. */
  line: number;
  /** Named and default bindings. */
  names?: ImportBinding[];
  /** A binding of the whole module (`import * as ns`, Python `import a.b as x`, a Go package alias). */
  ns?: string;
  /** Re-exported from this module: everything (`export *`) or the listed names (`imported` → `local` = exported name). */
  reexport?: 'all' | ImportBinding[];
  typeOnly?: boolean;
  kind?: 'static' | 'dynamic' | 'require' | 'side-effect' | 'include' | 'wildcard' | 'static-member';
  /** Python relative level (number of leading dots). */
  level?: number;
}

/** A top-level declaration a file offers to others. */
export interface ExportDecl {
  name: string;
  kind: string;
  line: number;
  /** The declaration header, whitespace-normalised: what an edit to the signature changes. */
  sig: string;
  /** Not visible outside its package/module (Go lower-case, Python `_x`): kept for same-package resolution. */
  internal?: boolean;
}

export interface ParsedFile {
  lang: Lang;
  imports: RawImport[];
  exports: ExportDecl[];
  /** `export { a as b }` without a `from`: a local (or imported) binding exported under a name. */
  localExports?: ImportBinding[];
  /** Lines where each import-bound local name is used (outside the import itself). At most a few per name. */
  uses: Record<string, number[]>;
  /** `qualifier.member` uses: qualifier → member → lines. Qualifiers are import-bound names (any package-like name in Go). */
  members: Record<string, Record<string, number[]>>;
  /** Go package clause, Java/Kotlin package, PHP namespace. */
  pkg?: string;
  /** C# namespaces declared in the file. */
  namespaces?: string[];
  /** Identifiers used that could name a declaration elsewhere in scope (types, same-package functions). Bounded. */
  refs?: string[];
  /** Why this file is an entry point, read from its content (`func main`, `__main__`, routes…). */
  entry?: string;
  /** Go: interface name → its method names (for implementation edges). */
  ifaces?: Record<string, string[]>;
  /** Classes, interfaces, structs, traits declared here, with members (codegraph/parse/members). */
  types?: TypeDecl[];
  /** Methods declared outside their type's body: Go receivers, Rust `impl` blocks, Kotlin extensions. */
  ext?: ExtMethod[];
  /** `recv.method(…)` calls whose receiver type this file's own text determines. */
  calls?: CallSite[];
  /** Declared return types of top-level functions. */
  returns?: Record<string, TypeRef>;
  /** Types of module-level variables (`svc = BillingService()`, `export const svc = new Svc()`). */
  globals?: Record<string, TypeRef>;
  loc: number;
}

/**
 * A type as one file's text names it, resolved later against that file's
 * imports and scope (codegraph/members):
 *
 * - `'T'`, `'pkg.T'` — a type name as written (qualified by an import);
 * - `{ ret: 'f' }` — what calling `f` gives: an instance when `f` is a class,
 *   the declared return type when it is a function;
 * - `{ v: 'x' }` — the type of a module-level variable, possibly imported;
 * - `{ of, m }` — the declared return type of method `m` on a receiver of type `of`;
 * - `{ of, f }` — the declared type of field `f` on a receiver of type `of`.
 *
 * Nothing here is a guess: a parse that cannot name the type records nothing.
 */
export type TypeRef = string | { ret: string } | { v: string } | { of: TypeRef; m: string } | { of: TypeRef; f: string };

/** A method (or interface/trait member) of a type. */
export interface MemberDecl {
  name: string;
  line: number;
  /** Header text, whitespace-normalised. */
  sig: string;
  /** Declared return type. `'Self'` means the receiver's own type. */
  ret?: TypeRef;
  /** Go: declared on the pointer receiver (`func (s *T)`), so only `*T` has it. */
  ptr?: boolean;
  /** Declared without a body to be overridden (`abstract`, `@abstractmethod`). */
  abstract?: boolean;
  internal?: boolean;
}

export interface TypeDecl {
  name: string;
  kind: 'class' | 'interface' | 'struct' | 'trait' | 'enum' | 'object' | 'type';
  line: number;
  /** Supertypes as written: `extends`, Python bases, Kotlin/C# `:` lists, Go embedded interfaces. */
  bases?: string[];
  /** `implements` lists (Java, TS, PHP). */
  impls?: string[];
  /** Go struct embedding (promoted methods). */
  embeds?: Array<{ name: string; ptr: boolean }>;
  methods: MemberDecl[];
  /** Field name → declared or constructed type. */
  fields?: Record<string, TypeRef>;
  /** Interface, trait, protocol or ABC: calls through it may reach any implementation. */
  iface?: boolean;
  internal?: boolean;
  /** `export default class` (TS/JS). */
  def?: boolean;
}

/** A method declared outside its type's body. `trait`: Rust `impl Trait for Type`. */
export interface ExtMethod { type: string; trait?: string; m: MemberDecl }

export interface CallSite { recv: TypeRef; m: string; line: number }

/** One file as stored: identity, freshness, and its parse. */
export interface FileRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  parsed?: ParsedFile;
}

/** `call`: a method call whose receiver's type is known (codegraph/members). */
export type EdgeKind = 'import' | 'reexport' | 'package' | 'inferred' | 'dynamic' | 'call';

export interface FileEdge {
  from: number;
  to: number;
  kind: EdgeKind;
  /** Symbols of `to` that `from` uses, through any re-export chain. */
  names: string[];
  /**
   * A literal import that only passes through a barrel: every name it binds
   * resolved to a declaration in another file, which has its own edge. Kept
   * for the picture, skipped by impact so a barrel does not make everything
   * depend on everything.
   */
  passThrough?: boolean;
  /** `resolved`: an explicit import or a language rule; `inferred`: a unique name in scope, or an interface. */
  confidence: 'resolved' | 'inferred';
  /** Every reason for this edge is a call or an implementation through an interface: possible, not certain. */
  viaInterface?: boolean;
}

/** One file that uses a declared symbol. */
export interface SymbolRef {
  file: number;
  /** The name it uses locally (an alias, `ns.member`, or the name itself). */
  local: string;
  lines: number[];
  /**
   * `ondemand`: found by the TypeScript language service for this one symbol
   * (codegraph/ts-ondemand) — "exact (on demand)".
   * `call`: a method called on a receiver whose type is known; `interface`:
   * a call through an interface (or abstract method) that this implementation
   * may receive, or the interface's own link to a type that satisfies it.
   */
  via: 'import' | 'namespace' | 'reexport' | 'package' | 'inferred' | 'call' | 'interface' | 'ondemand';
}

/** A type that satisfies an interface (or trait, protocol, abstract base), and why. */
export interface Implementation {
  iface: { file: number; name: string };
  impl: { file: number; name: string };
  /** The interface's methods, each with where the implementation has it. */
  methods: Array<{ name: string; file: number; line: number; ptr?: boolean }>;
  /** `declared`: `implements`/`extends`/`impl Trait for`; `structural`: the method sets match (Go, TS). */
  how: 'declared' | 'structural';
  /** Go: only `*T` has every method (some have pointer receivers). */
  pointer?: boolean;
}

export interface GraphFile {
  id: number;
  path: string;
  lang: Lang;
  size: number;
  loc: number;
  dir: string;
  isTest: boolean;
  entry?: string;
  exports: ExportDecl[];
  fanIn: number;
  fanOut: number;
  churn: number;
  authors: Array<[string, number]>;
  community: number;
  hotspot: number;
}

export interface CoChange {
  a: number;
  b: number;
  /** Commits that touched both. */
  count: number;
  /** count / min(commits(a), commits(b)). */
  confidence: number;
}

export interface Community {
  id: number;
  label: string;
  files: number[];
}

export interface CodeGraph {
  root: string;
  builtAt: number;
  /** Changes whenever the graph's content does: a cheap "has anything moved" for clients. */
  version: string;
  files: GraphFile[];
  edges: FileEdge[];
  /** `${fileId}:${name}` → users. */
  symbols: Map<string, SymbolRef[]>;
  /** External package → importing files. */
  external: Map<string, number[]>;
  /** Bindings to a name their module does not export (a removed or renamed symbol's users). */
  dangling: Map<string, SymbolRef[]>;
  /** Imports that look local but resolved to nothing (bounded). */
  unresolved: Array<{ file: number; spec: string }>;
  cochange: CoChange[];
  communities: Community[];
  /** Interface → implementation pairs, with the methods that make them one. */
  implementations: Implementation[];
  git: { available: boolean; head?: string; commits: number; skippedLarge: number };
  stats: {
    indexed: number; parsed: number; skipped: number; truncated: boolean; buildMs: number; resolveMs: number;
    /** How TS/JS method calls were resolved: the TypeScript checker, or the lexical rules (and why). */
    methods?: { ts: 'checker' | 'lexical' | 'pending'; note?: string; calls: number; overCap?: boolean };
  };
}
