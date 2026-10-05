/**
 * Exact TS/JS callers of one symbol, on demand, for projects too large for
 * the whole-project checker pass (codegraph/ts-check).
 *
 * ## Why
 *
 * Above 2,500 TS/JS files or 6 MB the checker pass is skipped: on this
 * repository (1,446 files, 16.5 MB) it cost ~27 s and ~1.7 GB, every time
 * anything changed. But the questions that need exactness are about one
 * symbol at a time — who calls `aicoHome`, who uses the method whose
 * signature just changed. Answering *that* exactly is cheap if the program
 * holds only the files that could mention the symbol: measured here, 115
 * candidate files pulled 983 into the program (3.5 s, ~780 MB) and
 * `findReferences` took ~0.1 s — the same 57 files a full program gives.
 *
 * ## How
 *
 * - **Candidates from the graph, not a scan.** A file that names an exported
 *   function or type must import its module, directly or through re-exports,
 *   so the reverse import closure of the declaring file is a complete
 *   candidate set. A method (`Type.method`) can be called on an instance a
 *   file never imported the class for, so for methods the worker also scans
 *   the project's TS/JS text for `.method` (texts cached by modification time).
 * - **One long-lived LanguageService per project, in a worker.** Built
 *   lazily on the first query from the project's tsconfig (paths, project
 *   references honoured, sources of referenced projects used), with
 *   `skipLibCheck` and module resolution kept to the project's own files.
 *   Script versions are file modification times, so later queries reuse
 *   everything unchanged (incremental). Files added by earlier queries stay.
 * - **Memory-capped.** After a query, a heap over ~1 GB disposes the service;
 *   the next query rebuilds it. The worker's own heap is capped at 2 GB.
 * - **Time-boxed.** A query answers within the budget (8 s by default) or
 *   returns the lexical answer marked `partial`; the worker keeps going and
 *   the exact answer is cached for the next ask.
 * - **Cached by content.** Results are keyed by the symbol and a hash of
 *   every TS/JS file's content hash (codegraph/index `tsContentKey`): an edit
 *   anywhere invalidates, nothing else does.
 *
 * Users found this way carry `via: 'ondemand'` ("exact (on demand)");
 * implementations of an interface method come from
 * `getImplementationAtPosition`.
 *
 * Not used when the whole-project pass runs (it is already exact), for other
 * languages, or when `typescript` cannot be loaded (the lexical answer stands,
 * and says so).
 *
 * @module codegraph/ts-ondemand
 */

import { Worker } from 'node:worker_threads';
import { typescriptPath } from './ts-check.js';
import { keyOf } from './paths.js';
import type { CodeGraph, SymbolRef } from './types.js';

export interface OnDemandResult {
  /** Users of the symbol: `ondemand` (exact) or `reexport`; the lexical users when partial. */
  users: SymbolRef[];
  /** Implementations of an interface/abstract member: where they are. */
  implementations: Array<{ file: number; line: number }>;
  status: 'exact' | 'partial';
  ms: number;
  cached: boolean;
  /** The worker's heap after the query, MB (exact answers only). */
  heapMB?: number;
  /** Files in the service's program (exact answers only). */
  programFiles?: number;
  /** The service went over its memory cap after this answer and was disposed; the next query rebuilds it. */
  disposed?: boolean;
  note?: string;
}

export const ON_DEMAND_BUDGET_MS = 8_000;
const HEAP_LIMIT_MB = 2_048;
const DISPOSE_ABOVE_MB = 1_000;
const IDLE_MS = 10 * 60_000;
const CACHE_MAX = 300;

interface WorkerAnswer {
  id: number;
  ok: boolean;
  reason?: string;
  files?: Array<{ rel: string; lines: number[]; kind: 'direct' | 'iface' | 'reexport' }>;
  impls?: Array<{ rel: string; line: number }>;
  heapMB?: number;
  programFiles?: number;
  disposed?: boolean;
}

interface Host { worker: Worker; pending: Map<number, (a: WorkerAnswer) => void>; idle?: ReturnType<typeof setTimeout> }
const hosts = new Map<string, Host>();
let nextId = 1;
const cache = new Map<string, OnDemandResult>();
/** Answers still being computed (a timed-out query keeps running). */
const inflight = new Map<string, Promise<OnDemandResult | undefined>>();

function hostFor(root: string, tsPath: string): Host {
  let h = hosts.get(root);
  if (h) return h;
  const worker = new Worker(`(${onDemandWorker.toString()})()`, {
    eval: true, workerData: { root, tsPath, disposeAboveMb: Number(process.env.AICO_CODEGRAPH_ONDEMAND_DISPOSE_MB) || DISPOSE_ABOVE_MB }, resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB }, stdout: true, stderr: true,
  });
  worker.unref();
  const host: Host = { worker, pending: new Map() };
  const fail = (reason: string): void => {
    hosts.delete(root);
    for (const r of host.pending.values()) r({ id: 0, ok: false, reason });
    host.pending.clear();
  };
  worker.on('message', (a: WorkerAnswer) => { const r = host.pending.get(a.id); host.pending.delete(a.id); r?.(a); });
  worker.on('error', (err: Error) => fail(/heap|memory/i.test(err.message) ? 'the language service ran out of memory' : err.message.slice(0, 200)));
  worker.on('exit', () => fail('the language service stopped'));
  hosts.set(root, host);
  h = host;
  return h;
}

function ask(root: string, tsPath: string, msg: Record<string, unknown>): Promise<WorkerAnswer> {
  const h = hostFor(root, tsPath);
  const id = nextId++;
  if (h.idle) clearTimeout(h.idle);
  h.idle = setTimeout(() => { void h.worker.terminate(); hosts.delete(root); }, IDLE_MS);
  h.idle.unref?.();
  return new Promise(resolve => { h.pending.set(id, resolve); h.worker.postMessage({ ...msg, id }); });
}

/** Stop every language-service worker (tests; shutdown). */
export async function disposeOnDemand(): Promise<void> {
  const all = [...hosts.values()];
  hosts.clear();
  cache.clear();
  inflight.clear();
  await Promise.all(all.map(h => h.worker.terminate().catch(() => 0)));
}

/** Files that import `file` directly or through any chain of imports/re-exports, and the file itself. */
function reverseClosure(g: CodeGraph, file: number): number[] {
  const inn = new Map<number, number[]>();
  for (const e of g.edges) { const l = inn.get(e.to) ?? []; l.push(e.from); inn.set(e.to, l); }
  const seen = new Set([file]);
  const queue = [file];
  for (let i = 0; i < queue.length; i++) for (const p of inn.get(queue[i]!) ?? []) if (!seen.has(p)) { seen.add(p); queue.push(p); }
  return [...seen];
}

/** Whether this graph's TS/JS calls need the on-demand path: the project is over the full pass's limits. */
export function onDemandApplies(g: CodeGraph, file: number): boolean {
  const f = g.files[file];
  return Boolean(f && (f.lang === 'ts' || f.lang === 'js') && g.stats.methods?.overCap);
}

/**
 * Exact users of `name` declared in `file`, when the project is too large for
 * the whole-project pass. Undefined when it does not apply. `contentKey` is a
 * hash of every TS/JS file's content (codegraph/index tsContentKey).
 */
export async function onDemandUsers(g: CodeGraph, file: number, name: string, contentKey: string, opts: { budgetMs?: number; force?: boolean } = {}): Promise<OnDemandResult | undefined> {
  if (!opts.force && !onDemandApplies(g, file)) return undefined;
  if (process.env.AICO_CODEGRAPH_TYPECHECK === 'off' || name === 'default') return undefined;
  const decl = g.files[file]!.exports.find(e => e.name === name);
  if (!decl) return undefined;
  const tsPath = typescriptPath(g.root);
  const lexical = (note: string, started: number): OnDemandResult => ({
    users: g.symbols.get(`${file}:${name}`) ?? [], implementations: [], status: 'partial', ms: Date.now() - started, cached: false, note,
  });
  const started = Date.now();
  if (!tsPath) return lexical('`typescript` is not installed in the project or with AICO, so these are the lexical rules\' callers', started);
  const key = `${g.root}|${g.files[file]!.path}#${name}|${contentKey}`;
  const held = cache.get(key);
  if (held) return { ...held, cached: true, ms: Date.now() - started };

  let run = inflight.get(key);
  if (!run) {
    const member = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
    const ts = g.files.filter(f => f.lang === 'ts' || f.lang === 'js').map(f => f.path);
    run = ask(g.root, tsPath, {
      type: 'refs', decl: g.files[file]!.path, line: decl.line, member,
      roots: reverseClosure(g, file).map(id => g.files[id]!.path).filter(p => /\.[cm]?[jt]sx?$/.test(p)),
      // A method can be called on an instance a file never imported the class for.
      scan: name.includes('.') ? { files: ts, needle: `.${member}` } : undefined,
    }).then(a => {
      if (!a.ok || !a.files) return undefined;
      const users: SymbolRef[] = [];
      for (const f of a.files) {
        const id = g.files.findIndex(x => keyOf(x.path) === keyOf(f.rel));
        if (id < 0 || id === file) continue;
        users.push({ file: id, local: name, lines: f.lines.slice(0, 5), via: f.kind === 'direct' ? 'ondemand' : f.kind === 'iface' ? 'interface' : 'reexport' });
      }
        const implementations = (a.impls ?? []).map(i => ({ file: g.files.findIndex(x => keyOf(x.path) === keyOf(i.rel)), line: i.line })).filter(i => i.file >= 0);
      const out: OnDemandResult = { users, implementations, status: 'exact', ms: 0, cached: false, ...(a.heapMB !== undefined ? { heapMB: a.heapMB } : {}), ...(a.programFiles !== undefined ? { programFiles: a.programFiles } : {}), ...(a.disposed ? { disposed: true } : {}) };
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, out);
      return out;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, run);
  }
  const budget = opts.budgetMs ?? ON_DEMAND_BUDGET_MS;
  const res = await Promise.race([run, new Promise<'timeout'>(r => { const t = setTimeout(() => r('timeout'), budget); t.unref?.(); })]);
  if (res === 'timeout') return lexical(`the language service did not finish within ${Math.round(budget / 1000)} s; these are the lexical rules' callers (it keeps working — ask again for the exact set)`, started);
  if (!res) return lexical('the language service could not answer; these are the lexical rules\' callers', started);
  return { ...res, ms: Date.now() - started };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The worker: one LanguageService, kept between queries. Sent as source, self-contained. */
function onDemandWorker(): void {
  const req = (globalThis as any).require as (id: string) => any;
  const { parentPort, workerData } = req('node:worker_threads');
  const nodePath = req('node:path');
  const fs = req('node:fs');
  const ts = req(workerData.tsPath as string);
  const root: string = workerData.root;
  const fwd = (f: string): string => nodePath.resolve(f).split(nodePath.sep).join('/');
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const key = (f: string): string => (caseless ? fwd(f).toLowerCase() : fwd(f));
  const rootKey = key(root);
  const relOf = (f: string): string | undefined => { const k = key(f); return k.startsWith(`${rootKey}/`) ? fwd(f).slice(fwd(root).length + 1) : undefined; };
  const texts = new Map<string, { v: string; text: string }>();
  const versionOf = (f: string): string => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '0'; } };
  const textOf = (f: string): string | undefined => {
    const v = versionOf(f);
    const held = texts.get(f);
    if (held && held.v === v) return held.text;
    try { const text = fs.readFileSync(f, 'utf8'); texts.set(f, { v, text }); return text; } catch { return undefined; }
  };

  let ls: any;
  let files = new Set<string>();
  let options: any;
  let refs: any;
  const build = (): void => {
    const cfg = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(root, ts.sys.fileExists, 'jsconfig.json');
    options = {};
    refs = undefined;
    if (cfg && key(cfg).startsWith(rootKey)) {
      const raw = ts.readConfigFile(cfg, ts.sys.readFile);
      if (!raw.error) {
        const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, nodePath.dirname(cfg));
        options = parsed.options;
        refs = parsed.projectReferences;
      }
    }
    options = { ...options, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true, types: [], composite: false, incremental: false };
    if (options.moduleResolution === undefined) { options.module ??= ts.ModuleKind.ESNext; options.moduleResolution = ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs; }
    options.target ??= ts.ScriptTarget.ES2022;
    options.jsx ??= ts.JsxEmit.Preserve;
    const host: any = {
      getScriptFileNames: () => [...files],
      getScriptVersion: (f: string) => versionOf(f),
      getScriptSnapshot: (f: string) => { const t = textOf(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o: any) => ts.getDefaultLibFilePath(o),
      getProjectReferences: () => refs,
      // Project references: answer from the referenced projects' sources, not their build output.
      useSourceOfProjectReferenceRedirect: () => true,
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory, directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
      resolveModuleNames: (names: string[], containing: string) => names.map((n: string) => {
        const r = ts.resolveModuleName(n, containing, options, ts.sys).resolvedModule;
        return r && !/[\\/]node_modules[\\/]/.test(r.resolvedFileName) ? r : undefined;
      }),
    };
    ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  };

  parentPort.on('message', (m: any) => {
    try {
      if (!ls) { files = new Set(); build(); }
      const abs = (rel: string): string => fwd(nodePath.join(root, rel));
      for (const r of m.roots as string[]) files.add(abs(r));
      if (m.scan) for (const r of m.scan.files as string[]) { if (files.has(abs(r))) continue; const t = textOf(abs(r)); if (t && t.includes(m.scan.needle)) files.add(abs(r)); }
      const declAbs = abs(m.decl);
      files.add(declAbs);
      const program = ls.getProgram();
      const sf = program.getSourceFile(declAbs);
      if (!sf) { parentPort.postMessage({ id: m.id, ok: false, reason: 'the declaring file is not in the program' }); return; }
      // The declaration's position: the member name on its line (the next lines if the header wraps).
      let pos = -1;
      for (let l = m.line - 1; l < Math.min(sf.getLineStarts().length, m.line + 3) && pos < 0; l++) {
        const start = sf.getLineStarts()[l];
        const end = l + 1 < sf.getLineStarts().length ? sf.getLineStarts()[l + 1] : sf.text.length;
        const hit = new RegExp(`(?<![\\w$])${m.member.replace(/[$]/g, '\\$')}(?![\\w$])`).exec(sf.text.slice(start, end));
        if (hit) pos = start + hit.index;
      }
      if (pos < 0) { parentPort.postMessage({ id: m.id, ok: false, reason: 'the declaration was not found at its line' }); return; }
      const byFile = new Map<string, { lines: Set<number>; real: boolean; iface: boolean }>();
      // findReferences answers for related symbols too: the interface member this method
      // implements (calls through it reach this one — "via interface") and sibling
      // implementations of that member (not users of this one). Classify by each group's definition.
      const kindOf = (def: any): 'self' | 'iface' | 'other' => {
        if (key(def.fileName) === key(declAbs) && def.textSpan.start <= pos && pos < def.textSpan.start + def.textSpan.length) return 'self';
        // An import or re-export of it (`import { a as b }`): the same symbol under another name.
        if (def.kind === 'alias') return 'self';
        const dsf = program.getSourceFile(def.fileName);
        let node = dsf ? (ts as any).getTokenAtPosition(dsf, def.textSpan.start) : undefined;
        for (let k = 0; node && k < 4; k++, node = node.parent) {
          if (ts.isMethodSignature(node) || ts.isPropertySignature(node)) return 'iface';
          if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract)) return 'iface';
          if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isFunctionDeclaration(node)) return 'other';
        }
        return 'other';
      };
      for (const group of ls.findReferences(declAbs, pos) ?? []) {
        const kind = kindOf(group.definition);
        if (kind === 'other') continue;
        for (const r of group.references) {
          if (r.isDefinition) continue;
          const rel = relOf(r.fileName);
          if (!rel) continue;
          const rsf = program.getSourceFile(r.fileName);
          const line = rsf ? rsf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1 : 0;
          // A re-export (`export { a } from`) forwards the name; it is not a use.
          let node = rsf ? (ts as any).getTokenAtPosition(rsf, r.textSpan.start) : undefined;
          // The name of a member's own declaration (the interface member this one implements)
          // is reported as a reference; a declaration is not a use.
          const decl = node?.parent;
          if (decl && decl.name === node && (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl) || ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl))) continue;
          let reexport = false;
          for (let k = 0; node && k < 4; k++, node = node.parent) if (ts.isExportSpecifier(node)) { reexport = true; break; }
          const e = byFile.get(rel) ?? { lines: new Set<number>(), real: false, iface: false };
          if (!reexport) { if (kind === 'self') e.real = true; else e.iface = true; if (line) e.lines.add(line); }
          byFile.set(rel, e);
        }
      }
      const impls: Array<{ rel: string; line: number }> = [];
      for (const i of ls.getImplementationAtPosition(declAbs, pos) ?? []) {
        const rel = relOf(i.fileName);
        const isf = program.getSourceFile(i.fileName);
        if (rel && isf && !(key(i.fileName) === key(declAbs) && i.textSpan.start <= pos && pos <= i.textSpan.start + i.textSpan.length)) {
          impls.push({ rel, line: isf.getLineAndCharacterOfPosition(i.textSpan.start).line + 1 });
        }
      }
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1e6);
      const programFiles = program.getSourceFiles().length;
      let disposed = false;
      if (heapMB > workerData.disposeAboveMb) { ls.dispose(); ls = undefined; texts.clear(); disposed = true; }
      parentPort.postMessage({
        id: m.id, ok: true, heapMB, programFiles, disposed, impls,
        files: [...byFile.entries()].map(([rel, e]) => ({ rel, lines: [...e.lines].sort((a, b) => a - b), kind: e.real ? 'direct' : e.iface ? 'iface' : 'reexport' })),
      });
    } catch (err) {
      parentPort.postMessage({ id: m.id, ok: false, reason: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
