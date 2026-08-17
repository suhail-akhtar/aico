import type { McpResource, McpResourceContent } from './base.js';
import { mcpRegistry } from './registry.js';

export const listMcpResourcesToolDefinition = {
  name: 'ListMcpResources',
  description: 'List all resources available from configured MCP servers.',
  inputSchema: {
    type: 'object',
    properties: {
      server_name: {
        type: 'string',
        description: 'Optional: filter to a specific MCP server name.',
      },
    },
  },
};

export const readMcpResourceToolDefinition = {
  name: 'ReadMcpResource',
  description: 'Read the content of a specific MCP resource by URI.',
  inputSchema: {
    type: 'object',
    properties: {
      server_name: {
        type: 'string',
        description: 'The MCP server name that owns this resource.',
      },
      uri: {
        type: 'string',
        description: 'The resource URI to read.',
      },
    },
    required: ['server_name', 'uri'],
  },
};

export async function executeListMcpResources(args: {
  server_name?: string;
}): Promise<Array<McpResource & { serverName: string }>> {
  const all = await mcpRegistry.listAllResources();
  if (args.server_name) {
    return all.filter((r) => r.serverName === args.server_name);
  }
  return all;
}

export async function executeReadMcpResource(args: {
  server_name: string;
  uri: string;
}): Promise<McpResourceContent> {
  return mcpRegistry.readResource(args.server_name, args.uri);
}
