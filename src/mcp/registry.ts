import chalk from 'chalk';
import type { McpTool, McpResource, McpResourceContent, McpServerConfigV2, McpHealthStatus } from './base.js';
import { McpStdioClient } from './stdio.js';
import { McpHttpClient } from './http.js';
import { McpSseClient } from './sse.js';
import type { McpBaseClient } from './base.js';
import { currentRunContext } from '../run-context.js';

/**
 * What the hosting process is told with each tool call: the calling session.
 * The desktop app's browser gives each chat its own tab by it (and keeps the
 * browser copilot on the page the user is looking at); without it, every
 * chat drove the one tab in front. Host servers only — they run this engine.
 */
export function hostCallMeta(): Record<string, unknown> | undefined {
  const sessionId = currentRunContext()?.sessionId;
  return sessionId ? { 'aico/sessionId': sessionId } : undefined;
}

export interface McpServerInfo {
  name: string;
  config: McpServerConfigV2;
  health: McpHealthStatus;
  toolCount: number;
  resourceCount: number;
  lastChecked: number;
  /** The server's own instructions for its tools, when it sent any. */
  instructions?: string;
  /** Contributed by the process hosting the engine (not in settings). */
  host?: boolean;
}

type SubscriberFn = (servers: McpServerInfo[]) => void;

class McpServerRegistry {
  private _clients = new Map<string, McpBaseClient>();
  private _toolCache = new Map<string, McpTool[]>();
  private _resourceCache = new Map<string, McpResource[]>();
  private _configs = new Map<string, McpServerConfigV2>();
  private _subscribers: SubscriberFn[] = [];
  private _healthTimer?: ReturnType<typeof setInterval>;
  /**
   * Servers the hosting process provides — the desktop app's IDE and browser
   * endpoint, say. Never written to settings (its port and token are only
   * good for this run), and kept across reloads: reloading the user's servers
   * must not unplug the window the engine is running in.
   */
  private _host: Record<string, McpServerConfigV2> = {};

  /** Register the host's servers and connect them now. */
  async setHostServers(config: Record<string, McpServerConfigV2>): Promise<void> {
    this._host = { ...config };
    await this.loadServers(Object.fromEntries([...this._configs.entries()].filter(([n]) => !(n in this._host))));
  }

  async loadServers(config: Record<string, McpServerConfigV2>): Promise<void> {
    // Stop any previously running clients
    this.stopAll();

    for (const [name, serverConfig] of Object.entries({ ...config, ...this._host })) {
      try {
        const client = this._createClient(serverConfig);
        if (name in this._host) client.callMeta = hostCallMeta;
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
      ...(client.instructions ? { instructions: client.instructions } : {}),
      ...(name in this._host ? { host: true } : {}),
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
