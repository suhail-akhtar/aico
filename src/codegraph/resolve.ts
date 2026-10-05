/**
 * From per-file parses to a graph: every import resolved to a real file, every
 * binding followed through re-exports to the declaration it names.
 *
 * ## Why accuracy is the whole job
 *
 * The Phase 0 benchmark (ADR 0028) measured external graph tools giving an
 * agent *wrong* caller lists: seven callers of `formatAmount`, all of them
 * same-named decoys, because a `@/` path alias was not resolved; seven of 58
 * Python callers; no Go package at all. A wrong list is worse than none — the
 * agent trusts it. So this module resolves the way the language does, and
 * where it cannot be sure it adds nothing:
 *
 * - **TS/JS**: `tsconfig`/`jsconfig` (with `extends`) `baseUrl` and `paths`,
 *   relative paths with extension swaps and `index` files, workspace packages
 *   by `package.json` name and `exports`, and source for a package's built
 *   entry when the build output is not indexed.
 * - **Python**: absolute imports against every source root (the parent of each
 *   top-level package, so `api/shop_api` resolves as `shop_api`), relative
 *   imports by level, a name that is really a submodule.
 * - **Go**: `go.mod` module path → package directory; the importer's local name
 *   is the package *clause*.
 * - **Java/Kotlin, C#, PHP, Ruby, Rust**: by the scope rules each language
 *   defines (package, namespace + usings, PSR-4, require, `mod`/`use`).
 *
 * A binding is then followed to its **origin** — `export *`, `export { a as
 * b } from`, `export { a as b }` of an import, Python package re-exports — so
 * `import { money } from '@/components/ui'` is a use of `formatAmount` in
 * `src/lib/format/currency.ts`, and a same-named function elsewhere is a
 * different symbol with its own users.
 *
 * Names visible by scope (Go same package, Java/C# same package/namespace)
 * link only when exactly one declaration in scope has the name; Ruby
 * constants link only when the name is declared once in the project
 * (`inferred`). Ambiguity is no edge, never several.
 *
 * @module codegraph/resolve
 */

import type { EdgeKind, FileEdge, ImportBinding, Lang, ParsedFile, RawImport, SymbolRef } from './types.js';
import { baseOf, dirOf, joinRel, keyOf, normRel, stemOf } from './paths.js';
import { goTypeKey } from './parse/go.js';
import { isTestPath } from './parse/index.js';

export interface ResolveFile {
  path: string;
  parsed?: ParsedFile;
}

export interface Resolution {
  edges: FileEdge[];
  symbols: Map<string, SymbolRef[]>;
  external: Map<string, number[]>;
  unresolved: Array<{ file: number; spec: string }>;
  /** `${file}:${name}` → bindings that name it although the file does not export it (any more). */
  dangling: Map<string, SymbolRef[]>;
}

interface Origin { file: number; name: string }

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const SWAPS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const BUILD_DIRS = /^(dist|build|lib|out|esm|cjs)\//;
const ASSET = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|json|ya?ml|toml|md|mdx|txt|html|wasm|glsl|graphql|gql)$/i;
const IGNORED_SEGMENT = /\/(node_modules|dist|dist-test|build|out|coverage|\.next|\.nuxt|target|vendor|__pycache__)\//;

const PY_STDLIB = new Set(['os', 'sys', 're', 'json', 'typing', 'dataclasses', 'datetime', 'time', 'math', 'random', 'collections', 'itertools', 'functools', 'pathlib', 'logging', 'unittest', 'asyncio', 'subprocess', 'enum', 'abc', 'copy', 'io', 'uuid', 'hashlib', 'base64', 'decimal', 'string', 'textwrap', 'contextlib', 'threading', 'tempfile', 'shutil', 'glob', 'argparse', 'csv', 'sqlite3', 'socket', 'http', 'urllib', 'email', 'traceback', 'inspect', 'types', 'weakref', 'warnings', 'pickle', 'struct', 'operator', 'statistics', 'secrets', 'hmac', 'zlib', 'gzip', 'zipfile', 'xml', 'html', 'platform', 'signal', 'queue', 'concurrent', 'multiprocessing', 'importlib', 'pprint', 'fractions', 'numbers', 'heapq', 'bisect', 'array', 'locale', 'calendar', 'zoneinfo', 'shlex', 'getpass', 'configparser', 'codecs', 'unicodedata', 'difflib', 'fnmatch', 'stat', 'errno', 'ctypes', 'ssl', 'select', 'selectors', 'mimetypes', 'webbrowser', 'doctest', 'pdb', 'timeit', 'gc', 'atexit', '__future__', 'builtins', 'typing_extensions']);

/** JSON with comments and trailing commas (tsconfig, jsconfig). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface TsPaths { prefix: string; suffix: string; star: boolean; targets: string[] }
interface TsCfg { baseUrl?: string; paths: TsPaths[] }

export class Resolver {
  readonly files: ResolveFile[];
  private readonly configs: Map<string, string>;
  private readonly byKey = new Map<string, number>();
  private readonly byDir = new Map<string, number[]>();
  private readonly tsCfgCache = new Map<string, TsCfg | null>();
  private readonly tsCfgByDir = new Map<string, TsCfg | null>();
  private readonly workspaces: Array<{ name: string; dir: string; json: Record<string, unknown> }> = [];
  private readonly pyRoots: string[];
  private readonly goModules: Array<{ path: string; dir: string }> = [];
  private readonly fqn = new Map<string, number[]>();
  private readonly pkgFiles = new Map<string, number[]>();
  private readonly nsTypes = new Map<string, Map<string, number[]>>();
  private readonly psr4: Array<{ prefix: string; dirs: string[] }> = [];
  private readonly globalDecl = new Map<string, number[]>();
  private readonly rustCrates: Array<{ name: string; src: string; root?: number }> = [];
  private readonly rustModules = new Map<string, number>();
  private readonly originMemo = new Map<string, Origin | null>();

  constructor(files: ResolveFile[], configs: Map<string, string>) {
    this.files = files;
    this.configs = configs;
    files.forEach((f, id) => {
      this.byKey.set(keyOf(f.path), id);
      const d = keyOf(dirOf(f.path));
      const list = this.byDir.get(d);
      if (list) list.push(id); else this.byDir.set(d, [id]);
    });
    for (const [rel, text] of configs) {
      const base = baseOf(rel);
      if (base === 'package.json') {
        try {
          const json = JSON.parse(text) as Record<string, unknown>;
          if (typeof json.name === 'string') this.workspaces.push({ name: json.name, dir: dirOf(rel), json });
        } catch { /* a broken package.json names nothing */ }
      } else if (base === 'go.mod') {
        const mod = /^\s*module\s+(\S+)/m.exec(text)?.[1];
        if (mod) this.goModules.push({ path: mod, dir: dirOf(rel) });
      } else if (base === 'composer.json') {
        try {
          const json = JSON.parse(text) as { autoload?: { 'psr-4'?: Record<string, string | string[]> }; 'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> } };
          for (const block of [json.autoload?.['psr-4'], json['autoload-dev']?.['psr-4']]) {
            for (const [prefix, dirs] of Object.entries(block ?? {})) {
              const list = (Array.isArray(dirs) ? dirs : [dirs]).map(d => joinRel(dirOf(rel), d) ?? '');
              this.psr4.push({ prefix: prefix.replace(/\\+$/, ''), dirs: list });
            }
          }
        } catch { /* no autoload map */ }
      } else if (base === 'Cargo.toml') {
        const name = /\[package\][\s\S]*?\n\s*name\s*=\s*"([^"]+)"/.exec(text)?.[1];
        const src = joinRel(dirOf(rel), 'src') ?? 'src';
        const root = this.lookup(`${src}/lib.rs`) ?? this.lookup(`${src}/main.rs`);
        this.rustCrates.push({ name: (name ?? '').replace(/-/g, '_'), src, ...(root !== undefined ? { root } : {}) });
      }
    }
    this.workspaces.sort((a, b) => b.name.length - a.name.length);
    this.goModules.sort((a, b) => b.path.length - a.path.length);
    this.psr4.sort((a, b) => b.prefix.length - a.prefix.length);
    this.pyRoots = this.computePyRoots();
    this.indexScopes();
  }

  lookup(rel: string | undefined): number | undefined {
    if (rel === undefined) return undefined;
    return this.byKey.get(keyOf(rel));
  }

  parsed(id: number): ParsedFile | undefined {
    return this.files[id]?.parsed;
  }

  filesInDir(dir: string): number[] {
    return this.byDir.get(keyOf(dir)) ?? [];
  }

  // ── TS/JS ──────────────────────────────────────────────────────────────

  private loadTsConfig(rel: string, depth = 0): TsCfg | null {
    const cached = this.tsCfgCache.get(rel);
    if (cached !== undefined) return cached;
    const text = this.configs.get(rel);
    if (text === undefined || depth > 6) { this.tsCfgCache.set(rel, null); return null; }
    let json: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try { json = parseJsonc(text) as typeof json; } catch { this.tsCfgCache.set(rel, null); return null; }
    const dir = dirOf(rel);
    let cfg: TsCfg = { paths: [] };
    const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
    for (const p of parents) {
      if (!p.startsWith('.')) continue;
      const target = joinRel(dir, p.endsWith('.json') ? p : `${p}.json`);
      const parent = target ? this.loadTsConfig(target, depth + 1) : null;
      if (parent) cfg = { ...(parent.baseUrl !== undefined ? { baseUrl: parent.baseUrl } : {}), paths: parent.paths };
    }
    const opts = json.compilerOptions ?? {};
    if (typeof opts.baseUrl === 'string') cfg.baseUrl = joinRel(dir, opts.baseUrl) ?? '';
    if (opts.paths && typeof opts.paths === 'object') {
      const base = cfg.baseUrl ?? dir;
      cfg.paths = Object.entries(opts.paths).map(([pattern, targets]) => {
        const star = pattern.indexOf('*');
        return {
          prefix: star < 0 ? pattern : pattern.slice(0, star),
          suffix: star < 0 ? '' : pattern.slice(star + 1),
          star: star >= 0,
          targets: (Array.isArray(targets) ? targets : []).map(t => (base ? `${base}/${t}` : t)),
        };
      }).sort((a, b) => b.prefix.length - a.prefix.length);
    }
    this.tsCfgCache.set(rel, cfg);
    return cfg;
  }

  private tsConfigFor(fileRel: string): TsCfg | null {
    let dir = dirOf(fileRel);
    const walked: string[] = [];
    for (;;) {
      const held = this.tsCfgByDir.get(dir);
      if (held !== undefined) { for (const w of walked) this.tsCfgByDir.set(w, held); return held; }
      walked.push(dir);
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const rel = dir ? `${dir}/${name}` : name;
        if (this.configs.has(rel)) {
          const cfg = this.loadTsConfig(rel);
          for (const w of walked) this.tsCfgByDir.set(w, cfg);
          return cfg;
        }
      }
      if (!dir) break;
      dir = dirOf(dir);
    }
    for (const w of walked) this.tsCfgByDir.set(w, null);
    return null;
  }

  /** A path (no extension, or a swappable one) to a file id. */
  tryJsPath(rel: string | undefined, depth = 0, fromPackage = false): number | undefined {
    if (rel === undefined || depth > 3) return undefined;
    const direct = this.lookup(rel);
    if (direct !== undefined && /\.[cm]?[jt]sx?$/.test(rel)) return direct;
    const dot = rel.lastIndexOf('.');
    const ext = dot > rel.lastIndexOf('/') ? rel.slice(dot) : '';
    for (const swap of SWAPS[ext] ?? []) {
      const hit = this.lookup(rel.slice(0, dot) + swap);
      if (hit !== undefined) return hit;
    }
    if (direct !== undefined) return direct;
    for (const e of JS_EXTS) {
      const hit = this.lookup(rel + e);
      if (hit !== undefined) return hit;
    }
    for (const e of JS_EXTS) {
      const hit = this.lookup(`${rel}/index${e}`);
      if (hit !== undefined) return hit;
    }
    const pkg = this.configs.get(`${rel}/package.json`);
    if (pkg !== undefined) {
      try { return this.resolvePackage(rel, '', JSON.parse(pkg) as Record<string, unknown>, depth + 1); } catch { /* fall through */ }
    }
    // A package's built entry (dist/…) is not indexed; its source usually is.
    if (fromPackage) {
      const segs = rel.split('/');
      const at = segs.findIndex(seg => BUILD_DIRS.test(`${seg}/`));
      if (at >= 0) {
        segs[at] = 'src';
        return this.tryJsPath(segs.join('/').replace(/\.d\.ts$/, '').replace(/\.[cm]?js$/, ''), depth + 1);
      }
    }
    return undefined;
  }

  private pickExport(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) { for (const v of value) { const s = this.pickExport(v); if (s) return s; } return undefined; }
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const k of ['source', 'development', 'import', 'module', 'default', 'require', 'node', 'browser', 'types']) {
        if (k in o) { const s = this.pickExport(o[k]); if (s) return s; }
      }
    }
    return undefined;
  }

  private resolvePackage(dir: string, subpath: string, json: Record<string, unknown>, depth = 0): number | undefined {
    const exp = json.exports;
    if (exp !== undefined) {
      const map = typeof exp === 'string' || Array.isArray(exp) || !Object.keys(exp as object).some(k => k.startsWith('.'))
        ? { '.': exp } as Record<string, unknown>
        : exp as Record<string, unknown>;
      const key = subpath ? `./${subpath}` : '.';
      let target = map[key] !== undefined ? this.pickExport(map[key]) : undefined;
      if (target === undefined) {
        for (const [k, v] of Object.entries(map)) {
          const star = k.indexOf('*');
          if (star < 0) continue;
          const pre = k.slice(0, star);
          const post = k.slice(star + 1);
          if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
            const mid = key.slice(pre.length, key.length - post.length);
            target = this.pickExport(v)?.replace('*', mid);
            break;
          }
        }
      }
      if (target) {
        const hit = this.tryJsPath(joinRel(dir, target), depth + 1, true);
        if (hit !== undefined) return hit;
      }
    }
    if (subpath) return this.tryJsPath(joinRel(dir, subpath), depth + 1);
    for (const field of ['source', 'module', 'main', 'types', 'typings']) {
      const v = json[field];
      if (typeof v === 'string') {
        const hit = this.tryJsPath(joinRel(dir, v), depth + 1, true);
        if (hit !== undefined) return hit;
      }
    }
    return this.lookupIndex(dir) ?? this.lookupIndex(dir ? `${dir}/src` : 'src');
  }

  private lookupIndex(dir: string): number | undefined {
    for (const e of JS_EXTS) {
      const hit = this.lookup(`${dir}/index${e}`);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  resolveJs(from: string, spec: string): { target?: number; external?: string; local?: boolean } {
    // Stylesheets, pictures, data: dependencies of a bundle, not of the code graph.
    if (ASSET.test(spec.split('?')[0]!)) return {};
    if (spec.startsWith('.')) {
      const rel = joinRel(dirOf(from), spec);
      const t = this.tryJsPath(rel);
      if (t !== undefined) return { target: t };
      // Into build output or dependencies, which are not indexed by design: not a broken import.
      return rel && IGNORED_SEGMENT.test(`/${rel}/`) ? {} : { local: true };
    }
    if (/^(node:|bun:|https?:|data:|virtual:)/.test(spec)) return {};
    const cfg = this.tsConfigFor(from);
    let aliased = false;
    for (const p of cfg?.paths ?? []) {
      const matches = p.star ? spec.startsWith(p.prefix) && spec.endsWith(p.suffix) && spec.length >= p.prefix.length + p.suffix.length : spec === p.prefix;
      if (!matches) continue;
      // `"zustand": ["../web/node_modules/zustand"]` pins a dependency's copy; it is still external.
      if (p.targets.some(t => t.includes('node_modules/'))) {
        const parts = spec.split('/');
        return { external: spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]! };
      }
      aliased = true;
      const mid = p.star ? spec.slice(p.prefix.length, spec.length - p.suffix.length) : '';
      for (const t of p.targets) {
        const hit = this.tryJsPath(normRel(p.star ? t.replace('*', mid) : t));
        if (hit !== undefined) return { target: hit };
      }
    }
    for (const ws of this.workspaces) {
      if (spec === ws.name || spec.startsWith(`${ws.name}/`)) {
        const hit = this.resolvePackage(ws.dir, spec.slice(ws.name.length + 1), ws.json);
        if (hit !== undefined) return { target: hit };
        return { local: true };
      }
    }
    if (cfg?.baseUrl !== undefined) {
      const hit = this.tryJsPath(joinRel(cfg.baseUrl, spec));
      if (hit !== undefined) return { target: hit };
    }
    if (aliased || spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('#')) return { local: true };
    const parts = spec.split('/');
    return { external: spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]! };
  }

  // ── Python ─────────────────────────────────────────────────────────────

  private computePyRoots(): string[] {
    const roots = new Set<string>(['']);
    const isPkg = (dir: string): boolean => this.lookup(dir ? `${dir}/__init__.py` : '__init__.py') !== undefined;
    for (const f of this.files) {
      if (f.path.endsWith('.py') && f.path.startsWith('src/')) roots.add('src');
      if (baseOf(f.path) !== '__init__.py') continue;
      // The top-level package containing this one: its parent is a source root.
      let top = dirOf(f.path);
      while (top !== '' && dirOf(top) !== '' && isPkg(dirOf(top))) top = dirOf(top);
      roots.add(top === '' ? '' : dirOf(top));
    }
    return [...roots];
  }

  /** A dotted module under a root: `a/b.py` or `a/b/__init__.py`. */
  private pyModuleAt(base: string, dotted: string): number | undefined {
    const rel = dotted ? `${base ? `${base}/` : ''}${dotted.split('.').join('/')}` : base;
    return this.lookup(`${rel}.py`) ?? this.lookup(`${rel}.pyi`) ?? this.lookup(rel ? `${rel}/__init__.py` : '__init__.py');
  }

  resolvePy(from: string, spec: string, level = 0): { target?: number; external?: string; local?: boolean } {
    if (level > 0) {
      let base = dirOf(from);
      for (let k = 1; k < level; k++) base = dirOf(base);
      const t = this.pyModuleAt(base, spec);
      return t !== undefined ? { target: t } : { local: true };
    }
    // Roots that contain the importer first, deepest first: the package it lives in wins a name clash.
    const fromDir = dirOf(from);
    const roots = [...this.pyRoots].sort((a, b) => {
      const ia = a === '' || fromDir === a || fromDir.startsWith(`${a}/`) ? 1 : 0;
      const ib = b === '' || fromDir === b || fromDir.startsWith(`${b}/`) ? 1 : 0;
      return ib - ia || b.length - a.length;
    });
    for (const root of roots) {
      const t = this.pyModuleAt(root, spec);
      if (t !== undefined) return { target: t };
    }
    const top = spec.split('.')[0]!;
    if (PY_STDLIB.has(top)) return {};
    // A first segment that is a local package means a missing submodule, not a dependency.
    for (const root of roots) if (this.pyModuleAt(root, top) !== undefined) return { local: true };
    return { external: top };
  }

  /** `from pkg import name` where `name` is a submodule of `pkg`. */
  pySubmodule(pkgFile: number, name: string): number | undefined {
    const f = this.files[pkgFile]!;
    if (baseOf(f.path) !== '__init__.py') return undefined;
    return this.pyModuleAt(dirOf(f.path), name);
  }

  // ── Go ─────────────────────────────────────────────────────────────────

  resolveGo(spec: string): { targets?: number[]; external?: string } {
    for (const mod of this.goModules) {
      if (spec === mod.path || spec.startsWith(`${mod.path}/`)) {
        const dir = joinRel(mod.dir, spec.slice(mod.path.length + 1)) ?? mod.dir;
        const targets = this.filesInDir(dir).filter(id => this.files[id]!.path.endsWith('.go') && !this.files[id]!.path.endsWith('_test.go'));
        return targets.length ? { targets } : {};
      }
    }
    const segs = spec.split('/');
    if (!segs[0]!.includes('.')) return {};
    return { external: segs.slice(0, 3).join('/') };
  }

  // ── Scope indexes for Java/Kotlin, C#, PHP, Ruby, Rust ────────────────

  private indexScopes(): void {
    const push = <K>(map: Map<K, number[]>, key: K, id: number): void => {
      const list = map.get(key);
      if (!list) map.set(key, [id]); else if (!list.includes(id)) list.push(id);
    };
    this.files.forEach((f, id) => {
      const p = f.parsed;
      if (!p) return;
      if ((p.lang === 'java' || p.lang === 'kotlin') && p.pkg !== undefined) {
        push(this.pkgFiles, p.pkg, id);
        for (const e of p.exports) push(this.fqn, `${p.pkg}.${e.name}`, id);
      } else if (p.lang === 'cs') {
        for (const ns of p.namespaces ?? ['']) {
          const types = this.nsTypes.get(ns) ?? new Map<string, number[]>();
          this.nsTypes.set(ns, types);
          for (const e of p.exports) push(types, e.name, id);
        }
      } else if (p.lang === 'php') {
        for (const e of p.exports) push(this.fqn, p.pkg ? `${p.pkg}\\${e.name}` : e.name, id);
        if (p.pkg !== undefined) push(this.pkgFiles, `php:${p.pkg}`, id);
      } else if (p.lang === 'rb') {
        for (const e of p.exports) if (e.kind === 'class' || e.kind === 'module') push(this.globalDecl, e.name, id);
      } else if (p.lang === 'rs') {
        const crate = this.rustCrates.find(c => f.path === c.src || f.path.startsWith(`${c.src}/`));
        if (crate) this.rustModules.set(`${crate.name}::${rustModPath(f.path, crate.src)}`, id);
      }
    });
  }

  resolveJvm(spec: string, kind: RawImport['kind']): number[] {
    if (kind === 'wildcard') return this.pkgFiles.get(spec) ?? [];
    let s = spec;
    for (let k = 0; k < 3 && s.includes('.'); k++) {
      const hit = this.fqn.get(s);
      if (hit) return hit;
      s = s.slice(0, s.lastIndexOf('.'));
    }
    return [];
  }

  jvmPackage(pkg: string): number[] {
    return this.pkgFiles.get(pkg) ?? [];
  }

  csTypes(ns: string): Map<string, number[]> | undefined {
    return this.nsTypes.get(ns);
  }

  csNamespaces(): Iterable<string> {
    return this.nsTypes.keys();
  }

  resolvePhp(spec: string): number | undefined {
    const fq = spec.replace(/^\\/, '');
    const hit = this.fqn.get(fq);
    if (hit?.length === 1) return hit[0];
    for (const map of this.psr4) {
      if (fq !== map.prefix && !fq.startsWith(`${map.prefix}\\`)) continue;
      const rest = fq.slice(map.prefix.length + 1).split('\\').join('/');
      for (const d of map.dirs) {
        const t = this.lookup(`${d ? `${d}/` : ''}${rest}.php`);
        if (t !== undefined) return t;
      }
    }
    return undefined;
  }

  phpNamespaceFiles(ns: string): number[] {
    return this.pkgFiles.get(`php:${ns}`) ?? [];
  }

  resolveRubyRequire(from: string, spec: string, relative: boolean): number | undefined {
    const withExt = spec.endsWith('.rb') ? spec : `${spec}.rb`;
    if (relative) return this.lookup(joinRel(dirOf(from), withExt));
    return this.lookup(`lib/${withExt}`) ?? this.lookup(withExt) ?? this.lookup(joinRel(dirOf(from), withExt));
  }

  uniqueGlobal(name: string): number | undefined {
    const list = this.globalDecl.get(name);
    return list && list.length === 1 ? list[0] : undefined;
  }

  /** Rust: `mod x;` in `from` → the file. */
  resolveRustMod(from: string, name: string): number | undefined {
    const base = baseOf(from);
    const dir = ['mod.rs', 'lib.rs', 'main.rs'].includes(base) ? dirOf(from) : joinRel(dirOf(from), stemOf(from)) ?? '';
    return this.lookup(`${dir}/${name}.rs`) ?? this.lookup(`${dir}/${name}/mod.rs`);
  }

  /** Rust `use` path → the module file it names and the item name left over. */
  resolveRustUse(from: string, spec: string): { target?: number; item?: string; external?: string } {
    const crate = this.rustCrates.find(c => from === c.src || from.startsWith(`${c.src}/`));
    const segs = spec.split('::');
    let modPath: string[];
    let crateName: string | undefined;
    if (segs[0] === 'crate' && crate) { crateName = crate.name; modPath = segs.slice(1); }
    else if ((segs[0] === 'self' || segs[0] === 'super') && crate) {
      const here = rustModPath(from, crate.src).split('::').filter(Boolean);
      let k = 0;
      const cur = [...here];
      while (segs[k] === 'super') { cur.pop(); k++; }
      if (segs[k] === 'self') k++;
      crateName = crate.name;
      modPath = [...cur, ...segs.slice(k)];
    } else {
      const other = this.rustCrates.find(c => c.name === segs[0]);
      if (!other) return ['std', 'core', 'alloc'].includes(segs[0]!) ? {} : { external: segs[0]! };
      crateName = other.name;
      modPath = segs.slice(1);
    }
    for (let k = modPath.length; k >= 0; k--) {
      const hit = this.rustModules.get(`${crateName}::${modPath.slice(0, k).join('::')}`);
      if (hit !== undefined) {
        const item = modPath[k];
        return { target: hit, ...(item && item !== '*' ? { item } : {}) };
      }
    }
    return {};
  }

  // ── Origins: following a name through re-exports ───────────────────────

  /** Where `name`, as exported by file `id`, is declared. */
  originOf(id: number, name: string, depth = 0): Origin | undefined {
    const memoKey = `${id}:${name}`;
    const held = this.originMemo.get(memoKey);
    if (held !== undefined) return held ?? undefined;
    if (depth > 16) return undefined;
    this.originMemo.set(memoKey, null);
    const found = this.computeOrigin(id, name, depth);
    this.originMemo.set(memoKey, found ?? null);
    return found;
  }

  private computeOrigin(id: number, name: string, depth: number): Origin | undefined {
    const p = this.parsed(id);
    if (!p) return undefined;
    const from = this.files[id]!.path;
    if (p.lang === 'ts' || p.lang === 'js') {
      // export { local as name } / export default local
      const alias = p.localExports?.find(b => b.local === name);
      if (alias) {
        const viaImport = this.importBinding(p, alias.imported);
        if (viaImport) {
          const t = this.resolveJs(from, viaImport.imp.spec).target;
          if (t !== undefined) {
            if (viaImport.binding.imported === '*') return { file: t, name: '*' };
            return this.originOf(t, viaImport.binding.imported, depth + 1) ?? { file: t, name: viaImport.binding.imported };
          }
        }
        // A local declaration exported under another name: keyed by the exported name, as callers see it.
        if (p.exports.some(e => e.name === name)) return { file: id, name };
      }
      const decl = p.exports.find(e => e.name === name && e.kind !== 'alias');
      if (decl) return { file: id, name };
      for (const imp of p.imports) {
        if (!imp.reexport || imp.reexport === 'all') continue;
        const b = imp.reexport.find(r => r.local === name);
        if (!b) continue;
        const t = this.resolveJs(from, imp.spec).target;
        if (t === undefined) return undefined;
        if (b.imported === '*') return { file: t, name: '*' };
        return this.originOf(t, b.imported, depth + 1) ?? { file: t, name: b.imported };
      }
      if (name !== 'default') {
        for (const imp of p.imports) {
          if (imp.reexport !== 'all') continue;
          const t = this.resolveJs(from, imp.spec).target;
          if (t === undefined) continue;
          const o = this.originOf(t, name, depth + 1);
          if (o) return o;
        }
      }
      return undefined;
    }
    if (p.lang === 'py') {
      if (p.exports.some(e => e.name === name)) return { file: id, name };
      for (const imp of p.imports) {
        const b = imp.names?.find(n => n.local === name);
        if (!b) continue;
        const t = this.resolvePy(from, imp.spec, imp.level ?? 0).target;
        if (t === undefined) return undefined;
        const sub = this.pySubmodule(t, b.imported);
        if (sub !== undefined) return { file: sub, name: '*' };
        return this.originOf(t, b.imported, depth + 1) ?? { file: t, name: b.imported };
      }
      const sub = this.pySubmodule(id, name);
      if (sub !== undefined) return { file: sub, name: '*' };
      for (const imp of p.imports) {
        if (imp.reexport !== 'all') continue;
        const t = this.resolvePy(from, imp.spec, imp.level ?? 0).target;
        if (t === undefined) continue;
        const o = this.originOf(t, name, depth + 1);
        if (o) return o;
      }
      return undefined;
    }
    if (p.exports.some(e => e.name === name)) return { file: id, name };
    return undefined;
  }

  private importBinding(p: ParsedFile, local: string): { imp: RawImport; binding: ImportBinding } | undefined {
    for (const imp of p.imports) {
      if (imp.reexport) continue;
      const b = imp.names?.find(n => n.local === local);
      if (b) return { imp, binding: b };
      if (imp.ns === local) return { imp, binding: { imported: '*', local } };
    }
    return undefined;
  }
}

/** A Rust file's module path inside its crate's `src/`: `src/a/b.rs` → `a::b`, `src/a/mod.rs` → `a`. */
function rustModPath(file: string, src: string): string {
  const rel = file.slice(src.length + 1).replace(/\.rs$/, '');
  if (rel === 'lib' || rel === 'main') return '';
  const parts = rel.split('/');
  if (parts[parts.length - 1] === 'mod') parts.pop();
  if (parts[0] === 'bin') return parts.slice(1).join('::');
  return parts.join('::');
}

// ── Building the edges ──────────────────────────────────────────────────────

const KIND_RANK: Record<EdgeKind, number> = { import: 5, reexport: 4, package: 3, inferred: 2, dynamic: 1 };
const BARREL = /^(index\.[cm]?[jt]sx?|__init__\.py|mod\.rs)$/;

class EdgeSet {
  private readonly map = new Map<string, FileEdge & { passCount: number; total: number }>();
  add(from: number, to: number, kind: EdgeKind, names: string[], opts: { passThrough?: boolean; confidence?: 'resolved' | 'inferred' } = {}): void {
    if (from === to) return;
    const key = `${from}>${to}`;
    let e = this.map.get(key);
    if (!e) {
      e = { from, to, kind, names: [], confidence: opts.confidence ?? 'resolved', passCount: 0, total: 0 };
      this.map.set(key, e);
    }
    if (KIND_RANK[kind] > KIND_RANK[e.kind]) e.kind = kind;
    if ((opts.confidence ?? 'resolved') === 'resolved') e.confidence = 'resolved';
    for (const n of names) if (!e.names.includes(n) && e.names.length < 40) e.names.push(n);
    e.total++;
    if (opts.passThrough) e.passCount++;
  }
  list(): FileEdge[] {
    return [...this.map.values()].map(({ passCount, total, ...e }) => (passCount > 0 && passCount === total ? { ...e, passThrough: true } : e));
  }
}

/** Resolve every file's imports into edges, symbol references and external usage. */
export function resolveAll(resolver: Resolver): Resolution {
  const edges = new EdgeSet();
  const symbols = new Map<string, SymbolRef[]>();
  const external = new Map<string, number[]>();
  const unresolved: Array<{ file: number; spec: string }> = [];
  const files = resolver.files;

  const addRef = (o: Origin, ref: SymbolRef): void => {
    if (o.file === ref.file) return;
    const key = `${o.file}:${o.name}`;
    const list = symbols.get(key);
    if (!list) { symbols.set(key, [ref]); return; }
    const same = list.find(r => r.file === ref.file);
    if (same) {
      for (const l of ref.lines) if (!same.lines.includes(l) && same.lines.length < 5) same.lines.push(l);
      if (same.via === 'reexport' && ref.via !== 'reexport') { same.via = ref.via; same.local = ref.local; }
    } else list.push(ref);
  };
  const addExternal = (pkg: string, id: number): void => {
    const list = external.get(pkg);
    if (!list) external.set(pkg, [id]); else if (list[list.length - 1] !== id) list.push(id);
  };
  const noteUnresolved = (id: number, spec: string): void => { if (unresolved.length < 500) unresolved.push({ file: id, spec }); };
  const dangling = new Map<string, SymbolRef[]>();
  const addDangling = (file: number, name: string, ref: SymbolRef): void => {
    const key = `${file}:${name}`;
    const list = dangling.get(key);
    if (!list) dangling.set(key, [ref]); else if (!list.some(r => r.file === ref.file)) list.push(ref);
  };

  files.forEach((f, id) => {
    const p = f.parsed;
    if (!p) return;
    const barrel = BARREL.test(baseOf(f.path));
    const usedLines = (local: string): number[] => {
      const direct = p.uses[local] ?? [];
      const viaMembers = Object.values(p.members[local] ?? {}).flat();
      return [...new Set([...direct, ...viaMembers])].sort((a, b) => a - b).slice(0, 5);
    };
    switch (p.lang) {
      case 'ts':
      case 'js':
      case 'py':
        resolveModuleFile(resolver, id, f.path, p, { edges, addRef, addDangling, addExternal, noteUnresolved, usedLines, barrel });
        break;
      case 'go':
        resolveGoFile(resolver, id, p, { edges, addRef, addExternal });
        break;
      case 'java':
      case 'kotlin':
        resolveJvmFile(resolver, id, p, { edges, addRef });
        break;
      case 'cs':
        resolveCsFile(resolver, id, p, { edges, addRef, addExternal });
        break;
      case 'php':
        resolvePhpFile(resolver, id, f.path, p, { edges, addRef });
        break;
      case 'rb':
        resolveRubyFile(resolver, id, f.path, p, { edges, addRef });
        break;
      case 'rs':
        resolveRustFile(resolver, id, f.path, p, { edges, addRef, addExternal });
        break;
    }
  });

  resolveGoImplementations(resolver, edges, addRef);
  return { edges: edges.list(), symbols, external, unresolved, dangling };
}

/** Method names too generic to say which type satisfies a one-method interface. */
const GENERIC_METHODS = new Set(['String', 'Error', 'Close', 'Read', 'Write', 'ServeHTTP', 'Len', 'Less', 'Swap', 'Next', 'Reset', 'Get', 'Set', 'Run', 'Start', 'Stop', 'Do', 'Handle']);

/**
 * Go satisfies interfaces structurally, so "the handler calls the service"
 * goes through an interface no import names. An interface is linked to the
 * types whose method sets contain all of its methods — when that is a short,
 * specific list (at most six types; a one-method interface only when the
 * method name is not a generic one like `Close`). Labelled `inferred`.
 */
function resolveGoImplementations(r: Resolver, edges: EdgeSet, addRef: (o: Origin, ref: SymbolRef) => void): void {
  const types = new Map<string, { file: number; type: string; methods: Map<string, string> }>();
  r.files.forEach((f, id) => {
    if (f.parsed?.lang !== 'go') return;
    for (const e of f.parsed.exports) {
      if (e.kind !== 'method') continue;
      const [type, method] = e.name.split('.');
      const key = `${dirOf(f.path)}:${type}`;
      const t = types.get(key) ?? { file: id, type: type!, methods: new Map<string, string>() };
      const after = e.sig.indexOf(`${method}(`);
      t.methods.set(method!, after >= 0 ? goTypeKey(e.sig.slice(after + method!.length)) : '');
      // Methods may be spread over files; the type's declaring file wins when it is known.
      if (f.parsed.exports.some(x => x.name === type && x.kind === 'type')) t.file = id;
      types.set(key, t);
    }
  });
  if (types.size === 0) return;
  r.files.forEach((f, id) => {
    const ifaces = f.parsed?.ifaces;
    if (!ifaces) return;
    for (const [iface, entries] of Object.entries(ifaces)) {
      const methods = entries.map(e => { const [name, key] = e.split('|'); return { name: name!, key: key ?? '' }; });
      if (methods.length === 1 && GENERIC_METHODS.has(methods[0]!.name)) continue;
      // A test double (`memStore` in a _test file) is not where production calls go.
      const ifaceInTest = isTestPath(f.path);
      let impls = [...types.values()].filter(t => t.file !== id && (ifaceInTest || !isTestPath(r.files[t.file]!.path)) && methods.every(m => t.methods.has(m.name)));
      // Several types share the method names (every store has Insert): keep those whose
      // signatures name the same types, if that narrows it.
      if (impls.length > 1) {
        const exact = impls.filter(t => methods.every(m => t.methods.get(m.name) === m.key));
        if (exact.length > 0) impls = exact;
      }
      if (impls.length === 0 || impls.length > 6) continue;
      for (const impl of impls) {
        addRef({ file: impl.file, name: impl.type }, { file: id, local: iface, lines: [], via: 'inferred' });
        edges.add(id, impl.file, 'inferred', [impl.type], { confidence: 'inferred' });
      }
    }
  });
}

interface Sinks {
  edges: EdgeSet;
  addRef: (o: Origin, ref: SymbolRef) => void;
  addDangling: (file: number, name: string, ref: SymbolRef) => void;
  addExternal?: (pkg: string, id: number) => void;
  noteUnresolved?: (id: number, spec: string) => void;
  usedLines?: (local: string) => number[];
  barrel?: boolean;
}

function resolveModuleFile(r: Resolver, id: number, path: string, p: ParsedFile, s: Required<Sinks>): void {
  const isPy = p.lang === 'py';
  for (const imp of p.imports) {
    const res = isPy ? r.resolvePy(path, imp.spec, imp.level ?? 0) : r.resolveJs(path, imp.spec);
    if (res.external) { s.addExternal(res.external, id); continue; }
    if (res.target === undefined) { if (res.local) s.noteUnresolved(id, imp.spec); continue; }
    const t = res.target;
    const kind: EdgeKind = imp.reexport ? 'reexport' : imp.kind === 'dynamic' ? 'dynamic' : 'import';
    let anyInTarget = false;
    let anyBinding = false;

    const link = (origin: Origin | undefined, local: string, lines: number[], via: SymbolRef['via'], fallbackName: string): void => {
      anyBinding = true;
      if (origin && origin.name !== '*') {
        s.addRef(origin, { file: id, local, lines, via });
        s.edges.add(id, origin.file, kind, [origin.name]);
        if (origin.file === t) anyInTarget = true;
      } else if (origin && origin.name === '*') {
        // A namespace (a module object): its member uses are the symbols.
        const members = p.members[local] ?? {};
        let any = false;
        for (const [member, mLines] of Object.entries(members)) {
          const o = r.originOf(origin.file, member);
          if (!o) { s.addDangling(origin.file, member, { file: id, local: `${local}.${member}`, lines: mLines, via: 'namespace' }); continue; }
          if (o.name === '*') continue;
          any = true;
          s.addRef(o, { file: id, local: `${local}.${member}`, lines: mLines, via: 'namespace' });
          s.edges.add(id, o.file, kind, [o.name]);
          if (o.file === t) anyInTarget = true;
        }
        if (!any) { s.edges.add(id, origin.file, kind, []); if (origin.file === t) anyInTarget = true; }
      } else {
        // The module exists but does not export this name (any more): remembered, so a
        // removed or renamed symbol's users can still be named (codegraph/edit-note).
        if (fallbackName !== 'default') s.addDangling(t, fallbackName, { file: id, local, lines, via });
        s.edges.add(id, t, kind, [fallbackName]);
        anyInTarget = true;
      }
    };

    if (imp.reexport === 'all') {
      s.edges.add(id, t, 'reexport', []);
      continue;
    }
    if (Array.isArray(imp.reexport)) {
      for (const b of imp.reexport) {
        const o = b.imported === '*' ? { file: t, name: '*' } : r.originOf(t, b.imported);
        if (o && o.name !== '*') {
          s.addRef(o, { file: id, local: b.local, lines: [], via: 'reexport' });
          s.edges.add(id, o.file, 'reexport', [o.name]);
        } else {
          if (!o && b.imported !== 'default') s.addDangling(t, b.imported, { file: id, local: b.local, lines: [], via: 'reexport' });
          s.edges.add(id, t, 'reexport', [b.imported]);
        }
      }
      continue;
    }
    for (const b of imp.names ?? []) {
      const lines = s.usedLines(b.local);
      const unused = lines.length === 0;
      const via: SymbolRef['via'] = unused && s.barrel ? 'reexport' : 'import';
      let origin: Origin | undefined;
      if (isPy) {
        const sub = r.pySubmodule(t, b.imported);
        origin = sub !== undefined ? { file: sub, name: '*' } : r.originOf(t, b.imported);
      } else {
        origin = r.originOf(t, b.imported);
      }
      link(origin, b.local, lines, via, b.imported);
    }
    if (imp.ns) {
      // Python `import a.b.c` binds the dotted name; JS/TS `* as ns`, `require` binds a module object.
      link({ file: t, name: '*' }, imp.ns, s.usedLines(imp.ns), 'namespace', '*');
    }
    if (!anyBinding) s.edges.add(id, t, kind, []);
    else if (!anyInTarget) s.edges.add(id, t, kind, [], { passThrough: true });
  }
}

function resolveGoFile(r: Resolver, id: number, p: ParsedFile, s: Pick<Sinks, 'edges' | 'addRef' | 'addExternal'>): void {
  const self = r.files[id]!.path;
  for (const imp of p.imports) {
    const res = r.resolveGo(imp.spec);
    if (res.external) { s.addExternal?.(res.external, id); continue; }
    if (!res.targets?.length) continue;
    const clause = r.parsed(res.targets[0]!)?.pkg ?? imp.spec.split('/').pop()!;
    const local = imp.ns ?? clause;
    const decls = new Map<string, number>();
    for (const t of res.targets) for (const e of r.parsed(t)?.exports ?? []) if (!e.internal && !e.name.includes('.')) decls.set(e.name, t);
    let any = false;
    const used = imp.kind === 'wildcard'
      ? Object.fromEntries((p.refs ?? []).filter(n => decls.has(n)).map(n => [n, [] as number[]]))
      : p.members[local] ?? {};
    for (const [member, lines] of Object.entries(used)) {
      const t = decls.get(member);
      if (t === undefined) continue;
      any = true;
      s.addRef({ file: t, name: member }, { file: id, local: imp.kind === 'wildcard' ? member : `${local}.${member}`, lines, via: 'import' });
      s.edges.add(id, t, 'import', [member]);
    }
    if (!any) {
      const primary = res.targets.find(t => stemOf(r.files[t]!.path) === clause) ?? res.targets[0]!;
      s.edges.add(id, primary, 'import', []);
    }
  }
  // Same package: other files in this directory with the same clause share a scope.
  if (!p.pkg) return;
  const sameDir = r.filesInDir(dirOf(self)).filter(t => t !== id && r.parsed(t)?.lang === 'go' && r.parsed(t)?.pkg === p.pkg);
  if (!sameDir.length) return;
  const decls = new Map<string, number>();
  for (const t of sameDir) {
    for (const e of r.parsed(t)?.exports ?? []) {
      if (e.name.includes('.') || e.name === 'init' || e.name === '_') continue;
      decls.set(e.name, decls.has(e.name) ? -1 : t);
    }
  }
  const own = new Set((p.exports ?? []).map(e => e.name));
  for (const ref of p.refs ?? []) {
    const t = decls.get(ref);
    if (t === undefined || t < 0 || own.has(ref)) continue;
    s.addRef({ file: t, name: ref }, { file: id, local: ref, lines: [], via: 'package' });
    s.edges.add(id, t, 'package', [ref]);
  }
}

function resolveJvmFile(r: Resolver, id: number, p: ParsedFile, s: Pick<Sinks, 'edges' | 'addRef'>): void {
  const refs = new Set(p.refs ?? []);
  const linked = new Set<string>();
  for (const imp of p.imports) {
    const targets = r.resolveJvm(imp.spec, imp.kind);
    if (!targets.length) continue;
    if (imp.kind === 'wildcard') {
      for (const t of targets) {
        for (const e of r.parsed(t)?.exports ?? []) {
          if (!refs.has(e.name) || linked.has(e.name)) continue;
          linked.add(e.name);
          s.addRef({ file: t, name: e.name }, { file: id, local: e.name, lines: [], via: 'import' });
          s.edges.add(id, t, 'import', [e.name]);
        }
      }
      continue;
    }
    const name = imp.kind === 'static-member' ? imp.spec.split('.').slice(-2, -1)[0]! : imp.spec.split('.').pop()!;
    const t = targets[0]!;
    const declared = r.parsed(t)?.exports.find(e => e.name === name)?.name ?? name;
    linked.add(imp.names?.[0]?.local ?? declared);
    s.addRef({ file: t, name: declared }, { file: id, local: imp.names?.[0]?.local ?? declared, lines: [], via: 'import' });
    s.edges.add(id, t, 'import', [declared]);
  }
  if (p.pkg === undefined) return;
  // Same package: visible without an import, and a package cannot declare a name twice.
  const own = new Set(p.exports.map(e => e.name));
  for (const t of r.jvmPackage(p.pkg)) {
    if (t === id) continue;
    for (const e of r.parsed(t)?.exports ?? []) {
      if (!refs.has(e.name) || own.has(e.name) || linked.has(e.name)) continue;
      s.addRef({ file: t, name: e.name }, { file: id, local: e.name, lines: [], via: 'package' });
      s.edges.add(id, t, 'package', [e.name]);
    }
  }
}

function resolveCsFile(r: Resolver, id: number, p: ParsedFile, s: Pick<Sinks, 'edges' | 'addRef' | 'addExternal'>): void {
  const visible = new Set<string>();
  for (const ns of p.namespaces ?? ['']) {
    const parts = ns.split('.');
    for (let k = parts.length; k >= 0; k--) visible.add(parts.slice(0, k).join('.'));
  }
  for (const imp of p.imports) {
    if (r.csTypes(imp.spec)) visible.add(imp.spec);
    else if (imp.kind === 'static' && imp.names?.length) {
      // using Alias = Some.Type;
      const ns = imp.spec.slice(0, imp.spec.lastIndexOf('.'));
      const t = r.csTypes(ns)?.get(imp.spec.split('.').pop()!);
      if (t?.length === 1) { s.addRef({ file: t[0]!, name: imp.spec.split('.').pop()! }, { file: id, local: imp.names[0]!.local, lines: [], via: 'import' }); s.edges.add(id, t[0]!, 'import', [imp.spec.split('.').pop()!]); }
    } else if (!/^System(\.|$)/.test(imp.spec)) {
      const root = imp.spec.split('.')[0]!;
      if (![...r.csNamespaces()].some(n => n.split('.')[0] === root)) s.addExternal?.(imp.spec.split('.').slice(0, root === 'Microsoft' ? 2 : 1).join('.'), id);
    }
  }
  const own = new Set(p.exports.map(e => e.name));
  for (const ref of p.refs ?? []) {
    if (own.has(ref)) continue;
    const candidates = new Set<number>();
    for (const ns of visible) for (const t of r.csTypes(ns)?.get(ref) ?? []) if (t !== id) candidates.add(t);
    if (candidates.size !== 1) continue;
    const t = [...candidates][0]!;
    s.addRef({ file: t, name: ref }, { file: id, local: ref, lines: [], via: 'package' });
    s.edges.add(id, t, 'package', [ref]);
  }
}

function resolvePhpFile(r: Resolver, id: number, path: string, p: ParsedFile, s: Pick<Sinks, 'edges' | 'addRef'>): void {
  const imported = new Set<string>();
  for (const imp of p.imports) {
    if (imp.kind === 'include') {
      const t = r.lookup(joinRel(dirOf(path), imp.spec.replace(/^\//, ''))) ?? r.lookup(normRel(imp.spec));
      if (t !== undefined) s.edges.add(id, t, 'import', []);
      continue;
    }
    const t = r.resolvePhp(imp.spec);
    if (t === undefined) continue;
    const name = imp.spec.split('\\').pop()!;
    imported.add(imp.names?.[0]?.local ?? name);
    s.addRef({ file: t, name }, { file: id, local: imp.names?.[0]?.local ?? name, lines: [], via: 'import' });
    s.edges.add(id, t, 'import', [name]);
  }
  const own = new Set(p.exports.map(e => e.name));
  for (const ref of p.refs ?? []) {
    if (ref.includes('\\')) {
      const t = r.resolvePhp(ref);
      if (t !== undefined && t !== id) { const n = ref.split('\\').pop()!; s.addRef({ file: t, name: n }, { file: id, local: ref, lines: [], via: 'import' }); s.edges.add(id, t, 'import', [n]); }
      continue;
    }
    if (own.has(ref) || imported.has(ref) || p.pkg === undefined) continue;
    const t = r.resolvePhp(`${p.pkg}\\${ref}`);
    if (t !== undefined && t !== id) {
      s.addRef({ file: t, name: ref }, { file: id, local: ref, lines: [], via: 'package' });
      s.edges.add(id, t, 'package', [ref]);
    }
  }
}

function resolveRubyFile(r: Resolver, id: number, path: string, p: ParsedFile, s: Pick<Sinks, 'edges' | 'addRef'>): void {
  for (const imp of p.imports) {
    const t = r.resolveRubyRequire(path, imp.spec, imp.kind === 'include');
    if (t !== undefined) s.edges.add(id, t, 'import', []);
  }
  const own = new Set(p.exports.map(e => e.name));
  for (const ref of p.refs ?? []) {
    if (own.has(ref)) continue;
    const t = r.uniqueGlobal(ref);
    if (t === undefined || t === id) continue;
    s.addRef({ file: t, name: ref }, { file: id, local: ref, lines: [], via: 'inferred' });
    s.edges.add(id, t, 'inferred', [ref], { confidence: 'inferred' });
  }
}

function resolveRustFile(r: Resolver, id: number, path: string, p: ParsedFile, s: Pick<Sinks, 'edges' | 'addRef' | 'addExternal'>): void {
  for (const imp of p.imports) {
    if (imp.spec.startsWith('mod:')) {
      const t = r.resolveRustMod(path, imp.spec.slice(4));
      if (t !== undefined) s.edges.add(id, t, 'import', []);
      continue;
    }
    const res = r.resolveRustUse(path, imp.spec);
    if (res.external) { s.addExternal?.(res.external, id); continue; }
    if (res.target === undefined) continue;
    const item = res.item;
    const declared = item && r.parsed(res.target)?.exports.some(e => e.name === item) ? item : undefined;
    if (declared) s.addRef({ file: res.target, name: declared }, { file: id, local: imp.names?.[0]?.local ?? declared, lines: [], via: 'import' });
    s.edges.add(id, res.target, 'import', declared ? [declared] : []);
  }
}

export type { Lang };
