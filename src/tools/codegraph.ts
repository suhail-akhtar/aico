/**
 * `CodeGraph`: the project's dependency graph, as the agent reaches it.
 *
 * Deferred (group `graph`, tools/deferred.ts): the schema costs nothing until
 * a turn loads it, and a request that asks about impact, callers, usages,
 * dependencies, paths or architecture loads it outright — the Phase 0
 * benchmark (ADR 0028) found models rarely call a graph tool they have to
 * remember exists, and that extra always-sent schemas cost tokens on every
 * request.
 *
 * Every answer is bounded (`maxChars`, default ~6,000 characters) and
 * grouped by folder so a complete caller list fits; ambiguity is answered with
 * the candidates, never merged (codegraph/report).
 *
 * @module tools/codegraph
 */

import { currentCwd, currentRunContext } from '../run-context.js';
import { getCodeGraph } from '../codegraph/index.js';
import { uncommittedFiles } from '../codegraph/git.js';
import type { LayerRule } from '../codegraph/analyze.js';
import {
  DEFAULT_MAX_CHARS, mermaidArchitecture, reportChanges, reportCochange, reportCycles, reportDependencies, reportDependents,
  reportEntrypoints, reportFileImpact, reportHotspots, reportOverview, reportPath, reportSymbolImpact, resolveTarget,
} from '../codegraph/report.js';

export type CodeGraphAction = 'overview' | 'impact' | 'dependents' | 'dependencies' | 'path' | 'cycles' | 'hotspots' | 'entrypoints' | 'cochange' | 'changes' | 'diagram';

export interface CodeGraphInput {
  action?: CodeGraphAction;
  target?: string;
  to?: string;
  depth?: number;
  limit?: number;
  maxChars?: number;
  refresh?: boolean;
}

/** Layering rules from the run's settings (`codeGraph.rules`). */
function layerRules(): LayerRule[] {
  const rules = (currentRunContext()?.settings as { codeGraph?: { rules?: unknown } } | undefined)?.codeGraph?.rules;
  return Array.isArray(rules)
    ? rules.filter((r): r is LayerRule => Boolean(r) && typeof (r as LayerRule).from === 'string' && typeof (r as LayerRule).to === 'string')
    : [];
}

export async function codeGraphTool(input: CodeGraphInput): Promise<string> {
  const root = currentCwd();
  const g = await getCodeGraph(root, { force: input.refresh === true });
  const action = input.action ?? 'overview';
  const maxChars = Math.min(20_000, Math.max(1_500, Number(input.maxChars) || DEFAULT_MAX_CHARS));
  const depth = Math.min(6, Math.max(1, Number(input.depth) || (action === 'impact' ? 2 : 3)));
  const limit = Math.min(100, Math.max(1, Number(input.limit) || 15));
  if (g.files.length === 0) return 'No source files found in this project (TS/JS, Python, Go, Java, Kotlin, C#, PHP, Ruby, Rust).';

  const need = (): { file: number; symbol?: string } | string => {
    const t = resolveTarget(g, input.target);
    if (t.error) return `CodeGraph ${action}: ${t.error}`;
    return { file: t.file!, ...(t.symbol ? { symbol: t.symbol } : {}) };
  };

  switch (action) {
    case 'overview':
      return reportOverview(g, layerRules(), maxChars);
    case 'impact': {
      const t = need();
      if (typeof t === 'string') return t;
      return t.symbol ? reportSymbolImpact(g, t.file, t.symbol, depth, maxChars) : reportFileImpact(g, t.file, depth, maxChars);
    }
    case 'dependents': {
      const t = need();
      if (typeof t === 'string') return t;
      return t.symbol ? reportSymbolImpact(g, t.file, t.symbol, 1, maxChars) : reportDependents(g, t.file, maxChars);
    }
    case 'dependencies': {
      const t = need();
      if (typeof t === 'string') return t;
      return reportDependencies(g, t.file, maxChars);
    }
    case 'path': {
      const a = need();
      if (typeof a === 'string') return a;
      const b = resolveTarget(g, input.to);
      if (b.error) return `CodeGraph path: "to" — ${b.error}`;
      return reportPath(g, a.file, b.file!);
    }
    case 'cycles':
      return reportCycles(g, maxChars);
    case 'hotspots':
      return reportHotspots(g, limit);
    case 'entrypoints':
      return reportEntrypoints(g, maxChars);
    case 'cochange': {
      if (!input.target) return reportCochange(g, undefined, limit);
      const t = need();
      if (typeof t === 'string') return t;
      return reportCochange(g, t.file, limit);
    }
    case 'changes':
      return reportChanges(g, await uncommittedFiles(root), depth, maxChars);
    case 'diagram':
      return `\`\`\`mermaid\n${mermaidArchitecture(g, { maxNodes: limit > 15 ? limit : 18 })}\n\`\`\`\nArchitecture from the real import graph: each box is a module (files that depend on each other), arrows are dependencies with their count.`;
    default:
      throw new Error('CodeGraph: action must be overview, impact, dependents, dependencies, path, cycles, hotspots, entrypoints, cochange, changes or diagram.');
  }
}

export const codeGraphDefinition = {
  name: 'CodeGraph',
  description: [
    'The project\'s dependency graph, resolved like the compiler does: tsconfig `@/` aliases, barrels and re-exports,',
    'renamed imports, namespaces, Python packages/relative imports, Go packages, Java/C# namespaces; same-named',
    'symbols in other files are never mixed in. Use it before a change to know what it affects, instead of Grep.',
    'target: "path/file.ts", "path/file.ts#symbol", or a symbol name (ambiguous names list their files).',
    '  impact       — who uses a symbol (every file, with line) or what depends on a file, by depth; tests that reach it',
    '  dependents / dependencies — direct importers (with the symbols they use) / what a file imports',
    '  path         — shortest dependency path target → to (e.g. route → database)',
    '  cochange     — files that change together in git history though no import links them',
    '  changes      — what the uncommitted diff affects, and the tests to run',
    '  overview, entrypoints, hotspots, cycles, diagram (Mermaid architecture for docs)',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['overview', 'impact', 'dependents', 'dependencies', 'path', 'cycles', 'hotspots', 'entrypoints', 'cochange', 'changes', 'diagram'] },
      target: { type: 'string', description: 'File path, path#symbol, or symbol name.' },
      to: { type: 'string', description: 'path: the destination file or path#symbol.' },
      depth: { type: 'number', description: 'impact/changes: levels of dependents (default 2).' },
      limit: { type: 'number', description: 'Rows for hotspots/cochange (default 15).' },
      maxChars: { type: 'number', description: 'Answer budget (default 6000).' },
      refresh: { type: 'boolean', description: 'Re-index first (files just created).' },
    },
    required: [] as string[],
  },
};
