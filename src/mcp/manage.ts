import { loadSettings, saveProjectMcpServers, getProjectLocalSettingsPath } from '../settings.js';
import { mcpRegistry } from './registry.js';
import type { McpServerConfigV2 } from './base.js';

export type McpPreset = 'playwright';

export interface McpAddServerInput {
  name: string;
  preset?: McpPreset;
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

function assertValidName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('MCP server name may only contain letters, numbers, underscores, and dashes');
  }
}

export function buildMcpPresetConfig(preset: McpPreset): McpServerConfigV2 {
  switch (preset) {
    case 'playwright':
      return {
        type: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest', '--browser=chrome', '--viewport-size=1440x900'],
      };
  }
}

function buildConfig(input: McpAddServerInput): McpServerConfigV2 {
  if (input.preset) return buildMcpPresetConfig(input.preset);

  const type = input.type ?? 'stdio';
  if (type === 'stdio') {
    if (!input.command) throw new Error('stdio MCP servers require command');
    return {
      type,
      command: input.command,
      args: input.args ?? [],
      ...(input.env ? { env: input.env } : {}),
    };
  }

  if (!input.url) throw new Error(`${type} MCP servers require url`);
  return {
    type,
    url: input.url,
    ...(input.headers ? { headers: input.headers } : {}),
  };
}

async function persistAndReload(servers: Record<string, McpServerConfigV2>): Promise<void> {
  await saveProjectMcpServers(servers);
  await mcpRegistry.loadServers(servers);
  mcpRegistry.startHealthChecks();
}

export async function addMcpServer(input: McpAddServerInput): Promise<string> {
  assertValidName(input.name);
  const settings = await loadSettings();
  const current = settings.mcpServers ?? {};
  const config = buildConfig(input);
  const next = { ...current, [input.name]: config };
  await persistAndReload(next);

  const info = mcpRegistry.getServerInfos().find((s) => s.name === input.name);
  const status = info
    ? `${info.health}, ${info.toolCount} tool(s), ${info.resourceCount} resource(s)`
    : 'configured but not loaded';
  return `MCP server "${input.name}" saved to ${getProjectLocalSettingsPath()} and loaded: ${status}`;
}

export async function removeMcpServer(name: string): Promise<string> {
  assertValidName(name);
  const settings = await loadSettings();
  const current = { ...(settings.mcpServers ?? {}) };
  if (!current[name]) return `MCP server "${name}" is not configured.`;
  delete current[name];
  await persistAndReload(current);
  return `Removed MCP server "${name}" from ${getProjectLocalSettingsPath()}.`;
}

export async function reloadMcpServers(): Promise<string> {
  const settings = await loadSettings();
  const servers = settings.mcpServers ?? {};
  await mcpRegistry.loadServers(servers);
  mcpRegistry.startHealthChecks();
  return formatMcpServers();
}

export function formatMcpServers(): string {
  const infos = mcpRegistry.getServerInfos();
  if (infos.length === 0) {
    return '(No MCP servers loaded)';
  }

  return infos.map((s) =>
    `  ${s.name.padEnd(18)} ${s.health.padEnd(12)} ${String(s.toolCount).padStart(2)} tool(s), ${String(s.resourceCount).padStart(2)} resource(s)`,
  ).join('\n');
}

export function parseMcpAddCommand(args: string): McpAddServerInput {
  const trimmed = args.trim();
  if (!trimmed) throw new Error('Usage: /mcp-add playwright OR /mcp-add <name> -- <command> [args...]');

  if (trimmed === 'playwright' || trimmed === 'browser' || trimmed === 'qa-browser') {
    return { name: 'playwright', preset: 'playwright' };
  }

  const sep = trimmed.indexOf(' -- ');
  if (sep === -1) {
    throw new Error('Usage: /mcp-add <name> -- <command> [args...]');
  }

  const name = trimmed.slice(0, sep).trim();
  const commandText = trimmed.slice(sep + 4).trim();
  const parts = commandText.split(/\s+/).filter(Boolean);
  const [command, ...cmdArgs] = parts;
  if (!name || !command) {
    throw new Error('Usage: /mcp-add <name> -- <command> [args...]');
  }

  return { name, type: 'stdio', command, args: cmdArgs };
}

export const mcpAddServerToolDefinition = {
  name: 'McpAddServer',
  description:
    'Persist and load an MCP server so the agent gains new tools. Use preset="playwright" for browser automation QA. ' +
    'For arbitrary stdio servers provide name, command, and args. This writes .aico/settings.local.json and reloads MCP.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short MCP server name, e.g. playwright or github' },
      preset: { type: 'string', enum: ['playwright'], description: 'Optional built-in MCP preset.' },
      type: { type: 'string', enum: ['stdio', 'http', 'sse'], description: 'MCP transport type. Defaults to stdio.' },
      command: { type: 'string', description: 'Command for stdio servers, e.g. npx' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments for stdio servers.' },
      url: { type: 'string', description: 'HTTP/SSE endpoint URL.' },
      env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Environment variables for stdio servers.' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'HTTP headers for HTTP/SSE servers.' },
    },
    required: ['name'],
  },
};

export const mcpRemoveServerToolDefinition = {
  name: 'McpRemoveServer',
  description: 'Remove an MCP server from .aico/settings.local.json and reload the MCP registry.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'MCP server name to remove.' },
    },
    required: ['name'],
  },
};

export const mcpReloadServersToolDefinition = {
  name: 'McpReloadServers',
  description: 'Reload MCP servers from settings and report loaded tools/resources.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
