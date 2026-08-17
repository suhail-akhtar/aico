// Thin re-export shim — all logic lives in src/mcp/
export type { McpServerConfig, McpServerConfigV2, McpTool, McpResource, McpResourceContent } from './mcp/index.js';
export { loadMcpTools, mcpRegistry } from './mcp/index.js';
