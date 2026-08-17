// Public API
export type { McpServerConfigV2, McpServerConfig, McpTool, McpResource, McpResourceContent, McpHealthStatus } from './base.js';
export { McpBaseClient } from './base.js';
export { McpStdioClient } from './stdio.js';
export { McpHttpClient } from './http.js';
export { McpSseClient } from './sse.js';
export { mcpRegistry } from './registry.js';
export type { McpServerInfo } from './registry.js';
export {
  listMcpResourcesToolDefinition,
  readMcpResourceToolDefinition,
  executeListMcpResources,
  executeReadMcpResource,
} from './resources.js';

// ── Backward-compat shim ────────────────────────────────────────────────
// loadMcpTools() is kept for any code that called the old src/mcp.ts API.
// New code should use mcpRegistry.loadServers() + mcpRegistry.getToolsForAgent().
import { McpStdioClient } from './stdio.js';
import type { McpServerConfigV2 } from './base.js';

export async function loadMcpTools(
  _name: string,
  config: McpServerConfigV2,
): Promise<import('./base.js').McpTool[]> {
  const client = new McpStdioClient(config);
  await client.initialize();
  return client.listTools();
}
