/**
 * Members and calls: what types a file declares (classes, interfaces,
 * structs, traits — their methods, fields, supertypes) and which
 * `recv.method(…)` calls it makes on a receiver whose type its own text
 * states.
 *
 * ## Why
 *
 * ADR 0028 shipped with an honest limit: "no type inference — `obj.method()`
 * through an interface or a receiver of unknown type is not linked". Who calls
 * `BillingService.process` is the question a refactor asks most, and a
 * file-level import edge does not answer it: the importer may call `charge`
 * and never `process`, and a same-named `process` on an unrelated class is a
 * decoy a name match would merge.
 *
 * ## Where it is sound, and only there
 *
 * A receiver's type is recorded only when the code states it:
 *
 * - a constructor: `new T()`, `T()` (Python, Kotlin), `T{…}` / `&T{}` / `new(T)`
 *   (Go), `T::new()` (Rust: the declared return type of `new`), `T.new` (Ruby);
 * - a declaration: a typed parameter, local, field or property (`svc: T`,
 *   `T svc`, `$svc` typed, `let svc: T`), a dataclass field, a Go struct field,
 *   a receiver (`func (s *Store)`, `self`, `this`, `$this`);
 * - a declared return type of the function or method called (`x = make()`,
 *   `x := store.New()`, `T.create()`), followed through imports at resolution;
 * - a module-level variable of a known type, possibly imported.
 *
 * Everything else — an untyped parameter, a value from a container, a
 * variable assigned two different types or from an expression this does not
 * read (a ternary, an arithmetic result) — is *unknown*, and an unknown
 * receiver records no call. Shadowing is respected: a loop variable, `catch`
 * binding, comprehension or lambda parameter of the same name makes the outer
 * type unknown rather than wrongly inherited. A name a file assigns more than
 * one type is unknown in that function.
 *
 * The types recorded are *names as written*; which declaration a name means
 * (through imports, packages, namespaces) is resolution's job
 * (codegraph/members), where an unresolvable name stays unlinked.
 *
 * ## What it deliberately does not do
 *
 * - Element types of containers (`items[0].run()`, `for x in xs` without a
 *   declared type), generics' type arguments, flow narrowing, overloads.
 * - Return types nobody declared (Python without `->`, TS without `: T`),
 *   except that calling a class is an instance of it.
 * - TS/JS when the TypeScript checker is available: this is the fallback;
 *   the checker's answers replace these (codegraph/ts-check).
 *
 * @module codegraph/parse/members
 */

import { lineAt, normaliseSig, stringAt, type Masked } from '../lex.js';
import type { CallSite, ExportDecl, ExtMethod, Lang, ParsedFile, TypeDecl, TypeRef } from '../types.js';

export interface Members {
  types: TypeDecl[];
  ext: ExtMethod[];
  calls: CallSite[];
  returns: Record<string, TypeRef>;
  globals: Record<string, TypeRef>;
  /** `Type.method` declarations to add to the file's exports. */
  exports: ExportDecl[];
  /** Ranges of `impl`/`trait` bodies (Rust): functions inside are methods, not top-level. */
  methodRanges: Array<[number, number]>;
}

const MAX_CALLS = 4_000;

// ── Brackets and statements ─────────────────────────────────────────────────

const PAIR: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The matching closer of the bracket at `open`, or -1. Strings and comments are already blank. */
export function closeOf(code: string, open: number): number {
  const o = code[open]!;
  const c = PAIR[o];
  if (!c) return -1;
  let d = 0;
  for (let j = open; j < code.length; j++) {
    const ch = code[j];
    if (ch === o) d++;
    else if (ch === c) { d--; if (d === 0) return j; }
  }
  return -1;
}

function openOf(code: string, close: number): number {
  const c = code[close]!;
  const o = OPEN[c];
  if (!o) return -1;
  let d = 0;
  for (let j = close; j >= 0; j--) {
    const ch = code[j];
    if (ch === c) d++;
    else if (ch === o) { d--; if (d === 0) return j; }
  }
  return -1;
}

/** Split at top-level separators, brackets and angle brackets balanced (`=>`/`->` are not brackets). */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '>' && s[i - 1] !== '=' && s[i - 1] !== '-') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const CONTINUES = /^(\?\.|\.(?!\.)|->|\?->|&&|\|\||\?\?|[+\-*/%]|\?|:(?!:))/;

/** End of the statement starting at `start`: a top-level `;`, or a line end that does not continue. */
export function stmtEnd(code: string, start: number, lang: Lang, cap = 600): number {
  let depth = 0;
  const end = Math.min(code.length, start + cap);
  for (let j = start; j < end; j++) {
    const ch = code[j]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return j; depth--; }
    else if (depth === 0 && ch === ';' && lang !== 'py') return j;
    else if (depth === 0 && ch === ',' && (lang === 'go' || lang === 'py')) return j;
    else if (depth === 0 && ch === '\n') {
      let k = j - 1;
      while (k > start && (code[k] === ' ' || code[k] === '\t' || code[k] === '\r')) k--;
      if (code[k] === '\\' || /[=,(.+\-*/&|?:]$/.test(code[k] ?? '') && lang !== 'py') continue;
      let n = j + 1;
      while (n < code.length && /\s/.test(code[n]!)) n++;
      if (lang !== 'py' && lang !== 'rb' && CONTINUES.test(code.slice(n, n + 3))) continue;
      return j;
    }
  }
  return end;
}

// ── Type text ───────────────────────────────────────────────────────────────

const NO_TYPE = new Set(['string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'object', 'int', 'float', 'str', 'bool', 'bytes', 'None', 'null', 'undefined', 'long', 'double', 'char', 'byte', 'short', 'error', 'rune', 'int64', 'int32', 'uint', 'uint64', 'float64', 'float32', 'usize', 'isize', 'u8', 'u32', 'u64', 'i32', 'i64', 'f32', 'f64', 'String', 'str', 'Unit', 'Int', 'Long', 'Boolean', 'Double', 'Any', 'Nothing', 'mixed', 'array', 'callable', 'iterable', 'dynamic', 'decimal', 'Object', 'Integer', 'Self_']);
const WRAPPERS = /^(Promise|Awaited|Readonly|Box|Rc|Arc|Task|ValueTask|Lazy|Optional|Annotated|ClassVar|Final|Required|NotRequired|ReadOnly)$/;
const PY_OPTIONAL = /^(Optional|Annotated|ClassVar|Final|Required|NotRequired)$/;

/**
 * A declared type's core name: wrappers that do not change what methods it has
 * (`Promise<T>`, `Optional[T]`, `T | null`, `*T`, `&mut T`, `?T`, `T?`, `Box<T>`)
 * removed, generic arguments dropped. Undefined for anything that is not one
 * named type (unions of two types, arrays, functions, tuples).
 */
export function coreType(raw: string | undefined, lang: Lang): string | undefined {
  if (raw === undefined) return undefined;
  let t = raw.trim().replace(/\s+/g, ' ');
  for (let guard = 0; guard < 8; guard++) {
    const before = t;
    t = t.replace(/^(?:readonly|final|const|mut|dyn|impl|in|out|ref|params|this|static|unowned|lateinit|volatile|transient|crate|pub)\s+/, '')
      .replace(/^&(?:'[A-Za-z_]\w*\s+)?(?:mut\s+)?/, '')
      .replace(/^\*+/, '')
      .replace(/^\?/, '')
      .replace(/[?!]$/, '')
      .replace(/^@\w+(?:\([^)]*\))?\s+/, '')
      .trim();
    // Unions with null/undefined/None: the other member.
    const bar = splitTop(t, '|').map(x => x.trim()).filter(Boolean);
    if (bar.length > 1) {
      const real = bar.filter(x => !/^(null|undefined|None|void)$/.test(x));
      if (real.length !== 1) return undefined;
      t = real[0]!;
    }
    // Wrapper<T> / Wrapper[T] → T.
    const g = /^([A-Za-z_$][\w$.]*)\s*([<[])(.*)([>\]])$/.exec(t);
    if (g) {
      const base = g[1]!.split('.').pop()!;
      const args = splitTop(g[3]!).map(x => x.trim());
      if (lang === 'py' && base === 'Union') {
        const real = args.filter(x => !/^(None|type\(None\))$/.test(x));
        if (real.length !== 1) return undefined;
        t = real[0]!;
      } else if (WRAPPERS.test(base) && (lang !== 'java' || base !== 'Optional') && (lang === 'py' ? PY_OPTIONAL.test(base) || base === 'Awaited' : true)) {
        if (!args.length) return undefined;
        t = args[0]!;
      } else {
        t = g[1]!;
      }
    }
    if (t === before) break;
  }
  if (lang === 'rs') t = t.replace(/::/g, '.');
  if (lang === 'php') t = t.replace(/^\\/, '');
  const ok = lang === 'php' ? /^[A-Za-z_][\w\\]*$/.test(t) : /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t);
  if (!ok) return undefined;
  if (NO_TYPE.has(t)) return undefined;
  return t;
}

// ── Expressions ─────────────────────────────────────────────────────────────

interface Seg { name: string; call: boolean; conn: string; composite?: boolean }

const SELF_NAMES: Partial<Record<Lang, string[]>> = {
  ts: ['this'], js: ['this'], java: ['this'], kotlin: ['this'], cs: ['this'], php: ['$this', 'self', 'static'], py: ['self', 'cls'], rs: ['self', 'Self'], rb: ['self'],
};

export interface ExprCtx {
  lang: Lang;
  /** A name's type here: a TypeRef, `null` for known-unknown (shadowed, conflicting), undefined for not bound. */
  lookup: (name: string) => TypeRef | null | undefined;
  /** The enclosing type, for `this`/`self`. */
  cls?: string;
  /** Names bound by imports (module objects, imported values and types). */
  imported: Set<string>;
}

/** Parse a postfix chain `[new] a.b(…).c` into segments; undefined unless the whole text is one chain. */
function chain(src: string, lang: Lang): { segs: Seg[]; isNew: boolean; group?: string } | undefined {
  let s = src.trim();
  s = s.replace(/^(?:await|yield)\s+/, '').replace(/^try[!?]?\s+/, '');
  if (lang === 'go' || lang === 'rs') s = s.replace(/^&(?:mut\s+)?/, '');
  let i = 0;
  const segs: Seg[] = [];
  let isNew = false;
  let group: string | undefined;
  const ws = (): void => { while (i < s.length && /\s/.test(s[i]!)) i++; };
  const idAt = (): string | undefined => {
    const m = /^(?:\$|\\|@)?[A-Za-z_][\w$]*(?:\\[A-Za-z_]\w*)*/.exec(s.slice(i));
    if (!m) return undefined;
    i += m[0].length;
    return m[0];
  };
  if (/^new\s/.test(s)) { isNew = true; i = 3; ws(); }
  if (s[i] === '(' && !isNew) {
    const close = closeOf(s, i);
    if (close < 0) return undefined;
    group = s.slice(i + 1, close);
    i = close + 1;
  } else {
    const first = idAt();
    if (!first) return undefined;
    segs.push({ name: first, call: false, conn: '' });
  }
  for (;;) {
    ws();
    // Generic arguments right before a call: `make<T>(` / `make::<T>(`.
    if ((s[i] === '<' || s.startsWith('::<', i)) && segs.length) {
      const startG = s[i] === '<' ? i : i + 2;
      let d = 0; let j = startG;
      for (; j < s.length; j++) { if (s[j] === '<') d++; else if (s[j] === '>') { d--; if (d === 0) break; } }
      if (j < s.length && s[j + 1] === '(') i = j + 1;
    }
    if (s[i] === '(') {
      const close = closeOf(s, i);
      if (close < 0 || !segs.length) return undefined;
      segs[segs.length - 1]!.call = true;
      i = close + 1;
      continue;
    }
    if (s[i] === '{' && (lang === 'go' || lang === 'rs') && segs.length && !segs[segs.length - 1]!.call) {
      const close = closeOf(s, i);
      if (close < 0) return undefined;
      segs[segs.length - 1]!.composite = true;
      i = close + 1;
      continue;
    }
    if (s[i] === '!' && s[i + 1] !== '=' && lang === 'ts') { i++; continue; }
    if (s[i] === '?' && lang === 'rs') { i++; continue; }
    const conn = /^(\?\.|!\.|\.|->|\?->|::)/.exec(s.slice(i));
    if (!conn) break;
    const save = i;
    i += conn[0].length;
    ws();
    const name = idAt();
    if (!name) { i = save; break; }
    segs.push({ name, call: false, conn: conn[0] });
  }
  ws();
  if (i < s.length) return undefined;
  return { segs, isNew, ...(group !== undefined ? { group } : {}) };
}

const CAP = /^[A-Z]/;

/** What an expression evaluates to, as a {@link TypeRef}; undefined when the text does not say. */
export function exprType(src: string, ctx: ExprCtx, depth = 0): TypeRef | undefined {
  if (depth > 6) return undefined;
  let text = src.trim().replace(/;$/, '').trim();
  if (!text) return undefined;
  const lang = ctx.lang;
  // `x as T` (TS, Kotlin), `x as! T`.
  if (lang === 'ts' || lang === 'js' || lang === 'kotlin') {
    const as = /^([\s\S]*\S)\s+as[!?]?\s+([A-Za-z_$][\w$.]*(?:<[^]*>)?)\s*$/.exec(text);
    if (as) return coreType(as[2], lang);
  }
  // Go `new(T)`, Rust/PHP typed literal forms handled by the chain.
  const goNew = lang === 'go' ? /^new\s*\(\s*([A-Za-z_][\w.]*)\s*\)$/.exec(text) : null;
  if (goNew) return goNew[1];
  if (lang === 'rb') text = text.replace(/\.new\b(\s*\(.*\))?$/s, '.new()');
  const c = chain(text, lang);
  if (!c) return undefined;
  const { segs } = c;
  let cur: TypeRef | undefined;
  let k = 0;
  if (c.group !== undefined) {
    cur = exprType(c.group, ctx, depth + 1);
    if (cur === undefined) return undefined;
  } else if (c.isNew) {
    // `new a.b.C(…)`: the qualified name up to the call.
    const parts: string[] = [];
    for (; k < segs.length; k++) {
      parts.push(segs[k]!.name.replace(/^\\/, ''));
      if (segs[k]!.call) { k++; break; }
    }
    cur = parts.join(lang === 'php' ? '\\' : '.');
  } else {
    const s0 = segs[0]!;
    const selfNames = SELF_NAMES[lang] ?? [];
    if (selfNames.includes(s0.name) && !s0.call) {
      if (!ctx.cls) return undefined;
      cur = ctx.cls;
      k = 1;
    } else if (lang === 'rb' && segs.length >= 2 && CAP.test(s0.name) && segs[1]!.name === 'new') {
      cur = s0.name;
      k = 2;
    } else if (s0.composite) {
      cur = s0.name;
      k = 1;
    } else if (s0.call) {
      cur = { ret: s0.name };
      k = 1;
    } else {
      const bound = ctx.lookup(s0.name);
      if (bound === null) return undefined;
      if (bound !== undefined) { cur = bound; k = 1; }
      else if (ctx.imported.has(s0.name) || (lang === 'go' && /^[a-z]/.test(s0.name) && segs[1] && /^[A-Z]/.test(segs[1].name))) {
        // A module, package or imported value: `models.User(…)`, `pkg.New()`, `pkg.T{}`, `svc`.
        // `app.models.User(…)` after `import app.models`: the dotted path up to the member used.
        let q = s0.name;
        let j = 1;
        while (segs[j] && !segs[j]!.call && !segs[j]!.composite && segs[j + 1] && segs[j]!.conn === '.' && lang === 'py') { q = `${q}.${segs[j]!.name}`; j++; }
        const next = segs[j];
        if (!next) { cur = { v: q }; k = j; }
        else {
          const qn = `${q}.${next.name}`;
          cur = next.composite ? qn : next.call ? { ret: qn } : { v: qn };
          k = j + 1;
        }
      } else if ((CAP.test(s0.name) && lang !== 'go') || (segs[1]?.conn === '::' && (lang === 'php' || lang === 'rs'))) {
        // A type used statically: `Foo.create()`, `T::new()`, `Repo::find()`.
        cur = s0.name.replace(/^\\/, '');
        k = 1;
        // `a::b::T::new()`: a path to a type.
        while (lang === 'rs' && segs[k]?.conn === '::' && !segs[k]!.call && segs[k + 1]?.conn === '::') { cur = `${cur}.${segs[k]!.name}`; k++; }
      } else {
        return undefined;
      }
    }
  }
  for (; k < segs.length; k++) {
    const seg = segs[k]!;
    if (seg.composite) return undefined;
    cur = seg.call ? { of: cur!, m: seg.name } : { of: cur!, f: seg.name };
  }
  return cur;
}

/** The receiver expression ending just before `at` (a `.`, `->`, `::` connector), read backwards. */
export function receiverBefore(code: string, at: number): string | undefined {
  let i = at - 1;
  const skip = (): void => { while (i >= 0 && /\s/.test(code[i]!)) i--; };
  skip();
  let start = -1;
  for (let guard = 0; guard < 40; guard++) {
    const ch = code[i];
    if (ch === undefined) break;
    if (ch === '!' || (ch === '?' && code[i + 1] !== '.')) { i--; skip(); continue; }
    if (ch === ')' || ch === ']') {
      const o = openOf(code, i);
      if (o < 0) return undefined;
      start = o;
      i = o - 1;
      // `f(…)`, `x[…]`: the name before the group belongs to the chain.
      let k = i;
      while (k >= 0 && (code[k] === ' ' || code[k] === '\t')) k--;
      if (k >= 0 && /[\w$>]/.test(code[k]!)) {
        // `make<T>(`: skip generic arguments.
        if (code[k] === '>') {
          let d = 0; let j = k;
          for (; j >= 0; j--) { if (code[j] === '>') d++; else if (code[j] === '<') { d--; if (d === 0) break; } }
          if (j < 0) return undefined;
          k = j - 1;
          if (code[k] === ':' && code[k - 1] === ':') k -= 2;
        }
        i = k;
        continue;
      }
      break;
    }
    if (/[\w$]/.test(ch)) {
      let j = i;
      while (j >= 0 && /[\w$\\@]/.test(code[j]!)) j--;
      start = j + 1;
      i = j;
      // `new X(…)`
      let k = i;
      while (k >= 0 && (code[k] === ' ' || code[k] === '\t')) k--;
      if (code.slice(Math.max(0, k - 2), k + 1) === 'new' && !/[\w$]/.test(code[k - 3] ?? '')) { start = k - 2; break; }
      // A connector before: keep going.
      const conn = /(\?\.|!\.|\.|->|\?->|::)$/.exec(code.slice(Math.max(0, k - 2), k + 1));
      if (conn && !(conn[0] === '.' && code[k - 1] === '.')) {
        i = k - conn[0].length;
        skip();
        continue;
      }
      break;
    }
    break;
  }
  if (start < 0) return undefined;
  const text = code.slice(start, at).trim();
  if (!text || /^\d/.test(text)) return undefined;
  return text;
}

// ── Scopes ──────────────────────────────────────────────────────────────────

interface Assign { name: string; declared?: TypeRef | undefined; typed: boolean; rhs?: string; unknown?: boolean; /** Where it was written: its right-hand side is read in that place's scope. */ at?: number }

interface Scope {
  start: number;
  end: number;
  /** Enclosing type for `this`/`self`. */
  cls?: string;
  params: Map<string, TypeRef | null>;
  assigns: Map<string, Assign[]>;
  resolved: Map<string, TypeRef | null>;
  module?: boolean;
}

interface ClassRange { name: string; start: number; end: number; decl: TypeDecl; fieldRaw: Map<string, Assign[]> }

const serial = (t: TypeRef): string => (typeof t === 'string' ? t : JSON.stringify(t));

class FileModel {
  readonly lang: Lang;
  readonly code: string;
  readonly m: Masked;
  readonly source: string;
  readonly scopes: Scope[] = [];
  readonly classes: ClassRange[] = [];
  readonly types: TypeDecl[] = [];
  readonly ext: ExtMethod[] = [];
  readonly returns: Record<string, TypeRef> = {};
  readonly imported: Set<string>;
  readonly methodRanges: Array<[number, number]> = [];
  private evaluating = new Set<string>();

  constructor(m: Masked, source: string, lang: Lang, imported: Set<string>) {
    this.m = m;
    this.code = m.code;
    this.source = source;
    this.lang = lang;
    this.imported = imported;
    this.scopes.push({ start: 0, end: this.code.length + 1, params: new Map(), assigns: new Map(), resolved: new Map(), module: true });
  }

  line(at: number): number { return lineAt(this.m, at); }

  addScope(start: number, end: number, params: Map<string, TypeRef | null>, cls?: string): Scope {
    const s: Scope = { start, end, params, assigns: new Map(), resolved: new Map(), ...(cls ? { cls } : {}) };
    this.scopes.push(s);
    return s;
  }

  /** The innermost scope containing `at`. */
  scopeAt(at: number): Scope {
    let best = this.scopes[0]!;
    for (const s of this.scopes) if (s.start <= at && at < s.end && (s.end - s.start) < (best.end - best.start)) best = s;
    return best;
  }

  /** Scopes containing `at`, innermost first. */
  chainAt(at: number): Scope[] {
    return this.scopes.filter(s => s.start <= at && at < s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
  }

  classAt(at: number): ClassRange | undefined {
    let best: ClassRange | undefined;
    for (const c of this.classes) if (c.start <= at && at < c.end && (!best || c.start >= best.start)) best = c;
    return best;
  }

  assign(at: number, a: Assign): void {
    const s = this.scopeAt(at);
    // A statement in a class body itself (not in one of its methods) declares a field,
    // which the member scan reads; it is not a variable of the enclosing scope.
    const c = this.classAt(at);
    if (c && s.start <= c.start) return;
    a.at ??= at;
    const list = s.assigns.get(a.name) ?? [];
    list.push(a);
    s.assigns.set(a.name, list);
  }

  fieldAssign(at: number, a: Assign): void {
    const c = this.classAt(at);
    if (!c) return;
    const list = c.fieldRaw.get(a.name) ?? [];
    list.push(a);
    c.fieldRaw.set(a.name, list);
  }

  ctxAt(at: number): ExprCtx {
    const chainScopes = this.chainAt(at);
    const cls = chainScopes.find(s => s.cls)?.cls ?? this.classAt(at)?.name;
    return { lang: this.lang, imported: this.imported, ...(cls ? { cls } : {}), lookup: (name) => this.lookup(name, chainScopes, at, cls) };
  }

  private lookup(name: string, chainScopes: Scope[], at: number, cls: string | undefined): TypeRef | null | undefined {
    for (const s of chainScopes) {
      if (s.params.has(name)) return s.params.get(name)!;
      if (s.assigns.has(name)) return this.resolveAssigns(s, name, at);
    }
    // Kotlin's implicit lambda parameter is never a field.
    if (this.lang === 'kotlin' && name === 'it') return null;
    // Ruby instance variables are the object's fields.
    if (this.lang === 'rb' && name.startsWith('@') && cls) return { of: cls, f: name };
    // Java-like languages reach their own fields (and C# properties) by bare name.
    if (cls && (this.lang === 'java' || this.lang === 'kotlin' || this.lang === 'cs')) {
      const own = this.classes.find(c => c.name === cls && c.start <= at && at < c.end);
      if (own?.decl.fields?.[name] !== undefined || /^[a-z_]/.test(name)) return { of: cls, f: name };
    }
    return undefined;
  }

  /** One type for every assignment of `name` in the scope, or null. */
  private resolveAssigns(s: Scope, name: string, at: number): TypeRef | null {
    const held = s.resolved.get(name);
    if (held !== undefined) return held;
    const key = `${s.start}:${name}`;
    if (this.evaluating.has(key)) return null;
    this.evaluating.add(key);
    let out: TypeRef | null = null;
    try {
      const list = s.assigns.get(name)!;
      const typed = list.find(a => a.typed);
      if (typed) out = typed.declared ?? null;
      else {
        let one: TypeRef | undefined;
        let ok = true;
        for (const a of list) {
          if (a.unknown || a.rhs === undefined) { ok = false; break; }
          const t = exprType(a.rhs, this.ctxAt(a.at ?? at));
          if (t === undefined || (one !== undefined && serial(one) !== serial(t))) { ok = false; break; }
          one = t;
        }
        out = ok && one !== undefined ? one : null;
      }
    } finally {
      this.evaluating.delete(key);
    }
    s.resolved.set(name, out);
    return out;
  }

  /** A class's fields, from declarations and assignments in its methods. */
  finishFields(): void {
    for (const c of this.classes) {
      const fields: Record<string, TypeRef> = { ...(c.decl.fields ?? {}) };
      for (const [name, list] of c.fieldRaw) {
        if (fields[name] !== undefined) continue;
        const typed = list.find(a => a.typed);
        if (typed) { if (typed.declared !== undefined) fields[name] = typed.declared; continue; }
        let one: TypeRef | undefined;
        let ok = true;
        for (const a of list) {
          // Read where it was written: `self.repo = repo` names the method's parameter.
          const t = a.rhs !== undefined ? exprType(a.rhs, this.ctxAt(a.at ?? c.start)) : undefined;
          if (a.unknown || t === undefined || (one !== undefined && serial(one) !== serial(t))) { ok = false; break; }
          one = t;
        }
        if (ok && one !== undefined) fields[name] = one;
      }
      if (Object.keys(fields).length) c.decl.fields = fields;
    }
  }
}

// ── Parameters ──────────────────────────────────────────────────────────────

function paramMap(list: string, lang: Lang, fm: FileModel, listOffset: number, cls?: string, first = true): Map<string, TypeRef | null> {
  const out = new Map<string, TypeRef | null>();
  const parts = splitTop(list);
  let offset = listOffset;
  const goPending: string[] = [];
  const goNamed = lang === 'go' && parts.some(p => /^\s*[A-Za-z_]\w*\s+(?!$)/.test(p) && !/^\s*(chan|func|map|struct|interface)\b/.test(p));
  parts.forEach((rawPart, idx) => {
    const part = rawPart.replace(/=[^]*$/, (m) => (lang === 'go' ? m : '')).trim();
    const at = offset;
    offset += rawPart.length + 1;
    if (!part) return;
    let name: string | undefined;
    let type: TypeRef | undefined | null = null;
    switch (lang) {
      case 'ts':
      case 'js': {
        const p = /^(?:(?:public|private|protected|readonly|override)\s+)*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*\??\s*(?::\s*([^]+))?$/.exec(part);
        if (!p) return;
        name = p[1];
        if (name === 'this') return;
        type = p[2] ? coreType(p[2], lang) ?? null : null;
        if (/^(?:public|private|protected|readonly|override)\s/.test(part) && cls) {
          const c = fm.classes.find(x => x.name === cls);
          if (c && type) (c.decl.fields ??= {})[name!] = type;
        }
        break;
      }
      case 'py': {
        const p = /^\*{0,2}([A-Za-z_]\w*)\s*(?::\s*([^]+))?$/.exec(part);
        if (!p) return;
        name = p[1];
        if (idx === 0 && first && cls && (name === 'self' || name === 'cls')) { out.set(name!, cls); return; }
        type = p[2] ? coreType(pyAnnotation(fm, p[2], at + rawPart.indexOf(p[2])), 'py') ?? null : null;
        break;
      }
      case 'java': {
        const p = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:final\s+)*([A-Za-z_][\w.]*(?:<[^]*>)?(?:\[\])*)(?:\.\.\.)?\s+([A-Za-z_]\w*)$/.exec(part);
        if (!p) return;
        name = p[2];
        type = /\[\]$/.test(p[1]!) ? null : coreType(p[1], lang) ?? null;
        break;
      }
      case 'cs': {
        const p = /^(?:\[[^\]]*\]\s*)*(?:(?:this|ref|out|in|params|scoped)\s+)*([A-Za-z_][\w.]*(?:<[^]*>)?\??(?:\[\])*)\s+@?([A-Za-z_]\w*)$/.exec(part);
        if (!p) return;
        name = p[2];
        type = /\[\]$/.test(p[1]!) ? null : coreType(p[1], lang) ?? null;
        break;
      }
      case 'kotlin': {
        const p = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:vararg|val|var|private|public|protected|internal|override|open|final|crossinline|noinline)\s+)*([A-Za-z_]\w*)\s*:\s*([^]+)$/.exec(part);
        if (!p) return;
        name = p[1];
        type = coreType(p[2], lang) ?? null;
        if (/(^|\s)(val|var)\s/.test(part) && cls) {
          const c = fm.classes.find(x => x.name === cls);
          if (c && type) (c.decl.fields ??= {})[name!] = type;
        }
        break;
      }
      case 'php': {
        const p = /^(?:#\[[^\]]*\]\s*)*((?:(?:public|private|protected|readonly)\s+)*)(\??[\\\w|]+\s+)?&?(?:\.\.\.)?\$([A-Za-z_]\w*)$/.exec(part);
        if (!p) return;
        name = `$${p[3]}`;
        type = p[2] ? coreType(p[2], lang) ?? null : null;
        if (p[1] && cls) {
          const c = fm.classes.find(x => x.name === cls);
          if (c && type) (c.decl.fields ??= {})[p[3]!] = type;
        }
        break;
      }
      case 'rs': {
        if (/^&?\s*(?:'[a-z]\w*\s+)?(?:mut\s+)?self$/.test(part) || /^(?:mut\s+)?self\s*:/.test(part)) { if (cls) out.set('self', cls); return; }
        const p = /^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([^]+)$/.exec(part);
        if (!p) return;
        name = p[1];
        type = coreType(p[2], lang) ?? null;
        break;
      }
      case 'go': {
        if (goNamed) {
          const p = /^([A-Za-z_]\w*)(?:\s+([^]+))?$/.exec(part);
          if (!p) return;
          if (!p[2]) { goPending.push(p[1]!); return; }
          const t = /^\.\.\./.test(p[2]) || /^\[\]/.test(p[2]) || /^map\[/.test(p[2]) ? null : coreType(p[2], lang) ?? null;
          for (const n of [...goPending, p[1]!]) out.set(n, t);
          goPending.length = 0;
        }
        return;
      }
      case 'rb': {
        const p = /^\*{0,2}&?([a-z_]\w*)/.exec(part);
        if (p) out.set(p[1]!, null);
        return;
      }
    }
    if (name) out.set(name, type ?? null);
  });
  return out;
}

/** A Python annotation's text; a string annotation (`"Svc"`) is read from the source. */
function pyAnnotation(fm: FileModel, text: string, at: number): string {
  const t = text.trim();
  if (t.startsWith('"') || t.startsWith('\'')) {
    const lit = stringAt(fm.m, at + text.indexOf(t[0]!));
    return lit?.value ?? t;
  }
  return t;
}

// ── Language rules ──────────────────────────────────────────────────────────

/** Words before a parenthesis that make it a statement or an operator, not a function. */
// Only words that introduce a statement or an expression with a parenthesised head: a method
// may well be called `delete`, `list`, `print`, `select` or `go`.
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'sizeof', 'lock', 'using', 'foreach', 'synchronized', 'elif', 'match', 'when', 'else', 'do', 'try', 'await', 'yield', 'throw', 'assert', 'super', 'new', 'fixed', 'checked', 'unchecked', 'instanceof', 'nameof', 'stackalloc', 'def', 'lambda']);
/** Names that are never a method of their own: control words and declaration keywords. */
const KEYWORD_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super', 'throw', 'typeof', 'else', 'do', 'try', 'function', 'fn', 'func', 'fun', 'constructor']);
const FN_WORDS = new Set(['function', 'fn', 'func', 'fun']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'strictfp', 'virtual', 'override', 'async', 'sealed', 'extern', 'partial', 'readonly', 'unsafe', 'required', 'const', 'volatile', 'transient', 'return', 'new']);

const TS_MOD = '(?:(?:public|private|protected|static|async|override|abstract|readonly|declare|accessor)\\s+)*';

/** TS/JS class and interface bodies, functions, fields, locals. */
function scanBraceTypes(fm: FileModel): void {
  const { code, lang } = fm;
  const add = (decl: TypeDecl, open: number): void => {
    const close = closeOf(code, open);
    if (close < 0) return;
    fm.types.push(decl);
    fm.classes.push({ name: decl.name, start: open, end: close + 1, decl, fieldRaw: new Map() });
  };
  const list = (s: string | undefined): string[] => (s ? splitTop(s).map(x => coreType(x, lang)).filter((x): x is string => Boolean(x)) : []);

  if (lang === 'ts' || lang === 'js') {
    for (const x of code.matchAll(/(?:^|[;}\n])[ \t]*(export\s+)?(default\s+)?(?:declare\s+)?(abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s*(?:<[^{]*?>)?\s*(?:extends\s+([^{]+?))?\s*(?:implements\s+([^{]+?))?\s*\{/g)) {
      const open = x.index! + x[0].length - 1;
      add({ name: x[4]!, kind: 'class', line: fm.line(x.index! + x[0].indexOf('class')), bases: list(x[5]?.replace(/\(.*$/, '')), impls: list(x[6]), methods: [], ...(x[1] ? {} : { internal: true }), ...(x[2] ? { def: true } : {}) }, open);
    }
    for (const x of code.matchAll(/(?:^|[;}\n])[ \t]*(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?:<[^{]*?>)?\s*(?:extends\s+([^{]+?))?\s*\{/g)) {
      add({ name: x[2]!, kind: 'interface', line: fm.line(x.index! + x[0].indexOf('interface')), bases: list(x[3]), methods: [], iface: true, ...(x[1] ? {} : { internal: true }) }, x.index! + x[0].length - 1);
    }
    for (const x of code.matchAll(/(?:^|[;}\n])[ \t]*(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*?>)?\s*=\s*\{/g)) {
      add({ name: x[2]!, kind: 'interface', line: fm.line(x.index! + x[0].indexOf('type')), methods: [], iface: true, ...(x[1] ? {} : { internal: true }) }, x.index! + x[0].length - 1);
    }
  } else if (lang === 'java' || lang === 'kotlin' || lang === 'cs' || lang === 'php') {
    const re = lang === 'php'
      ? /(?:^|\n)[ \t]*((?:(?:abstract|final|readonly)\s+)*)(class|interface|trait|enum)\s+([A-Za-z_]\w*)\s*(?:extends\s+([^{]+?))?\s*(?:implements\s+([^{]+?))?\s*\{/g
      : lang === 'java'
        ? /(?:^|\n)[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|protected|private|abstract|final|sealed|non-sealed|static|strictfp)\s+)*)(class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)\s*(?:<[^{]*?>)?\s*(\([^)]*\))?\s*(?:extends\s+([^{]+?))?\s*(?:implements\s+([^{]+?))?\s*(?:permits\s+[^{]+?)?\{/g
        : lang === 'cs'
          ? /(?:^|\n)[ \t]*(?:\[[^\]\n]*\]\s*)*((?:(?:public|internal|protected|private|abstract|sealed|static|partial|readonly|ref|unsafe|new|file)\s+)*)(class|interface|struct|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)\s*(?:<[^{(:]*?>)?\s*(\([^)]*\))?\s*(?::\s*([^{]+?))?\s*(?:where\s+[^{]+)?\{/g
          : /(?:^|\n)[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*((?:(?:public|protected|private|internal|abstract|final|sealed|open|data|enum|annotation|inner|value|inline|fun)\s+)*)(class|interface|object)\s+([A-Za-z_]\w*)\s*(?:<[^{(:]*?>)?\s*(?:(?:private|internal|public|protected)?\s*constructor\s*)?(\([^)]*\))?\s*(?::\s*([^{]+?))?\s*\{/g;
    for (const x of code.matchAll(re)) {
      const open = x.index! + x[0].length - 1;
      const mods = x[1] ?? '';
      const kindWord = x[2]!.split(/\s+/)[0]!;
      const kind: TypeDecl['kind'] = kindWord === 'interface' || kindWord === '@interface' ? 'interface' : kindWord === 'trait' ? 'trait' : kindWord === 'struct' ? 'struct' : kindWord === 'enum' ? 'enum' : kindWord === 'object' ? 'object' : 'class';
      const name = x[3]!;
      let bases: string[] = [];
      let impls: string[] = [];
      if (lang === 'php') { bases = list(x[4]?.replace(/\\/g, '\\')); impls = list(x[5]); }
      else if (lang === 'java') { bases = list(x[5]); impls = list(x[6]); }
      else { bases = list((x[5] ?? '').replace(/\([^)]*\)/g, '')); }
      const decl: TypeDecl = {
        name, kind, line: fm.line(x.index! + x[0].indexOf(x[2]!)), bases, ...(impls.length ? { impls } : {}), methods: [],
        // A PHP trait is mixed in (`use T;`), not implemented: it is a base, not an interface.
        ...(kind === 'interface' ? { iface: true } : {}),
        ...(/\bprivate\b|\bfile\b/.test(mods) ? { internal: true } : {}),
      };
      add(decl, open);
      // Record components (Java), primary constructors (Kotlin, C#): fields.
      const ctor = lang === 'java' ? x[4] : lang === 'php' ? undefined : x[4];
      if (ctor) {
        const params = paramMap(ctor.slice(1, -1), lang, fm, x.index! + x[0].indexOf(ctor) + 1, name);
        const c = fm.classes[fm.classes.length - 1]!;
        if (lang === 'java' || lang === 'cs') for (const [n, t] of params) if (t) (decl.fields ??= {})[n] = t;
        // Kotlin/C# constructor parameters are visible in the class body.
        fm.addScope(open, c.end, params, name);
      }
    }
  } else if (lang === 'go') {
    for (const x of code.matchAll(/(?:^|\n)[ \t]*type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\s*\{/g)) {
      const open = x.index! + x[0].length - 1;
      const kind = x[2] === 'struct' ? 'struct' : 'interface';
      add({ name: x[1]!, kind, line: fm.line(x.index! + x[0].indexOf('type')), methods: [], ...(kind === 'interface' ? { iface: true } : {}), ...(/^[A-Z]/.test(x[1]!) ? {} : { internal: true }) }, open);
    }
    // Named non-struct types can have methods too (`type Celsius float64`).
    for (const x of code.matchAll(/(?:^|\n)[ \t]*type\s+([A-Za-z_]\w*)\s+(?!struct\b|interface\b|=)([A-Za-z_*[][^\n{]*)\n/g)) {
      if (fm.types.some(t => t.name === x[1])) continue;
      fm.types.push({ name: x[1]!, kind: 'type', line: fm.line(x.index! + x[0].indexOf('type')), methods: [], ...(/^[A-Z]/.test(x[1]!) ? {} : { internal: true }) });
    }
  } else if (lang === 'rs') {
    for (const x of code.matchAll(/(?:^|\n)[ \t]*(pub(?:\([^)]*\))?\s+)?(struct|trait|enum)\s+([A-Za-z_]\w*)\s*(?:<[^{;(]*?>)?\s*(?::\s*([^{;]+?))?\s*(?:where\s+[^{;]+?)?(\{|\(|;)/g)) {
      const kind = x[2] === 'trait' ? 'trait' : x[2] === 'enum' ? 'enum' : 'struct';
      const decl: TypeDecl = { name: x[3]!, kind, line: fm.line(x.index! + x[0].indexOf(x[2]!)), bases: kind === 'trait' ? list(x[4]?.replace(/\+/g, ',')) : [], methods: [], ...(kind === 'trait' ? { iface: true } : {}), ...(x[1] ? {} : { internal: true }) };
      if (x[5] === '{') add(decl, x.index! + x[0].length - 1);
      else fm.types.push(decl);
    }
  } else if (lang === 'rb') {
    for (const x of code.matchAll(/(?:^|\n)([ \t]*)class\s+([A-Z]\w*(?:::[A-Z]\w*)*)\s*(?:<\s*([A-Z][\w:]*))?/g)) {
      const name = x[2]!.split('::').pop()!;
      const start = x.index! + x[0].length;
      const end = rubyEnd(code, start, x[1]!.length);
      const decl: TypeDecl = { name, kind: 'class', line: fm.line(x.index! + x[0].indexOf('class')), bases: x[3] ? [x[3].split('::').pop()!] : [], methods: [] };
      fm.types.push(decl);
      fm.classes.push({ name, start, end, decl, fieldRaw: new Map() });
    }
  }
}

/** Where a Ruby `class`/`def` at this indentation ends: the next `end` at the same indentation. */
function rubyEnd(code: string, from: number, indent: number): number {
  const re = new RegExp(`\\n[ \\t]{${indent}}end\\b`, 'g');
  re.lastIndex = from;
  const m = re.exec(code);
  return m ? m.index + m[0].length : code.length;
}

/** The text between two offsets with nested brace bodies blanked: members of the body itself. */
function flatBody(code: string, open: number, close: number): string {
  let out = '';
  let depth = 0;
  for (let j = open + 1; j < close; j++) {
    const ch = code[j]!;
    if (ch === '{') { depth++; out += depth === 1 ? '{' : ' '; continue; }
    if (ch === '}') { out += depth === 1 ? '}' : ' '; depth--; continue; }
    out += depth > 0 && ch !== '\n' ? ' ' : ch;
  }
  return out;
}

/** Members of each brace-bodied type: methods (with return types), fields. */
function scanBraceMembers(fm: FileModel): void {
  const { code, lang } = fm;
  for (const c of fm.classes) {
    if (lang === 'rb') { scanRubyMembers(fm, c); continue; }
    const body = flatBody(code, c.start, c.end - 1);
    const base = c.start + 1;
    const d = c.decl;
    const fields: Record<string, TypeRef> = { ...(d.fields ?? {}) };
    const method = (name: string, at: number, ret: string | undefined, abstract: boolean, internal: boolean, headerEnd: number): void => {
      if (KEYWORD_CALLS.has(name)) return;
      if (d.methods.some(x => x.name === name)) return;
      const sig = normaliseSig(code.slice(at, headerEnd));
      const r = ret === undefined ? undefined : ret.trim() === 'Self' || ret.trim() === 'this' || ret.trim() === 'static' ? 'Self' : coreType(ret, lang);
      d.methods.push({ name, line: fm.line(at), sig, ...(r ? { ret: r } : {}), ...(abstract ? { abstract } : {}), ...(internal ? { internal } : {}) });
    };
    if (lang === 'ts' || lang === 'js') {
      for (const x of body.matchAll(new RegExp(`(?:^|[;\\n{}])[ \\t]*(${TS_MOD})(get\\s+|set\\s+)?\\*?\\s*(#?[A-Za-z_$][\\w$]*)\\s*\\??\\s*(?:<[^>()]*>)?\\s*\\(`, 'g'))) {
        const name = x[3]!;
        const paren = base + x.index! + x[0].length - 1;
        const close = closeOf(code, paren);
        if (close < 0) continue;
        const tail = /^\s*(?::\s*([^{;=]+?))?\s*(\{|;|\n|$)/.exec(code.slice(close + 1, close + 300));
        // Constructor parameter properties become fields inside paramMap.
        if (name === 'constructor') { paramMap(code.slice(paren + 1, close), lang, fm, paren + 1, c.name); continue; }
        if (!tail) continue;
        // A getter reads like a field: `order.total.format()`.
        if (x[2]?.startsWith('get')) { const t = coreType(tail[1], lang); if (t) fields[name] = t; continue; }
        if (x[2]) continue;
        const abstract = d.iface === true || /\babstract\b/.test(x[1]!);
        method(name, base + x.index! + x[0].search(/\S/), tail[1], abstract, /\bprivate\b/.test(x[1]!) || name.startsWith('#') || d.internal === true, close + 1);
      }
      // Arrow-function properties and function-typed members: `run = async (x: T): Promise<R> => …`, `run: (x) => R`.
      for (const x of body.matchAll(new RegExp(`(?:^|[;\\n{}])[ \\t]*(${TS_MOD})([A-Za-z_$][\\w$]*)\\s*\\??\\s*(=\\s*(?:async\\s*)?|:\\s*)\\(([^()]*)\\)\\s*(?::\\s*([^=;{]+?))?\\s*=>\\s*([^;\\n{]*)`, 'g'))) {
        const ret = x[3]!.startsWith(':') ? x[6] : x[5];
        method(x[2]!, base + x.index! + x[0].search(/\S/), ret, x[3]!.startsWith(':'), /\bprivate\b/.test(x[1]!) || d.internal === true, base + x.index! + x[0].length);
      }
      // Fields: `name: T`, `name = new T()`.
      for (const x of body.matchAll(new RegExp(`(?:^|[;\\n{}])[ \\t]*${TS_MOD}(#?[A-Za-z_$][\\w$]*)\\s*[?!]?\\s*(?::\\s*([^=;\\n(]+?))?\\s*(=(?!>)\\s*([^;\\n]+))?\\s*(?=[;\\n}])`, 'g'))) {
        const name = x[1]!;
        if (d.methods.some(mm => mm.name === name) || KEYWORD_CALLS.has(name)) continue;
        if (x[2]) { const t = coreType(x[2], lang); if (t) fields[name] = t; }
        else if (x[4] && !/=>/.test(x[4])) fm.fieldAssign(base + x.index!, { name, typed: false, rhs: x[4], ...{ at: base + x.index! } } as Assign);
      }
    } else if (lang === 'java' || lang === 'cs') {
      const mods = lang === 'java'
        ? '(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\\s+)*'
        : '(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|new|extern|partial|readonly|unsafe|required)\\s+)*';
      for (const x of body.matchAll(new RegExp(`(?:^|[;\\n{}])[ \\t]*(?:@\\w+(?:\\([^)]*\\))?\\s+|\\[[^\\]\\n]*\\]\\s*)*(${mods})(?:<[^>]*>\\s+)?([A-Za-z_][\\w.]*(?:<[^;{}()]*>)?(?:\\[\\])*\\??)\\s+([A-Za-z_]\\w*)\\s*(?:<[^>()]*>)?\\s*\\(`, 'g'))) {
        const ret = x[2]!;
        const name = x[3]!;
        if ((CONTROL.has(ret) && ret !== 'void') || MODIFIERS.has(ret) || name === c.name) continue;
        const paren = base + x.index! + x[0].length - 1;
        const close = closeOf(code, paren);
        if (close < 0) continue;
        const after = code.slice(close + 1, close + 200);
        const isAbstract = /\babstract\b/.test(x[1]!) || (d.iface === true && /^\s*(?:throws[^;{]*)?;/.test(after));
        method(name, base + x.index! + x[0].search(/\S/), ret === 'void' ? undefined : ret, isAbstract, /\bprivate\b/.test(x[1]!) || d.internal === true, close + 1);
      }
      // Fields and properties.
      for (const x of body.matchAll(new RegExp(`(?:^|[;\\n{}])[ \\t]*(?:@\\w+(?:\\([^)]*\\))?\\s+|\\[[^\\]\\n]*\\]\\s*)*${mods}([A-Za-z_][\\w.]*(?:<[^;{}()=]*>)?\\??)\\s+([A-Za-z_]\\w*)\\s*(=[^;{]*)?(;|\\{)`, 'g'))) {
        if (CONTROL.has(x[1]!) || MODIFIERS.has(x[1]!)) continue;
        const t = coreType(x[1], lang);
        if (t) fields[x[2]!] = t;
      }
    } else if (lang === 'kotlin') {
      for (const x of body.matchAll(/(?:^|[;\n{}])[ \t]*((?:(?:public|private|protected|internal|override|open|abstract|suspend|inline|operator|infix|final)\s+)*)fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/g)) {
        const paren = base + x.index! + x[0].length - 1;
        const close = closeOf(code, paren);
        if (close < 0) continue;
        const tail = /^\s*(?::\s*([^{=\n]+?))?\s*(\{|=|\n|$)/.exec(code.slice(close + 1, close + 300));
        method(x[2]!, base + x.index! + x[0].search(/\S/), tail?.[1], /\babstract\b/.test(x[1]!) || (d.iface === true && tail?.[2] !== '{' && tail?.[2] !== '='), /\bprivate\b/.test(x[1]!) || d.internal === true, close + 1);
      }
      for (const x of body.matchAll(/(?:^|[;\n{}])[ \t]*(?:(?:public|private|protected|internal|override|open|abstract|lateinit|const|final)\s+)*(?:val|var)\s+([A-Za-z_]\w*)\s*(?::\s*([^=\n{]+?))?\s*(?:=\s*([^\n;]+))?(?=[;\n}])/g)) {
        if (x[2]) { const t = coreType(x[2], lang); if (t) fields[x[1]!] = t; }
        else if (x[3]) fm.fieldAssign(base + x.index!, { name: x[1]!, typed: false, rhs: x[3], ...{ at: base + x.index! } } as Assign);
      }
    } else if (lang === 'php') {
      for (const x of body.matchAll(/(?:^|[;\n{}])[ \t]*((?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+&?([A-Za-z_]\w*)\s*\(/g)) {
        const paren = base + x.index! + x[0].length - 1;
        const close = closeOf(code, paren);
        if (close < 0) continue;
        const tail = /^\s*(?::\s*(\??[\\\w|]+))?\s*(\{|;)/.exec(code.slice(close + 1, close + 200));
        method(x[2]!, base + x.index! + x[0].search(/\S/), tail?.[1], /\babstract\b/.test(x[1]!) || (d.iface === true), /\bprivate\b/.test(x[1]!), close + 1);
        if (x[2] === '__construct') paramMap(code.slice(paren + 1, close), lang, fm, paren + 1, c.name);
      }
      for (const x of body.matchAll(/(?:^|[;\n{}])[ \t]*(?:(?:public|private|protected|static|readonly|var)\s+)+(\??[\\\w|]+\s+)?\$([A-Za-z_]\w*)\s*(?:=[^;]*)?;/g)) {
        if (x[1]) { const t = coreType(x[1], lang); if (t) fields[x[2]!] = t; }
      }
      // `use SomeTrait;` inside a class mixes the trait's methods in.
      for (const x of body.matchAll(/(?:^|[;\n{}])[ \t]*use\s+([\\\w]+(?:\s*,\s*[\\\w]+)*)\s*;/g)) {
        for (const t of x[1]!.split(',')) { const n = coreType(t, lang); if (n) (d.bases ??= []).push(n); }
      }
    } else if (lang === 'go') {
      if (d.kind === 'struct') {
        for (const line of body.split('\n')) {
          const l = line.replace(/`[^`]*`/g, '').trim();
          if (!l || l === '{' || l === '}') continue;
          const named = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+([^\s].*)$/.exec(l);
          const embedded = /^(\*?)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)$/.exec(l);
          if (embedded) (d.embeds ??= []).push({ name: embedded[2]!, ptr: embedded[1] === '*' });
          else if (named) {
            const t = /^(\[|map\[|chan\b|func\b)/.test(named[2]!.trim()) ? undefined : coreType(named[2], lang);
            if (t) for (const n of named[1]!.split(',')) fields[n.trim()] = t;
          }
        }
      } else {
        let off = 0;
        for (const line of body.split('\n')) {
          const at = base + off;
          off += line.length + 1;
          const l = line.trim();
          const mm = /^([A-Za-z_]\w*)\s*(\([^]*)$/.exec(l);
          if (mm) {
            const results = goResults(mm[2]!);
            d.methods.push({ name: mm[1]!, line: fm.line(at), sig: normaliseSig(l), ...(results ? { ret: results } : {}), abstract: true, ...(/^[A-Z]/.test(mm[1]!) ? {} : { internal: true }) });
          } else if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(l)) (d.bases ??= []).push(l);
        }
      }
    } else if (lang === 'rs') {
      for (const x of body.matchAll(/(?:^|[;\n{}])[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(/g)) {
        const paren = base + x.index! + x[0].length - 1;
        const close = closeOf(code, paren);
        if (close < 0) continue;
        const tail = /^\s*(?:->\s*([^{;]+?))?\s*(?:where\s+[^{;]+?)?\s*(\{|;)/.exec(code.slice(close + 1, close + 300));
        method(x[2]!, base + x.index! + x[0].search(/\S/), tail?.[1], tail?.[2] === ';', false, close + 1);
      }
      if (d.kind === 'struct') {
        for (const x of body.matchAll(/(?:^|[,{\n])[ \t]*(?:pub(?:\([^)]*\))?\s+)?([a-z_]\w*)\s*:\s*([^,\n}]+)/g)) {
          const t = coreType(x[2], lang);
          if (t) fields[x[1]!] = t;
        }
      }
    }
    if (Object.keys(fields).length) d.fields = fields;
  }
}

function scanRubyMembers(fm: FileModel, c: ClassRange): void {
  const body = fm.code.slice(c.start, c.end);
  for (const x of body.matchAll(/(?:^|\n)[ \t]*def\s+(self\.)?([a-z_]\w*[?!=]?)/g)) {
    const at = c.start + x.index! + x[0].search(/\S/);
    if (!c.decl.methods.some(m => m.name === x[2])) c.decl.methods.push({ name: x[2]!, line: fm.line(at), sig: normaliseSig(x[0]) });
  }
}

/** Go results: the first result's type (`(T, error)` → T, `*T` → T). */
function goResults(paramsAndResults: string): TypeRef | undefined {
  const p = paramsAndResults.trim();
  if (!p.startsWith('(')) return undefined;
  const close = closeOf(p, 0);
  if (close < 0) return undefined;
  let rest = p.slice(close + 1).trim().replace(/\{$/, '').trim();
  if (!rest) return undefined;
  if (rest.startsWith('(')) {
    const c2 = closeOf(rest, 0);
    if (c2 < 0) return undefined;
    const first = splitTop(rest.slice(1, c2))[0]?.trim() ?? '';
    // `(n int, err error)`: a named result.
    const named = /^[A-Za-z_]\w*\s+(\S.*)$/.exec(first);
    rest = named && !/^(chan|func|map)\b/.test(first) ? named[1]! : first;
  }
  if (/^(\[|map\[|chan\b|func\b)/.test(rest)) return undefined;
  return coreType(rest, 'go');
}

// ── Functions, locals, calls ────────────────────────────────────────────────

/** Function and lambda scopes of a brace language, with their parameters. */
function scanBraceFunctions(fm: FileModel): void {
  const { code, lang } = fm;
  for (let p = code.indexOf('('); p >= 0; p = code.indexOf('(', p + 1)) {
    const close = closeOf(code, p);
    if (close < 0) continue;
    // What comes right after the parameter list decides whether this is a function.
    const after = code.slice(close + 1, close + 260);
    let bodyOpen = -1;
    let exprBody = false;
    // Each tail must end in a body `{` or an arrow: a call followed by anything else is not a function.
    // Groups: 1 the return annotation (where the language has one), 2 the arrow, 3/4 the body brace.
    const tailRe = lang === 'ts' || lang === 'js' ? /^\s*(?::\s*([^{;=]+?)\s*)?(?:(=>)\s*(\{)?|(\{))/
      : lang === 'java' ? /^\s*()(?:throws\s+[\w.,\s<>]+?\s*)?(?:(->)\s*(\{)?|(\{))/
        : lang === 'cs' ? /^\s*()(?:where\s+[^{;]+?\s*)?(?:(=>)\s*(\{)?|(\{))/
          : lang === 'kotlin' ? /^\s*(?::\s*([^{=;\n]+?)\s*)?(?:(=)(?!=)\s*(\{)?|(\{))/
            : lang === 'php' ? /^\s*(?:use\s*\([^)]*\)\s*)?(?::\s*(\??[\\\w|]+)\s*)?(?:(=>)\s*(\{)?|(\{))/
              : lang === 'go' ? /^\s*(\([^)]*\)|[^{;\n=()]*?)\s*()()(\{)/
                : /^\s*(?:->\s*([^{;]+?)\s*)?(?:where\s+[^{;]+?\s*)?()()(\{)/;
    const t = tailRe.exec(after);
    if (!t) continue;
    const brace = t[3] || t[4];
    const arrowSeen = Boolean(t[2]);
    if (brace === '{') bodyOpen = close + 1 + t[0].length - 1;
    else if (arrowSeen) exprBody = true;
    else continue;
    const ret: string | undefined = t[1] || undefined;
    // The name (or keyword) before the parameter list.
    let k = p - 1;
    while (k >= 0 && /\s/.test(code[k]!)) k--;
    if (code[k] === '>' && lang !== 'go') { // generic parameters `<T>(`
      let d = 0; let j = k;
      for (; j >= 0; j--) { if (code[j] === '>') d++; else if (code[j] === '<') { d--; if (d === 0) break; } }
      k = j - 1;
      while (k >= 0 && /\s/.test(code[k]!)) k--;
    }
    let j = k;
    while (j >= 0 && /[\w$]/.test(code[j]!)) j--;
    const name = code.slice(j + 1, k + 1);
    // An arrow makes a lambda whatever precedes it (`return (x) => …`, `async (x) => …`); a
    // Kotlin `fun f(x) = …` is a function with an expression body.
    const isLambda = arrowSeen && (!name || lang !== 'kotlin');
    if (name && CONTROL.has(name) && !isLambda) continue;
    if (!name && !isLambda && !(lang === 'ts' || lang === 'js')) continue;
    // `new Foo(args) {` (an anonymous class) and calls followed by a block are not declarations.
    let b = j;
    while (b >= 0 && /\s/.test(code[b]!)) b--;
    if (code.slice(Math.max(0, b - 2), b + 1) === 'new') continue;
    if (name && !arrowSeen && (lang === 'ts' || lang === 'js')) {
      // A call followed by a block (`if (x) {` was handled; `foo(x) {` only in class bodies/objects is a method).
      if (code[b] === '.' || code[b] === '=') continue;
    }
    const start = exprBody ? close + 1 : bodyOpen;
    const end = exprBody ? stmtEnd(code, close + 1 + t[0].length, lang) : closeOf(code, bodyOpen) + 1;
    if (end <= start) continue;
    const cls = fm.classAt(p)?.name;
    const params = paramMap(code.slice(p + 1, close), lang, fm, p + 1, cls);
    fm.addScope(start, end, params, cls);
    // Return types of top-level functions: a declaration keyword right before the name.
    const declared = name && !FN_WORDS.has(name) && name !== 'async' && FN_WORDS.has(/([A-Za-z_]\w*)\s*\*?\s*$/.exec(code.slice(Math.max(0, j - 16), j + 1))?.[1] ?? '');
    if (declared && !fm.classAt(p)) {
      const r = lang === 'go' ? goResults(code.slice(p, close + 1) + ' ' + (ret ?? '')) : coreType(ret, lang);
      if (r && fm.returns[name] === undefined) fm.returns[name] = r;
    }
    // `const make = (…): T => …`
    if (!name && (lang === 'ts' || lang === 'js')) {
      const before = code.slice(Math.max(0, p - 120), p);
      const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?$/.exec(before);
      const r = coreType(ret, lang);
      if (decl && r && !fm.classAt(p)) fm.returns[decl[1]!] ??= r;
    }
  }
  // Single-parameter arrows `x => …` (TS/JS, C#), Kotlin lambdas `{ a, b -> … }`, Rust closures `|x| …`.
  const simple = lang === 'ts' || lang === 'js' || lang === 'cs' ? /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g
    : lang === 'java' ? /(?<![\w$.])([A-Za-z_$][\w$]*)\s*->/g
      : lang === 'kotlin' ? /\{\s*([A-Za-z_]\w*(?:\s*:\s*[\w.<>?]+)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*:\s*[\w.<>?]+)?)*)\s*->/g
        : lang === 'rs' ? /\|([^|]*)\|/g : undefined;
  if (simple) {
    for (const x of code.matchAll(simple)) {
      const startAt = x.index! + x[0].length;
      const end = lang === 'kotlin' ? closeOf(code, x.index!) + 1 : code[startAt + (code.slice(startAt).search(/\S/))] === '{'
        ? closeOf(code, startAt + code.slice(startAt).search(/\S/)) + 1
        : stmtEnd(code, startAt, lang);
      if (end <= startAt) continue;
      const params = lang === 'kotlin' || lang === 'rs' ? paramMap(x[1]!, lang === 'rs' ? 'rs' : 'kotlin', fm, x.index! + 1) : new Map<string, TypeRef | null>([[x[1]!, null]]);
      for (const n of (lang === 'kotlin' || lang === 'rs' ? splitTop(x[1]!) : [x[1]!])) { const nm = /^\s*(?:mut\s+)?&?([A-Za-z_$][\w$]*)/.exec(n)?.[1]; if (nm && !params.has(nm)) params.set(nm, null); }
      fm.addScope(startAt, end, params, fm.classAt(x.index!)?.name);
    }
  }
}

/** Python classes and functions by indentation. */
function scanPython(fm: FileModel): void {
  const { code } = fm;
  const blockEnd = (headerEnd: number, indent: number): number => {
    const nl = code.indexOf('\n', headerEnd);
    if (nl < 0) return code.length;
    // `def f(): return x` — a one-line body.
    if (code.slice(headerEnd, nl).trim()) return nl;
    const re = /\n([ \t]*)(?=\S)/g;
    re.lastIndex = nl;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) if (m[1]!.length <= indent) return m.index;
    return code.length;
  };
  for (const x of code.matchAll(/(?:^|\n)([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*(\([^)]*\))?[ \t]*:/g)) {
    const indent = x[1]!.length;
    const at = x.index! + x[0].indexOf('class');
    const start = x.index! + x[0].length;
    const end = blockEnd(start, indent);
    const parts = x[3] ? splitTop(x[3].slice(1, -1)).map(s => s.trim()).filter(Boolean) : [];
    const bases = parts.filter(s => !s.includes('=')).map(s => coreType(s, 'py') ?? (/^(Protocol|ABC|Generic)\b/.test(s) ? s : '')).filter(Boolean);
    const iface = parts.some(s => /^(?:typing\.|abc\.)?(Protocol|ABC)\b/.test(s) || /metaclass\s*=\s*(?:abc\.)?ABCMeta/.test(s));
    const decl: TypeDecl = { name: x[2]!, kind: 'class', line: fm.line(at), bases: bases.filter(b => !/^(Protocol|ABC|Generic|object)$/.test(b)), methods: [], ...(iface ? { iface: true } : {}), ...(x[2]!.startsWith('_') ? { internal: true } : {}) };
    fm.types.push(decl);
    fm.classes.push({ name: x[2]!, start, end, decl, fieldRaw: new Map() });
    // Class-level annotations: dataclass fields, typed attributes.
    const bodyIndent = /\n([ \t]+)\S/.exec(code.slice(start, end))?.[1]?.length ?? indent + 4;
    for (const y of code.slice(start, end).matchAll(new RegExp(`\\n[ \\t]{${bodyIndent}}([A-Za-z_]\\w*)[ \\t]*:[ \\t]*([^=\\n]+?)[ \\t]*(?:=[^\\n]*)?(?=\\n|$)`, 'g'))) {
      const t = coreType(pyAnnotation(fm, y[2]!, start + y.index! + y[0].indexOf(y[2]!)), 'py');
      if (t) (decl.fields ??= {})[y[1]!] = t;
    }
    for (const y of code.slice(start, end).matchAll(new RegExp(`\\n[ \\t]{${bodyIndent}}([A-Za-z_]\\w*)[ \\t]*=(?!=)[ \\t]*([^\\n]+)`, 'g'))) {
      if (decl.fields?.[y[1]!]) continue;
      fm.fieldAssign(start + y.index! + 1, { name: y[1]!, typed: false, rhs: y[2]!, ...{ at: start + y.index! + 1 } } as Assign);
    }
  }
  for (const x of code.matchAll(/(?:^|\n)([ \t]*)((?:@[^\n]+\n[ \t]*)*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/g)) {
    const indent = x[1]!.length;
    const paren = x.index! + x[0].length - 1;
    const close = closeOf(code, paren);
    if (close < 0) continue;
    const tail = /^\s*(?:->\s*([^:]+?))?\s*:/.exec(code.slice(close + 1, close + 300));
    if (!tail) continue;
    const headerEnd = close + 1 + tail[0].length;
    const end = blockEnd(headerEnd, indent);
    const defAt = x.index! + x[0].indexOf('def', x[0].indexOf(x[2]!) + x[2]!.length);
    const owner = fm.classes.find(c => c.start <= defAt && defAt < c.end && /\n([ \t]+)\S/.exec(code.slice(c.start, c.end))?.[1]?.length === indent);
    const decorators = x[2]!;
    const isStatic = /@staticmethod\b/.test(decorators);
    const params = paramMap(code.slice(paren + 1, close), 'py', fm, paren + 1, owner?.name, !isStatic);
    fm.addScope(headerEnd, end, params, owner?.name);
    const retText = tail[1] ? pyAnnotation(fm, tail[1], close + 1 + tail[0].indexOf(tail[1])) : undefined;
    const ret = retText === undefined ? undefined : /^(Self|typing\.Self)$/.test(retText.trim()) ? 'Self' : coreType(retText, 'py');
    const name = x[3]!;
    if (owner) {
      if (/@property\b/.test(decorators)) { if (ret) (owner.decl.fields ??= {})[name] = ret; continue; }
      if (!owner.decl.methods.some(mm => mm.name === name)) {
        owner.decl.methods.push({
          name, line: fm.line(defAt), sig: normaliseSig(code.slice(defAt, close + 1 + (tail[1] ? tail[0].length - 1 : 0))),
          ...(ret ? { ret } : {}), ...(/@(?:abc\.)?abstractmethod\b/.test(decorators) ? { abstract: true } : {}),
          ...(name.startsWith('_') ? { internal: true } : {}),
        });
      }
    } else if (indent === 0 && ret) fm.returns[name] ??= ret;
  }
  // Lambdas and comprehensions shadow.
  for (const x of code.matchAll(/\blambda\b([^:]*):/g)) {
    const params = new Map<string, TypeRef | null>();
    for (const n of x[1]!.split(',')) { const nm = /^\s*\*{0,2}([A-Za-z_]\w*)/.exec(n)?.[1]; if (nm) params.set(nm, null); }
    const s = x.index! + x[0].length;
    fm.addScope(s, stmtEnd(code, s, 'py'), params);
  }
}

/** Assignments, for/catch bindings and field assignments, per language. */
function scanAssignments(fm: FileModel, skip: Array<[number, number]>): void {
  const { code, lang } = fm;
  // Import statements bind names too (`import a as b`), but those are imports, not variables.
  const inSkip = (at: number): boolean => skip.some(([a, b]) => at >= a && at < b);
  const origAssign = fm.assign.bind(fm);
  fm.assign = (at, a) => { if (!inSkip(at)) origAssign(at, a); };
  const rhsAt = (at: number): string => code.slice(at, stmtEnd(code, at, lang));
  const unknown = (at: number, names: string[]): void => { for (const n of names) fm.assign(at, { name: n, typed: false, unknown: true }); };
  const typedAt = (at: number, name: string, t: TypeRef | undefined): void => fm.assign(at, { name, typed: true, ...(t !== undefined ? { declared: t } : {}) });
  const untyped = (at: number, name: string, rhsStart: number): void => fm.assign(at, { name, typed: false, rhs: rhsAt(rhsStart) });
  const field = (at: number, name: string, rhsStart: number | undefined, t?: TypeRef): void => {
    fm.fieldAssign(at, t !== undefined ? { name, typed: true, declared: t } : { name, typed: false, ...(rhsStart !== undefined ? { rhs: rhsAt(rhsStart) } : { unknown: true }), ...{ at } } as Assign);
  };
  const names = (s: string): string[] => [...s.matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]);

  switch (lang) {
    case 'ts':
    case 'js':
      for (const x of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;\n]+))?\s*(=(?![=>]))?/g)) {
        const at = x.index!;
        if (x[3]) typedAt(at, x[2]!, coreType(x[3], lang));
        else if (x[4]) untyped(at, x[2]!, at + x[0].length);
        else unknown(at, [x[2]!]);
      }
      for (const x of code.matchAll(/\b(?:const|let|var)\s*([{[][^=]*?[}\]])\s*(?::[^=]+)?=/g)) unknown(x.index!, names(x[1]!.replace(/:\s*[A-Za-z_$][\w$]*/g, '')));
      for (const x of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*|[{[][^)]*?[}\]])\s+(?:of|in)\b/g)) unknown(x.index!, names(x[1]!));
      for (const x of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) unknown(x.index!, [x[1]!]);
      for (const x of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) {
        const before = code.slice(Math.max(0, x.index! - 12), x.index!);
        if (/\b(const|let|var)\s+$/.test(before) || /[,{(:]\s*$/.test(before)) continue;
        untyped(x.index!, x[1]!, x.index! + x[0].length);
      }
      for (const x of code.matchAll(/\bthis\.(#?[A-Za-z_$][\w$]*)\s*=(?![=>])/g)) field(x.index!, x[1]!, x.index! + x[0].length);
      break;
    case 'py':
      for (const x of code.matchAll(/(?:^|\n)[ \t]*([A-Za-z_]\w*)[ \t]*(?::[ \t]*([^=\n]+?))?[ \t]*=(?!=)/g)) {
        const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
        if (x[2]) typedAt(at, x[1]!, coreType(pyAnnotation(fm, x[2], x.index! + x[0].indexOf(x[2])), 'py'));
        else untyped(at, x[1]!, x.index! + x[0].length);
      }
      for (const x of code.matchAll(/(?:^|\n)[ \t]*([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_*]\w*)+)[ \t]*=(?!=)/g)) unknown(x.index! + 1, names(x[1]!));
      for (const x of code.matchAll(/\bfor\s+([^\n]*?)\s+in\b/g)) unknown(x.index!, names(x[1]!));
      for (const x of code.matchAll(/\b(?:as)\s+([A-Za-z_]\w*)/g)) unknown(x.index!, [x[1]!]);
      for (const x of code.matchAll(/([A-Za-z_]\w*)\s*:=/g)) unknown(x.index!, [x[1]!]);
      for (const x of code.matchAll(/\bglobal\s+([^\n]+)/g)) unknown(x.index!, names(x[1]!));
      for (const x of code.matchAll(/\bself\.([A-Za-z_]\w*)[ \t]*(?::[ \t]*([^=\n]+?))?[ \t]*=(?!=)/g)) {
        if (x[2]) field(x.index!, x[1]!, undefined, coreType(pyAnnotation(fm, x[2], x.index! + x[0].indexOf(x[2])), 'py'));
        else field(x.index!, x[1]!, x.index! + x[0].length);
      }
      break;
    case 'go':
      for (const x of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)((?:\s*,\s*[A-Za-z_]\w*)*)\s*:=\s*(range\b)?/g)) {
        const at = x.index!;
        if (x[3]) { unknown(at, [x[1]!, ...names(x[2]!)]); continue; }
        if (x[1] !== '_') untyped(at, x[1]!, at + x[0].length);
        unknown(at, names(x[2]!).filter(n => n !== '_'));
      }
      for (const x of code.matchAll(/\bvar\s+([A-Za-z_]\w*)\s+([^=\n;]+?)\s*(?:=|\n|;)/g)) typedAt(x.index!, x[1]!, /^(\[|map\[|chan\b|func\b)/.test(x[2]!.trim()) ? undefined : coreType(x[2], 'go'));
      for (const x of code.matchAll(/\bvar\s+([A-Za-z_]\w*)\s*=/g)) untyped(x.index!, x[1]!, x.index! + x[0].length);
      for (const x of code.matchAll(/(?<![\w.:])([A-Za-z_]\w*)\s*=(?!=)/g)) {
        if (/\bvar\s+$/.test(code.slice(Math.max(0, x.index! - 6), x.index!))) continue;
        untyped(x.index!, x[1]!, x.index! + x[0].length);
      }
      break;
    case 'java':
    case 'cs':
      for (const x of code.matchAll(/(?:^|[;{}(\n,])[ \t]*(?:final\s+|readonly\s+|const\s+|using\s+|await\s+using\s+)*([A-Z][\w.]*(?:<[^;{}()=]*>)?\??|var)\s+([A-Za-z_]\w*)\s*(=(?!=)|;|:|\bin\b)/g)) {
        const at = x.index! + x[0].search(/\S/);
        if (x[1] === 'var') {
          if (x[3]!.startsWith('=')) untyped(at, x[2]!, x.index! + x[0].length);
          else unknown(at, [x[2]!]);
        } else typedAt(at, x[2]!, coreType(x[1], lang));
      }
      for (const x of code.matchAll(/(?<![\w.])([a-z_]\w*)\s*=(?![=>])/g)) {
        const before = code.slice(Math.max(0, x.index! - 60), x.index!);
        if (/[A-Za-z_>\]?]\s+$/.test(before)) continue;
        untyped(x.index!, x[1]!, x.index! + x[0].length);
      }
      for (const x of code.matchAll(/\bthis\.([A-Za-z_]\w*)\s*=(?![=>])/g)) field(x.index!, x[1]!, x.index! + x[0].length);
      break;
    case 'kotlin':
      for (const x of code.matchAll(/\b(?:val|var)\s+([A-Za-z_]\w*)\s*(?::\s*([^=\n;,)]+))?\s*(=(?!=))?/g)) {
        // `class A(val x: T)`: a constructor parameter (a field), not a variable.
        if (/[(,]\s*(?:@\w+\s+)*(?:(?:private|public|protected|internal|override|open)\s+)*$/.test(code.slice(Math.max(0, x.index! - 60), x.index!))) continue;
        if (x[2]) typedAt(x.index!, x[1]!, coreType(x[2], lang));
        else if (x[3]) untyped(x.index!, x[1]!, x.index! + x[0].length);
        else unknown(x.index!, [x[1]!]);
      }
      for (const x of code.matchAll(/\bfor\s*\(\s*([A-Za-z_]\w*)\s*(?::\s*([^)]+?))?\s+in\b/g)) {
        if (x[2]) typedAt(x.index!, x[1]!, coreType(x[2], lang)); else unknown(x.index!, [x[1]!]);
      }
      break;
    case 'php':
      for (const x of code.matchAll(/(?<!->)\$([A-Za-z_]\w*)\s*=(?![=>])/g)) {
        if (x[1] === 'this') continue;
        untyped(x.index!, `$${x[1]}`, x.index! + x[0].length);
      }
      for (const x of code.matchAll(/\bas\s+(?:\$\w+\s*=>\s*)?\$([A-Za-z_]\w*)/g)) unknown(x.index!, [`$${x[1]}`]);
      for (const x of code.matchAll(/\$this->([A-Za-z_]\w*)\s*=(?![=>])/g)) field(x.index!, x[1]!, x.index! + x[0].length);
      break;
    case 'rs':
      for (const x of code.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::\s*([^=;]+))?\s*(=(?!=))?/g)) {
        if (x[2]) typedAt(x.index!, x[1]!, coreType(x[2], lang));
        else if (x[3]) untyped(x.index!, x[1]!, x.index! + x[0].length);
        else unknown(x.index!, [x[1]!]);
      }
      for (const x of code.matchAll(/\blet\s+(?:mut\s+)?([(\[{][^=]*?)\s*=/g)) unknown(x.index!, names(x[1]!));
      // Loop and pattern bindings. Bounded to one pattern (`impl Trait for Type {` is not a loop).
      for (const x of code.matchAll(/\bfor\s+([\w\s,&()]+?)\s+in\b/g)) unknown(x.index!, names(x[1]!));
      for (const x of code.matchAll(/\b(?:if|while)\s+let\s+([^={};\n]+?)\s*=(?!=)/g)) unknown(x.index!, names(x[1]!).filter(n => /^[a-z_]/.test(n)));
      break;
    case 'rb':
      for (const x of code.matchAll(/(?:^|\n)[ \t]*([a-z_]\w*)[ \t]*=(?![=~])/g)) untyped(x.index! + 1, x[1]!, x.index! + x[0].length);
      for (const x of code.matchAll(/@([a-z_]\w*)[ \t]*=(?![=~])/g)) field(x.index!, `@${x[1]}`, x.index! + x[0].length);
      break;
  }
}

/** Every `recv.method(…)` with a known receiver type. */
function scanCalls(fm: FileModel, skip: Array<[number, number]>): CallSite[] {
  const { code, lang } = fm;
  const out: CallSite[] = [];
  const seen = new Set<string>();
  const re = lang === 'php' ? /(->|\?->|::)\s*([A-Za-z_]\w*)\s*\(/g
    : lang === 'rs' ? /(\.|::)\s*([A-Za-z_]\w*)\s*(?:::<[^>()]*>)?\s*\(/g
      : lang === 'rb' ? /(\.)\s*([a-z_]\w*[?!]?)(?=\s*[(\s\n;)]|$)/g
        : /(\?\.|!\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  for (const x of code.matchAll(re)) {
    if (out.length >= MAX_CALLS) break;
    const at = x.index!;
    if (code[at - 1] === '.' || (x[1] === '.' && /\d/.test(code[at - 1] ?? ''))) continue;
    if (skip.some(([a, b]) => at >= a && at < b)) continue;
    const recvText = receiverBefore(code, at);
    if (!recvText) continue;
    if (lang === 'rb' && x[2] === 'new') continue;
    const recv = exprType(recvText, fm.ctxAt(at));
    if (recv === undefined) continue;
    // A Go package-qualified function (`pkg.Func(`) is an import, not a method call.
    if (lang === 'go' && typeof recv === 'object' && 'v' in recv && !recv.v.includes('.')) continue;
    const line = fm.line(at);
    const key = `${line}:${x[2]}:${serial(recv)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ recv, m: x[2]!, line });
  }
  return out;
}

/** Go methods (`func (s *T) M`), Rust `impl` blocks, Kotlin extension functions. */
function scanExtMethods(fm: FileModel): void {
  const { code, lang } = fm;
  if (lang === 'go') {
    // `func (s *T) M(`, `func (T) M(` — a receiver name, when present, is followed by a space or `*`.
    for (const x of code.matchAll(/(?:^|\n)func\s*\(\s*(?:([A-Za-z_]\w*)(?=\s+|\s*\*))?\s*(\*?)\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/g)) {
      const paren = x.index! + x[0].length - 1;
      const close = closeOf(code, paren);
      if (close < 0) continue;
      const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
      const bodyOpen = code.indexOf('{', close);
      const results = goResults(code.slice(paren, bodyOpen < 0 ? close + 1 : bodyOpen));
      fm.ext.push({ type: x[3]!, m: { name: x[4]!, line: fm.line(at), sig: normaliseSig(code.slice(at, bodyOpen < 0 ? close + 1 : bodyOpen)), ...(results ? { ret: results } : {}), ...(x[2] ? { ptr: true } : {}), ...(/^[A-Z]/.test(x[4]!) && /^[A-Z]/.test(x[3]!) ? {} : { internal: true }) } });
      // The receiver variable is the type.
      if (x[1] && bodyOpen >= 0) {
        const end = closeOf(code, bodyOpen) + 1;
        const s = fm.scopes.find(sc => sc.start === bodyOpen);
        if (s) s.params.set(x[1], x[3]!);
        else fm.addScope(bodyOpen, end, new Map([[x[1], x[3]!]]));
      }
    }
  } else if (lang === 'rs') {
    for (const x of code.matchAll(/(?:^|\n)[ \t]*(?:unsafe\s+)?impl\s*(?:<[^{]*?>)?\s+(?:([A-Za-z_][\w:]*)(?:<[^{]*?>)?\s+for\s+)?&?([A-Za-z_][\w:]*)(?:<[^{]*?>)?\s*(?:where\s+[^{]+?)?\{/g)) {
      const open = x.index! + x[0].length - 1;
      const close = closeOf(code, open);
      if (close < 0) continue;
      fm.methodRanges.push([open, close]);
      const type = x[2]!.replace(/::/g, '.');
      const trait = x[1]?.replace(/::/g, '.');
      const body = flatBody(code, open, close);
      for (const y of body.matchAll(/(?:^|[;\n{}])[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(/g)) {
        const paren = open + 1 + y.index! + y[0].length - 1;
        const pc = closeOf(code, paren);
        if (pc < 0) continue;
        const tail = /^\s*(?:->\s*([^{;]+?))?\s*(?:where\s+[^{;]+?)?\s*(\{|;)/.exec(code.slice(pc + 1, pc + 300));
        const at = open + 1 + y.index! + y[0].search(/\S/);
        const retRaw = tail?.[1]?.trim();
        const ret = retRaw === 'Self' ? 'Self' : coreType(retRaw, 'rs');
        fm.ext.push({ type, ...(trait ? { trait } : {}), m: { name: y[2]!, line: fm.line(at), sig: normaliseSig(code.slice(at, pc + 1 + (tail?.[1] ? tail[0].length - 1 : 0))), ...(ret ? { ret } : {}), ...(y[1] || trait ? {} : { internal: true }) } });
      }
      // `self` and `Self` inside the block are the type.
      const lastSeg = type.split('.').pop()!;
      for (const s of fm.scopes) if (s.start > open && s.end <= close + 1) { if (s.params.has('self')) s.params.set('self', lastSeg); s.cls ??= lastSeg; }
      fm.classes.push({ name: lastSeg, start: open, end: close + 1, decl: { name: lastSeg, kind: 'struct', line: 0, methods: [] }, fieldRaw: new Map() });
    }
    for (const x of code.matchAll(/(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+[A-Za-z_]\w*[^{;]*\{/g)) {
      const open = x.index! + x[0].length - 1;
      const close = closeOf(code, open);
      if (close > 0) fm.methodRanges.push([open, close]);
    }
  } else if (lang === 'kotlin') {
    for (const x of code.matchAll(/(?:^|\n)(?:(?:public|internal|private|inline|suspend|operator|infix)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Z][\w.]*)(?:<[^>]*>)?\.([A-Za-z_]\w*)\s*\(/g)) {
      const paren = x.index! + x[0].length - 1;
      const close = closeOf(code, paren);
      if (close < 0) continue;
      const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
      const tail = /^\s*(?::\s*([^{=\n]+?))?\s*(\{|=)/.exec(code.slice(close + 1, close + 300));
      const ret = coreType(tail?.[1], 'kotlin');
      fm.ext.push({ type: x[1]!, m: { name: x[2]!, line: fm.line(at), sig: normaliseSig(code.slice(at, close + 1)), ...(ret ? { ret } : {}) } });
      const s = fm.scopes.find(sc => sc.start >= close && sc.start < close + 300);
      if (s) s.cls = x[1]!.split('.').pop()!;
    }
  }
}

/** Module-level variables of a known type. */
function scanGlobals(fm: FileModel): Record<string, TypeRef> {
  const out: Record<string, TypeRef> = {};
  const mod = fm.scopes[0]!;
  const ctx = fm.ctxAt(0);
  for (const name of mod.assigns.keys()) {
    const t = ctx.lookup(name);
    if (t) out[name] = t;
  }
  return out;
}

/**
 * Members, ext methods, return types, globals and calls of one file.
 * `imported` are the names its imports bind; `skip` ranges are its import statements.
 */
export function extractMembers(m: Masked, source: string, lang: Lang, imported: Set<string>, skip: Array<[number, number]> = []): Members {
  const fm = new FileModel(m, source, lang, imported);
  if (lang === 'py') {
    scanPython(fm);
  } else if (lang === 'rb') {
    scanBraceTypes(fm);
    scanBraceMembers(fm);
    for (const x of fm.code.matchAll(/(?:^|\n)([ \t]*)def[ \t]+(?:self\.)?[a-z_]\w*[?!=]?[ \t]*(\([^)]*\))?/g)) {
      const start = x.index! + x[0].length;
      const params = x[2] ? paramMap(x[2].slice(1, -1), 'rb', fm, x.index! + x[0].indexOf(x[2]) + 1) : new Map<string, TypeRef | null>();
      fm.addScope(start, rubyEnd(fm.code, start, x[1]!.length), params, fm.classAt(start)?.name);
    }
  } else {
    scanBraceTypes(fm);
    scanBraceFunctions(fm);
    scanBraceMembers(fm);
    scanExtMethods(fm);
  }
  scanAssignments(fm, skip);
  fm.finishFields();
  const calls = scanCalls(fm, skip);
  const globals = scanGlobals(fm);
  const exports: ExportDecl[] = [];
  for (const t of fm.types) {
    for (const mm of t.methods) exports.push({ name: `${t.name}.${mm.name}`, kind: 'method', line: mm.line, sig: mm.sig, ...(mm.internal || t.internal ? { internal: true } : {}) });
  }
  if (lang !== 'go') {
    for (const e of fm.ext) {
      const owner = e.type.split('.').pop()!;
      exports.push({ name: `${owner}.${e.m.name}`, kind: 'method', line: e.m.line, sig: e.m.sig, ...(e.m.internal ? { internal: true } : {}) });
    }
  }
  return { types: fm.types, ext: fm.ext, calls, returns: fm.returns, globals, exports, methodRanges: fm.methodRanges };
}


/** A parse with its members merged in: methods join the exports as `Type.method`. */
export function withMembers(p: ParsedFile, mem: Members, m: Masked): ParsedFile {
  // Rust: an `fn` inside `impl`/`trait` is a method (exported as `Type.fn`), not a top-level function.
  const inside = mem.methodRanges.map(([a, b]) => [lineAt(m, a), lineAt(m, b)] as const);
  const kept = inside.length ? p.exports.filter(e => !inside.some(([a, b]) => e.line > a && e.line <= b)) : p.exports;
  const names = new Set(kept.map(e => e.name));
  const exports = [...kept, ...mem.exports.filter(e => !names.has(e.name) && (names.add(e.name), true))];
  return {
    ...p,
    exports,
    ...(mem.types.length ? { types: mem.types } : {}),
    ...(mem.ext.length ? { ext: mem.ext } : {}),
    ...(mem.calls.length ? { calls: mem.calls } : {}),
    ...(Object.keys(mem.returns).length ? { returns: mem.returns } : {}),
    ...(Object.keys(mem.globals).length ? { globals: mem.globals } : {}),
  };
}
