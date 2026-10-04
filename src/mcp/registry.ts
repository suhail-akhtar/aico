import chalk from 'chalk';
import type { McpTool, McpResource, McpResourceContent, McpServerConfigV2, McpHealthStatus } from './base.js';
import { McpStdioClient } from './stdio.js';
import { McpHttpClient } from './http.js';
import { McpSseClient } from './sse.js';
import type { McpBaseClient } from './base.js';
import { currentRunContext } from '../run-context.js';
import { reviewServerTools, approveTools, serverIdentity, type HeldTool } from './pins.js';
import { resolveConfigSecrets } from './secrets.js';
import { guardMcpText } from './base.js';

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
  /** `modern` (2026-07-28) or `legacy` (initialize handshake), and the revision in use. */
  era?: 'modern' | 'legacy';
  protocolVersion?: string;
  /** Tools held back until a person approves them (changed or new; see `mcp/pins`). */
  heldCount?: number;
  /** The last failure refreshing it, if any. */
  lastError?: string;
  /** Milliseconds the last connect (spawn, negotiate, list) took. */
  connectMs?: number;
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
  /** Tools a server listed that wait for a person (rug-pull defence). */
  private _held = new Map<string, HeldTool<McpTool>[]>();
  /** Every tool a server listed last time, approved or not. */
  private _listed = new Map<string, McpTool[]>();
  private _errors = new Map<string, string>();
  private _connectMs = new Map<string, number>();
  private _refreshing = new Map<string, Promise<void>>();

  /** Register the host's servers and connect them now. */
  async setHostServers(config: Record<string, McpServerConfigV2>): Promise<void> {
    this._host = { ...config };
    await this.loadServers(Object.fromEntries([...this._configs.entries()].filter(([n]) => !(n in this._host))));
  }

  async loadServers(config: Record<string, McpServerConfigV2>): Promise<void> {
    // Stop any previously running clients
    this.stopAll();

    for (const [name, serverConfig] of Object.entries({ ...config, ...this._host })) {
      const started = Date.now();
      let client: McpBaseClient | undefined;
      try {
        // `{{secret:…}}` in env/headers becomes the value here, for this
        // spawn only; settings and `_configs` keep the reference.
        client = this._createClient(await resolveConfigSecrets(name, serverConfig));
        if (name in this._host) client.callMeta = hostCallMeta;
        await client.initialize();
        this._configs.set(name, serverConfig);
        const tools = await this._applyListing(name, await client.listTools());
        const resources = await client.listResources();

        this._clients.set(name, client);
        this._resourceCache.set(name, resources);
        this._connectMs.set(name, Date.now() - started);
        this._errors.delete(name);
        client.onToolsChanged = () => { void this.refreshTools(name); };

        const held = this._held.get(name)?.length ?? 0;
        process.stdout.write(
          chalk.gray(`  ✓ MCP server "${name}": ${tools.length} tools, ${resources.length} resources`
            + `${held ? `, ${held} held until a person approves them (/mcp-review)` : ''}\n`),
        );
      } catch (err) {
        try { client?.stop(); } catch { /* already gone */ }
        this._configs.delete(name);
        this._toolCache.delete(name);
        this._errors.set(name, err instanceof Error ? err.message : String(err));
        process.stderr.write(
          chalk.yellow(`  ⚠ MCP server "${name}" failed to load: ${err}\n`),
        );
      }
    }

    this._emit();
  }

  /**
   * Take a server's listing: pin-check it (host servers excepted), cache what
   * may be used, keep the rest for review. Returns the usable tools.
   */
  private async _applyListing(name: string, listed: McpTool[]): Promise<McpTool[]> {
    this._listed.set(name, listed);
    let allowed = listed;
    if (!(name in this._host)) {
      const config = this._configs.get(name);
      const identity = serverIdentity(config);
      const review = reviewServerTools(name, listed, { trusted: config?.trust === 'trusted', ...(identity ? { identity } : {}) });
      allowed = review.allowed;
      this._held.set(name, review.held);
    } else {
      this._held.delete(name);
    }
    this._toolCache.set(name, allowed);
    return allowed;
  }

  /**
   * Re-list one server's tools now: on its `list_changed` notification, on
   * the periodic refresh, after an approval. A changed description takes the
   * tool away from the agent from the next step on (`agent.ts`
   * `syncMcpTools`), and the call-time check in `getToolsForAgent` refuses a
   * call through a handler built before the change. Coalesced per server.
   */
  refreshTools(name: string): Promise<void> {
    const running = this._refreshing.get(name);
    if (running) return running;
    const run = (async () => {
      const client = this._clients.get(name);
      if (!client) return;
      try {
        await this._applyListing(name, await client.listTools());
        this._errors.delete(name);
      } catch (err) {
        this._errors.set(name, err instanceof Error ? err.message : String(err));
      }
      this._emit();
    })().finally(() => this._refreshing.delete(name));
    this._refreshing.set(name, run);
    return run;
  }

  /** Tools waiting for a person, per server. */
  heldTools(name?: string): Array<{ server: string; held: HeldTool<McpTool> }> {
    const out: Array<{ server: string; held: HeldTool<McpTool> }> = [];
    for (const [server, held] of this._held) {
      if (name && server !== name) continue;
      for (const h of held) out.push({ server, held: h });
    }
    return out;
  }

  /**
   * A person approved a server's held tools (all, or the named ones): pin the
   * definitions as listed now and offer them. The caller establishes that a
   * person asked (see `McpManage approve`); this never decides that.
   */
  async approveHeld(name: string, tools?: readonly string[]): Promise<string[]> {
    const held = this._held.get(name) ?? [];
    const chosen = held.filter(h => !tools?.length || tools.includes(h.tool.name)).map(h => h.tool);
    if (!chosen.length) return [];
    const pinned = approveTools(name, chosen, serverIdentity(this._configs.get(name)));
    await this.refreshTools(name);
    return pinned;
  }

  /** Why a configured server is not loaded (or last failed to refresh). */
  errorOf(name: string): string | undefined {
    return this._errors.get(name);
  }

  /** Every tool the server listed last time, approved or not. */
  listedTools(name: string): McpTool[] {
    return this._listed.get(name) ?? [];
  }

  /** The live client, for `McpManage test` detail. */
  clientOf(name: string): McpBaseClient | undefined {
    return this._clients.get(name);
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
          // Guarded at offer time, not at listing: the pin hashes what the
          // server actually said, so a hidden change is still a change.
          description: `[MCP:${serverName}] ${guardMcpText(t.description, 'MCP tool description', false)}`,
          inputSchema: t.inputSchema,
          // Checked at call time too: a handler built before a refresh held
          // this tool back must not still reach the server.
          execute: (args: Record<string, unknown>) => {
            if (!this._toolCache.get(serverName)?.some(c => c.name === t.name)) {
              return Promise.reject(new Error(`MCP tool ${t.name} on "${serverName}" is not available: its definition `
                + 'changed since it was approved, or the server stopped offering it. A person can review it with /mcp-review.'));
            }
            return t.execute(args);
          },
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
      // Refresh tool metadata and use the request itself as the health ping.
      // Through the pin check, so a description that changed on a server that
      // sends no list_changed (or over HTTP, where none is listened for) is
      // caught here.
      const before = this._toolCache.get(name)?.map(t => t.name).join() ?? '';
      await this.refreshTools(name);
      if ((this._toolCache.get(name)?.map(t => t.name).join() ?? '') !== before) changed = true;
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
      ...(client.era ? { era: client.era } : {}),
      ...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
      ...(this._held.get(name)?.length ? { heldCount: this._held.get(name)!.length } : {}),
      ...(this._errors.get(name) ? { lastError: this._errors.get(name)! } : {}),
      ...(this._connectMs.has(name) ? { connectMs: this._connectMs.get(name)! } : {}),
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
    this._held.clear();
    this._listed.clear();
    this._errors.clear();
    this._resourceCache.clear();
    this._configs.clear();
  }

  getServerInfos(): McpServerInfo[] {
    return this._buildServerInfos();
  }

  getConfigs(): Record<string, McpServerConfigV2> {
    return Object.fromEntries(this._configs.entries());
  }

  /** The config a loaded server runs under, for policy decisions (`mcp/policy`). */
  configOf(serverName: string): McpServerConfigV2 | undefined {
    return this._configs.get(serverName);
  }

  /** Whether a server was contributed by the hosting process rather than settings. */
  isHost(serverName: string): boolean {
    return serverName in this._host;
  }

  /** Names of the servers whose tools are loaded, for splitting `mcp__<server>__<tool>`. */
  serverNames(): string[] {
    return [...this._toolCache.keys()];
  }
}

export const mcpRegistry = new McpServerRegistry();
