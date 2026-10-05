/**
 * The Code map view's routes (ADR 0028).
 *
 *   GET /api/codegraph/graph?path=             the whole graph, compact (codegraph/view)
 *   GET /api/codegraph/version?path=           refresh if stale; the version, so a view knows to reload
 *   GET /api/codegraph/file?path=&file=        one file: exports and their users, importers, imports, history
 *   GET /api/codegraph/symbol?path=&file=&name= who uses one symbol, with lines
 *   GET /api/codegraph/diff?path=              uncommitted files, as graph ids
 *   GET /api/codegraph/mermaid?path=           the architecture as a Mermaid flowchart
 *   GET /api/codegraph/context?path=&ids=      "Ask AICO about this": the selection as chat context
 *
 * ## Only registered projects
 *
 * `path` must be a project the server already knows (`isKnownProject`), the
 * same rule every other route that takes a folder follows: without it the
 * parameter would be a way to make the engine walk and describe any directory
 * on the machine. Answers carry project-relative paths, symbol names and line
 * numbers — never file contents.
 *
 * @module server/codegraph-routes
 */

import type http from 'node:http';
import path from 'node:path';
import { exactUsersOnDemand, getCodeGraph, findFile } from '../codegraph/index.js';
import { codeGraphRules } from '../codegraph/rules.js';
import { uncommittedFiles } from '../codegraph/git.js';
import { mermaidArchitecture, type LayerRule } from '../codegraph/analyze.js';
import { fileDetail, selectionContext, symbolDetail, viewPayload } from '../codegraph/view.js';

export interface CodeGraphRouteDeps {
  send: (res: http.ServerResponse, status: number, body: unknown) => void;
  /** Whether a folder is a registered project (server/projects isKnownProject). */
  isKnownProject: (dir: string) => Promise<boolean>;
  /** Layering rules for a project (settings `codeGraph.rules`). */
  rulesFor?: (dir: string) => Promise<LayerRule[]>;
}

export interface CodeGraphAnswer { status: number; body: unknown }

/** The route logic without HTTP, for tests. */
export async function codeGraphAnswer(route: string, params: URLSearchParams, deps: Omit<CodeGraphRouteDeps, 'send'>): Promise<CodeGraphAnswer | undefined> {
  if (!route.startsWith('codegraph/')) return undefined;
  const raw = params.get('path') ?? '';
  if (!raw) return { status: 400, body: { error: 'path required' } };
  const root = path.resolve(raw);
  if (!await deps.isKnownProject(root)) return { status: 403, body: { error: 'not a registered project' } };

  const g = await getCodeGraph(root, { force: params.get('refresh') === '1' });
  const fileParam = (): number | undefined => {
    const f = params.get('file');
    if (!f) return undefined;
    if (/^\d+$/.test(f)) return Number(f) < g.files.length ? Number(f) : undefined;
    return findFile(g, f).id;
  };
  switch (route) {
    case 'codegraph/graph':
      return { status: 200, body: viewPayload(g, await (deps.rulesFor ?? projectLayerRules)(root)) };
    case 'codegraph/version':
      return { status: 200, body: { version: g.version, files: g.files.length } };
    case 'codegraph/file': {
      const id = fileParam();
      if (id === undefined) return { status: 404, body: { error: 'no such file in the graph' } };
      return { status: 200, body: fileDetail(g, id) };
    }
    case 'codegraph/symbol': {
      const id = fileParam();
      const name = params.get('name') ?? '';
      if (id === undefined || !name) return { status: 404, body: { error: 'file and name required' } };
      // A project over the whole-project checker's limit: this symbol, exactly, on demand (time-boxed).
      return { status: 200, body: symbolDetail(g, id, name, await exactUsersOnDemand(g, id, name)) };
    }
    case 'codegraph/diff': {
      const changed = await uncommittedFiles(root);
      const ids = changed.map(p => findFile(g, p).id).filter((x): x is number => x !== undefined);
      return { status: 200, body: { changed, ids } };
    }
    case 'codegraph/mermaid':
      return { status: 200, body: { mermaid: mermaidArchitecture(g, { maxNodes: Math.min(40, Number(params.get('nodes')) || 18) }) } };
    case 'codegraph/symbols': {
      // Exported symbols whose name matches, for the view's search box.
      const q = (params.get('q') ?? '').trim().toLowerCase();
      if (q.length < 2) return { status: 200, body: { symbols: [] } };
      const hits: Array<{ file: number; name: string; kind: string; line: number; exact: boolean }> = [];
      for (const f of g.files) {
        for (const e of f.exports) {
          if (e.internal) continue;
          const n = e.name.toLowerCase();
          if (n === q || n.startsWith(q) || (q.length >= 3 && n.includes(q))) hits.push({ file: f.id, name: e.name, kind: e.kind, line: e.line, exact: n === q });
        }
        if (hits.length > 400) break;
      }
      // Exact names first, and among same-named symbols the most used: the one people usually mean.
      const users = (h: { file: number; name: string }): number => (g.symbols.get(`${h.file}:${h.name}`) ?? []).length;
      hits.sort((a, b) => Number(b.exact) - Number(a.exact) || users(b) - users(a) || a.name.length - b.name.length);
      return { status: 200, body: { symbols: hits.slice(0, 20) } };
    }
    case 'codegraph/context': {
      const ids = (params.get('ids') ?? '').split(',').filter(s => /^\d+$/.test(s)).map(Number).filter(n => n < g.files.length).slice(0, 40);
      return { status: 200, body: { text: selectionContext(g, ids) } };
    }
    default:
      return { status: 404, body: { error: 'unknown codegraph route' } };
  }
}

/**
 * A project's layering rules: the union of the person's own (global and for
 * this project) and the project's files — a project adds rules, never removes
 * the person's (codegraph/rules).
 */
export async function projectLayerRules(dir: string): Promise<LayerRule[]> {
  return codeGraphRules(dir);
}

export async function handleCodeGraphRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: CodeGraphRouteDeps): Promise<boolean> {
  if (!route.startsWith('codegraph/')) return false;
  if ((req.method ?? 'GET') !== 'GET') { deps.send(res, 405, { error: 'GET only' }); return true; }
  try {
    const answer = await codeGraphAnswer(route, url.searchParams, deps);
    if (!answer) return false;
    deps.send(res, answer.status, answer.body);
  } catch (err) {
    deps.send(res, 500, { error: (err as Error).message });
  }
  return true;
}
