/**
 * Which MCP tools only read.
 *
 * MCP tools used to bypass the tool pipeline entirely, so nothing ever had to
 * ask this: plan mode offered every MCP tool, `ask` mode never asked before
 * one, and a read-only agent could call a server's delete. Routing them through
 * the pipeline (agent.ts) made the question unavoidable, and the answer has to
 * come from somewhere trustworthy.
 *
 * **Not from the server.** The MCP spec says tool annotations (`readOnlyHint`,
 * `destructiveHint`) are untrusted unless the server is, and a server that
 * lies about them is exactly the one that matters. So annotations are not read
 * here at all, and a server is assumed to write unless:
 *
 *  - the person marked it read-only in settings (`readOnly: true`), or
 *  - it is the hosting process's own server (the desktop's `ide_*`/`browser_*`
 *    tools), whose read tools are classified by name in the table below. The
 *    desktop browser's own consent gate (ADR 0005) still applies on top.
 *
 * Deliberately coarse: a whole server is read-only or it is not. Per-tool
 * effect classes and pinned tool hashes are the design's Phase 6
 * (docs/engineering/design/agents-skills-tools.md §5.3); `readOnly: true` is the
 * same thing as that design's `tools: { "*": { effect: "read" } }`.
 *
 * @module mcp/policy
 */

import { mcpRegistry } from './registry.js';

/**
 * The desktop host server's tools that only observe or navigate.
 *
 * Navigation is here for the same reason WebFetch is allowed in plan mode: it
 * reads a page. Clicking, typing, filling, uploading, logging in, evaluating
 * script and everything that changes the IDE are not, so they need the same
 * approval any other writing tool does.
 */
export const HOST_READ_TOOLS: ReadonlySet<string> = new Set([
  'browser_console', 'browser_downloads', 'browser_extract', 'browser_find', 'browser_forms',
  'browser_insights', 'browser_memory_search', 'browser_navigate', 'browser_network',
  'browser_new_tab', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_scroll',
  'browser_scroll_to', 'browser_select_tab', 'browser_snapshot', 'browser_tabs',
  'browser_tabs_overview', 'browser_text', 'browser_wait', 'browser_hover',
  'ide_describe', 'ide_plugin_list', 'ide_plugin_read', 'ide_terminal_read',
]);

/** Whether a tool name is an MCP tool (`mcp__<server>__<tool>`). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__') && name.indexOf('__', 5) > 5;
}

/**
 * Split `mcp__<server>__<tool>` into its parts.
 *
 * Server names may contain underscores (and so `__`), so a loaded server whose
 * prefix matches wins — the longest one, so `a__b` is not read as server `a`.
 * Unloaded names fall back to the first separator.
 */
export function parseMcpToolName(
  name: string,
  servers: readonly string[] = mcpRegistry.serverNames(),
): { server: string; tool: string } | undefined {
  if (!isMcpToolName(name)) return undefined;
  const known = servers
    .filter(s => name.startsWith(`mcp__${s}__`) && name.length > `mcp__${s}__`.length)
    .sort((a, b) => b.length - a.length)[0];
  if (known) return { server: known, tool: name.slice(`mcp__${known}__`.length) };
  const cut = name.indexOf('__', 5);
  return { server: name.slice(5, cut), tool: name.slice(cut + 2) };
}

/** Whether an MCP tool may be treated as read-only. Unknown means no. */
export function isReadOnlyMcpTool(name: string): boolean {
  const parts = parseMcpToolName(name);
  if (!parts) return false;
  if (mcpRegistry.isHost(parts.server)) return HOST_READ_TOOLS.has(parts.tool);
  return mcpRegistry.configOf(parts.server)?.readOnly === true;
}
