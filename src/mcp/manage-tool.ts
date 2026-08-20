/**
 * Everything a person can ask to have done to their MCP servers.
 *
 * The same one-tool-with-an-action shape as `SkillManage`, for the same reason:
 * these verbs are identical across every registry, and spending a tool slot on
 * each would cost more attention than it buys.
 *
 * **Adding a server is checked, not assumed.** `McpAddServer` reported success
 * as soon as the config was written, so a typo'd command produced a cheerful
 * "saved and loaded" followed by a server that never answered. Adding now says
 * how many tools actually arrived, and says plainly when the answer is none —
 * because a server contributing nothing is the single most common way this is
 * misconfigured, and the only moment anyone is looking is right after adding.
 *
 * **Disable is not remove.** A server that is slow, noisy, or simply not
 * relevant to today's work should be switchable without losing the command line
 * and environment that took a README to assemble.
 *
 * @module mcp/manage-tool
 */

import fs from 'fs';
import path from 'path';
import { loadSettings } from '../settings.js';
import { mcpRegistry } from './registry.js';
import { addMcpServer, updateMcpServer, removeMcpServer, reloadMcpServers } from './manage.js';
import { disabledIn, isDisabled, setEnabled, forget } from '../registry-state.js';

export interface McpManageInput {
  action: 'list' | 'read' | 'add' | 'update' | 'remove' | 'enable' | 'disable' | 'reload' | 'test' | 'export' | 'import' | 'paste';
  /** A pasted JSON config, in either the whole-file or just-the-block shape. */
  json?: string;
  name?: string;
  /** stdio: the command to run. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse: the URL to call. */
  url?: string;
  type?: 'stdio' | 'http' | 'sse';
  headers?: Record<string, string>;
  /** For export/import: the JSON file. */
  path?: string;
}

/** Split a pasted command line the way a shell would, honouring quotes. */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const parts = line.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map(p => p.replace(/^["']|["']$/g, ''));
  return { command: clean[0] ?? '', args: clean.slice(1) };
}

/**
 * What a pasted MCP config says, and what is wrong with it.
 *
 * Config for these servers is passed around as a JSON blob — it is what every
 * README gives you and what Claude Desktop stores — so pasting one should be a
 * first-class way in rather than something to translate by hand into fields.
 *
 * Checked before anything is written, and reported all at once. A server that
 * is saved and then fails to start is the same dead end as a typo'd command:
 * the moment to catch it is while the person is still looking at the text they
 * pasted.
 */
export interface ParsedMcpConfig {
  ok: boolean;
  servers: Array<{ name: string; type: string; summary: string }>;
  problems: string[];
}

export function parseMcpConfig(text: string): ParsedMcpConfig {
  const problems: string[] = [];
  const servers: ParsedMcpConfig['servers'] = [];

  if (!text.trim()) return { ok: false, servers, problems: ['Nothing pasted.'] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      servers,
      // Trailing commas and comments are the two things people paste from a
      // config file that JSON.parse will not take, and the message otherwise
      // just says "unexpected token".
      problems: [
        `Not valid JSON: ${why}.`,
        'Trailing commas and // comments are the usual cause — JSON allows neither.',
      ],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, servers, problems: ['That is not a JSON object.'] };
  }

  // Both shapes are common: the whole settings file with an mcpServers key, or
  // just the contents of that key.
  const record = parsed as Record<string, unknown>;
  const block = (record['mcpServers'] && typeof record['mcpServers'] === 'object')
    ? record['mcpServers'] as Record<string, unknown>
    : record;

  const names = Object.keys(block);
  if (names.length === 0) return { ok: false, servers, problems: ['No servers defined in there.'] };

  for (const name of names) {
    const config = block[name];
    if (!config || typeof config !== 'object') {
      problems.push(`"${name}": expected an object.`);
      continue;
    }
    const entry = config as Record<string, unknown>;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      problems.push(`"${name}": a name may only hold letters, numbers, underscores and dashes.`);
      continue;
    }

    const url = typeof entry['url'] === 'string' ? entry['url'] : '';
    const command = typeof entry['command'] === 'string' ? entry['command'] : '';
    const declared = typeof entry['type'] === 'string' ? entry['type'] : '';

    if (!url && !command) {
      problems.push(`"${name}": needs either a command (stdio) or a url (http/sse).`);
      continue;
    }
    if (url && command) {
      problems.push(`"${name}": has both a command and a url — it can only be one.`);
      continue;
    }
    if (declared && !['stdio', 'http', 'sse'].includes(declared)) {
      problems.push(`"${name}": type "${declared}" is not one of stdio, http, sse.`);
      continue;
    }
    if (entry['args'] !== undefined && !Array.isArray(entry['args'])) {
      problems.push(`"${name}": args must be a list.`);
      continue;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      problems.push(`"${name}": "${url}" is not an http or https URL.`);
      continue;
    }

    const type = declared || (url ? (url.includes('/sse') ? 'sse' : 'http') : 'stdio');
    const args = Array.isArray(entry['args']) ? entry['args'] as string[] : [];
    servers.push({
      name,
      type,
      summary: url || [command, ...args].join(' '),
    });
  }

  return { ok: problems.length === 0 && servers.length > 0, servers, problems };
}

/** What a server is contributing right now. */
function statusOf(name: string): string {
  const info = mcpRegistry.getServerInfos().find(s => s.name === name);
  if (!info) return 'not loaded';
  return `${info.health}, ${info.toolCount} tool(s), ${info.resourceCount} resource(s)`;
}

export async function executeMcpManage(input: McpManageInput): Promise<string> {
  const name = input.name?.trim() ?? '';

  switch (input.action) {
    case 'list': {
      const settings = await loadSettings();
      const configured = Object.keys(settings.mcpServers ?? {});
      if (configured.length === 0) {
        return 'No MCP servers configured. The agent has its own tools regardless; MCP adds someone else\'s.';
      }
      const off = disabledIn('mcp');
      return [
        `${configured.length} MCP server(s):`,
        ...configured.map(server => {
          const marked = off.has(server.toLowerCase()) ? ' [disabled]' : '';
          return `- ${server}${marked}: ${statusOf(server)}`;
        }),
      ].join('\n');
    }

    case 'read': {
      const settings = await loadSettings();
      const config = (settings.mcpServers ?? {})[name];
      if (!config) return `No MCP server called "${name}". Use action:"list".`;
      const info = mcpRegistry.getServerInfos().find(s => s.name === name);
      const tools = mcpRegistry.getToolsForAgent()
        .filter(t => t.name.startsWith(`mcp__${name}__`) || t.name.includes(name));
      return [
        `name: ${name}`,
        `enabled: ${!isDisabled('mcp', name)}`,
        `status: ${statusOf(name)}`,
        `config: ${JSON.stringify(config, null, 2)}`,
        info && tools.length ? `\ntools it contributes:\n${tools.map(t => `  - ${t.name}: ${t.description.slice(0, 100)}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'add': {
      if (!name) return 'A name is required.';
      // Either shape, and people know which one they have: a command to run, or
      // a URL to call. Asking for a transport type first is asking them to read
      // a spec before they can paste what their README gave them.
      let payload;
      if (input.url) {
        payload = {
          name,
          type: input.type ?? (input.url.includes('/sse') ? 'sse' as const : 'http' as const),
          url: input.url,
          ...(input.headers ? { headers: input.headers } : {}),
        };
      } else if (input.command) {
        const split = input.args?.length
          ? { command: input.command, args: input.args }
          : splitCommandLine(input.command);
        payload = { name, type: 'stdio' as const, ...split, ...(input.env ? { env: input.env } : {}) };
      } else {
        return 'Give either a command to run (stdio) or a url to call (http/sse).';
      }

      const saved = await addMcpServer(payload as Parameters<typeof addMcpServer>[0]);
      const info = mcpRegistry.getServerInfos().find(s => s.name === name);

      // The check that matters, at the only moment anyone is looking.
      if (!info || info.toolCount === 0) {
        return [
          saved,
          '',
          `WARNING: "${name}" is configured but contributed 0 tools, so nothing about the agent has `
          + 'changed yet. Usually the command or URL is wrong, or the server needs credentials in env. '
          + `Check with action:"test" name:"${name}".`,
        ].join('\n');
      }
      return `${saved}\nIts ${info.toolCount} tool(s) are now available to the agent.`;
    }

    case 'update': {
      if (!name) return 'A name is required.';
      // A command line arrives as a line, not an argv array, wherever it comes
      // from — so it is split here exactly as it is on add.
      const split = input.command && !input.args?.length ? splitCommandLine(input.command) : undefined;
      try {
        return await updateMcpServer({
          name,
          ...(split ? split : { ...(input.command ? { command: input.command } : {}), ...(input.args ? { args: input.args } : {}) }),
          ...(input.url ? { url: input.url } : {}),
          ...(input.type ? { type: input.type } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.headers ? { headers: input.headers } : {}),
        });
      } catch (err) {
        return `Not updated: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case 'paste': {
      const parsed = parseMcpConfig(String(input.json ?? ''));
      if (!parsed.ok) {
        return `Not added:\n${parsed.problems.map(p => `  - ${p}`).join('\n')}`;
      }
      const block = JSON.parse(String(input.json));
      const servers = (block.mcpServers && typeof block.mcpServers === 'object')
        ? block.mcpServers : block;

      const added: string[] = [];
      const failed: string[] = [];
      for (const server of parsed.servers) {
        try {
          await addMcpServer({ name: server.name, ...servers[server.name] });
          added.push(`${server.name} — ${statusOf(server.name)}`);
        } catch (err) {
          failed.push(`${server.name} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return [
        added.length ? `Added: ${added.join('; ')}` : '',
        failed.length ? `Failed: ${failed.join('; ')}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'remove': {
      const result = await removeMcpServer(name);
      forget('mcp', name);
      return result;
    }

    case 'enable':
    case 'disable': {
      const settings = await loadSettings();
      if (!(settings.mcpServers ?? {})[name]) return `No MCP server called "${name}".`;
      const wanted = input.action === 'enable';
      const changed = setEnabled('mcp', name, wanted);
      if (!changed) return `"${name}" was already ${wanted ? 'enabled' : 'disabled'}.`;
      // Reload so the change takes effect now rather than next launch — the
      // whole point of a switch is that it acts when you flip it.
      await reloadMcpServers();
      return `"${name}" is now ${wanted ? 'enabled' : 'disabled'}. ${statusOf(name)}`;
    }

    case 'reload':
      return await reloadMcpServers();

    case 'test': {
      const settings = await loadSettings();
      if (!(settings.mcpServers ?? {})[name]) return `No MCP server called "${name}".`;
      await reloadMcpServers();
      const info = mcpRegistry.getServerInfos().find(s => s.name === name);
      if (!info) return `"${name}" is configured but did not load at all. Check the command or URL.`;
      return info.toolCount === 0
        ? `"${name}" loaded (${info.health}) but contributes 0 tools. It is not doing anything for the agent.`
        : `"${name}" is ${info.health} with ${info.toolCount} tool(s) and ${info.resourceCount} resource(s).`;
    }

    case 'export': {
      if (!input.path) return 'A path is required — where to write the JSON.';
      const settings = await loadSettings();
      const servers = settings.mcpServers ?? {};
      const chosen = name ? { [name]: servers[name] } : servers;
      if (name && !servers[name]) return `No MCP server called "${name}".`;

      const target = path.resolve(input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ mcpServers: chosen }, null, 2), 'utf8');
      return `Exported ${Object.keys(chosen).length} server(s) to ${target}. `
        + 'Anything secret lives in env values — check before sharing this file.';
    }

    case 'import': {
      if (!input.path) return 'A path is required — the JSON file to read.';
      const target = path.resolve(input.path);
      if (!fs.existsSync(target)) return `${target} does not exist.`;
      let parsed: { mcpServers?: Record<string, unknown> };
      try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (err) { return `${target} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`; }

      const incoming = parsed.mcpServers ?? (parsed as Record<string, unknown>);
      const names = Object.keys(incoming);
      if (names.length === 0) return 'That file defines no servers.';

      const added: string[] = [];
      const failed: string[] = [];
      for (const server of names) {
        const config = incoming[server] as Record<string, unknown>;
        try {
          await addMcpServer({ name: server, ...config } as Parameters<typeof addMcpServer>[0]);
          added.push(server);
        } catch (err) {
          failed.push(`${server} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return [
        added.length ? `Imported: ${added.map(s => `${s} — ${statusOf(s)}`).join('; ')}` : '',
        failed.length ? `Failed: ${failed.join('; ')}` : '',
      ].filter(Boolean).join('\n');
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

export const mcpManageToolDefinition = {
  name: 'McpManage',
  description: [
    'Manage MCP servers: list, read, add, remove, enable, disable, reload, test, export and import.',
    'Use this whenever someone asks what servers are connected, or asks to connect, remove, switch off,',
    'check, or share one. A connected server\'s tools become available to the agent.',
    'Adding reports how many tools actually arrived — a server contributing none is configured wrong.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'add', 'update', 'remove', 'enable', 'disable', 'reload', 'test', 'export', 'import', 'paste'],
        description:
          'list: every configured server and what it contributes. read: one in full, with its tools. '
          + 'add: connect a new one. update: change part of its config, keeping the rest. remove: delete '
          + 'its config. enable/disable: switch without losing '
          + 'the config. reload: reconnect everything. test: check one is actually working. '
          + 'export/import: JSON config files.',
      },
      name: { type: 'string', description: 'Which server. Required for everything except list, reload and import.' },
      command: {
        type: 'string',
        description: 'For a stdio server: the command line, e.g. "npx -y @modelcontextprotocol/server-filesystem /path". Split like a shell would.',
      },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments, if not already part of command.' },
      env: { type: 'object', description: 'Environment variables the server needs, e.g. API keys.' },
      url: { type: 'string', description: 'For an http/sse server: the URL to call.' },
      type: { type: 'string', enum: ['stdio', 'http', 'sse'], description: 'Usually inferred from command vs url.' },
      headers: { type: 'object', description: 'HTTP headers, for a url server that needs auth.' },
      path: { type: 'string', description: 'For export: where to write the JSON. For import: the file to read.' },
      json: { type: 'string', description: 'For paste: a JSON config, either the whole file with an mcpServers key or just that block.' },
    },
    required: ['action'],
  },
};
