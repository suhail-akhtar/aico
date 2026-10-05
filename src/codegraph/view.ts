/**
 * The graph as the Code map view receives it: compact arrays, paths relative
 * to the project, nothing a client cannot draw.
 *
 * Shaped here rather than in the route so the payload is one pure function the
 * tests can hold to its size and content. Edges travel as tuples — a
 * 5,000-file project has tens of thousands of them, and field names repeated
 * per edge would be most of the response.
 *
 * Also the "Ask AICO about this" context: the selected files' exports,
 * imports, users and history in a few thousand characters — precise context
 * a person picked, sent to a chat as text.
 *
 * Interfaces carry their explanation with them: which types implement one,
 * whether declared or by matching method sets (Go, TypeScript), each method
 * with where the implementation has it and whether only the pointer type
 * does — so "inferred" is never the whole answer.
 *
 * @module codegraph/view
 */

import { cycles, orphans, layerViolations, type LayerRule } from './analyze.js';
import { recentCommits, symbolUsers, danglingUsers } from './index.js';
import type { CodeGraph, EdgeKind, Implementation } from './types.js';
import type { OnDemandResult } from './ts-ondemand.js';

export const EDGE_KIND_CODE: Record<EdgeKind, number> = { import: 0, reexport: 1, package: 2, inferred: 3, dynamic: 4, call: 5 };

export interface ViewFile {
  path: string;
  lang: string;
  loc: number;
  size: number;
  fanIn: number;
  fanOut: number;
  churn: number;
  hotspot: number;
  community: number;
  test?: 1;
  entry?: string;
  exports: number;
}

export interface ViewPayload {
  version: string;
  root: string;
  builtAt: number;
  files: ViewFile[];
  /** [from, to, kind code, symbols used, passThrough 0/1, inferred 0/1, through an interface 0/1] */
  edges: Array<[number, number, number, number, number, number, number]>;
  communities: Array<{ id: number; label: string; files: number[] }>;
  /** [a, b, commits together, confidence] */
  cochange: Array<[number, number, number, number]>;
  cycles: number[][];
  orphans: number[];
  violations: Array<{ from: number; to: number; rule: string }>;
  external: Array<[string, number]>;
  git: CodeGraph['git'];
  stats: CodeGraph['stats'];
  /** How many interface → implementation pairs, and how many of them are structural (method sets). */
  implementations: { total: number; structural: number };
}

export function viewPayload(g: CodeGraph, rules: LayerRule[] = []): ViewPayload {
  return {
    version: g.version,
    root: g.root,
    builtAt: g.builtAt,
    files: g.files.map(f => ({
      path: f.path, lang: f.lang, loc: f.loc, size: f.size, fanIn: f.fanIn, fanOut: f.fanOut, churn: f.churn,
      hotspot: f.hotspot, community: f.community, exports: f.exports.filter(e => !e.internal).length,
      ...(f.isTest ? { test: 1 as const } : {}), ...(f.entry ? { entry: f.entry } : {}),
    })),
    edges: g.edges.map(e => [e.from, e.to, EDGE_KIND_CODE[e.kind], e.names.length, e.passThrough ? 1 : 0, e.confidence === 'inferred' ? 1 : 0, e.viaInterface ? 1 : 0]),
    communities: g.communities.map(c => ({ id: c.id, label: c.label, files: c.files })),
    cochange: g.cochange.slice(0, 2_000).map(c => [c.a, c.b, c.count, c.confidence]),
    cycles: cycles(g).slice(0, 100),
    orphans: orphans(g),
    violations: layerViolations(g, rules).slice(0, 500).map(v => ({ from: v.from, to: v.to, rule: `${v.rule.from} ↛ ${v.rule.to}${v.rule.reason ? ` (${v.rule.reason})` : ''}` })),
    external: [...g.external.entries()].map(([p, ids]) => [p, ids.length] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 60),
    git: g.git,
    stats: g.stats,
    implementations: { total: g.implementations.length, structural: g.implementations.filter(i => i.how === 'structural').length },
  };
}

/** One implementation as a client shows it: who, how, and the methods that make it one. */
export interface ImplView {
  iface: { id: number; name: string };
  impl: { id: number; name: string };
  how: Implementation['how'];
  pointer?: boolean;
  methods: Array<{ name: string; id: number; line: number; ptr?: boolean }>;
  /** A sentence: why this type satisfies this interface. */
  why: string;
}

export function implView(g: CodeGraph, i: Implementation): ImplView {
  const ptrs = i.methods.filter(m => m.ptr).map(m => m.name);
  const names = i.methods.map(m => m.name);
  const lang = g.files[i.impl.file]?.lang;
  const why = i.how === 'structural'
    ? `${i.pointer ? `*${i.impl.name}` : i.impl.name} has every method of ${i.iface.name} with the same parameter and result types: ${names.join(', ') || '(none)'}${ptrs.length ? ` — ${ptrs.join(', ')} ${ptrs.length === 1 ? 'has a pointer receiver' : 'have pointer receivers'}, so only *${i.impl.name} satisfies it` : ''}${lang === 'ts' || lang === 'js' ? ' (TypeScript: assignable without `implements`)' : ''}.`
    : `${i.impl.name} declares ${i.iface.name} as a supertype${names.length ? ` and has ${names.join(', ')}` : ''}.`;
  return {
    iface: { id: i.iface.file, name: i.iface.name },
    impl: { id: i.impl.file, name: i.impl.name },
    how: i.how,
    ...(i.pointer ? { pointer: true } : {}),
    methods: i.methods.map(m => ({ name: m.name, id: m.file, line: m.line, ...(m.ptr ? { ptr: true } : {}) })),
    why,
  };
}

/** A graph with only what is certain: no edge or user that rests on an interface or a unique name. */
const exactMemo = new WeakMap<CodeGraph, CodeGraph>();
export function exactOnly(g: CodeGraph): CodeGraph {
  const held = exactMemo.get(g);
  if (held) return held;
  const keep = (via: string): boolean => via !== 'interface' && via !== 'inferred';
  const symbols = new Map([...g.symbols].map(([k, refs]) => [k, refs.filter(r => keep(r.via))] as const).filter(([, refs]) => refs.length > 0));
  const out: CodeGraph = { ...g, edges: g.edges.filter(e => e.confidence !== 'inferred'), symbols };
  exactMemo.set(g, out);
  return out;
}

export interface FileDetail {
  id: number;
  path: string;
  lang: string;
  loc: number;
  size: number;
  entry?: string;
  test: boolean;
  churn: number;
  hotspot: number;
  community: string;
  authors: Array<[string, number]>;
  exports: Array<{ name: string; kind: string; line: number; sig: string; users: number }>;
  importers: Array<{ id: number; names: string[]; kind: string; inferred: boolean; viaInterface?: boolean }>;
  imports: Array<{ id: number; names: string[]; kind: string; inferred: boolean; viaInterface?: boolean }>;
  /** Interfaces declared here and the types that implement them. */
  implementedBy: ImplView[];
  /** Types declared here and the interfaces they implement. */
  implementing: ImplView[];
  external: string[];
  cochange: Array<{ id: number; count: number; confidence: number }>;
  commits: Array<{ hash: string; at: number; author: string; subject: string }>;
}

export function fileDetail(g: CodeGraph, id: number): FileDetail {
  const f = g.files[id]!;
  const kindName = (k: EdgeKind): string => k;
  return {
    id, path: f.path, lang: f.lang, loc: f.loc, size: f.size, ...(f.entry ? { entry: f.entry } : {}), test: f.isTest,
    churn: f.churn, hotspot: f.hotspot, community: g.communities.find(c => c.id === f.community)?.label ?? '',
    authors: f.authors,
    exports: f.exports.filter(e => !e.internal).slice(0, 200).map(e => ({ name: e.name, kind: e.kind, line: e.line, sig: e.sig, users: symbolUsers(g, id, e.name).filter(u => u.via !== 'reexport').length })),
    importers: g.edges.filter(e => e.to === id && !e.passThrough).map(e => ({ id: e.from, names: e.names.slice(0, 12), kind: kindName(e.kind), inferred: e.confidence === 'inferred', ...(e.viaInterface ? { viaInterface: true } : {}) })),
    imports: g.edges.filter(e => e.from === id && !e.passThrough).map(e => ({ id: e.to, names: e.names.slice(0, 12), kind: kindName(e.kind), inferred: e.confidence === 'inferred', ...(e.viaInterface ? { viaInterface: true } : {}) })),
    implementedBy: g.implementations.filter(i => i.iface.file === id).slice(0, 80).map(i => implView(g, i)),
    implementing: g.implementations.filter(i => i.impl.file === id).slice(0, 80).map(i => implView(g, i)),
    external: [...g.external.entries()].filter(([, ids]) => ids.includes(id)).map(([p]) => p),
    cochange: g.cochange.filter(c => c.a === id || c.b === id).slice(0, 12).map(c => ({ id: c.a === id ? c.b : c.a, count: c.count, confidence: c.confidence })),
    commits: recentCommits(g.root, f.path),
  };
}

export interface SymbolDetail {
  file: number;
  name: string;
  sig?: string;
  line?: number;
  kind?: string;
  users: Array<{ id: number; local: string; lines: number[]; via: string }>;
  /** How the users were found: the graph's rules, or exactly on demand by the TypeScript language service (or that attempt, partial). */
  exactness?: { mode: 'on-demand' | 'partial'; ms: number; cached: boolean; note?: string };
  /** For an interface (or one of its methods): what implements it, and why. For a type: what it implements. */
  implementations?: ImplView[];
  implementing?: ImplView[];
}

export function symbolDetail(g: CodeGraph, id: number, name: string, onDemand?: OnDemandResult): SymbolDetail {
  const decl = g.files[id]?.exports.find(e => e.name === name);
  const users = onDemand?.status === 'exact' ? onDemand.users : symbolUsers(g, id, name);
  const list = users.length ? users : danglingUsers(g, id, name);
  const typeName = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  const impls = g.implementations.filter(i => i.iface.file === id && i.iface.name === typeName);
  const implementing = g.implementations.filter(i => i.impl.file === id && i.impl.name === typeName);
  return {
    file: id, name, ...(decl ? { sig: decl.sig, line: decl.line, kind: decl.kind } : {}),
    users: list.map(u => ({ id: u.file, local: u.local, lines: u.lines, via: u.via })),
    ...(onDemand ? { exactness: { mode: onDemand.status === 'exact' ? 'on-demand' as const : 'partial' as const, ms: onDemand.ms, cached: onDemand.cached, ...(onDemand.note ? { note: onDemand.note } : {}) } } : {}),
    ...(impls.length ? { implementations: impls.slice(0, 80).map(i => implView(g, i)) } : {}),
    ...(implementing.length ? { implementing: implementing.slice(0, 80).map(i => implView(g, i)) } : {}),
  };
}

/**
 * Context for a chat about the selected files: what each declares, what it
 * imports, who uses it, and its history. Bounded to `maxChars`.
 */
export function selectionContext(g: CodeGraph, ids: number[], maxChars = 6_000): string {
  const out: string[] = [];
  const sel = new Set(ids);
  for (const id of ids) {
    const f = g.files[id];
    if (!f) continue;
    const exps = f.exports.filter(e => !e.internal).slice(0, 10).map(e => `${e.name} (${symbolUsers(g, id, e.name).filter(u => u.via !== 'reexport').length} users)`);
    const imports = g.edges.filter(e => e.from === id && !e.passThrough).slice(0, 15).map(e => `${g.files[e.to]!.path}${e.names.length ? ` [${e.names.slice(0, 4).join(', ')}]` : ''}`);
    const users = g.edges.filter(e => e.to === id && !e.passThrough).slice(0, 15).map(e => `${g.files[e.from]!.path}${e.names.length ? ` [${e.names.slice(0, 4).join(', ')}]` : ''}`);
    const partners = g.cochange.filter(c => c.a === id || c.b === id).slice(0, 4).map(c => `${g.files[c.a === id ? c.b : c.a]!.path} (${c.count}×)`);
    out.push([
      `### ${f.path}${sel.size > 1 ? '' : ''}`,
      `${f.lang}, ${f.loc} lines${f.entry ? `, entry point (${f.entry})` : ''}${f.isTest ? ', test' : ''}; imported by ${f.fanIn}, imports ${f.fanOut}${f.churn ? `, ${f.churn} recent commits` : ''}`,
      exps.length ? `Exports: ${exps.join(', ')}` : '',
      imports.length ? `Imports: ${imports.join('; ')}` : '',
      users.length ? `Used by: ${users.join('; ')}${f.fanIn > users.length ? ` (+${f.fanIn - users.length} more)` : ''}` : 'Used by: nothing',
      partners.length ? `Changes together with: ${partners.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
    if (out.join('\n\n').length > maxChars) break;
  }
  const text = out.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 2)}…` : text;
}
