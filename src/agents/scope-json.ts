/**
 * A `ToolScope` (agents/effective) as JSON, and back.
 *
 * A background agent's bounds have to survive a restart (ADR 0021): resuming
 * an interrupted agent with an open scope because its real one lived in a
 * `Set` that died with the process would turn "aico restarted" into a way to
 * widen what an agent may do. So the scope it ran under is written to its
 * ledger record, and a resume rebuilds it — then narrows it further by whoever
 * asks for the resume, never the other way round.
 *
 * @module agents/scope-json
 */

import type { ScopeLayer, ToolScope, WriteBound } from './effective.js';
import type { SerializedScope } from '../work/types.js';

export function serializeScope(scope: ToolScope | undefined): SerializedScope | undefined {
  if (!scope) return undefined;
  return {
    layers: scope.layers.map(l => ({
      label: l.label,
      tools: l.tools === 'all' ? 'all' : [...l.tools],
      mcp: l.mcp === 'all' || l.mcp === 'readonly' ? l.mcp : [...l.mcp],
      ...(l.deny?.length ? { deny: [...l.deny] } : {}),
    })),
    delegate: scope.delegate,
    ...(scope.delegateTo ? { delegateTo: scope.delegateTo === 'readonly' ? 'readonly' : [...scope.delegateTo] } : {}),
    ...(scope.writeBounds?.length
      ? { writeBounds: scope.writeBounds.map(b => ({ label: b.label, root: b.root, globs: [...b.globs] })) }
      : {}),
  };
}

export function deserializeScope(json: SerializedScope | undefined): ToolScope | undefined {
  if (!json || !Array.isArray(json.layers)) return undefined;
  const layers: ScopeLayer[] = json.layers.map(l => ({
    label: String(l.label),
    tools: l.tools === 'all' ? 'all' : new Set((l.tools ?? []).map(String)),
    mcp: l.mcp === 'all' || l.mcp === 'readonly' ? l.mcp : (l.mcp ?? []).map(String),
    ...(l.deny?.length ? { deny: l.deny.map(String) } : {}),
  }));
  const writeBounds: WriteBound[] = (json.writeBounds ?? []).map(b => ({ label: b.label, root: b.root, globs: b.globs }));
  return {
    layers,
    delegate: json.delegate !== false,
    ...(json.delegateTo ? { delegateTo: json.delegateTo } : {}),
    ...(writeBounds.length ? { writeBounds } : {}),
  };
}

/**
 * Both scopes at once: every layer and write bound of each, and delegation only
 * where both allow it. Used when a resume is asked for by a run whose own
 * scope is narrower than the one the agent was started under.
 */
export function intersectScopes(a: ToolScope | undefined, b: ToolScope | undefined): ToolScope | undefined {
  if (!a) return b;
  if (!b) return a;
  const writeBounds = [...(a.writeBounds ?? []), ...(b.writeBounds ?? [])];
  return {
    layers: [...a.layers, ...b.layers],
    delegate: a.delegate && b.delegate,
    ...(a.delegateTo ?? b.delegateTo ? { delegateTo: (a.delegateTo ?? b.delegateTo)! } : {}),
    ...(writeBounds.length ? { writeBounds } : {}),
  };
}
