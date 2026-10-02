/**
 * What an agent run may use: one resolver, applied to both what is offered and
 * what is dispatched.
 *
 * Before this, a restriction bound only the run it was written on. A read-only
 * `review` agent was offered `Task` like everyone else, and a child asking for
 * `tools: 'all'` resolved the full built-in set — so "read-only" was one tool
 * call away from Write. `canDelegate: false` was a sentence in the prompt.
 * Agent allow-lists ignored MCP altogether, which made the desktop editor's
 * `mcp:<server>` chips a promise nothing kept.
 *
 * The rule is the design's §4.3 (docs/engineering/design/agents-skills-tools.md):
 *
 *     effective(d) = own allow-list ∩ effective(d−1) ∩ settings
 *
 * kept as a list of layers, every one of which must allow a tool. Intersection
 * by layering rather than by computing a set up front, because MCP tools
 * arrive mid-run (a server added during the turn) and a set computed at the
 * start would not know them. A child's scope is its parent's layers plus its
 * own, so it can never hold more than its parent: `tools: 'all'` adds nothing
 * and means "all of mine".
 *
 * Delegation (`Task`, `Investigate`) is decided by `canDelegate`, not by the
 * tool lists — a spec's list naming `Task` was never what turned it on, and a
 * child inherits its parent's "no".
 *
 * Custom tools (custom-tools/) are named in an allow-list as `custom:<name>`
 * (or by their bare name); either spelling admits exactly that tool. A list
 * that names none admits none — a restricted agent never picks up a tool a
 * person installed later.
 *
 * What it does not do: decide permission prompts (that is the permission
 * stage), or validate names at save time (the design's Phase 3). Unknown names
 * simply match nothing.
 *
 * @module agents/effective
 */

import { isMcpToolName, isReadOnlyMcpTool, parseMcpToolName } from '../mcp/policy.js';

/** An allow-list as specs and Task carry it. */
export type ToolAllow = readonly string[] | 'all' | 'readonly';

/** One restriction in the chain, and who imposed it. */
export interface ScopeLayer {
  /** Named in a refusal, so the model (and the person) can see which bound it hit. */
  label: string;
  /** Built-in and custom tool names allowed; `'all'` is every one. */
  tools: 'all' | ReadonlySet<string>;
  /** MCP tools allowed: every one, only read-only ones, or those matching these entries. */
  mcp: 'all' | 'readonly' | readonly string[];
}

/** What a run may use. Passed to every child it delegates to. */
export interface ToolScope {
  readonly layers: readonly ScopeLayer[];
  /** Whether `Task`/`Investigate` are available. False anywhere above means false here. */
  readonly delegate: boolean;
}

/** No restriction: the orchestrator's scope when nobody narrowed it. */
export const OPEN_SCOPE: ToolScope = Object.freeze({ layers: Object.freeze([]) as readonly ScopeLayer[], delegate: true });

/** The tools that spawn sub-agents, governed by `delegate` rather than by name lists. */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['Task', 'Investigate']);

/**
 * Whether an allow-list entry names MCP tools.
 *
 * Four spellings, all live somewhere: `MCP` (the desktop editor's "every MCP
 * tool" chip and the old built-in `qa` agent), `mcp:<server>` and
 * `mcp:<server>:<tool>` (the editor's server chips), and Claude Code's
 * `mcp__<server>__<tool>` / `mcp__<server>__*`.
 */
export function isMcpEntry(entry: string): boolean {
  return entry === 'MCP' || entry.startsWith('mcp:') || entry.startsWith('mcp__');
}

/** Whether one MCP allow-list entry covers an MCP tool name. */
export function mcpEntryMatches(entry: string, name: string): boolean {
  if (entry === 'MCP') return isMcpToolName(name);
  const parts = parseMcpToolName(name);
  if (!parts) return false;
  if (entry.startsWith('mcp:')) {
    const rest = entry.slice(4);
    const cut = rest.indexOf(':');
    const server = cut < 0 ? rest : rest.slice(0, cut);
    const tool = cut < 0 ? undefined : rest.slice(cut + 1);
    return parts.server === server && (tool === undefined || tool === '*' || tool === parts.tool);
  }
  if (entry.endsWith('__*')) return name.startsWith(entry.slice(0, -1)) && name.length > entry.length - 1;
  return entry === name;
}

/** Whether a name-list entry (settings `disabledTools`, an allow-list) covers a tool. */
export function entryMatches(entry: string, name: string): boolean {
  if (entry.startsWith('custom:')) return entry.slice('custom:'.length) === name;
  return isMcpEntry(entry) ? mcpEntryMatches(entry, name) : entry === name;
}

/**
 * The layer an allow-list imposes, or nothing when it imposes nothing.
 *
 * `readonlyTools` is what `'readonly'` means for built-ins; the caller passes it
 * because the list lives with the tool definitions, which import far more than
 * this module should. `'readonly'` admits MCP tools only from servers marked
 * read-only.
 */
export function layerFor(label: string, allow: ToolAllow | undefined, readonlyTools: Iterable<string>): ScopeLayer | undefined {
  if (allow === undefined || allow === 'all') return undefined;
  if (allow === 'readonly') return { label, tools: new Set(readonlyTools), mcp: 'readonly' };
  const tools = new Set<string>();
  const mcp: string[] = [];
  for (const raw of allow) {
    const entry = String(raw).trim();
    if (!entry) continue;
    if (isMcpEntry(entry)) mcp.push(entry);
    else if (entry.startsWith('custom:')) tools.add(entry.slice('custom:'.length));
    else tools.add(entry);
  }
  return { label, tools, mcp };
}

/** A child's scope: everything the parent's says, plus its own. */
export function narrowScope(
  parent: ToolScope | undefined,
  own: { layer?: ScopeLayer | undefined; canDelegate?: boolean | undefined },
): ToolScope {
  const base = parent ?? OPEN_SCOPE;
  return {
    layers: own.layer ? [...base.layers, own.layer] : base.layers,
    delegate: base.delegate && own.canDelegate !== false,
  };
}

/** The first layer that refuses this tool, or undefined when every layer allows it. */
export function refusingLayer(scope: ToolScope | undefined, name: string): ScopeLayer | 'delegate' | undefined {
  if (!scope) return undefined;
  if (DELEGATION_TOOLS.has(name)) return scope.delegate ? undefined : 'delegate';
  const mcp = isMcpToolName(name);
  for (const layer of scope.layers) {
    if (mcp) {
      if (layer.mcp === 'all') continue;
      if (layer.mcp === 'readonly') {
        if (isReadOnlyMcpTool(name)) continue;
        return layer;
      }
      if (layer.mcp.some(entry => mcpEntryMatches(entry, name))) continue;
      return layer;
    }
    if (layer.tools === 'all' || layer.tools.has(name)) continue;
    return layer;
  }
  return undefined;
}

/** Whether a run with this scope may use (and be offered) this tool. */
export function scopeAllows(scope: ToolScope | undefined, name: string): boolean {
  return refusingLayer(scope, name) === undefined;
}

/** Why a call was refused, in words the model can act on. */
export function scopeDenial(scope: ToolScope | undefined, name: string): string | undefined {
  const refused = refusingLayer(scope, name);
  if (!refused) return undefined;
  if (refused === 'delegate') {
    return `${name} is not available: this agent may not delegate (canDelegate is off here or above it). Do the work yourself.`;
  }
  return `${name} is outside what this agent may use (limited by ${refused.label}). Use one of the tools you were given.`;
}
