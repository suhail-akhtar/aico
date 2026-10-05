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
 * Method callers (`path#Class.method`) come from receiver types
 * (codegraph/members); for TS/JS the answer waits briefly for the TypeScript
 * checker when it is still running, so a caller list is the checker's when it
 * can be. `exact: true` drops everything that rests on an interface or a
 * unique name; `implementations` explains which types satisfy an interface
 * and by which methods.
 *
 * @module tools/codegraph
 */

import { currentCwd } from '../run-context.js';
import { exactUsersOnDemand, getCodeGraph } from '../codegraph/index.js';
import { uncommittedFiles } from '../codegraph/git.js';
import { codeGraphRules } from '../codegraph/rules.js';
import { exactOnly } from '../codegraph/view.js';
import {
  DEFAULT_MAX_CHARS, implementationsText, mermaidArchitecture, reportChanges, reportCochange, reportCycles, reportDependencies, reportDependents,
  reportEntrypoints, reportFileImpact, reportHotspots, reportOverview, reportPath, reportSymbolImpact, resolveTarget,
} from '../codegraph/report.js';

export type CodeGraphAction = 'overview' | 'impact' | 'dependents' | 'dependencies' | 'path' | 'cycles' | 'hotspots' | 'entrypoints' | 'cochange' | 'changes' | 'diagram' | 'implementations';

/** How long an answer waits for the TypeScript checker still running behind the graph. */
const EXACT_WAIT_MS = 20_000;

export interface CodeGraphInput {
  action?: CodeGraphAction;
  target?: string;
  to?: string;
  depth?: number;
  limit?: number;
  maxChars?: number;
  refresh?: boolean;
  /** Only what is certain: leave out calls and edges that go through an interface or rest on a unique name. */
  exact?: boolean;
}

export async function codeGraphTool(input: CodeGraphInput): Promise<string> {
  const root = currentCwd();
  const full = await getCodeGraph(root, { force: input.refresh === true, exact: EXACT_WAIT_MS });
  const g = input.exact === true ? exactOnly(full) : full;
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
      return reportOverview(g, await codeGraphRules(root), maxChars);
    case 'impact': {
      const t = need();
      if (typeof t === 'string') return t;
      return t.symbol ? reportSymbolImpact(g, t.file, t.symbol, depth, maxChars, await exactUsersOnDemand(full, t.file, t.symbol)) : reportFileImpact(g, t.file, depth, maxChars);
    }
    case 'dependents': {
      const t = need();
      if (typeof t === 'string') return t;
      return t.symbol ? reportSymbolImpact(g, t.file, t.symbol, 1, maxChars, await exactUsersOnDemand(full, t.file, t.symbol)) : reportDependents(g, t.file, maxChars);
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
    case 'implementations': {
      const t = need();
      if (typeof t === 'string') return t;
      const text = implementationsText(full, t.file, t.symbol?.split('.')[0], maxChars);
      return text || `${full.files[t.file]!.path}${t.symbol ? `#${t.symbol}` : ''}: no interface declared here has an implementation in the project, and no type here implements one the graph knows.`;
    }
    case 'diagram':
      return `\`\`\`mermaid\n${mermaidArchitecture(g, { maxNodes: limit > 15 ? limit : 18 })}\n\`\`\`\nArchitecture from the real import graph: each box is a module (files that depend on each other), arrows are dependencies with their count.`;
    default:
      throw new Error('CodeGraph: action must be overview, impact, dependents, dependencies, path, cycles, hotspots, entrypoints, cochange, changes, implementations or diagram.');
  }
}

export const codeGraphDefinition = {
  name: 'CodeGraph',
  description: [
    'The project\'s dependency graph, resolved like the compiler does: tsconfig `@/` aliases, barrels and re-exports,',
    'renamed imports, namespaces, Python packages/relative imports, Go packages, Java/C# namespaces; same-named',
    'symbols in other files are never mixed in. Use it before a change to know what it affects, instead of Grep.',
    'target: "path/file.ts", "path/file.ts#symbol" (methods: #Class.method), or a symbol name (ambiguous names list their files).',
    '  impact       — who uses a symbol or calls a method (receiver types resolved; via interface marked), or what depends on a file',
    '  dependents / dependencies — direct importers (with the symbols they use) / what a file imports',
    '  path         — shortest dependency path target → to (e.g. route → database)',
    '  cochange     — files that change together in git history though no import links them',
    '  changes      — what the uncommitted diff affects, and the tests to run',
    '  implementations — types implementing an interface (or interfaces a type implements), with the methods; Go by method set',
    '  overview, entrypoints, hotspots, cycles, diagram (Mermaid architecture for docs). exact:true = certain links only',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['overview', 'impact', 'dependents', 'dependencies', 'path', 'cycles', 'hotspots', 'entrypoints', 'cochange', 'changes', 'implementations', 'diagram'] },
      target: { type: 'string', description: 'File path, path#symbol, or symbol name.' },
      to: { type: 'string', description: 'path: the destination file or path#symbol.' },
      depth: { type: 'number', description: 'impact/changes: levels of dependents (default 2).' },
      limit: { type: 'number', description: 'Rows for hotspots/cochange (default 15).' },
      maxChars: { type: 'number', description: 'Answer budget (default 6000).' },
      refresh: { type: 'boolean', description: 'Re-index first (files just created).' },
      exact: { type: 'boolean', description: 'Leave out links through interfaces or unique names.' },
    },
    required: [] as string[],
  },
};
