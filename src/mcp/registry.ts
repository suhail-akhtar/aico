import chalk from 'chalk';
import type { McpTool, McpResource, McpResourceContent, McpServerConfigV2, McpHealthStatus } from './base.js';
import { McpStdioClient } from './stdio.js';
import { McpHttpClient } from './http.js';
import { McpSseClient } from './sse.js';
import type { McpBaseClient } from './base.js';

export interface McpServerInfo {
  name: string;
  config: McpServerConfigV2;
  health: McpHealthStatus;
  toolCount: number;
  resourceCount: number;
  lastChecked: number;
}

type SubscriberFn = (servers: McpServerInfo[]) => void;

class McpServerRegistry {
  private _clients = new Map<string, McpBaseClient>();
  private _toolCache = new Map<string, McpTool[]>();
  private _resourceCache = new Map<string, McpResource[]>();
  private _configs = new Map<string, McpServerConfigV2>();
  private _subscribers: SubscriberFn[] = [];
  private _healthTimer?: ReturnType<typeof setInterval>;

  async loadServers(config: Record<string, McpServerConfigV2>): Promise<void> {
    // Stop any previously running clients
    this.stopAll();

    for (const [name, serverConfig] of Object.entries(config)) {
      try {
        const client = this._createClient(serverConfig);
        await client.initialize();
        const tools = await client.listTools();
        const resources = await client.listResources();

        this._clients.set(name, client);
        this._toolCache.set(name, tools);
        this._resourceCache.set(name, resources);
        this._configs.set(name, serverConfig);

        process.stdout.write(
          chalk.gray(`  ✓ MCP server "${name}": ${tools.length} tools, ${resources.length} resources\n`),
        );
      } catch (err) {
        process.stderr.write(
          chalk.yellow(`  ⚠ MCP server "${name}" failed to load: ${err}\n`),
        );
      }
    }

    this._emit();
  }

  private _createClient(config: McpServerConfigV2): McpBaseClient {
    switch (config.type) {
      case 'http':  return new McpHttpClient(config);
      case 'sse':   return new McpSseClient(config);
      case 'stdio':
      default:      return new McpStdioClient(config);
    }
  }

  /** Get all MCP tools as agent-compatible tool entries */
  getToolsForAgent(): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<unknown> }> {
    const result: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<unknown> }> = [];
    for (const [serverName, tools] of this._toolCache) {
      for (const t of tools) {
        result.push({
          name: `mcp__${serverName}__${t.name}`,
          description: `[MCP:${serverName}] ${t.description}`,
          inputSchema: t.inputSchema,
          execute: t.execute,
        });
      }
    }
    return result;
  }

  async listAllResources(): Promise<Array<McpResource & { serverName: string }>> {
    const result: Array<McpResource & { serverName: string }> = [];
    for (const [serverName, resources] of this._resourceCache) {
      for (const r of resources) {
        result.push({ ...r, serverName });
      }
    }
    return result;
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceContent> {
    const client = this._clients.get(serverName);
    if (!client) throw new Error(`MCP server "${serverName}" not found`);
    return client.readResource(uri);
  }

  /** Start 30-second health check pings */
  startHealthChecks(): void {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(() => { void this._runHealthChecks(); }, 30_000);
    // Don't prevent process exit
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  private async _runHealthChecks(): Promise<void> {
    let changed = false;
    for (const [name, client] of this._clients) {
      const wasHealthy = client.getHealth() === 'healthy';
      try {
        // Refresh tool metadata and use the request itself as the health ping.
        const tools = await client.listTools();
        this._toolCache.set(name, tools);
      } catch {
        // Client will update its own health status
      }
      const isHealthy = client.getHealth() === 'healthy';
      if (wasHealthy !== isHealthy) changed = true;
    }
    if (changed) this._emit();
  }

  /** Subscribe to server status changes — returns an unsubscribe function */
  subscribe(fn: SubscriberFn): () => void {
    this._subscribers.push(fn);
    // Immediately emit current state
    fn(this._buildServerInfos());
    return () => {
      this._subscribers = this._subscribers.filter((s) => s !== fn);
    };
  }

  private _buildServerInfos(): McpServerInfo[] {
    return Array.from(this._clients.entries()).map(([name, client]) => ({
      name,
      config: this._configs.get(name)!,
      health: client.getHealth(),
      toolCount: this._toolCache.get(name)?.length ?? 0,
      resourceCount: this._resourceCache.get(name)?.length ?? 0,
      lastChecked: Date.now(),
    }));
  }

  private _emit(): void {
    const infos = this._buildServerInfos();
    for (const fn of this._subscribers) fn(infos);
  }

  stopAll(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = undefined;
    }
    for (const client of this._clients.values()) {
      try { client.stop(); } catch { /* ignore */ }
    }
    this._clients.clear();
    this._toolCache.clear();
    this._resourceCache.clear();
    this._configs.clear();
  }

  getServerInfos(): McpServerInfo[] {
    return this._buildServerInfos();
  }

  getConfigs(): Record<string, McpServerConfigV2> {
    return Object.fromEntries(this._configs.entries());
  }
}

export const mcpRegistry = new McpServerRegistry();
