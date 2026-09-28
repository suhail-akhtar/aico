/** Backward-compatible MCP server config (V2 adds http/sse support) */
export interface McpServerConfigV2 {
  /** Process command — required for stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type: 'stdio' | 'http' | 'sse';
  /** HTTP/SSE endpoint URL */
  url?: string;
  /** Extra HTTP headers (e.g. Authorization) */
  headers?: Record<string, string>;
}

/** Backward-compat alias — existing configs only need command + type:'stdio' */
export type McpServerConfig = McpServerConfigV2;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export type McpHealthStatus = 'healthy' | 'degraded' | 'disconnected';

/** A server's instructions are capped: they ride in every request's prompt. */
const MAX_INSTRUCTIONS = 6000;

/** JSON-RPC request/response shapes */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message: string; code?: number };
}

/**
 * Abstract base class for all MCP transport implementations.
 * Concrete subclasses implement `send()`, `isAlive()`, `stop()`, and `getHealth()`.
 */
export abstract class McpBaseClient {
  protected initialized = false;
  /**
   * What the server said about how to use it (`instructions` in the MCP
   * initialize result). Kept so it can reach the agent — a server that ships a
   * manual for its tools is telling the model something the tool schemas cannot.
   */
  instructions?: string;

  /** Send a JSON-RPC request and return the result */
  abstract send(method: string, params?: unknown): Promise<unknown>;

  /** Return true if the transport connection is usable */
  abstract isAlive(): boolean;

  /** Gracefully shut down the transport */
  abstract stop(): void;

  /** Current health status for the registry status bar */
  abstract getHealth(): McpHealthStatus;

  async initialize(): Promise<void> {
    const result = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aico', version: '1.0.0' },
    }) as { instructions?: unknown } | undefined;
    if (typeof result?.instructions === 'string' && result.instructions.trim()) {
      this.instructions = result.instructions.trim().slice(0, MAX_INSTRUCTIONS);
    }
    // Send initialized notification — no response expected
    await this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  /** Send a JSON-RPC notification (fire-and-forget) */
  protected async sendNotification(method: string, params: unknown): Promise<void> {
    try {
      await this.send(method, params);
    } catch {
      // Notifications are fire-and-forget — ignore errors
    }
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.send('tools/list', {})) as {
      tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    };
    const rawTools = result?.tools ?? [];
    return rawTools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
      execute: (args: Record<string, unknown>) => this.callTool(t.name, args),
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.send('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const content = result?.content ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    return text || result;
  }

  async listResources(): Promise<McpResource[]> {
    try {
      const result = (await this.send('resources/list', {})) as {
        resources?: McpResource[];
      };
      return result?.resources ?? [];
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<McpResourceContent> {
    const result = (await this.send('resources/read', { uri })) as {
      contents?: Array<McpResourceContent>;
    };
    const contents = result?.contents ?? [];
    return contents[0] ?? { uri };
  }
}
