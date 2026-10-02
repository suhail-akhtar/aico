import { McpBaseClient, type McpServerConfigV2, type McpHealthStatus, type SendOptions } from './base.js';
import { McpRpcError, McpTimeoutError, standardHeaders } from './protocol.js';

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string; code?: number; data?: unknown };
}

/**
 * MCP Streamable HTTP transport — each JSON-RPC message is one POST.
 *
 * Speaks both eras (see `mcp/base`):
 *
 * - **2026-07-28.** Every POST carries `MCP-Protocol-Version`, `Mcp-Method`,
 *   and `Mcp-Name` where the method needs it, plus any `Mcp-Param-*` a tool's
 *   schema asks for. No session.
 * - **2025-03-26 … 2025-11-25.** The server may mint an `Mcp-Session-Id` on
 *   `initialize`; it is echoed on every later request. Without it such servers
 *   answer 400 to everything after the handshake — which this client used to
 *   do to them.
 *
 * Either era may answer with JSON or with an SSE stream scoped to the request
 * (notifications, then the response); both are read. The stream is read to
 * the response and no further, so a long-lived `subscriptions/listen` stream
 * is not something this transport opens (the registry's periodic refresh is
 * what notices list changes over HTTP).
 *
 * A non-2xx answer keeps its JSON-RPC error body, because the era probe has to
 * tell a modern error (`UnsupportedProtocolVersion`, 400) from a legacy
 * server's refusal of a method it never heard of.
 */
export class McpHttpClient extends McpBaseClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private msgId = 1;
  private _healthy = true;
  private _lastError?: string;
  private sessionId?: string;

  constructor(config: McpServerConfigV2) {
    super();
    if (!config.url) throw new Error('McpHttpClient requires config.url');
    this.url = config.url;
    this.headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(config.headers ?? {}),
    };
  }

  protected override mirrorsHeaders(): boolean {
    return true;
  }

  isAlive(): boolean {
    return this._healthy;
  }

  getHealth(): McpHealthStatus {
    return this._healthy ? 'healthy' : 'degraded';
  }

  /** The last transport failure, for `McpManage test`. */
  get lastError(): string | undefined {
    return this._lastError;
  }

  private headersFor(method: string, params: unknown, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...this.headers, ...standardHeaders(method, params), ...(extra ?? {}) };
    // 2025-06-18 and later handshake revisions require the negotiated version on every later request.
    if (this.era === 'legacy' && this.protocolVersion && this.protocolVersion >= '2025-06-18' && method !== 'initialize') {
      h['MCP-Protocol-Version'] = this.protocolVersion;
    }
    if (this.sessionId && this.era !== 'modern') h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: this.headersFor(method, params),
        body: JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }),
        signal: controller.signal,
      });
      await resp.body?.cancel().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async send(method: string, params?: unknown, opts?: SendOptions): Promise<unknown> {
    const id = this.msgId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });

    const controller = new AbortController();
    const timeoutMs = opts?.timeoutMs || 30_000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: this.headersFor(method, params, opts?.headers),
        body,
        signal: controller.signal,
      });

      const sid = resp.headers.get('mcp-session-id');
      if (sid && method === 'initialize') this.sessionId = sid;

      const type = resp.headers.get('content-type') ?? '';
      const msg = type.includes('text/event-stream') ? await this.readStream(resp, id) : parse(await resp.text());

      if (!resp.ok) {
        if (msg?.error) throw new McpRpcError(msg.error.message, msg.error.code, msg.error.data, resp.status);
        throw new McpRpcError(`MCP HTTP ${resp.status}: ${resp.statusText}`, undefined, undefined, resp.status);
      }
      this._healthy = true;
      if (msg?.error) throw new McpRpcError(msg.error.message, msg.error.code, msg.error.data, resp.status);
      return msg?.result;
    } catch (err) {
      if (err instanceof McpRpcError) throw err; // the server answered; the connection is fine
      this._healthy = false;
      const failure = timedOut ? new McpTimeoutError(method) : err;
      this._lastError = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read an SSE response up to the message answering `id`; notifications on the way are handled. */
  private async readStream(resp: Response, id: number): Promise<RpcMessage | undefined> {
    if (!resp.body) return undefined;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = done ? '' : events.pop() ?? '';
        for (const event of events) {
          const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          const msg = parse(data);
          if (!msg) continue;
          if (typeof msg.method === 'string') { this.handleServerMessage({ id: msg.id, method: msg.method, params: msg.params }); continue; }
          if (msg.id === id) return msg;
        }
        if (done) return undefined;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  stop(): void {
    this._healthy = false;
  }
}

function parse(text: string): RpcMessage | undefined {
  if (!text.trim()) return undefined;
  try { return JSON.parse(text) as RpcMessage; } catch { return undefined; }
}
