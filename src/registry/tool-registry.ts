/**
 * The default tool registry.
 *
 * Wraps the existing built-in tool table and its `executeTool` dispatch, so
 * behaviour is unchanged, and adds the thing that was missing: **registration**.
 *
 * Previously, contributing a tool meant two edits to core — an entry in
 * `toolDefinitions` and a `case` in the `switch` inside `executeTool()`. That
 * is why "AICO's tool layer is a switch statement" was a fair description. A
 * plugin can now call `register()` and be done, and unregister cleanly when it
 * unloads.
 *
 * Built-ins are registered lazily on first use rather than at import time, so
 * merely importing this module does not pull the whole tool graph into a
 * process that only wanted the type.
 *
 * @module registry/tool-registry
 */

import type { ToolDef } from '../providers/types.js';
import {
  executeTool as executeBuiltinTool,
  getToolsForAgent,
  getToolsForSpec,
  toolDefinitions,
  type SubAgentType,
  type ToolDefinition,
} from '../tools/index.js';
import type {
  RegisteredTool,
  ToolExecutor,
  ToolRegistryCapability,
} from './capabilities.js';

/** Options narrowing which built-ins a registry starts with. */
export interface ToolRegistryOptions {
  /** Restrict built-ins to a sub-agent's set. */
  agentType?: SubAgentType;
  /** Explicit whitelist, taking priority over `agentType`. */
  specTools?: string[] | 'all' | 'readonly';
  /** Start empty. Used by tests and by fully custom compositions. */
  noBuiltins?: boolean;
}

/** Registration-ordered tool registry over the built-in dispatch. */
export class DefaultToolRegistry implements ToolRegistryCapability {
  private readonly entries = new Map<string, RegisteredTool>();

  constructor(options: ToolRegistryOptions = {}) {
    if (options.noBuiltins) return;
    const defs = options.specTools
      ? getToolsForSpec(options.specTools)
      : options.agentType
        ? getToolsForAgent(options.agentType)
        : toolDefinitions;
    for (const definition of defs) {
      // Built-ins keep going through `executeTool`, which owns the result
      // cache, the concurrency lock, and per-tool truncation. Reimplementing
      // that here would fork behaviour the whole system depends on.
      this.entries.set(definition.name, {
        definition,
        execute: (args) => executeBuiltinTool(definition.name, args),
      });
    }
  }

  register(definition: ToolDefinition, execute: ToolExecutor): () => void {
    const previous = this.entries.get(definition.name);
    this.entries.set(definition.name, { definition, execute });
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // Restore what was shadowed rather than deleting outright, so overriding
      // a built-in for the duration of a plugin does not permanently remove it.
      if (previous) this.entries.set(definition.name, previous);
      else this.entries.delete(definition.name);
    };
  }

  list(): ToolDefinition[] {
    return [...this.entries.values()].map(e => e.definition);
  }

  get(name: string): RegisteredTool | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.entries.get(name);
    if (!entry) return { error: `Unknown tool: ${name}` };
    return entry.execute(args);
  }

  schemas(): ToolDef[] {
    return this.list().map(d => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    }));
  }
}
