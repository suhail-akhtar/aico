/**
 * TS/JS method calls resolved by the TypeScript type checker: exact where the
 * lexical rules (parse/members) can only follow what the text states.
 *
 * ## Why the checker, and why in a worker
 *
 * For TypeScript the compiler already knows what `obj.method()` calls —
 * through inferred types, generics, `this.x.y`, union members, imported
 * types, declaration merging — and it knows which classes satisfy an
 * interface structurally, which no name rule can. So when `typescript` is
 * loadable (the project's own copy first, then AICO's — ADR 0013), its
 * answers replace the lexical ones for TS/JS files.
 *
 * It is not cheap: measured on this repository (1,420 files, 300k lines) a
 * program took ~12 s and ~1.7 GB to build and ~15 s to walk; a 110-file app
 * took 0.6 s and ~95 MB. So it runs in a worker thread (the engine stays
 * responsive; the memory is returned when the worker exits), with a heap
 * ceiling, a deadline, and size caps above which the lexical rules stand and
 * the graph says why. The graph is built first without it and rebuilt when it
 * finishes; a client polling the version sees the update.
 *
 * Module resolution is limited to the project's own files: an import of a
 * package from `node_modules` is left unresolved (its types become `any`), so
 * the checker never loads dependency type trees it does not need for calls
 * into the project.
 *
 * ## What the worker reports
 *
 * Per file: each call whose method name some project type declares, the
 * declaration(s) the checker resolved it to (`Class.method`), and — for a
 * method declared on an interface or as abstract — the implementations'
 * methods, labelled as through an interface. `known` lists every call the
 * checker had an answer for, project or not, so a lexical guess about a
 * call the checker attributes to a library is dropped. Implementations:
 * declared (`implements`, `extends` of an abstract class) and structural
 * (`isTypeAssignableTo`, when the TypeScript version exposes it).
 *
 * The worker's code is a self-contained function sent as source
 * (`toString()`), so it runs the same from the CLI bundle, the desktop
 * engine and the test build; it reaches `require` through `globalThis`,
 * which bundlers leave alone.
 *
 * @module codegraph/ts-check
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Above these the checker is not run; the lexical rules stand (and the graph says so). */
export const TS_CHECK_MAX_FILES = 2_500;
export const TS_CHECK_MAX_BYTES = 6_000_000;
const TIMEOUT_MS = 120_000;
const HEAP_MB = 2_048;

/** `[line, target file (project-relative), symbol, via: 0 call / 1 interface]` */
export type TsCall = [number, string, string, 0 | 1];
export interface TsFileResult { calls: TsCall[]; known: string[] }
export interface TsImpl { iface: [string, string]; impl: [string, string]; methods: Array<[string, string, number]>; how: 0 | 1 }
export type TsCheckResult =
  | { ok: true; files: Record<string, TsFileResult>; impls: TsImpl[]; ms: number; groups: number }
  | { ok: false; reason: string };

/** Where `typescript` can be loaded from: the project's own, then AICO's. */
export function typescriptPath(root: string): string | undefined {
  for (const base of [path.join(root, 'package.json'), import.meta.url]) {
    try { return createRequire(base).resolve('typescript'); } catch { /* not there: the next one */ }
  }
  return undefined;
}

/** Run the checker over `files` (project-relative TS/JS paths). Never throws. */
export function runTsCheck(root: string, files: string[], timeoutMs = TIMEOUT_MS): Promise<TsCheckResult> {
  if (process.env.AICO_CODEGRAPH_TYPECHECK === 'off') return Promise.resolve({ ok: false, reason: 'switched off (AICO_CODEGRAPH_TYPECHECK=off)' });
  const tsPath = typescriptPath(root);
  if (!tsPath) return Promise.resolve({ ok: false, reason: '`typescript` is installed neither in the project nor with AICO' });
  return new Promise(resolve => {
    let done = false;
    const finish = (r: TsCheckResult): void => { if (done) return; done = true; clearTimeout(timer); void worker.terminate().catch(() => undefined); resolve(r); };
    const worker = new Worker(`(${tsCheckWorker.toString()})()`, {
      eval: true,
      workerData: { root, files, tsPath },
      resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => finish({ ok: false, reason: `the type checker took longer than ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    timer.unref?.();
    worker.on('message', (m: TsCheckResult) => finish(m));
    worker.on('error', (err: Error) => finish({ ok: false, reason: /heap|memory/i.test(err.message) ? 'the type checker ran out of memory' : `the type checker failed: ${err.message.slice(0, 200)}` }));
    worker.on('exit', code => finish({ ok: false, reason: `the type checker exited (${code})` }));
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The worker. Self-contained: no closure over this module, no imports — it
 * is sent as source. Types are `any` because `typescript` is loaded at run
 * time from wherever it was found.
 */
function tsCheckWorker(): void {
  const req = (globalThis as any).require as (id: string) => any;
  const { parentPort, workerData } = req('node:worker_threads');
  const nodePath = req('node:path');
  const fs = req('node:fs');
  const started = Date.now();
  try {
    const ts = req(workerData.tsPath as string);
    const root: string = workerData.root;
    const rels: string[] = workerData.files;
    const caseless = process.platform === 'win32' || process.platform === 'darwin';
    const fwd = (f: string): string => nodePath.resolve(f).split(nodePath.sep).join('/');
    const key = (f: string): string => (caseless ? fwd(f).toLowerCase() : fwd(f));
    const relOf = new Map<string, string>();
    for (const r of rels) relOf.set(key(nodePath.join(root, r)), r);
    const relFor = (fileName: string): string | undefined => relOf.get(key(fileName));

    // One program per nearest tsconfig/jsconfig: each package's own paths and options.
    const cfgMemo = new Map<string, string>();
    const nearestConfig = (rel: string): string => {
      let dir = nodePath.dirname(nodePath.join(root, rel));
      const walked: string[] = [];
      for (;;) {
        const held = cfgMemo.get(dir);
        if (held !== undefined) { for (const w of walked) cfgMemo.set(w, held); return held; }
        walked.push(dir);
        for (const n of ['tsconfig.json', 'jsconfig.json']) {
          const c = nodePath.join(dir, n);
          if (fs.existsSync(c)) { for (const w of walked) cfgMemo.set(w, c); return c; }
        }
        const up = nodePath.dirname(dir);
        if (up === dir || !key(up).startsWith(key(root)) || key(dir) === key(root)) break;
        dir = up;
      }
      for (const w of walked) cfgMemo.set(w, '');
      return '';
    };
    const groups = new Map<string, string[]>();
    for (const r of rels) { const c = nearestConfig(r); const l = groups.get(c) ?? []; l.push(r); groups.set(c, l); }

    const files: Record<string, { calls: Array<[number, string, string, 0 | 1]>; known: string[] }> = {};
    const impls: Array<{ iface: [string, string]; impl: [string, string]; methods: Array<[string, string, number]>; how: 0 | 1 }> = [];
    const implSeen = new Set<string>();

    for (const [cfg, groupRels] of groups) {
      let options: any = {};
      if (cfg) {
        const raw = ts.readConfigFile(cfg, ts.sys.readFile);
        if (!raw.error) options = ts.parseJsonConfigFileContent(raw.config, ts.sys, nodePath.dirname(cfg)).options;
      }
      options = {
        ...options,
        noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, types: [], declaration: false,
        sourceMap: false, incremental: false, composite: false, tsBuildInfoFile: undefined,
      };
      if (options.moduleResolution === undefined) { options.module ??= ts.ModuleKind.ESNext; options.moduleResolution = ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs; }
      if (options.target === undefined) options.target = ts.ScriptTarget.ES2022;
      if (options.jsx === undefined) options.jsx = ts.JsxEmit.Preserve;
      const host = ts.createCompilerHost(options, true);
      // The project's own files only: a dependency's types are not needed for calls into the project.
      host.resolveModuleNames = (names: string[], containing: string) => names.map((n: string) => {
        const r = ts.resolveModuleName(n, containing, options, host).resolvedModule;
        return r && !/[\\/]node_modules[\\/]/.test(r.resolvedFileName) ? r : undefined;
      });
      const program = ts.createProgram({ rootNames: groupRels.map(r => nodePath.join(root, r)), options, host });
      const checker = program.getTypeChecker();
      const sources = program.getSourceFiles().filter((sf: any) => relFor(sf.fileName) !== undefined);

      // Owners: classes, interfaces, object type aliases — named, in the project.
      const ownerOf = (decl: any): { name: string; node: any } | undefined => {
        const parent = decl.parent;
        if (!parent) return undefined;
        if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isInterfaceDeclaration(parent)) && parent.name) return { name: parent.name.text, node: parent };
        if (ts.isTypeLiteralNode(parent) && parent.parent && ts.isTypeAliasDeclaration(parent.parent)) return { name: parent.parent.name.text, node: parent.parent };
        return undefined;
      };
      const isMethodish = (d: any): boolean => ts.isMethodDeclaration(d) || ts.isMethodSignature(d)
        || ((ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) && d.initializer === undefined ? Boolean(d.type && (ts.isFunctionTypeNode(d.type))) : false)
        || (ts.isPropertyDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)));
      const isAbstract = (d: any): boolean => Boolean(ts.getCombinedModifierFlags?.(d) & ts.ModifierFlags.Abstract);
      const nameOf = (d: any): string | undefined => (d.name && (ts.isIdentifier(d.name) || ts.isPrivateIdentifier(d.name)) ? d.name.text : undefined);
      const lineOf = (node: any): number => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

      // Method names declared in the project: a call to any other name cannot reach the project.
      const projectMethods = new Set<string>();
      const classes: any[] = [];
      const ifaces: any[] = [];
      for (const sf of sources) {
        const visit = (n: any): void => {
          if (isMethodish(n) && ownerOf(n)) { const nm = nameOf(n); if (nm) projectMethods.add(nm); }
          if (ts.isClassDeclaration(n) && n.name) classes.push(n);
          if ((ts.isInterfaceDeclaration(n)) || (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type))) ifaces.push(n);
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }

      // Declared supertypes, resolved through aliases to their declarations.
      const declOfExpr = (expr: any): any => {
        let sym = checker.getSymbolAtLocation(expr);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        return sym?.declarations?.find((d: any) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d));
      };
      const supersOf = (n: any): any[] => {
        const out: any[] = [];
        for (const h of n.heritageClauses ?? []) for (const t of h.types) { const d = declOfExpr(t.expression); if (d && relFor(d.getSourceFile().fileName) !== undefined) out.push(d); }
        return out;
      };
      const ancestors = (n: any): any[] => {
        const out: any[] = [];
        const seen = new Set<any>([n]);
        const queue = [n];
        for (let i = 0; i < queue.length && out.length < 64; i++) for (const s of supersOf(queue[i])) if (!seen.has(s)) { seen.add(s); out.push(s); queue.push(s); }
        return out;
      };
      const membersOf = (decl: any): any[] => (ts.isTypeAliasDeclaration(decl) ? decl.type.members ?? [] : decl.members ?? []);
      const declName = (decl: any): string => decl.name.text;
      /** The concrete declaration of method `m` a class instance runs: own, else up the class chain. */
      const concreteMethod = (cls: any, m: string): any => {
        for (const c of [cls, ...ancestors(cls).filter((a: any) => ts.isClassDeclaration(a))]) {
          const hit = membersOf(c).find((x: any) => isMethodish(x) && nameOf(x) === m && !isAbstract(x) && (x.body || x.initializer));
          if (hit) return hit;
        }
        return undefined;
      };
      const implsOf = new Map<any, Array<{ cls: any; how: 0 | 1 }>>();
      const addImpl = (iface: any, cls: any, how: 0 | 1): void => {
        const list = implsOf.get(iface) ?? [];
        if (list.some(x => x.cls === cls)) return;
        list.push({ cls, how });
        implsOf.set(iface, list);
      };
      for (const c of classes) {
        for (const a of ancestors(c)) {
          const abstract = ts.isClassDeclaration(a) && membersOf(a).some((x: any) => isAbstract(x));
          if (!ts.isClassDeclaration(a) || abstract) addImpl(a, c, 0);
        }
      }
      // Structural: TypeScript does not need `implements` — a class whose instances are assignable is one.
      if (typeof checker.isTypeAssignableTo === 'function') {
        for (const i of ifaces) {
          const names = membersOf(i).filter((x: any) => isMethodish(x)).map(nameOf).filter(Boolean) as string[];
          if (!names.length) continue;
          const iType = checker.getTypeAtLocation(i.name);
          for (const c of classes) {
            if (implsOf.get(i)?.some(x => x.cls === c) || membersOf(c).some((x: any) => isAbstract(x))) continue;
            const has = new Set<string>();
            for (const k of [c, ...ancestors(c)]) for (const x of membersOf(k)) { const nm = nameOf(x); if (nm) has.add(nm); }
            if (!names.every(nm => has.has(nm))) continue;
            const sym = checker.getSymbolAtLocation(c.name);
            if (!sym) continue;
            const cType = checker.getDeclaredTypeOfSymbol(sym);
            try { if (checker.isTypeAssignableTo(cType, iType)) addImpl(i, c, 1); } catch { /* an internal checker failure on one pair: no claim */ }
          }
        }
      }
      for (const [iface, list] of implsOf) {
        const ifaceRel = relFor(iface.getSourceFile().fileName)!;
        const names = [...membersOf(iface), ...ancestors(iface).flatMap((a: any) => membersOf(a))].filter((x: any) => isMethodish(x) && (!ts.isClassDeclaration(x.parent) || isAbstract(x))).map(nameOf).filter(Boolean) as string[];
        for (const { cls, how } of list) {
          const k = `${ifaceRel}:${declName(iface)}>${relFor(cls.getSourceFile().fileName)}:${declName(cls)}`;
          if (implSeen.has(k)) continue;
          implSeen.add(k);
          const methods: Array<[string, string, number]> = [];
          for (const nm of [...new Set(names)]) {
            const m = concreteMethod(cls, nm);
            if (m) methods.push([nm, relFor(m.getSourceFile().fileName)!, lineOf(m)]);
          }
          impls.push({ iface: [ifaceRel, declName(iface)], impl: [relFor(cls.getSourceFile().fileName)!, declName(cls)], methods, how });
        }
      }

      // Calls.
      for (const sf of sources) {
        const rel = relFor(sf.fileName)!;
        const out = { calls: [] as Array<[number, string, string, 0 | 1]>, known: [] as string[] };
        const seen = new Set<string>();
        const push = (c: [number, string, string, 0 | 1]): void => { const k = c.join('|'); if (!seen.has(k)) { seen.add(k); out.calls.push(c); } };
        const visit = (n: any): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const nameNode = n.expression.name;
            const m: string = nameNode.text;
            if (projectMethods.has(m)) {
              let sym = checker.getSymbolAtLocation(nameNode);
              if (sym) {
                if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
                const line = lineOf(nameNode);
                out.known.push(`${line}:${m}`);
                const roots = typeof checker.getRootSymbols === 'function' ? checker.getRootSymbols(sym) : [sym];
                for (const root of roots) {
                  for (const d of root.declarations ?? []) {
                    if (!isMethodish(d)) continue;
                    const owner = ownerOf(d);
                    const target = relFor(d.getSourceFile().fileName);
                    if (!owner || target === undefined) continue;
                    push([line, target, `${owner.name}.${m}`, 0]);
                    const viaIface = ts.isInterfaceDeclaration(owner.node) || ts.isTypeAliasDeclaration(owner.node) || isAbstract(d);
                    if (!viaIface) continue;
                    const list = implsOf.get(owner.node) ?? [];
                    if (list.length > 12) continue;
                    for (const { cls } of list) {
                      const im = concreteMethod(cls, m);
                      const imOwner = im ? ownerOf(im) : undefined;
                      const imRel = im ? relFor(im.getSourceFile().fileName) : undefined;
                      if (im && imOwner && imRel !== undefined) push([line, imRel, `${imOwner.name}.${m}`, 1]);
                    }
                  }
                }
              }
            }
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        files[rel] = out;
      }
    }
    parentPort.postMessage({ ok: true, files, impls, ms: Date.now() - started, groups: groups.size });
  } catch (err) {
    parentPort.postMessage({ ok: false, reason: `the type checker failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
