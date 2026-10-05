/**
 * The graph's answers as text an agent reads: compact, complete where it
 * matters, and honest about what it does not know.
 *
 * ## Complete before compact
 *
 * The answer the benchmark punished was the *truncated* one: a caller list cut
 * at a token budget looks complete, and the agent edits what it was shown. So
 * a list of direct users is the last thing trimmed — paths are grouped by
 * folder (a folder name once, then file names) to fit, and anything that
 * still does not fit says how many were left out and how to see them.
 *
 * ## Ambiguity is an answer
 *
 * A bare symbol name declared in several files is never merged: the answer
 * lists the declarations with their user counts and asks for `file#name`.
 * Merging is how other tools reported decoys as callers.
 *
 * @module codegraph/report
 */

import {
  adjacency, cycleWitness, cycles, impactLayers, layerViolations, mermaidArchitecture, orphans, shortestPath, type LayerRule,
} from './analyze.js';
import { findFile, findSymbolDecls, symbolUsers } from './index.js';
import { dirOf, baseOf } from './paths.js';
import type { CodeGraph, SymbolRef } from './types.js';

export const DEFAULT_MAX_CHARS = 6_000;

/** `a/b/c.ts:3, a/b/d.ts` grouped as `a/b/ — c.ts:3, d.ts`, within a budget. */
export function groupedPaths(items: Array<{ path: string; note?: string }>, budget: number): { text: string; shown: number } {
  const byDir = new Map<string, string[]>();
  for (const it of items) {
    const d = dirOf(it.path);
    const list = byDir.get(d) ?? [];
    list.push(`${baseOf(it.path)}${it.note ? it.note : ''}`);
    byDir.set(d, list);
  }
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const [dir, names] of byDir) {
    const head = `  ${dir ? `${dir}/` : './'} — `;
    let line = head;
    for (const n of names) {
      const piece = (line === head ? '' : ', ') + n;
      if (used + line.length + piece.length > budget) break;
      line += piece;
      shown++;
    }
    if (line === head) break;
    lines.push(line);
    used += line.length + 1;
    if (used > budget) break;
  }
  return { text: lines.join('\n'), shown };
}

function more(total: number, shown: number, hint: string): string {
  return total > shown ? `\n  … ${total - shown} more (${hint})` : '';
}

export interface Target {
  file?: number;
  symbol?: string;
  error?: string;
}

/** `path`, `path#symbol`, or a bare symbol name, to a file and optional symbol. */
export function resolveTarget(g: CodeGraph, target: string | undefined): Target {
  const raw = (target ?? '').trim();
  if (!raw) return { error: 'needs a target: a file path, `path#symbol`, or a symbol name.' };
  const hash = raw.lastIndexOf('#');
  if (hash > 0) {
    const f = findFile(g, raw.slice(0, hash));
    const name = raw.slice(hash + 1);
    if (f.id === undefined) return { error: notFound(g, raw.slice(0, hash), f.candidates) };
    const decl = g.files[f.id]!.exports.find(e => e.name === name || e.name.endsWith(`.${name}`));
    if (!decl) {
      const names = g.files[f.id]!.exports.filter(e => !e.internal).map(e => e.name).slice(0, 30);
      return { error: `${g.files[f.id]!.path} declares no top-level \`${name}\`. It declares: ${names.join(', ') || 'nothing the graph reads'}.` };
    }
    return { file: f.id, symbol: decl.name };
  }
  const f = findFile(g, raw);
  if (f.id !== undefined) return { file: f.id };
  if (/[/\\.]/.test(raw) && !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(raw)) return { error: notFound(g, raw, f.candidates) };
  const decls = findSymbolDecls(g, raw);
  if (decls.length === 1) return { file: decls[0]!.file, symbol: decls[0]!.name };
  if (decls.length > 1) {
    const rows = decls.slice(0, 20).map(d => `  ${g.files[d.file]!.path}#${d.name}  — ${symbolUsers(g, d.file, d.name).length} user file(s)`);
    return { error: `\`${raw}\` is declared in ${decls.length} files — different symbols with the same name, never merged here. Pass target as path#name:\n${rows.join('\n')}` };
  }
  return { error: notFound(g, raw, f.candidates) };
}

function notFound(g: CodeGraph, q: string, candidates?: number[]): string {
  if (candidates?.length) return `"${q}" matches several files: ${candidates.slice(0, 12).map(c => g.files[c]!.path).join(', ')}. Pass a longer path.`;
  return `No indexed file or top-level symbol matches "${q}". The graph indexes ${g.files.length} source files (TS/JS, Python, Go, Java, Kotlin, C#, PHP, Ruby, Rust); Grep finds anything else.`;
}

const VIA_NOTE: Record<SymbolRef['via'], string> = {
  import: '', namespace: '', reexport: ' (re-export)', package: ' (same package)', inferred: ' (inferred)',
};

/** Who uses a symbol, then what depends on those files. */
export function reportSymbolImpact(g: CodeGraph, file: number, symbol: string, depth: number, maxChars: number): string {
  const f = g.files[file]!;
  const decl = f.exports.find(e => e.name === symbol);
  const users = symbolUsers(g, file, symbol);
  const direct = users.filter(u => u.via !== 'reexport');
  const reexports = users.filter(u => u.via === 'reexport');
  const head = `${symbol} — ${f.path}${decl ? `:${decl.line}` : ''}${decl?.sig ? `\n  ${decl.sig}` : ''}`;
  if (users.length === 0) {
    return `${head}\nNo file uses it through an import the graph resolves. It may be unused, used only in ${f.path}, or reached dynamically — Grep for the name to be sure.`;
  }
  const items = direct.map(u => {
    const path = g.files[u.file]!.path;
    const alias = u.local !== symbol && !u.local.endsWith(`.${symbol}`) ? ` as ${u.local}` : u.local !== symbol ? ` (${u.local})` : '';
    return { path, note: `${u.lines.length ? `:${u.lines[0]}` : ''}${alias}${VIA_NOTE[u.via]}` };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const tests = direct.filter(u => g.files[u.file]!.isTest).length;
  const budget = Math.max(1_500, maxChars - 900);
  const grouped = groupedPaths(items, budget);
  const parts = [
    head,
    `Used directly in ${direct.length} file(s)${tests ? ` (${tests} tests)` : ''} — resolved through imports, aliases, barrels and namespaces; same-named symbols in other files are not included:`,
    grouped.text + more(items.length, grouped.shown, 'raise maxChars'),
  ];
  if (reexports.length) parts.push(`Re-exported by: ${reexports.map(u => `${g.files[u.file]!.path}${u.local !== symbol ? ` as ${u.local}` : ''}`).join(', ')}`);
  if (depth > 1) {
    const layers = impactLayers(g, [file], depth, direct.map(u => u.file));
    const beyond = layers.slice(1);
    const count = beyond.reduce((n, l) => n + l.files.length, 0);
    if (count) {
      const sample = beyond.flatMap(l => l.files).slice(0, 25).map(id => g.files[id]!.path);
      parts.push(`Then ${count} more file(s) depend on those (depth ≤ ${depth}): ${sample.join(', ')}${count > sample.length ? ', …' : ''}`);
    }
  }
  if (f.lang === 'ts' || f.lang === 'js') parts.push('Line-exact references: Refactor {"action":"findReferences","path":"' + f.path + '","symbol":"' + symbol + '"} (load the refactor group).');
  else if (direct.some(u => u.via === 'inferred')) parts.push('(inferred) = linked by a unique name in scope, not an explicit import.');
  return parts.join('\n');
}

/** What depends on a file, by depth, with the tests that reach it. */
export function reportFileImpact(g: CodeGraph, file: number, depth: number, maxChars: number): string {
  const f = g.files[file]!;
  const layers = impactLayers(g, [file], depth);
  const total = layers.reduce((n, l) => n + l.files.length, 0);
  const exportsLine = f.exports.filter(e => !e.internal).slice(0, 12).map(e => `${e.name} (${symbolUsers(g, file, e.name).filter(u => u.via !== 'reexport').length})`).join(', ');
  const parts = [`${f.path} — ${f.loc} lines, imported by ${f.fanIn} file(s), imports ${f.fanOut}${f.churn ? `, ${f.churn} recent commits` : ''}`];
  if (exportsLine) parts.push(`Exports (direct users): ${exportsLine}`);
  if (total === 0) { parts.push('Nothing in the project depends on it through a resolved import.'); return parts.join('\n'); }
  let budget = Math.max(1_500, maxChars - 600);
  for (const layer of layers) {
    const items = layer.files.map(id => {
      const e = g.edges.find(x => x.from === id && layer.depth === 1 && x.to === file);
      return { path: g.files[id]!.path, note: e?.names.length ? ` [${e.names.slice(0, 3).join(', ')}${e.names.length > 3 ? ', …' : ''}]` : '' };
    });
    const grouped = groupedPaths(items, budget);
    parts.push(`Depth ${layer.depth} — ${layer.files.length} file(s):\n${grouped.text}${more(items.length, grouped.shown, 'raise maxChars or lower depth')}`);
    budget -= grouped.text.length;
    if (budget < 300) break;
  }
  const allIds = layers.flatMap(l => l.files);
  const tests = allIds.filter(id => g.files[id]!.isTest);
  parts.push(tests.length ? `Tests that reach it (${tests.length}): ${tests.slice(0, 15).map(id => g.files[id]!.path).join(', ')}${tests.length > 15 ? ', …' : ''}` : 'No test file reaches it through imports.');
  const partners = g.cochange.filter(c => c.a === file || c.b === file).slice(0, 5);
  if (partners.length) parts.push(`Changes together with (git history, not imports): ${partners.map(c => `${g.files[c.a === file ? c.b : c.a]!.path} (${c.count}×)`).join(', ')}`);
  return parts.join('\n');
}

export function reportDependents(g: CodeGraph, file: number, maxChars: number): string {
  const f = g.files[file]!;
  const edges = g.edges.filter(e => e.to === file && !e.passThrough);
  if (!edges.length) return `${f.path}: nothing imports it${f.entry ? ` (an entry point: ${f.entry})` : ''}.`;
  const items = edges.map(e => ({ path: g.files[e.from]!.path, note: `${e.names.length ? ` [${e.names.slice(0, 4).join(', ')}${e.names.length > 4 ? ', …' : ''}]` : ''}${e.confidence === 'inferred' ? ' (inferred)' : ''}` })).sort((a, b) => a.path.localeCompare(b.path));
  const grouped = groupedPaths(items, maxChars - 200);
  return `${f.path} is used by ${edges.length} file(s) [symbols they use]:\n${grouped.text}${more(items.length, grouped.shown, 'raise maxChars')}`;
}

export function reportDependencies(g: CodeGraph, file: number, maxChars: number): string {
  const f = g.files[file]!;
  const edges = g.edges.filter(e => e.from === file && !e.passThrough);
  const ext = [...g.external.entries()].filter(([, ids]) => ids.includes(file)).map(([p]) => p);
  const items = edges.map(e => ({ path: g.files[e.to]!.path, note: `${e.names.length ? ` [${e.names.slice(0, 4).join(', ')}${e.names.length > 4 ? ', …' : ''}]` : ''}${e.kind === 'package' ? ' (same package)' : e.confidence === 'inferred' ? ' (inferred)' : ''}` })).sort((a, b) => a.path.localeCompare(b.path));
  const grouped = groupedPaths(items, maxChars - 300);
  const unresolved = g.unresolved.filter(u => u.file === file).map(u => u.spec);
  return [
    `${f.path} depends on ${edges.length} project file(s)${ext.length ? ` and ${ext.length} external package(s)` : ''}:`,
    grouped.text + more(items.length, grouped.shown, 'raise maxChars'),
    ext.length ? `External: ${ext.slice(0, 30).join(', ')}` : '',
    unresolved.length ? `Unresolved local imports: ${unresolved.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export function reportPath(g: CodeGraph, from: number, to: number): string {
  const a = g.files[from]!.path;
  const b = g.files[to]!.path;
  const path = shortestPath(g, from, to);
  const hop = (p: number[]): string => p.map((id, i) => {
    if (i === 0) return `  ${g.files[id]!.path}`;
    const e = g.edges.find(x => x.from === p[i - 1] && x.to === id);
    const how = e ? ` — via ${e.names.slice(0, 4).join(', ') || e.kind}${e.confidence === 'inferred' ? ' (inferred: interface implementation or unique name)' : ''}` : '';
    return `  → ${g.files[id]!.path}${how}`;
  }).join('\n');
  if (path) return `Shortest dependency path ${a} → ${b} (${path.length - 1} hop(s)):\n${hop(path)}`;
  const back = shortestPath(g, to, from);
  if (back) return `No path from ${a} to ${b}, but ${b} reaches ${a} (${back.length - 1} hop(s)):\n${hop(back)}`;
  return `No dependency path between ${a} and ${b} in either direction. Calls through dynamic dispatch, dependency injection by name, events or HTTP are invisible to an import graph.`;
}

export function reportCycles(g: CodeGraph, maxChars: number): string {
  const comps = cycles(g);
  if (!comps.length) return 'No import cycles.';
  const lines = [`${comps.length} import cycle(s) (largest first):`];
  let used = 0;
  for (const comp of comps) {
    const w = cycleWitness(g, comp).map(id => g.files[id]!.path);
    const line = `  ${comp.length} files: ${w.join(' → ')}`;
    if (used + line.length > maxChars - 100) { lines.push(`  … ${comps.length - lines.length + 1} more`); break; }
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

export function reportHotspots(g: CodeGraph, limit: number): string {
  if (!g.git.available) {
    const top = [...g.files].sort((a, b) => b.fanIn - a.fanIn).slice(0, limit);
    return `No git history here, so no churn. Most depended-on files instead:\n${top.map(f => `  ${f.path} — imported by ${f.fanIn}, ${f.loc} lines`).join('\n')}`;
  }
  const top = [...g.files].filter(f => f.hotspot > 0).sort((a, b) => b.hotspot - a.hotspot).slice(0, limit);
  if (!top.length) return 'No file has changed in the recent history window.';
  return `Hotspots (recent churn × importers × size; last ${g.git.commits} commits):\n${top.map(f => `  ${f.path} — ${f.churn} commits, imported by ${f.fanIn}, ${f.loc} lines${f.authors.length ? `, mostly ${f.authors[0]![0]}` : ''}`).join('\n')}`;
}

export function reportEntrypoints(g: CodeGraph, maxChars: number): string {
  const entries = g.files.filter(f => f.entry && !f.isTest);
  if (!entries.length) return 'No entry points recognised (main functions, routes, pages, package bins, scripts).';
  const by = new Map<string, string[]>();
  for (const f of entries) { const l = by.get(f.entry!) ?? []; l.push(f.path); by.set(f.entry!, l); }
  const lines: string[] = [`${entries.length} entry point(s):`];
  for (const [why, paths] of by) {
    const g2 = groupedPaths(paths.map(p => ({ path: p })), Math.max(400, Math.floor(maxChars / by.size)));
    lines.push(`${why} (${paths.length}):\n${g2.text}${more(paths.length, g2.shown, 'raise maxChars')}`);
  }
  return lines.join('\n');
}

export function reportCochange(g: CodeGraph, file: number | undefined, limit: number): string {
  if (!g.git.available) return 'No git history here, so no co-change signal.';
  const list = file === undefined ? g.cochange.slice(0, limit) : g.cochange.filter(c => c.a === file || c.b === file).slice(0, limit);
  if (!list.length) return file === undefined ? 'No files changed together more than once in the recent history.' : `${g.files[file]!.path} has not changed together with another file more than once in the last ${g.git.commits} commits.`;
  const head = file === undefined
    ? `Files that change together (last ${g.git.commits} commits; commits over 40 files ignored):`
    : `${g.files[file]!.path} changes together with (last ${g.git.commits} commits):`;
  const linked = new Set(g.edges.map(e => `${e.from},${e.to}`));
  const rows = list.map(c => {
    const other = file === undefined ? `${g.files[c.a]!.path} ⇄ ${g.files[c.b]!.path}` : g.files[c.a === file ? c.b : c.a]!.path;
    const imports = linked.has(`${c.a},${c.b}`) || linked.has(`${c.b},${c.a}`);
    return `  ${other} — ${c.count} commits together (${Math.round(c.confidence * 100)}%)${imports ? '' : ', no import between them'}`;
  });
  return `${head}\n${rows.join('\n')}`;
}

export function reportOverview(g: CodeGraph, rules: LayerRule[], maxChars: number): string {
  const langs = new Map<string, number>();
  for (const f of g.files) langs.set(f.lang, (langs.get(f.lang) ?? 0) + 1);
  const tests = g.files.filter(f => f.isTest).length;
  const hubs = [...g.files].sort((a, b) => b.fanIn - a.fanIn).slice(0, 8).filter(f => f.fanIn > 0);
  const ext = [...g.external.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12);
  const comps = cycles(g);
  const orphanList = orphans(g);
  const violations = rules.length ? layerViolations(g, rules) : [];
  const entries = g.files.filter(f => f.entry && !f.isTest);
  const lines = [
    `${g.files.length} source files (${[...langs.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')}), ${tests} tests, ${g.edges.filter(e => !e.passThrough).length} dependencies${g.stats.truncated ? ' — TRUNCATED at the file limit' : ''}.`,
    `Modules (communities of files that depend on each other):`,
    ...g.communities.slice(0, 14).map(c => {
      const top = c.files.map(id => g.files[id]!).sort((a, b) => b.fanIn - a.fanIn).slice(0, 3).map(f => baseOf(f.path));
      return `  ${c.label} — ${c.files.length} files (core: ${top.join(', ')})`;
    }),
    g.communities.length > 14 ? `  … ${g.communities.length - 14} smaller` : '',
    hubs.length ? `Most depended-on: ${hubs.map(f => `${f.path} (${f.fanIn})`).join(', ')}` : '',
    entries.length ? `Entry points: ${entries.slice(0, 10).map(f => `${f.path} (${f.entry})`).join(', ')}${entries.length > 10 ? `, … ${entries.length - 10} more` : ''}` : '',
    ext.length ? `External packages by importing files: ${ext.map(([p, ids]) => `${p} ${ids.length}`).join(', ')}` : '',
    comps.length ? `Import cycles: ${comps.length} (largest ${comps[0]!.length} files) — action "cycles" lists them.` : 'No import cycles.',
    orphanList.length ? `Files nothing imports (not entry points, tests or config): ${orphanList.length}${orphanList.length <= 8 ? ` — ${orphanList.map(id => g.files[id]!.path).join(', ')}` : ''}` : '',
    rules.length ? `Layering rules: ${violations.length ? `${violations.length} violation(s): ${violations.slice(0, 5).map(v => `${g.files[v.from]!.path} → ${g.files[v.to]!.path}`).join('; ')}` : 'all respected'}` : '',
    g.git.available ? `Git: last ${g.git.commits} commits read for churn and co-change.` : 'Not a git repository (no churn or co-change).',
  ].filter(Boolean);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 20)}\n…` : text;
}

export function reportChanges(g: CodeGraph, changed: string[], depth: number, maxChars: number): string {
  if (!changed.length) return 'No uncommitted changes.';
  const ids = changed.map(p => findFile(g, p).id).filter((x): x is number => x !== undefined);
  const others = changed.length - ids.length;
  if (!ids.length) return `${changed.length} changed file(s), none of them indexed source: ${changed.slice(0, 10).join(', ')}`;
  const layers = impactLayers(g, ids, depth);
  const affected = layers.flatMap(l => l.files);
  const tests = affected.filter(id => g.files[id]!.isTest).concat(ids.filter(id => g.files[id]!.isTest));
  const grouped = groupedPaths(affected.map(id => ({ path: g.files[id]!.path })), maxChars - 800);
  return [
    `${ids.length} changed source file(s)${others ? ` (+${others} other files)` : ''}: ${ids.map(id => g.files[id]!.path).join(', ')}`,
    affected.length ? `They affect ${affected.length} file(s) (depth ≤ ${depth}):\n${grouped.text}${more(affected.length, grouped.shown, 'raise maxChars')}` : 'Nothing else depends on them.',
    tests.length ? `Tests to run: ${[...new Set(tests)].slice(0, 20).map(id => g.files[id]!.path).join(', ')}` : 'No test reaches the change through imports.',
  ].join('\n');
}

/** The direct-dependency adjacency as a compact list, for sub-agent context. */
export function neighbourhood(g: CodeGraph, ids: number[], maxChars = 3_000): string {
  const adj = adjacency(g);
  const lines: string[] = [];
  for (const id of ids) {
    const f = g.files[id]!;
    lines.push(`${f.path}: imports ${adj.out[id]!.slice(0, 12).map(x => g.files[x]!.path).join(', ') || 'nothing'}; used by ${adj.in[id]!.slice(0, 12).map(x => g.files[x]!.path).join(', ') || 'nothing'}`);
    if (lines.join('\n').length > maxChars) break;
  }
  return lines.join('\n');
}

export { mermaidArchitecture };
