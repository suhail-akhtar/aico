/**
 * Method calls linked to the method they call: `svc.process()` → the
 * `process` of the class `svc` is, through imports, base classes and
 * interfaces — and interfaces linked to the types that implement them.
 *
 * ## Why here, after the file graph
 *
 * A call's receiver type is a name as one file wrote it (parse/members);
 * which declaration that name means is the same question the import graph
 * already answers — tsconfig aliases, barrels and re-exports, Python
 * packages, Go package clauses, Java/C# namespaces, PHP PSR-4, Rust `use`
 * paths. So this module asks the {@link Resolver} rather than matching
 * names: a `process` on an unrelated class with the same name is a different
 * symbol and never collects these calls.
 *
 * ## What is linked
 *
 * - **Exact** (`via: 'call'`): the receiver's type is known and declares the
 *   method, or a base class (or embedded Go struct, or mixed-in PHP trait)
 *   does. The call is linked to the declaration that runs.
 * - **Through an interface** (`via: 'interface'`, the edge marked
 *   `viaInterface` and `inferred`): the method is declared on an interface,
 *   trait, protocol/ABC or as abstract; the call may reach any
 *   implementation, so each implementation's method is linked too — labelled,
 *   so "exact only" can leave them out.
 * - **Implementations**: nominal where the language declares them
 *   (`implements`, `extends`, Python bases, `impl Trait for T`, Kotlin/C#
 *   `:` lists); **structural for Go**, by an exact method-set check: every
 *   interface method present with an identical signature (parameter and
 *   result types compared by package, names ignored), on `T` or — when some
 *   have pointer receivers — only on `*T` (recorded as `pointer`). Embedded
 *   interfaces are expanded; an interface embedding one from outside the
 *   project is not checked, because its full method set is unknown.
 *
 * ## What stays unlinked
 *
 * A receiver whose type does not resolve to a declaration in the project, a
 * method no type in its hierarchy declares (it may come from a library base
 * class), dynamic dispatch the declared types do not show. Never a guess.
 *
 * @module codegraph/members
 */

import type { Implementation, Lang, MemberDecl, ParsedFile, RawImport, SymbolRef, TypeDecl, TypeRef } from './types.js';
import type { Resolver } from './resolve.js';
import { dirOf } from './paths.js';
import { closeOf, splitTop } from './parse/members.js';
import { isTestPath } from './parse/index.js';

interface MethodInfo {
  name: string;
  /** The file that declares it (Go/Rust: where the receiver method or `impl` block is). */
  file: number;
  owner: TypeInfo;
  line: number;
  ret?: TypeRef;
  ptr?: boolean;
  abstract?: boolean;
  sig: string;
  /** The file whose imports resolve `ret`. */
  ctx: number;
}

export interface TypeInfo {
  key: string;
  file: number;
  name: string;
  decl: TypeDecl;
  lang: Lang;
  iface: boolean;
  methods: Map<string, MethodInfo>;
  /** Supertypes named by `impl Trait for T` blocks elsewhere (Rust). */
  traits: Array<{ name: string; ctx: number }>;
}

/** A resolved call: who calls which method, and how sure. */
/** `inferred`: the receiver's type was found by a unique name, not by an import (Ruby constants). */
export interface CallLink { from: number; line: number; file: number; symbol: string; via: 'call' | 'interface'; inferred?: boolean }

export interface MemberResolution {
  links: CallLink[];
  implementations: Implementation[];
  /** Go interfaces not checked because they embed one from outside the project. */
  unchecked: number;
}

/** Calls the TypeScript checker resolved for one file (codegraph/ts-check), replacing the lexical ones. */
export interface ExactFile {
  calls: Array<{ line: number; file: number; symbol: string; via: 'call' | 'interface' }>;
  /** `line:method` of every call the checker had an answer for (in the project or not). */
  known: Set<string>;
}

const MAX_IMPL_LINKS = 12;
/** An interface with more implementations than this gets no file edges (still listed). */
export const MAX_IMPL_EDGES = 8;

export class MemberIndex {
  readonly types = new Map<string, TypeInfo>();
  private readonly byFile = new Map<number, TypeInfo[]>();
  private readonly memoType = new Map<string, TypeInfo | null>();
  private readonly memoAnc = new Map<string, TypeInfo[]>();

  constructor(private readonly r: Resolver) {
    r.files.forEach((f, id) => {
      const p = f.parsed;
      if (!p?.types) return;
      for (const d of p.types) {
        const t: TypeInfo = { key: `${id}:${d.name}`, file: id, name: d.name, decl: d, lang: p.lang, iface: d.iface === true, methods: new Map(), traits: [] };
        for (const m of d.methods) t.methods.set(m.name, this.method(m, id, t));
        this.types.set(t.key, t);
        const list = this.byFile.get(id) ?? [];
        list.push(t);
        this.byFile.set(id, list);
      }
    });
    // Methods declared outside their type: Go receivers, Rust impl blocks, Kotlin extensions.
    r.files.forEach((f, id) => {
      for (const e of f.parsed?.ext ?? []) {
        const t = f.parsed!.lang === 'go' ? this.goPackageType(id, e.type) : this.typeByName(id, e.type);
        if (!t) continue;
        if (!t.methods.has(e.m.name) || t.methods.get(e.m.name)!.abstract) t.methods.set(e.m.name, this.method(e.m, id, t));
        if (e.trait && !t.traits.some(x => x.name === e.trait && x.ctx === id)) t.traits.push({ name: e.trait, ctx: id });
      }
    });
  }

  private method(m: MemberDecl, file: number, owner: TypeInfo): MethodInfo {
    return { name: m.name, file, owner, line: m.line, sig: m.sig, ctx: file, ...(m.ret !== undefined ? { ret: m.ret } : {}), ...(m.ptr ? { ptr: true } : {}), ...(m.abstract ? { abstract: true } : {}) };
  }

  typesIn(file: number): TypeInfo[] { return this.byFile.get(file) ?? []; }

  private declared(file: number, name: string): TypeInfo | undefined {
    return this.types.get(`${file}:${name}`);
  }

  /** A Go type of this file's package (same directory, same package clause). */
  private goPackageType(file: number, name: string): TypeInfo | undefined {
    const own = this.declared(file, name);
    if (own) return own;
    const pkg = this.r.parsed(file)?.pkg;
    const hits = this.r.filesInDir(dirOf(this.r.files[file]!.path)).filter(t => this.r.parsed(t)?.lang === 'go' && this.r.parsed(t)?.pkg === pkg).map(t => this.declared(t, name)).filter((x): x is TypeInfo => Boolean(x));
    return hits.length === 1 ? hits[0] : undefined;
  }

  // ── Names to declarations ─────────────────────────────────────────────

  /** The import of `ctx` that binds `local` (a name or a namespace), if any. */
  private binding(ctx: number, local: string): { imp: RawImport; imported: string } | undefined {
    for (const imp of this.r.parsed(ctx)?.imports ?? []) {
      if (imp.reexport) continue;
      const b = imp.names?.find(n => n.local === local);
      if (b) return { imp, imported: b.imported };
      if (imp.ns === local) return { imp, imported: '*' };
    }
    return undefined;
  }

  /**
   * Where an imported name of `ctx` is declared (TS/JS, Python): its origin
   * through re-exports; `name: '*'` for a module object.
   */
  private origin(ctx: number, local: string): { file: number; name: string } | undefined {
    const p = this.r.parsed(ctx);
    const b = this.binding(ctx, local);
    if (!p || !b) return undefined;
    const from = this.r.files[ctx]!.path;
    const t = p.lang === 'py' ? this.r.resolvePy(from, b.imp.spec, b.imp.level ?? 0).target : this.r.resolveJs(from, b.imp.spec).target;
    if (t === undefined) return undefined;
    if (b.imported === '*') return { file: t, name: '*' };
    if (p.lang === 'py') {
      const sub = this.r.pySubmodule(t, b.imported);
      if (sub !== undefined) return { file: sub, name: '*' };
    }
    return this.r.originOf(t, b.imported) ?? { file: t, name: b.imported };
  }

  /** `name` exported by module file `file` → its declaration. */
  private member(file: number, name: string): { file: number; name: string } | undefined {
    const p = this.r.parsed(file);
    if (p?.lang === 'py') { const sub = this.r.pySubmodule(file, name); if (sub !== undefined) return { file: sub, name: '*' }; }
    return this.r.originOf(file, name) ?? (p?.exports.some(e => e.name === name) || p?.types?.some(t => t.name === name) || p?.globals?.[name] !== undefined ? { file, name } : undefined);
  }

  /** A declaration named through `ctx`'s imports, possibly qualified (`models.User`, `ns.Svc`). */
  private declOf(ctx: number, q: string): { file: number; name: string } | undefined {
    const segs = q.split('.');
    let cur = this.origin(ctx, segs[0]!);
    let k = 1;
    // Python `import app.models` binds `app.models` as one namespace.
    if (!cur && this.r.parsed(ctx)?.lang === 'py') {
      for (let n = segs.length - 1; n >= 1; n--) {
        const o = this.origin(ctx, segs.slice(0, n).join('.'));
        if (o) { cur = o; k = n; break; }
      }
    }
    if (!cur) return undefined;
    for (; k < segs.length; k++) {
      if (cur.name !== '*') return undefined;
      cur = this.member(cur.file, segs[k]!);
      if (!cur) return undefined;
    }
    return cur;
  }

  /** The type a declaration names: a default export class, or the type itself. */
  private typeAtDecl(d: { file: number; name: string }): TypeInfo | undefined {
    if (d.name === 'default') {
      const p = this.r.parsed(d.file);
      const local = p?.localExports?.find(b => b.local === 'default')?.imported;
      const def = this.typesIn(d.file).find(t => t.decl.def || t.name === local);
      return def;
    }
    return this.declared(d.file, d.name);
  }

  /** A type name as file `ctx` writes it → the type declared in the project, or undefined. */
  typeByName(ctx: number, name: string): TypeInfo | undefined {
    const key = `${ctx}|${name}`;
    const held = this.memoType.get(key);
    if (held !== undefined) return held ?? undefined;
    this.memoType.set(key, null);
    const t = this.computeType(ctx, name);
    this.memoType.set(key, t ?? null);
    return t;
  }

  private computeType(ctx: number, name: string): TypeInfo | undefined {
    const p = this.r.parsed(ctx);
    if (!p) return undefined;
    const lang = p.lang;
    const qualified = name.includes('.') || name.includes('\\');
    if (!qualified) {
      const own = this.declared(ctx, name);
      if (own) return own;
    }
    switch (lang) {
      case 'ts':
      case 'js':
      case 'py': {
        const d = qualified ? this.declOf(ctx, name) : this.origin(ctx, name);
        return d && d.name !== '*' ? this.typeAtDecl(d) : undefined;
      }
      case 'go': {
        if (!qualified) return this.goPackageType(ctx, name);
        const [q, n] = name.split('.');
        const files = this.goImportTargets(ctx, q!);
        const hits = files.map(f => this.declared(f, n!)).filter((x): x is TypeInfo => Boolean(x));
        return hits.length === 1 ? hits[0] : undefined;
      }
      case 'java':
      case 'kotlin': {
        if (qualified) { const t = this.r.resolveJvm(name, 'static'); return t.length === 1 ? this.declared(t[0]!, name.split('.').pop()!) : undefined; }
        const cands = new Set<number>();
        for (const imp of p.imports) {
          const last = imp.names?.[0]?.local ?? imp.spec.split('.').pop();
          if (imp.kind === 'wildcard') { for (const f of this.r.jvmPackage(imp.spec)) if (this.declared(f, name)) cands.add(f); continue; }
          if (last === name) for (const f of this.r.resolveJvm(imp.spec, imp.kind)) if (this.declared(f, imp.spec.split('.').pop()!)) return this.declared(f, imp.spec.split('.').pop()!);
        }
        if (p.pkg !== undefined) for (const f of this.r.jvmPackage(p.pkg)) if (f !== ctx && this.declared(f, name)) cands.add(f);
        return cands.size === 1 ? this.declared([...cands][0]!, name) : undefined;
      }
      case 'cs': {
        const visible = new Set<string>();
        for (const ns of p.namespaces ?? ['']) { const parts = ns.split('.'); for (let k = parts.length; k >= 0; k--) visible.add(parts.slice(0, k).join('.')); }
        for (const imp of p.imports) if (this.r.csTypes(imp.spec)) visible.add(imp.spec);
        const short = name.split('.').pop()!;
        const cands = new Set<number>();
        for (const ns of visible) for (const f of this.r.csTypes(qualified ? `${ns ? `${ns}.` : ''}${name.slice(0, name.lastIndexOf('.'))}` : ns)?.get(short) ?? []) if (this.declared(f, short)) cands.add(f);
        return cands.size === 1 ? this.declared([...cands][0]!, short) : undefined;
      }
      case 'php': {
        const short = name.split('\\').pop()!;
        let f: number | undefined;
        if (qualified) f = this.r.resolvePhp(name);
        else {
          const imp = p.imports.find(i => i.names?.some(b => b.local === name));
          if (imp) f = this.r.resolvePhp(imp.spec);
          else if (p.pkg !== undefined) f = this.r.resolvePhp(`${p.pkg}\\${name}`);
          f ??= this.r.resolvePhp(name);
        }
        const imported = p.imports.find(i => i.names?.some(b => b.local === name));
        return f !== undefined ? this.declared(f, imported ? imported.spec.split('\\').pop()! : short) : undefined;
      }
      case 'rs': {
        const path = name.replace(/\./g, '::');
        const imp = qualified ? undefined : p.imports.find(i => i.names?.some(b => b.local === name));
        const res = this.r.resolveRustUse(this.r.files[ctx]!.path, imp ? imp.spec : qualified ? path : `self::${name}`);
        if (res.target === undefined) return undefined;
        return this.declared(res.target, res.item ?? name.split('.').pop()!);
      }
      case 'rb': {
        const f = this.r.uniqueGlobal(name);
        return f !== undefined ? this.declared(f, name) : undefined;
      }
    }
    return undefined;
  }

  /** Files of the Go package `ctx` imports under the local name `q`. */
  private goImportTargets(ctx: number, q: string): number[] {
    for (const imp of this.r.parsed(ctx)?.imports ?? []) {
      const res = this.r.resolveGo(imp.spec);
      if (!res.targets?.length) continue;
      const clause = this.r.parsed(res.targets[0]!)?.pkg ?? imp.spec.split('/').pop()!;
      if ((imp.ns ?? clause) === q) return res.targets;
    }
    return [];
  }

  // ── TypeRefs to types ─────────────────────────────────────────────────

  /** What a {@link TypeRef} written in file `ctx` is. `self` is the receiver type for `Self`. */
  typeOf(ctx: number, ref: TypeRef, depth = 0, self?: TypeInfo): TypeInfo | undefined {
    if (depth > 8) return undefined;
    if (typeof ref === 'string') return ref === 'Self' ? self : this.typeByName(ctx, ref);
    if ('ret' in ref) return this.callResult(ctx, ref.ret, depth);
    if ('v' in ref) return this.variable(ctx, ref.v, depth);
    const recv = this.typeOf(ctx, ref.of, depth + 1, self);
    if (!recv) return undefined;
    if ('m' in ref) {
      const m = this.findMethod(recv, ref.m);
      if (!m?.ret) return undefined;
      return m.ret === 'Self' ? recv : this.typeOf(m.ctx, m.ret, depth + 1, recv);
    }
    const f = this.findField(recv, ref.f);
    return f ? this.typeOf(f.ctx, f.ref, depth + 1, recv) : undefined;
  }

  /** What calling the function or class named `name` gives. */
  private callResult(ctx: number, name: string, depth: number): TypeInfo | undefined {
    const p = this.r.parsed(ctx);
    if (!p) return undefined;
    const qualified = name.includes('.');
    if (!qualified) {
      const own = this.declared(ctx, name);
      if (own) return own;
      const r = p.returns?.[name];
      if (r !== undefined) return this.typeOf(ctx, r, depth + 1);
    }
    if (p.lang === 'go') {
      if (!qualified) {
        for (const f of this.r.filesInDir(dirOf(this.r.files[ctx]!.path))) {
          const q = this.r.parsed(f);
          if (q?.lang === 'go' && q.pkg === p.pkg && q.returns?.[name] !== undefined) return this.typeOf(f, q.returns[name]!, depth + 1);
        }
        return undefined;
      }
      const [q, n] = name.split('.');
      for (const f of this.goImportTargets(ctx, q!)) {
        const r = this.r.parsed(f)?.returns?.[n!];
        if (r !== undefined) return this.typeOf(f, r, depth + 1);
      }
      return undefined;
    }
    if (p.lang === 'ts' || p.lang === 'js' || p.lang === 'py') {
      let d = qualified ? this.declOf(ctx, name) : this.origin(ctx, name);
      if (!d && qualified) {
        // `BillingService.create()`: a static/class method of an imported class.
        const cls = this.typeByName(ctx, name.slice(0, name.lastIndexOf('.')));
        const m = cls ? this.findMethod(cls, name.slice(name.lastIndexOf('.') + 1)) : undefined;
        if (cls && m?.ret) return m.ret === 'Self' ? cls : this.typeOf(m.ctx, m.ret, depth + 1, cls);
        return undefined;
      }
      if (!d || d.name === '*') return undefined;
      const t = this.typeAtDecl(d);
      if (t) return t;
      const r = this.r.parsed(d.file)?.returns?.[d.name];
      return r !== undefined ? this.typeOf(d.file, r, depth + 1) : undefined;
    }
    // Kotlin/Ruby/Rust/Java: calling a type's name constructs it.
    return this.typeByName(ctx, name);
  }

  /** A module-level variable (or, failing that, a type used statically). */
  private variable(ctx: number, name: string, depth: number): TypeInfo | undefined {
    const p = this.r.parsed(ctx);
    if (!p) return undefined;
    if (!name.includes('.')) {
      const g = p.globals?.[name];
      if (g !== undefined) return this.typeOf(ctx, g, depth + 1);
    }
    if (p.lang === 'go' && name.includes('.')) {
      const [q, n] = name.split('.');
      for (const f of this.goImportTargets(ctx, q!)) {
        const g = this.r.parsed(f)?.globals?.[n!];
        if (g !== undefined) return this.typeOf(f, g, depth + 1);
      }
      return this.typeByName(ctx, name);
    }
    if (p.lang === 'ts' || p.lang === 'js' || p.lang === 'py') {
      const d = name.includes('.') ? this.declOf(ctx, name) : this.origin(ctx, name);
      if (!d || d.name === '*') return undefined;
      const g = this.r.parsed(d.file)?.globals?.[d.name];
      if (g !== undefined) return this.typeOf(d.file, g, depth + 1);
      return this.typeAtDecl(d);
    }
    return this.typeByName(ctx, name);
  }

  // ── Hierarchy ─────────────────────────────────────────────────────────

  /** Direct supertypes, resolved in the declaring file. */
  supers(t: TypeInfo): TypeInfo[] {
    const out: TypeInfo[] = [];
    const names = [...(t.decl.bases ?? []), ...(t.decl.impls ?? [])];
    for (const n of names) { const s = this.typeByName(t.file, n); if (s && s !== t) out.push(s); }
    for (const e of t.decl.embeds ?? []) { const s = this.typeByName(t.file, e.name); if (s && s !== t) out.push(s); }
    for (const tr of t.traits) { const s = this.typeByName(tr.ctx, tr.name); if (s && s !== t) out.push(s); }
    return out;
  }

  /** Every supertype, nearest first. */
  ancestors(t: TypeInfo): TypeInfo[] {
    const held = this.memoAnc.get(t.key);
    if (held) return held;
    const out: TypeInfo[] = [];
    const seen = new Set([t.key]);
    const queue = [t];
    for (let i = 0; i < queue.length && out.length < 64; i++) {
      for (const s of this.supers(queue[i]!)) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        out.push(s);
        queue.push(s);
      }
    }
    this.memoAnc.set(t.key, out);
    return out;
  }

  findMethod(t: TypeInfo, name: string): MethodInfo | undefined {
    const own = t.methods.get(name);
    if (own && !own.abstract) return own;
    // A concrete method up the class chain wins over an abstract declaration.
    for (const a of this.ancestors(t)) { const m = a.methods.get(name); if (m && !m.abstract) return m; }
    if (own) return own;
    for (const a of this.ancestors(t)) { const m = a.methods.get(name); if (m) return m; }
    return undefined;
  }

  findField(t: TypeInfo, name: string): { ref: TypeRef; ctx: number } | undefined {
    for (const x of [t, ...this.ancestors(t)]) {
      const f = x.decl.fields?.[name];
      if (f !== undefined) return { ref: f, ctx: x.file };
    }
    return undefined;
  }
}

// ── Go: exact method sets ───────────────────────────────────────────────────

const GO_BUILTIN = new Set(['bool', 'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'byte', 'rune', 'float32', 'float64', 'complex64', 'complex128', 'error', 'any', 'comparable']);
const GO_TYPE_WORDS = new Set(['map', 'chan', 'func', 'struct', 'interface']);

/** Parameter or result types of a Go list (names dropped; `a, b T` gives T twice). */
export function goTypeList(list: string): string[] {
  const parts = splitTop(list).map(s => s.trim()).filter(Boolean);
  const named = parts.some(p => /^[A-Za-z_]\w*\s+\S/.test(p) && !GO_TYPE_WORDS.has(/^(\w+)/.exec(p)![1]!));
  if (!named) return parts;
  const out: string[] = [];
  let pending = 0;
  for (const p of parts) {
    const m = /^([A-Za-z_]\w*)\s+(\S[^]*)$/.exec(p);
    if (!m) { pending++; continue; }
    for (let i = 0; i <= pending; i++) out.push(m[2]!.trim());
    pending = 0;
  }
  return out;
}

class GoCanon {
  constructor(private readonly r: Resolver) {}
  private pkgId(file: number): string { return dirOf(this.r.files[file]!.path); }

  /** A type with every name qualified by its package: `*ordering.Order` in any file → `*<dir>.Order`. */
  type(text: string, ctx: number): string {
    const p = this.r.parsed(ctx);
    const local = new Set<string>();
    for (const f of this.r.filesInDir(dirOf(this.r.files[ctx]!.path))) {
      const q = this.r.parsed(f);
      if (q?.lang === 'go' && q.pkg === p?.pkg) for (const e of q.exports) if (e.kind === 'type') local.add(e.name);
    }
    return text.replace(/\s+/g, ' ').replace(/([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)|([A-Za-z_]\w*)/g, (all, q?: string, n?: string, id?: string) => {
      if (q && n) {
        for (const imp of p?.imports ?? []) {
          const res = this.r.resolveGo(imp.spec);
          const clause = res.targets?.length ? this.r.parsed(res.targets[0]!)?.pkg ?? imp.spec.split('/').pop()! : imp.spec.split('/').pop()!;
          if ((imp.ns ?? clause) === q) return `${res.targets?.length ? dirOf(this.r.files[res.targets[0]!]!.path) : imp.spec}.${n}`;
        }
        return all;
      }
      if (!id || GO_TYPE_WORDS.has(id) || GO_BUILTIN.has(id)) return all;
      return local.has(id) ? `${this.pkgId(ctx)}.${id}` : id;
    }).replace(/\s+/g, '');
  }

  /** `(params) results` of a method header → canonical `(T1,T2)(R1,R2)`. */
  sig(header: string, name: string, ctx: number): string | undefined {
    const at = header.search(new RegExp(`\\b${name}\\s*\\(`));
    if (at < 0) return undefined;
    const open = header.indexOf('(', at);
    const close = closeOf(header, open);
    if (close < 0) return undefined;
    const params = goTypeList(header.slice(open + 1, close));
    let rest = header.slice(close + 1).trim().replace(/\{$/, '').trim();
    let results: string[] = [];
    if (rest.startsWith('(')) { const c2 = closeOf(rest, 0); results = c2 > 0 ? goTypeList(rest.slice(1, c2)) : []; }
    else if (rest) results = [rest];
    rest = '';
    return `(${params.map(t => this.type(t, ctx)).join(',')})(${results.map(t => this.type(t, ctx)).join(',')})`;
  }
}

/** Go types satisfying Go interfaces, by exact method sets. */
function goImplementations(idx: MemberIndex, r: Resolver): { impls: Implementation[]; unchecked: number } {
  const canon = new GoCanon(r);
  const go = [...idx.types.values()].filter(t => t.lang === 'go');
  const sigOf = new Map<MethodInfo, string | undefined>();
  const sig = (m: MethodInfo): string | undefined => {
    if (!sigOf.has(m)) sigOf.set(m, canon.sig(m.sig, m.name, m.ctx));
    return sigOf.get(m);
  };
  // Interface method sets, embedded interfaces expanded.
  const ifaceSet = (t: TypeInfo, seen = new Set<string>()): Map<string, MethodInfo> | undefined => {
    if (seen.has(t.key)) return new Map();
    seen.add(t.key);
    const out = new Map<string, MethodInfo>();
    for (const [n, m] of t.methods) out.set(n, m);
    for (const b of t.decl.bases ?? []) {
      const s = idx.typeByName(t.file, b);
      if (!s || !s.iface) return undefined;
      const inner = ifaceSet(s, seen);
      if (!inner) return undefined;
      for (const [n, m] of inner) if (!out.has(n)) out.set(n, m);
    }
    return out;
  };
  // Concrete method sets: value receivers, and the pointer set (value + pointer + promoted).
  const valueSet = new Map<string, Map<string, MethodInfo>>();
  const ptrSet = new Map<string, Map<string, MethodInfo>>();
  const sets = (t: TypeInfo, seen = new Set<string>()): void => {
    if (valueSet.has(t.key) || seen.has(t.key)) return;
    seen.add(t.key);
    const v = new Map<string, MethodInfo>();
    const p = new Map<string, MethodInfo>();
    for (const [n, m] of t.methods) { if (!m.ptr) v.set(n, m); p.set(n, m); }
    for (const e of t.decl.embeds ?? []) {
      const s = idx.typeByName(t.file, e.name);
      if (!s) continue;
      if (s.iface) { for (const [n, m] of ifaceSet(s) ?? []) { if (!v.has(n)) v.set(n, m); if (!p.has(n)) p.set(n, m); } continue; }
      sets(s, seen);
      const sv = valueSet.get(s.key) ?? new Map();
      const sp = ptrSet.get(s.key) ?? new Map();
      // Embedding S promotes S's value methods to T and *T, and *S's to *T; embedding *S promotes both to both.
      for (const [n, m] of sv) { if (!v.has(n)) v.set(n, m); if (!p.has(n)) p.set(n, m); }
      for (const [n, m] of sp) { if (e.ptr && !v.has(n)) v.set(n, m); if (!p.has(n)) p.set(n, m); }
    }
    valueSet.set(t.key, v);
    ptrSet.set(t.key, p);
  };
  const concrete = go.filter(t => !t.iface);
  for (const t of concrete) sets(t);
  const byMethod = new Map<string, TypeInfo[]>();
  for (const t of concrete) for (const n of ptrSet.get(t.key)!.keys()) { const l = byMethod.get(n) ?? []; l.push(t); byMethod.set(n, l); }

  const impls: Implementation[] = [];
  let unchecked = 0;
  for (const i of go.filter(t => t.iface)) {
    const want = ifaceSet(i);
    if (!want) { unchecked++; continue; }
    if (want.size === 0) continue;
    const names = [...want.keys()];
    const cands = byMethod.get(names[0]!) ?? [];
    for (const t of cands) {
      const v = valueSet.get(t.key)!;
      const p = ptrSet.get(t.key)!;
      let pointer = false;
      const methods: Implementation['methods'] = [];
      let ok = true;
      for (const n of names) {
        const im = want.get(n)!;
        const target = sig(im);
        const vm = v.get(n);
        const pm = p.get(n);
        const vOk = vm && sig(vm) === target && target !== undefined;
        const pOk = pm && sig(pm) === target && target !== undefined;
        if (vOk) methods.push({ name: n, file: vm.file, line: vm.line });
        else if (pOk) { pointer = true; methods.push({ name: n, file: pm.file, line: pm.line, ptr: true }); }
        else { ok = false; break; }
      }
      if (!ok) continue;
      impls.push({ iface: { file: i.file, name: i.name }, impl: { file: t.file, name: t.name }, methods, how: 'structural', ...(pointer ? { pointer } : {}) });
    }
  }
  return { impls, unchecked };
}

/** Declared implementations: a type whose supertypes include an interface (or an abstract base). */
function nominalImplementations(idx: MemberIndex): Implementation[] {
  const out: Implementation[] = [];
  for (const t of idx.types.values()) {
    if (t.lang === 'go' || t.iface) continue;
    for (const a of idx.ancestors(t)) {
      const abstractNames = [...a.methods.values()].filter(m => a.iface || m.abstract).map(m => m.name);
      // Also the abstract methods it inherits from its own supertypes.
      if (a.iface) for (const aa of idx.ancestors(a)) for (const m of aa.methods.values()) if (!abstractNames.includes(m.name)) abstractNames.push(m.name);
      if (!a.iface && abstractNames.length === 0) continue;
      const methods: Implementation['methods'] = [];
      for (const n of abstractNames) {
        const m = idx.findMethod(t, n);
        if (m && !m.abstract) methods.push({ name: n, file: m.file, line: m.line });
      }
      out.push({ iface: { file: a.file, name: a.name }, impl: { file: t.file, name: t.name }, methods, how: 'declared' });
    }
  }
  return out;
}

/**
 * Resolve every call site and every implementation. `exact` replaces the
 * lexical TS/JS calls of a file with the TypeScript checker's answers;
 * `exactImpls` are the checker's TS implementations (structural included).
 */
export function resolveMembers(r: Resolver, exact?: Map<number, ExactFile>, exactImpls?: Implementation[]): MemberResolution {
  const idx = new MemberIndex(r);
  const go = goImplementations(idx, r);
  const nominal = nominalImplementations(idx).filter(i => !(exactImpls && isTs(r, i.iface.file)));
  const implementations = [...nominal, ...go.impls, ...(exactImpls ?? [])];
  const implsOf = new Map<string, Implementation[]>();
  for (const i of implementations) {
    const key = `${i.iface.file}:${i.iface.name}`;
    const l = implsOf.get(key) ?? [];
    l.push(i);
    implsOf.set(key, l);
  }
  const links: CallLink[] = [];
  r.files.forEach((f, id) => {
    const p = f.parsed;
    if (!p) return;
    const ex = exact?.get(id);
    if (ex) for (const c of ex.calls) links.push({ from: id, line: c.line, file: c.file, symbol: c.symbol, via: c.via });
    for (const c of p.calls ?? []) {
      if (ex?.known.has(`${c.line}:${c.m}`)) continue;
      const t = idx.typeOf(id, c.recv);
      if (!t) continue;
      const m = idx.findMethod(t, c.m);
      if (!m) continue;
      const inferred = p.lang === 'rb';
      links.push({ from: id, line: c.line, file: m.file, symbol: `${m.owner.name}.${c.m}`, via: 'call', ...(inferred ? { inferred } : {}) });
      if (!(m.owner.iface || m.abstract)) continue;
      // Through an interface: any implementation's method may run.
      const callerInTest = isTestPath(f.path);
      const impls = (implsOf.get(`${m.owner.file}:${m.owner.name}`) ?? []).filter(i => callerInTest || !isTestPath(r.files[i.impl.file]!.path));
      if (impls.length > MAX_IMPL_LINKS) continue;
      for (const i of impls) {
        const hit = i.methods.find(x => x.name === c.m);
        if (!hit) continue;
        links.push({ from: id, line: c.line, file: hit.file, symbol: `${i.impl.name}.${c.m}`, via: 'interface' });
      }
    }
  });
  return { links, implementations, unchecked: go.unchecked };
}

function isTs(r: Resolver, file: number): boolean {
  const l = r.parsed(file)?.lang;
  return l === 'ts' || l === 'js';
}

export type { ParsedFile, SymbolRef };
