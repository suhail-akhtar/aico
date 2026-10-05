/**
 * The code graph of a project: built once, kept fresh cheaply, asked many
 * questions.
 *
 * ## Freshness without a watcher
 *
 * A refresh walks the file list and compares each file's size and
 * modification time with the stored record; only a file that moved is read,
 * and only a file whose content hash changed is parsed again. Resolution is
 * then rebuilt from the cached parses (codegraph/resolve explains why that is
 * cheaper and more correct than patching edges). Refreshes are throttled per
 * project and coalesced — two callers asking at once share one walk — so the
 * agent's tool, the edit note and the Code map view can all call
 * {@link getCodeGraph} freely.
 *
 * Git history is re-read only when `HEAD` moves.
 *
 * ## TS/JS method calls: lexical first, the checker after
 *
 * A graph is built at once with the lexical receiver rules for every
 * language (parse/members). For TS/JS the TypeScript checker then runs in a
 * worker (codegraph/ts-check), debounced after changes; when it finishes the
 * graph is rebuilt from the same parses with its answers and the version
 * moves. `getCodeGraph(root, { exact })` waits for it (bounded) — the agent's
 * tool does; the Code map does not and reloads when the version changes.
 *
 * ## Bounds
 *
 * {@link MAX_FILES} files (sorted by path, so the same ones every time, and
 * the graph says when it is truncated) and {@link MAX_FILE_BYTES} per file;
 * a file of very long lines (a bundle, a generated table) is recorded but not
 * parsed. Ignore rules are the codebase map's: the built-in list plus the
 * project's own `.gitignore`.
 *
 * @module codegraph
 */

import fastGlob from 'fast-glob';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { IGNORED, gitignorePatterns } from '../codemap/build.js';
import { communities, computeDegrees, computeHotspots } from './analyze.js';
import { gitHead, readHistory, type GitHistory, emptyHistory } from './git.js';
import { SOURCE_EXTENSIONS, entryFromPath, isTestPath, langOf, parseSource } from './parse/index.js';
import { dirOf, joinRel, keyOf } from './paths.js';
import { Resolver, resolveAll } from './resolve.js';
import { loadStore, saveStore, type StoredTsExact } from './store.js';
import { runTsCheck, TS_CHECK_MAX_BYTES, TS_CHECK_MAX_FILES } from './ts-check.js';
import type { ExactFile } from './members.js';
import type { CodeGraph, CoChange, FileRecord, GraphFile, Implementation, Lang } from './types.js';

export type { CodeGraph } from './types.js';

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 1_000_000;
/** Between automatic refreshes of one project; a forced refresh ignores it. */
const REFRESH_THROTTLE_MS = 2_500;
const CONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json', 'package.json', 'go.mod', 'composer.json', 'Cargo.toml', 'index.html'];

interface ProjectState {
  root: string;
  records: Map<string, FileRecord>;
  configs: Map<string, string>;
  git: GitHistory;
  graph?: CodeGraph;
  lastRefresh: number;
  inflight?: Promise<CodeGraph>;
  loaded: boolean;
  truncated: boolean;
  skipped: number;
  /** The TypeScript checker's last answers (codegraph/ts-check). */
  tsExact?: StoredTsExact;
  /** A checker pass running now. */
  tsRun?: Promise<void>;
  tsTimer?: ReturnType<typeof setTimeout>;
  /** Files changed while a pass ran: run again after it. */
  tsDirty: boolean;
  tsLastEnd: number;
  /** Why the checker does not run here (too large, switched off, no typescript, failed). */
  tsNote?: string;
}

const states = new Map<string, ProjectState>();
const MAX_HELD = 4;

/** Called after a build that produced a new graph (the code-graph monitor listens: brief/service). */
type BuiltListener = (root: string, graph: CodeGraph) => void;
const builtListeners = new Set<BuiltListener>();

export function onGraphBuilt(listener: BuiltListener): () => void {
  builtListeners.add(listener);
  return () => { builtListeners.delete(listener); };
}

function announce(root: string, graph: CodeGraph): void {
  if (!builtListeners.size) return;
  // After the caller has its graph: a listener must never delay or fail a build.
  setImmediate(() => { for (const l of builtListeners) { try { l(root, graph); } catch { /* a listener's problem, not the graph's */ } } });
}

function stateFor(root: string): ProjectState {
  const key = keyOf(path.resolve(root));
  let s = states.get(key);
  if (!s) {
    s = { root: path.resolve(root), records: new Map(), configs: new Map(), git: emptyHistory(), lastRefresh: 0, loaded: false, truncated: false, skipped: 0, tsDirty: false, tsLastEnd: 0 };
    states.set(key, s);
    // Least recently created out first: a desktop with a dozen projects open must not hold a dozen graphs.
    while (states.size > MAX_HELD) states.delete(states.keys().next().value!);
  }
  return s;
}

/** Forget in-memory graphs (tests; after a project is removed). */
export function resetCodeGraphCache(): void {
  for (const s of states.values()) if (s.tsTimer) clearTimeout(s.tsTimer);
  states.clear();
}

export interface GraphOptions {
  /** Walk and re-check now, ignoring the throttle. */
  force?: boolean;
  /** Use whatever is in memory without walking (the edit note's budget). */
  cachedOnly?: boolean;
  /**
   * Wait for the TypeScript checker's method calls: `true` up to its own
   * deadline, a number for at most that many milliseconds. Without it a graph
   * may carry the lexical TS/JS calls while the checker runs behind it.
   */
  exact?: boolean | number;
}

/** The project's graph, refreshed if it may be stale. */
export async function getCodeGraph(root: string, opts: GraphOptions = {}): Promise<CodeGraph> {
  const s = stateFor(root);
  let g: CodeGraph;
  if (s.inflight) g = await s.inflight;
  else if (s.graph && (opts.cachedOnly || (!opts.force && Date.now() - s.lastRefresh < REFRESH_THROTTLE_MS))) g = s.graph;
  else {
    s.inflight = refresh(s).finally(() => { s.inflight = undefined; });
    g = await s.inflight;
  }
  if (opts.exact && !opts.cachedOnly) {
    if (!s.tsRun && tsPlan(s).env !== undefined && s.tsExact?.env !== tsPlan(s).env) startTsCheck(s);
    if (s.tsRun) {
      const wait = typeof opts.exact === 'number' ? opts.exact : 150_000;
      await Promise.race([s.tsRun, new Promise<void>(r => { const t = setTimeout(r, wait); t.unref?.(); })]);
    }
    g = s.graph ?? g;
  }
  return g;
}

/** Changes that should reach the checker are batched: one pass, a moment after the last. */
const TS_DEBOUNCE_MS = 1_500;
const TS_MIN_GAP_MS = 5_000;

/** The TS/JS files the checker would see, and the fingerprint of their contents — or why it will not run. */
function tsPlan(s: ProjectState): { env?: string; rels: string[]; hashes: Record<string, string>; skip?: string; overCap?: boolean } {
  const recs = [...s.records.values()].filter(r => r.parsed && (r.parsed.lang === 'ts' || r.parsed.lang === 'js') && !/\.d\.[cm]?ts$/.test(r.path));
  if (!recs.length) return { rels: [], hashes: {}, skip: 'no TS/JS files' };
  if (process.env.AICO_CODEGRAPH_TYPECHECK === 'off') return { rels: [], hashes: {}, skip: 'the TypeScript checker is switched off (AICO_CODEGRAPH_TYPECHECK=off)' };
  const bytes = recs.reduce((n, r) => n + r.size, 0);
  // Tests lower the limits to reach the on-demand path on a small fixture.
  const maxFiles = Number(process.env.AICO_CODEGRAPH_TS_MAX_FILES) || TS_CHECK_MAX_FILES;
  const maxBytes = Number(process.env.AICO_CODEGRAPH_TS_MAX_BYTES) || TS_CHECK_MAX_BYTES;
  if (recs.length > maxFiles || bytes > maxBytes) {
    return { rels: [], hashes: {}, overCap: true, skip: `${recs.length} TS/JS files (${(bytes / 1e6).toFixed(1)} MB) is over the whole-project type checker's limit (${maxFiles} files, ${maxBytes / 1e6} MB): method calls use the lexical rules, and a symbol you ask about is resolved exactly on demand by the TypeScript language service` };
  }
  recs.sort((a, b) => a.path.localeCompare(b.path));
  const hashes: Record<string, string> = {};
  for (const r of recs) hashes[r.path] = r.hash;
  const env = createHash('sha1').update(recs.map(r => `${r.path}:${r.hash}`).join('\n'))
    .update([...s.configs.entries()].filter(([k]) => /(?:ts|js)config[^/]*\.json$/.test(k)).map(([k, v]) => `${k}\0${v}`).join('\0'))
    .digest('hex').slice(0, 16);
  return { env, rels: recs.map(r => r.path), hashes };
}

/** After a build: run the checker if what it would see changed (debounced; never twice at once). */
function scheduleTsCheck(s: ProjectState): void {
  const plan = tsPlan(s);
  s.tsNote = plan.skip;
  if (!plan.env || s.tsExact?.env === plan.env) return;
  if (s.tsRun) { s.tsDirty = true; return; }
  if (s.tsTimer) clearTimeout(s.tsTimer);
  const delay = Math.max(TS_DEBOUNCE_MS, s.tsLastEnd + TS_MIN_GAP_MS - Date.now());
  s.tsTimer = setTimeout(() => { s.tsTimer = undefined; if (!s.tsRun) startTsCheck(s); }, delay);
  s.tsTimer.unref?.();
}

function startTsCheck(s: ProjectState): void {
  if (s.tsTimer) { clearTimeout(s.tsTimer); s.tsTimer = undefined; }
  const plan = tsPlan(s);
  if (!plan.env) return;
  const env = plan.env;
  s.tsRun = runTsCheck(s.root, plan.rels).then(res => {
    if (!res.ok) { s.tsNote = `the TypeScript checker did not run: ${res.reason}; method calls use the lexical rules`; return; }
    s.tsNote = undefined;
    s.tsExact = { env, hashes: plan.hashes, files: res.files, impls: res.impls, at: Date.now() };
    // Same parses, new answers: rebuild and let clients see a new version.
    if (states.get(keyOf(s.root)) === s) {
      s.graph = buildGraph(s, { parsed: 0, scanMs: 0 });
      void saveStore(s.root, [...s.records.values()], s.git, s.tsExact);
      announce(s.root, s.graph);
    }
  }).catch(() => undefined).finally(() => {
    s.tsRun = undefined;
    s.tsLastEnd = Date.now();
    if (s.tsDirty) { s.tsDirty = false; scheduleTsCheck(s); }
    if (s.graph) s.graph = { ...s.graph, stats: { ...s.graph.stats, methods: methodStats(s, s.graph.stats.methods?.calls ?? 0) } };
  });
}

function methodStats(s: ProjectState, calls: number): NonNullable<CodeGraph['stats']['methods']> {
  const plan = tsPlan(s);
  if (plan.skip) return { ts: 'lexical', note: plan.skip, calls, ...(plan.overCap ? { overCap: true } : {}) };
  if (s.tsRun) return { ts: 'pending', note: 'the TypeScript checker is running; TS/JS method calls use the lexical rules until it finishes', calls };
  if (s.tsExact && !s.tsNote) return { ts: 'checker', calls };
  return { ts: 'lexical', ...(s.tsNote ? { note: s.tsNote } : {}), calls };
}

/**
 * A hash of every TS/JS file's content hash: the on-demand language service's
 * cache key (codegraph/ts-ondemand) — any edit to TS/JS invalidates, nothing else.
 */
export function tsContentKey(root: string): string {
  const s = states.get(keyOf(path.resolve(root)));
  if (!s) return String(Date.now());
  const h = createHash('sha1');
  for (const r of [...s.records.values()].filter(x => /\.[cm]?[jt]sx?$/.test(x.path)).sort((a, b) => a.path.localeCompare(b.path))) h.update(`${r.path}:${r.hash}\n`);
  return h.digest('hex').slice(0, 16);
}

/** Exact users of one TS/JS symbol in a project too large for the whole-project pass (codegraph/ts-ondemand). */
export async function exactUsersOnDemand(g: CodeGraph, file: number, name: string, opts: { budgetMs?: number } = {}): Promise<import('./ts-ondemand.js').OnDemandResult | undefined> {
  const { onDemandUsers } = await import('./ts-ondemand.js');
  return onDemandUsers(g, file, name, tsContentKey(g.root), opts);
}

/** The graph only if one is already in memory (never builds). */
export function peekCodeGraph(root: string): CodeGraph | undefined {
  return states.get(keyOf(path.resolve(root)))?.graph;
}

async function scan(root: string): Promise<{ sources: string[]; configs: string[]; truncated: boolean }> {
  const ignore = [...IGNORED, ...await gitignorePatterns(root), '**/.aico/**'];
  const found = await fastGlob([`**/*.{${SOURCE_EXTENSIONS.join(',')}}`, ...CONFIG_NAMES.map(n => `**/${n}`)], {
    cwd: root, ignore, followSymbolicLinks: false, onlyFiles: true, dot: false, suppressErrors: true,
  });
  const configs: string[] = [];
  const sources: string[] = [];
  for (const f of found) (CONFIG_NAMES.includes(f.slice(f.lastIndexOf('/') + 1)) ? configs : sources).push(f);
  sources.sort();
  configs.sort();
  return { sources: sources.slice(0, MAX_FILES), configs: configs.slice(0, 2_000), truncated: sources.length > MAX_FILES };
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 20);

/** Minified or generated: long lines are not code a person reads or an import graph needs. */
function looksGenerated(text: string): boolean {
  if (text.length < 20_000) return false;
  const lines = text.length / (text.split('\n').length || 1);
  return lines > 400;
}

async function refresh(s: ProjectState): Promise<CodeGraph> {
  const started = Date.now();
  if (!s.loaded) {
    s.loaded = true;
    const stored = await loadStore(s.root);
    if (stored) {
      for (const r of stored.records) s.records.set(r.path, r);
      s.git = stored.git;
      if (stored.tsExact) s.tsExact = stored.tsExact;
    }
  }
  const { sources, configs, truncated } = await scan(s.root);
  s.truncated = truncated;
  let changed = !s.graph;
  let parsed = 0;
  let skipped = 0;
  const seen = new Set<string>();

  // Bounded concurrency: five thousand simultaneous stats exhaust file handles.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const rel = sources[cursor++];
      if (rel === undefined) return;
      seen.add(rel);
      const abs = path.join(s.root, rel);
      let info;
      try { info = await stat(abs); } catch { continue; }
      const held = s.records.get(rel);
      if (held && held.size === info.size && Math.abs(held.mtimeMs - info.mtimeMs) < 1) continue;
      if (info.size > MAX_FILE_BYTES) {
        s.records.set(rel, { path: rel, hash: `size:${info.size}`, size: info.size, mtimeMs: info.mtimeMs });
        skipped++;
        changed = true;
        continue;
      }
      let text: string;
      try { text = await readFile(abs, 'utf8'); } catch { continue; }
      const hash = sha1(text);
      if (held && held.hash === hash && held.parsed) { held.mtimeMs = info.mtimeMs; held.size = info.size; continue; }
      const lang = langOf(rel);
      let p;
      if (lang && !looksGenerated(text)) {
        try { p = parseSource(text, lang); } catch { p = undefined; }
      } else skipped++;
      s.records.set(rel, { path: rel, hash, size: info.size, mtimeMs: info.mtimeMs, ...(p ? { parsed: p } : {}) });
      parsed++;
      changed = true;
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  for (const rel of [...s.records.keys()]) if (!seen.has(rel)) { s.records.delete(rel); changed = true; }

  // Config files are small and few; read them every time so a tsconfig edit takes effect.
  const nextConfigs = new Map<string, string>();
  await Promise.all(configs.map(async rel => {
    try {
      const text = await readFile(path.join(s.root, rel), 'utf8');
      if (text.length < 512_000) nextConfigs.set(rel, text);
    } catch { /* gone mid-walk */ }
  }));
  if (!sameMap(nextConfigs, s.configs)) { s.configs = nextConfigs; changed = true; }

  const head = await gitHead(s.root);
  if (head !== s.git.head) {
    s.git = await readHistory(s.root);
    changed = true;
  }
  void skipped;
  s.skipped = [...s.records.values()].filter(r => !r.parsed).length;
  s.lastRefresh = Date.now();
  if (!changed && s.graph) return s.graph;

  const graph = buildGraph(s, { parsed, scanMs: Date.now() - started });
  s.graph = graph;
  void saveStore(s.root, [...s.records.values()], s.git, s.tsExact);
  scheduleTsCheck(s);
  announce(s.root, graph);
  return graph;
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Entry points named by package manifests and HTML pages (`main`, `bin`, scripts, `<script src>`). */
function manifestEntries(resolver: Resolver, configs: Map<string, string>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [rel, text] of configs) {
    const dir = dirOf(rel);
    if (rel.endsWith('package.json')) {
      let json: Record<string, unknown>;
      try { json = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
      const targets: Array<[string, string]> = [];
      for (const field of ['main', 'module', 'source']) if (typeof json[field] === 'string') targets.push([json[field] as string, 'package main']);
      const bin = json.bin;
      if (typeof bin === 'string') targets.push([bin, 'cli']);
      else if (bin && typeof bin === 'object') for (const v of Object.values(bin)) if (typeof v === 'string') targets.push([v, 'cli']);
      const scripts = json.scripts && typeof json.scripts === 'object' ? Object.values(json.scripts as Record<string, unknown>) : [];
      for (const sc of scripts) {
        if (typeof sc !== 'string') continue;
        for (const m of sc.matchAll(/(?:node|tsx|ts-node|bun|deno run|python3?)\s+(?:--[\w-]+(?:[= ]\S+)?\s+)*([\w./@-]+\.(?:[cm]?[jt]sx?|py))/g)) targets.push([m[1]!, 'script']);
      }
      for (const [t, why] of targets) {
        const id = resolver.tryJsPath(joinRel(dir, t), 0, true) ?? resolver.lookup(joinRel(dir, t));
        if (id !== undefined && !out.has(id)) out.set(id, why);
      }
    } else if (rel.endsWith('index.html')) {
      for (const m of text.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
        const src = m[1]!.replace(/^\//, '');
        const id = resolver.tryJsPath(joinRel(dir, src)) ?? resolver.tryJsPath(src);
        if (id !== undefined && !out.has(id)) out.set(id, 'page script');
      }
    }
  }
  return out;
}

function buildGraph(s: ProjectState, timing: { parsed: number; scanMs: number }): CodeGraph {
  const t0 = Date.now();
  const records = [...s.records.values()].sort((a, b) => a.path.localeCompare(b.path));
  const resolver = new Resolver(records.map(r => ({ path: r.path, ...(r.parsed ? { parsed: r.parsed } : {}) })), s.configs);
  const res = resolveAll(resolver, exactInput(s, resolver));
  const fromManifest = manifestEntries(resolver, s.configs);

  const files: GraphFile[] = records.map((r, id) => {
    const lang = (r.parsed?.lang ?? langOf(r.path) ?? 'js') as Lang;
    const authors = s.git.authors.get(r.path);
    const entry = r.parsed?.entry ?? entryFromPath(r.path) ?? fromManifest.get(id);
    return {
      id, path: r.path, lang, size: r.size, loc: r.parsed?.loc ?? 0, dir: dirOf(r.path), isTest: isTestPath(r.path),
      ...(entry ? { entry } : {}),
      exports: r.parsed?.exports ?? [],
      fanIn: 0, fanOut: 0,
      churn: s.git.churn.get(r.path) ?? 0,
      authors: authors ? [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3) : [],
      community: 0, hotspot: 0,
    };
  });
  computeDegrees(files, res.edges);
  const comms = communities({ files, edges: res.edges });
  for (const c of comms) for (const f of c.files) files[f]!.community = c.id;
  computeHotspots(files);

  const idOf = new Map(files.map(f => [f.path, f.id]));
  const cochange: CoChange[] = [];
  for (const [key, count] of s.git.pairs) {
    if (count < 2) continue;
    const [a, b] = key.split('\0');
    const ia = idOf.get(a!);
    const ib = idOf.get(b!);
    if (ia === undefined || ib === undefined) continue;
    const denom = Math.min(s.git.churn.get(a!) ?? count, s.git.churn.get(b!) ?? count);
    cochange.push({ a: ia, b: ib, count, confidence: Math.round((count / Math.max(1, denom)) * 100) / 100 });
  }
  cochange.sort((x, y) => y.count - x.count || y.confidence - x.confidence);

  const version = createHash('sha1')
    .update(records.map(r => r.hash).join(','))
    .update(String(s.git.head ?? ''))
    .update([...s.configs.values()].join('\0'))
    .update(s.tsExact?.env ?? '')
    .digest('hex').slice(0, 16);
  return {
    root: s.root,
    builtAt: Date.now(),
    version,
    files,
    edges: res.edges,
    symbols: res.symbols,
    dangling: res.dangling,
    external: res.external,
    unresolved: res.unresolved,
    cochange: cochange.slice(0, 5_000),
    communities: comms,
    implementations: res.implementations,
    git: { available: s.git.available, ...(s.git.head ? { head: s.git.head } : {}), commits: s.git.commits, skippedLarge: s.git.skippedLarge },
    stats: {
      indexed: files.length, parsed: timing.parsed, skipped: s.skipped, truncated: s.truncated,
      buildMs: timing.scanMs, resolveMs: Date.now() - t0,
      methods: methodStats(s, res.calls.exact + res.calls.viaInterface),
    },
  };
}

/**
 * The checker's answers as resolution takes them: only for files whose content is
 * still what the checker saw (an edited file falls back to the lexical rules until
 * the next pass), paths mapped to this build's ids.
 */
function exactInput(s: ProjectState, r: Resolver): { files: Map<number, ExactFile>; implementations: Implementation[] } | undefined {
  const x = s.tsExact;
  if (!x) return undefined;
  const files = new Map<number, ExactFile>();
  for (const [rel, res] of Object.entries(x.files)) {
    const rec = s.records.get(rel);
    const id = r.lookup(rel);
    if (!rec || id === undefined || rec.hash !== x.hashes[rel]) continue;
    const calls: ExactFile['calls'] = [];
    for (const [line, target, symbol, via] of res.calls) {
      const t = r.lookup(target);
      if (t !== undefined) calls.push({ line, file: t, symbol, via: via === 1 ? 'interface' : 'call' });
    }
    files.set(id, { calls, known: new Set(res.known) });
  }
  const implementations: Implementation[] = [];
  for (const i of x.impls) {
    const a = r.lookup(i.iface[0]);
    const b = r.lookup(i.impl[0]);
    if (a === undefined || b === undefined) continue;
    const methods = i.methods.map(([name, rel, line]) => ({ name, file: r.lookup(rel) ?? b, line }));
    implementations.push({ iface: { file: a, name: i.iface[1] }, impl: { file: b, name: i.impl[1] }, methods, how: i.how === 1 ? 'structural' : 'declared' });
  }
  return { files, implementations };
}

/** Recent commits for a file (from the stored history), newest first. */
export function recentCommits(root: string, file: string): Array<{ hash: string; at: number; author: string; subject: string }> {
  return states.get(keyOf(path.resolve(root)))?.git.recent.get(file) ?? [];
}

// ── Finding things in a graph ───────────────────────────────────────────────

/** A file by project-relative path, absolute path, or unique suffix (`format/currency.ts`). */
export function findFile(g: CodeGraph, query: string): { id?: number; candidates?: number[] } {
  let q = query.trim().replace(/\\/g, '/');
  const rootFwd = g.root.replace(/\\/g, '/');
  if (keyOf(q).startsWith(keyOf(`${rootFwd}/`))) q = q.slice(rootFwd.length + 1);
  q = q.replace(/^\.\//, '');
  const exact = g.files.find(f => keyOf(f.path) === keyOf(q));
  if (exact) return { id: exact.id };
  const suffix = g.files.filter(f => keyOf(f.path).endsWith(keyOf(`/${q}`)));
  if (suffix.length === 1) return { id: suffix[0]!.id };
  if (suffix.length > 1) return { candidates: suffix.map(f => f.id) };
  // Without an extension: `src/lib/format/currency`.
  const noExt = g.files.filter(f => keyOf(f.path.replace(/\.[^./]+$/, '')) === keyOf(q) || keyOf(f.path.replace(/\.[^./]+$/, '')).endsWith(keyOf(`/${q}`)));
  if (noExt.length === 1) return { id: noExt[0]!.id };
  return noExt.length ? { candidates: noExt.map(f => f.id) } : {};
}

/** Files declaring an exported symbol by name. */
export function findSymbolDecls(g: CodeGraph, name: string): Array<{ file: number; name: string }> {
  const out: Array<{ file: number; name: string }> = [];
  for (const f of g.files) for (const e of f.exports) if (e.name === name || e.name.endsWith(`.${name}`)) out.push({ file: f.id, name: e.name });
  return out;
}

/**
 * Bindings that still name `name` from `file` (or from a barrel that re-exports
 * everything of it) although it no longer exports that name: who a removal or
 * rename leaves broken.
 */
export function danglingUsers(g: CodeGraph, file: number, name: string): import('./types.js').SymbolRef[] {
  const barrels = new Set<number>([file]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of g.edges) {
      if (e.kind === 'reexport' && barrels.has(e.to) && !barrels.has(e.from) && (e.names.length === 0 || e.names.includes(name))) { barrels.add(e.from); grew = true; }
    }
  }
  const out: import('./types.js').SymbolRef[] = [];
  for (const b of barrels) for (const r of g.dangling.get(`${b}:${name}`) ?? []) if (!out.some(x => x.file === r.file)) out.push(r);
  return out;
}

/** Users of `name` declared in `file` (direct, through any alias, barrel or namespace). */
export function symbolUsers(g: CodeGraph, file: number, name: string): import('./types.js').SymbolRef[] {
  return g.symbols.get(`${file}:${name}`) ?? [];
}
