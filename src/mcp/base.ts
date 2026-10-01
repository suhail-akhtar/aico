import { offerToolImage } from '../tools/tool-images.js';

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

/** One item of an MCP tool result's `content`. Only the fields AICO reads. */
export interface McpContentItem {
  type: string;
  text?: string;
  /** Base64, for `image`. */
  data?: string;
  mimeType?: string;
  /** For `resource`: an embedded resource, which may itself be an image blob. */
  resource?: { uri?: string; mimeType?: string; blob?: string; text?: string };
}

/**
 * The pictures in an MCP result, as bytes.
 *
 * Two places an image can be: an `image` item, and an embedded `resource`
 * whose blob is an image. The declared MIME type only chooses what to look at —
 * the format itself is read from the bytes later, because a server's label is
 * not something a provider should be told on trust.
 */
export function mcpImages(content: readonly McpContentItem[]): Array<{ bytes: Buffer }> {
  const out: Array<{ bytes: Buffer }> = [];
  for (const item of content) {
    const data = item.type === 'image'
      ? item.data
      : item.type === 'resource' && /^image\//i.test(item.resource?.mimeType ?? '') ? item.resource?.blob : undefined;
    if (typeof data !== 'string' || !data) continue;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 0) out.push({ bytes });
  }
  return out;
}

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
  /**
   * MCP `_meta` to send with each `tools/call`, read at call time. Set only
   * for the host's own servers (see `registry.setHostServers`): the desktop's
   * browser tools must know which chat is calling so two chats — or a chat
   * and the browser copilot — each drive their own tab. A third-party server
   * is never told the session id.
   */
  callMeta?: () => Record<string, unknown> | undefined;

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
    const meta = this.callMeta?.();
    const result = (await this.send('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as {
      content?: McpContentItem[];
    };
    const content = result?.content ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');

    /*
      Image content, which used to vanish.

      A browser tool's screenshot came back as `{ type: 'image', data }` beside
      a line of text; only the text survived, so the model was told a
      screenshot was taken and never shown it. Worse, a result that was *only*
      an image fell through to the raw object, and the model was handed the
      base64 as a wall of characters. Each image is now offered to the model
      the way a Read of a PNG is (see `tools/tool-images`), and the result says
      what became of it.
    */
    const images = mcpImages(content);
    if (images.length > 0) {
      const notes: string[] = [];
      for (const [index, image] of images.entries()) {
        const note = await offerToolImage({
          bytes: image.bytes,
          name: `${name}${images.length > 1 ? `-${index + 1}` : ''}`,
          origin: `MCP tool ${name}`,
        });
        notes.push(`[Image ${images.length > 1 ? `${index + 1} ` : ''}from ${name}] ${note}`);
      }
      return [text, ...notes].filter(Boolean).join('\n');
    }
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
